/* ============================================================
   /admin* 前置中间件
   Cloudflare Pages Functions middleware：位于 functions/admin/ 下，
   会先于该目录下所有 Function（含 api/whitelist/[[path]].js）执行，
   也能拦住「静态后台页面」——这是单独在 API catch-all 里加判断做不到的。

   两个用途：
   1) ADMIN_LOCKDOWN_TEST=1 「测试锁定」
      除 /admin/test 外，/admin* 下的一切（页面 + 全部 API）一律 403。
      用于上线前验证 Cloudflare WAF 的 IP 白名单是否真的生效：
      配 WAF 的阶段即使规则写错、或 fallback 变量被提前打开，
      别人拿到的也只是一个不含任何数据的测试页，看不到申请记录。
   2) /admin/test 「自检页」
      任何模式下都可直接访问，显示当前开关状态，用来确认
      「WAF 是否放行了你现在这个 IP」。

   安全默认：两个开关都严格只认字符串 '1'。
   写成 'true' / 'yes' / '0' / 空 都算关闭，避免手滑打开无条件入口。
   未开启锁定时本中间件只做 next()，对现有功能零影响。
   ============================================================ */

import { cfg } from '../_lib/env.js';

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

/** 归一化路径：去掉结尾斜杠，防止 /admin/test/ 与 /admin/test 被当成两个路径 */
function normPath(url) {
  const p = new URL(url).pathname.replace(/\/+$/, '');
  return p || '/';
}

function isEnabled(env, key) {
  return cfg(env, key, '') === '1';
}

function testPage(env, request) {
  const lockdown = isEnabled(env, 'ADMIN_LOCKDOWN_TEST');
  const fallback = isEnabled(env, 'ADMIN_ALLOW_ACCESS_FALLBACK');
  const path = normPath(request.url);

  const rows = [
    ['当前路径', path],
    ['测试锁定（ADMIN_LOCKDOWN_TEST）', lockdown ? '开启' : '关闭'],
    ['Access 过渡模式（ADMIN_ALLOW_ACCESS_FALLBACK）', fallback ? '开启' : '关闭'],
  ];

  const banner = lockdown
    ? '<div class="box lock"><b>🔒 测试锁定已开启</b><br>除本页外，所有后台页面与接口均返回 403。这是配置 WAF 期间的安全状态。</div>'
    : '<div class="box ok"><b>✅ 未开启测试锁定</b><br>后台现在按正常鉴权模式工作。若这是过渡期，请确认 WAF 的 /admin* 规则已生效。</div>';

  const hint = lockdown
    ? '<p>接下来的验证：</p><ol><li>用<b>允许的 IP</b>打开本页 → 应看到这个页面</li>'
      + '<li>换一个不在白名单的网络（或手机热点）打开本页 → 应被 Cloudflare WAF 拦截</li>'
      + '<li>用 <code>curl -H "cf-access-authenticated-user-email: hacker@example.com" '
      + 'https://你的域名/admin/api/whitelist/me</code> → 应被 WAF 拦截或返回 403，绝不能返回 JSON</li>'
      + '<li>三项都符合后，才把 <code>ADMIN_ALLOW_ACCESS_FALLBACK</code> 设为 1，并把 '
      + '<code>ADMIN_LOCKDOWN_TEST</code> 设为 0</li></ol>'
    : '<p>本页不含任何申请数据，也不调用后台接口。能看到它，说明 WAF 已放行你当前的来源 IP。</p>';

  const body = rows
    .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
    .join('');

  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>LongerMC 后台自检</title>`
    + `<style>body{margin:0;background:#0d1117;color:#e6edf3;font:15px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;padding:32px 18px}`
    + `.wrap{max-width:720px;margin:0 auto}h1{font-size:20px;margin:0 0 6px}`
    + `.sub{color:#8b949e;font-size:13px;margin-bottom:22px}`
    + `table{width:100%;border-collapse:collapse;margin:18px 0}th,td{padding:10px 12px;border-bottom:1px solid #30363d;text-align:left;font-size:14px}`
    + `th{color:#8b949e;font-weight:500;width:58%}code{background:#161b22;padding:2px 6px;border-radius:4px;font-size:13px;word-break:break-all}`
    + `.box{padding:14px 16px;border-radius:8px;margin:18px 0}`
    + `.box.lock{background:#3b2418;border:1px solid #8a5a2b}`
    + `.box.ok{background:#12261a;border:1px solid #2e6b40}`
    + `ol{padding-left:20px}li{margin:6px 0}</style></head><body><div class="wrap">`
    + `<h1>LongerMC 管理后台 · 自检页</h1>`
    + `<div class="sub">/admin/test — 用于验证 Cloudflare WAF 是否已保护后台</div>`
    + banner
    + `<table>${body}</table>`
    + hint
    + `<p class="sub">切换到 Cloudflare Access 后：把两个变量都设为 0（或删除）、删除 WAF 规则、`
    + `配好 ACCESS_AUD / ACCESS_TEAM_DOMAIN / ADMIN_ALLOWED_EMAILS。</p>`
    + `</div></body></html>`,
    { status: 200, headers: HTML_HEADERS }
  );
}

function locked(path, isApi) {
  if (isApi) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: 'admin_lockdown',
          message: '后台处于测试锁定状态，仅 /admin/test 可访问。配置完成请把 ADMIN_LOCKDOWN_TEST 设为 0。',
        },
      }),
      {
        status: 403,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      }
    );
  }

  // 页面请求：给一句人话，别让管理员对着 JSON 猜
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>后台已锁定</title></head>`
    + `<body style="background:#0d1117;color:#e6edf3;font:15px/1.7 system-ui;padding:40px 20px">`
    + `<div style="max-width:640px;margin:0 auto"><h1>🔒 后台处于测试锁定状态</h1>`
    + `<p>路径 <code>${path.replace(/</g, '&lt;')}</code> 已被临时禁用。请打开 `
    + `<a href="/admin/test" style="color:#58a6ff">/admin/test</a> 查看当前配置。</p>`
    + `<p style="color:#8b949e">完成 WAF 验证后，把 ADMIN_LOCKDOWN_TEST 设为 0 即恢复。</p></div></body></html>`,
    { status: 403, headers: HTML_HEADERS }
  );
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const path = normPath(request.url);
  const isAdmin = path === '/admin' || path.startsWith('/admin/');

  // 理论上只会命中 /admin*，这里兜一层，绝不影响其它路径
  if (!isAdmin) return next();

  // 自检页任何模式都可访问（它不读数据库、不调用后台接口、不含申请数据）
  if (path === '/admin/test') return testPage(env, request);

  // 未开启锁定 → 完全放行，对现有功能零影响
  if (!isEnabled(env, 'ADMIN_LOCKDOWN_TEST')) return next();

  // 锁定优先于一切：即使 fallback 开着、或有人伪造了 Access 头，也进不去
  return locked(path, path.startsWith('/admin/api/'));
}
