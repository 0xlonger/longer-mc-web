/* ============================================================
   Cloudflare Turnstile 服务端校验
   - 生产环境缺少 TURNSTILE_SECRET 一律判定失败（拒绝放行）
   - 本地开发未配置密钥时，仅接受固定 mock token，且仅对非生产域名生效
   ============================================================ */

import { DEV_MOCK_TURNSTILE_TOKEN, cfg, isProduction, turnstileAllowedHostnames } from './env.js';
import { clientIp } from './http.js';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** 凭证时效上限：超过这个时间的 challenge 直接拒绝（防止凭证被长期重放） */
const MAX_CHALLENGE_AGE_SEC = 300;

export async function verifyTurnstile(env, request, token) {
  const secret = cfg(env, 'TURNSTILE_SECRET', '');
  const prod = isProduction(request, env);
  const input = String(token || '').trim();

  if (!secret) {
    if (!prod && input === DEV_MOCK_TURNSTILE_TOKEN) {
      return { ok: true, simulated: true };
    }
    return {
      ok: false,
      error: 'turnstile_not_configured',
      message: prod
        ? '人机验证服务未配置，请联系管理员'
        : '本地开发未配置 TURNSTILE_SECRET，请填写密钥或使用模拟 token',
    };
  }

  if (!input) {
    return { ok: false, error: 'turnstile_missing', message: '请先完成人机验证' };
  }
  if (input.length > 4096) {
    return { ok: false, error: 'turnstile_invalid', message: '人机验证凭据无效' };
  }

  let data = {};
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret, response: input, remoteip: clientIp(request) }),
    });
    data = await res.json();
  } catch (e) {
    return { ok: false, error: 'turnstile_error', message: '人机验证服务暂时不可用，请稍后再试' };
  }

  if (!data || data.success !== true) {
    return {
      ok: false,
      error: 'turnstile_failed',
      message: '人机验证未通过，请重新完成验证',
      codes: (data && data['error-codes']) || [],
    };
  }

  /**
   * 核对站点域名：siteverify 会返回签发该凭证的 hostname。
   * 不校验的话，密钥一旦被别的站点盗用（或预览域名与正式域名混用同一套密钥），
   * 别的站点签出的凭证在这里也会被接受。
   * 允许列表 = 环境变量 TURNSTILE_ALLOWED_HOSTNAMES ∪ 当前访问域名。
   */
  const allowed = turnstileAllowedHostnames(env);
  try {
    const currentHost = new URL(request.url).hostname.toLowerCase();
    if (currentHost) allowed.push(currentHost);
  } catch {
    /* ignore */
  }

  const gotHost = String(data.hostname || '').toLowerCase();
  if (gotHost && !allowed.includes(gotHost)) {
    console.warn('[turnstile] 凭证 hostname 不匹配', { gotHost, allowed });
    return {
      ok: false,
      error: 'turnstile_host_mismatch',
      message: '人机验证来源不匹配，请重新完成验证',
    };
  }

  // 凭证时效：过老的 challenge 直接拒绝
  if (data.challenge_ts) {
    const ts = Date.parse(data.challenge_ts);
    if (!Number.isNaN(ts) && Date.now() - ts > MAX_CHALLENGE_AGE_SEC * 1000) {
      return {
        ok: false,
        error: 'turnstile_expired',
        message: '人机验证已过期，请重新完成验证',
      };
    }
  }

  return { ok: true, simulated: false, hostname: gotHost || '' };
}
