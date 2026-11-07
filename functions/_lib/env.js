/* ============================================================
   环境变量与运行模式
   - 任何密钥 / 凭据都只从环境变量读取，禁止硬编码进仓库
   - 缺少关键配置时降级为「模拟模式」，保证本地可端到端开发
   ============================================================ */

export const SERVER_NAME = 'LongerMC';

/** 开发环境专用：只有未配置 TURNSTILE_SECRET 且非生产域名时才接受该 token */
export const DEV_MOCK_TURNSTILE_TOKEN = 'dev-mock-turnstile-token';

/** 开发环境专用兜底 pepper（生产环境缺少 CODE_PEPPER 会直接报错） */
export const DEV_INSECURE_PEPPER = 'dev-only-insecure-pepper-do-not-use-in-production';

const DEFAULT_PRODUCTION_HOSTS = 'mc.longer.xin,longer-mc.pages.dev';
const DEFAULT_DEV_HOSTS = 'localhost,127.0.0.1,[::1],0.0.0.0';
const DEFAULT_BASE_URL = 'https://mc.longer.xin';

export function cfg(env, name, fallback = '') {
  const v = env && env[name];
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s === '' ? fallback : s;
}

/** 主机名（小写、不含端口），用于生产 / 开发判定 */
export function hostOf(request) {
  try {
    return new URL(request.url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function hostList(env, name, fallback) {
  return cfg(env, name, fallback)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function matchHost(host, list) {
  for (const h of list) {
    if (host === h || host.endsWith('.' + h)) return true;
  }
  return false;
}

/**
 * 生产环境判定 —— 「安全默认」策略（重要）：
 *
 *   只有被显式列入 DEV_HOSTS（默认仅 localhost / 127.0.0.1）的域名才算非生产，
 *   其余一律按生产处理。
 *
 * 为什么不用「命中 PRODUCTION_HOSTS 才算生产」：
 *   那样一旦出现未列出的域名（例如 Pages 预览部署 abc123.longer-mc.pages.dev、
 *   或以后更换域名），就会被误判成开发环境，导致三重安全降级：
 *     1) send-code 在响应里回显 6 位验证码 devCode
 *     2) Turnstile 接受固定模拟 token，人机验证形同虚设
 *     3) DEV_ALLOW_ADMIN_BYPASS=1 直接放行管理后台
 *   改为安全默认后，未知域名一律走严格路径（缺 TURNSTILE_SECRET / CODE_PEPPER 直接报错）。
 *
 * 注意：预览部署（*.pages.dev）因此也会被当成生产环境，
 * 预览环境必须配置 Turnstile（站点密钥需覆盖预览域名）与 CODE_PEPPER，
 * 且管理后台 bypass 在预览环境不可用（这是预期行为）。
 */
export function isProduction(request, env) {
  const host = hostOf(request);

  // 取不到 host 时按生产处理（宁可严格，不可放宽）
  if (!host) return true;

  // 1) 命中生产域名（含子域）→ 生产
  if (matchHost(host, hostList(env, 'PRODUCTION_HOSTS', DEFAULT_PRODUCTION_HOSTS))) return true;

  // 2) 命中开发白名单 → 非生产
  if (matchHost(host, hostList(env, 'DEV_HOSTS', DEFAULT_DEV_HOSTS))) return false;

  // 3) 其余未知域名一律按生产处理
  return true;
}

/** 验证码 / 票据哈希用的 pepper */
export function pepper(env) {
  const p = cfg(env, 'CODE_PEPPER', '');
  if (p.length >= 8) return { value: p, devFallback: false };
  return { value: DEV_INSECURE_PEPPER, devFallback: true };
}

/** 邮件驱动：resend（真实发送） / log（仅日志 + D1 发件箱） */
export function emailDriver(env) {
  const explicit = cfg(env, 'EMAIL_DRIVER', '').toLowerCase();
  if (explicit === 'log' || explicit === 'simulate' || explicit === 'mock') return 'log';
  if (explicit === 'resend') return 'resend';
  return cfg(env, 'RESEND_API_KEY', '') ? 'resend' : 'log';
}

export function emailFrom(env) {
  return cfg(env, 'EMAIL_FROM', '');
}

export function appBaseUrl(env) {
  return cfg(env, 'APP_BASE_URL', DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function turnstileSiteKey(env) {
  return cfg(env, 'TURNSTILE_SITE_KEY', '');
}

/**
 * 重复冲突的提示粒度：
 *   generic  （默认）统一返回「你填写的信息与已有记录冲突」，不区分字段、不返回对方编号
 *   detailed 按字段返回 duplicate_ign / duplicate_qq / ... 并带上对方申请编号
 *
 * 为什么默认 generic：申请接口只需要一个邮箱验证码就能调用，
 * 字段级提示等于给探测者一本「数据字典」——能用返回值判断任意
 * IGN / QQ / Discord / 邮箱是否已被申请过。字段级提示对正常用户友好，
 * 但对攻击者等于信息泄露，默认取安全一侧。想改回详细提示：
 * 设置环境变量 DUPLICATE_HINT_MODE=detailed。
 */
export function duplicateHintMode(env) {
  return cfg(env, 'DUPLICATE_HINT_MODE', 'generic').toLowerCase() === 'detailed' ? 'detailed' : 'generic';
}

/**
 * 网页通道不可用时的「全人工白名单」入口。
 * 说明：网页端（申请 / 查询 / 修改）故障时，用户可以直接加入 QQ 群或
 * Discord 服务器，说明自己无法在网页完成操作，由管理员走全人工流程添加白名单。
 * 两个值都留空时，页面与邮件里不会显示该提示块。
 */
/**
 * 默认值与首页「加入区」保持一致的公开群号 / 邀请链接（不是密钥）。
 * 想换成别的群 / 别的邀请链接，用环境变量覆盖即可。
 */
const DEFAULT_QQ_GROUP = '1130448476';
const DEFAULT_DISCORD_INVITE = 'https://discord.gg/Ab4Gw2vBK';

export function fallbackContacts(env) {
  // 与 cfg() 不同：这里区分「没配」和「配了但留空」——
  // 留空表示有意关闭该提示块，不该回落到默认值。
  const raw = (name) => {
    const v = env && env[name];
    return v === undefined || v === null ? null : String(v).trim();
  };
  const pick = (name, dflt) => {
    const v = raw(name);
    return v === null ? dflt : v;
  };
  return {
    qqGroup: pick('FALLBACK_QQ_GROUP', DEFAULT_QQ_GROUP),
    qqGroupUrl: pick('FALLBACK_QQ_GROUP_URL', ''),
    discordInvite: pick('FALLBACK_DISCORD_INVITE', DEFAULT_DISCORD_INVITE),
  };
}

/** 允许通过 Turnstile 校验的站点域名（siteverify 返回的 hostname 必须在其中） */
export function turnstileAllowedHostnames(env) {
  return cfg(env, 'TURNSTILE_ALLOWED_HOSTNAMES', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 管理员白名单（在 Cloudflare Access 之上的第二道校验，可留空） */
export function adminAllowList(env) {
  return cfg(env, 'ADMIN_ALLOWED_EMAILS', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
