/* ============================================================
   HTTP 辅助：统一响应、来源校验、请求体读取
   ============================================================ */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export function ok(data = {}, status = 200) {
  return jsonResponse({ ok: true, ...data }, status);
}

export function fail(code, message, status = 400, extra = {}) {
  return jsonResponse({ ok: false, error: { code, message, ...extra } }, status);
}

export function clientIp(request) {
  const h = request.headers;
  const ip =
    h.get('cf-connecting-ip') ||
    (h.get('x-forwarded-for') || '').split(',')[0].trim() ||
    h.get('x-real-ip') ||
    '';
  return ip || 'unknown';
}

/**
 * 来源校验：浏览器请求必须同源；非浏览器（curl 等）没有相关头时放行，
 * 便于本地联调与文档示例。
 */
/**
 * 宽松来源校验（读请求用）
 * 浏览器同源 GET 通常不带 Origin，只带 Sec-Fetch-Site: same-origin，
 * 所以读请求在没有相关头部时必须放行，否则正常用户会被误伤。
 */
export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      return new URL(origin).host === new URL(request.url).host;
    } catch {
      return false;
    }
  }
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  return true;
}

/**
 * 严格来源校验（写请求用）
 *
 * 与 sameOrigin() 的区别：既没有 Origin 也没有 Sec-Fetch-Site 的请求一律拒绝。
 * 早期实现里这种情况直接 return true，等于 curl 一条命令就能绕过 CSRF 校验
 * 直接提交申请 / 修改 / 发验证码（只要能弄到一个 ticket）。
 *
 * 现代浏览器对同源 POST 一定会带 Origin，所以正常用户不受影响。
 * 注意 Sec-Fetch-Site: none 也不再放行——它表示请求由用户直接发起
 * （地址栏、书签），表单提交不可能是 none。
 */
export function sameOriginStrict(request) {
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      return new URL(origin).host === new URL(request.url).host;
    } catch {
      return false;
    }
  }
  const site = request.headers.get('sec-fetch-site');
  return site === 'same-origin';
}

export async function readJson(request, maxBytes = 8192) {
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) return null;
  let text = '';
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > maxBytes) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** 取字符串字段并裁剪长度，避免超长输入进入 DB / 正则 */
export function str(v, max = 200) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}
