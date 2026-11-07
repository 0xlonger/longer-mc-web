/* ============================================================
   管理后台鉴权
   生产（正式）：依赖 Cloudflare Access 保护 /admin*，读取已认证管理员邮箱；
        若配置了 ACCESS_TEAM_DOMAIN + ACCESS_AUD，则对 JWT 做完整校验。
   生产（过渡）：ADMIN_ALLOW_ACCESS_FALLBACK=1 时，允许「没有 Access 头」
        的请求以固定身份进入——配合 Cloudflare WAF 的 IP 白名单使用。
        ⚠️ 该变量为真的唯一前提是 WAF 已验证生效，否则后台等于裸奔。
        切到 Access 后把它改成 0（或删掉）即可，无需改代码。
   本地：可用 DEV_ALLOW_ADMIN_BYPASS=1 临时放行（生产域名强制忽略该变量）。
   ============================================================ */

import { adminAllowList, cfg, isProduction } from './env.js';

let jwksCache = { team: '', at: 0, keys: null };

function b64urlToJson(part) {
  const pad = part.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function fetchJwks(team) {
  const now = Date.now();
  if (jwksCache.team === team && jwksCache.keys && now - jwksCache.at < 10 * 60 * 1000) {
    return jwksCache.keys;
  }
  const res = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
  const data = await res.json();
  jwksCache = { team, at: now, keys: (data && data.keys) || [] };
  return jwksCache.keys;
}

async function verifyAccessJwt(request, env) {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return { ok: false, code: 'no_jwt', message: '缺少 Access JWT' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, code: 'bad_jwt', message: 'Access JWT 格式错误' };

  let header;
  let payload;
  try {
    header = b64urlToJson(parts[0]);
    payload = b64urlToJson(parts[1]);
  } catch {
    return { ok: false, code: 'bad_jwt', message: 'Access JWT 解析失败' };
  }

  const team = cfg(env, 'ACCESS_TEAM_DOMAIN', '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const aud = cfg(env, 'ACCESS_AUD', '');
  if (!team || !aud) return { ok: false, code: 'not_configured', message: '未配置 Access 校验参数' };

  try {
    const keys = await fetchJwks(team);
    const jwk = keys.find((k) => k.kid === header.kid) || keys[0];
    if (!jwk) return { ok: false, code: 'no_key', message: '找不到 Access 公钥' };

    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = Uint8Array.from(
      atob(parts[2].replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (parts[2].length % 4)) % 4)),
      (c) => c.charCodeAt(0)
    );

    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
    if (!valid) return { ok: false, code: 'bad_sig', message: 'Access JWT 签名校验失败' };

    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return { ok: false, code: 'expired', message: 'Access JWT 已过期' };
    }
    if (payload.aud && payload.aud !== aud) {
      return { ok: false, code: 'bad_aud', message: 'Access JWT audience 不匹配' };
    }
    const expectedIss = `https://${team}.cloudflareaccess.com`;
    if (payload.iss && payload.iss !== expectedIss) {
      return { ok: false, code: 'bad_iss', message: 'Access JWT issuer 不匹配' };
    }
    return { ok: true, email: payload.email || '' };
  } catch (e) {
    return { ok: false, code: 'jwt_error', message: `Access JWT 校验失败：${(e && e.message) || e}` };
  }
}

/**
 * 校验管理员身份
 * @returns {Promise<{ok:boolean,status?:number,code?:string,message?:string,actor?:string,dev?:boolean}>}
 */
export async function requireAdmin(request, env) {
  const prod = isProduction(request, env);

  // 生产环境里即使被误配了 bypass 变量也一律忽略，只留一条日志
  if (prod && cfg(env, 'DEV_ALLOW_ADMIN_BYPASS', '') === '1') {
    console.warn('[access] 生产环境检测到 DEV_ALLOW_ADMIN_BYPASS=1，已忽略');
  }

  // 1) 本地开发 bypass（生产强制关闭）
  if (!prod && cfg(env, 'DEV_ALLOW_ADMIN_BYPASS', '') === '1') {
    return {
      ok: true,
      actor: cfg(env, 'DEV_ADMIN_EMAIL', '') || 'dev@localhost',
      dev: true,
      mode: 'dev-bypass',
    };
  }

  // 生产环境若只靠 Access 注入的头、没配 JWT 校验，提示一次（不阻断）
  if (prod && !(cfg(env, 'ACCESS_TEAM_DOMAIN', '') && cfg(env, 'ACCESS_AUD', ''))) {
    console.warn('[access] 生产环境未配置 ACCESS_TEAM_DOMAIN / ACCESS_AUD，仅信任 Cf-Access-Authenticated-User-Email 头。请确认 Access 应用路径覆盖 /admin*');
  }

  // 2) Access 注入的已认证邮箱
  const headerEmail = (request.headers.get('cf-access-authenticated-user-email') || '').trim();
  const jwtEmail =
    cfg(env, 'ACCESS_TEAM_DOMAIN', '') && cfg(env, 'ACCESS_AUD', '')
      ? (await verifyAccessJwt(request, env))
      : { ok: true, email: '' };

  if (cfg(env, 'ACCESS_TEAM_DOMAIN', '') && cfg(env, 'ACCESS_AUD', '') && !jwtEmail.ok) {
    return { ok: false, status: 401, code: jwtEmail.code, message: jwtEmail.message };
  }

  let actor = (jwtEmail.email || headerEmail || '').toLowerCase();

  /**
   * 过渡模式：后台由 Cloudflare WAF 的 IP 白名单保护，没有 Access 注入的头。
   * 严格只认 '1'——写成 'true' / 'yes' / '0' 都算关闭，避免手滑打开一个
   * 无条件入口。审计日志里用固定 actor，并记 mode='ip-allowlist' 便于日后追溯。
   */
  const fallbackOn = cfg(env, 'ADMIN_ALLOW_ACCESS_FALLBACK', '') === '1';
  let fallbackUsed = false;
  if (!actor && fallbackOn) {
    actor = (cfg(env, 'ADMIN_FALLBACK_ACTOR', '') || 'waf-admin@local.invalid').toLowerCase();
    fallbackUsed = true;
  }

  if (!actor) {
    return {
      ok: false,
      status: 401,
      code: 'unauthenticated',
      message: '未通过 Cloudflare Access 认证（缺少 Cf-Access-Authenticated-User-Email）',
    };
  }

  // 3) 可选的管理员白名单（Access 之上的第二道校验）
  const allow = adminAllowList(env);
  if (allow.length && !allow.includes(actor)) {
    return { ok: false, status: 403, code: 'not_allowed', message: '该账号不在管理员白名单内' };
  }

  const mode = fallbackUsed
    ? 'ip-allowlist'
    : cfg(env, 'ACCESS_TEAM_DOMAIN', '')
      ? 'access-jwt'
      : 'access-header';
  return { ok: true, actor, dev: false, mode };
}
