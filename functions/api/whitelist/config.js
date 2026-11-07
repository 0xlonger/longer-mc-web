/* ============================================================
   GET /api/whitelist/config
   向前端下发非敏感运行配置（Turnstile 站点密钥等）
   ============================================================ */

import { ok } from '../../_lib/http.js';
import { DEV_MOCK_TURNSTILE_TOKEN, SERVER_NAME, appBaseUrl, cfg, emailDriver, fallbackContacts, isProduction, turnstileSiteKey } from '../../_lib/env.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const prod = isProduction(request, env);
  const driver = emailDriver(env);
  const hasSecret = !!cfg(env, 'TURNSTILE_SECRET', '');

  return ok({
    serverName: SERVER_NAME,
    baseUrl: appBaseUrl(env),
    turnstile: {
      siteKey: turnstileSiteKey(env),
      // 未配置站点密钥时前端不渲染控件
      enabled: !!turnstileSiteKey(env),
      mockMode: !prod && !hasSecret,
      mockToken: !prod && !hasSecret ? DEV_MOCK_TURNSTILE_TOKEN : null,
    },
    email: {
      simulated: driver !== 'resend',
    },
    limits: {
      codeTtlMinutes: 10,
      codeLength: 6,
      resendCooldownSec: 60,
    },
    production: prod,
    // 网页通道不可用时的「全人工白名单」入口（公开信息，不是密钥）
    fallback: fallbackContacts(env),
  });
}
