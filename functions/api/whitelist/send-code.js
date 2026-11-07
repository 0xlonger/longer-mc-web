/* ============================================================
   POST /api/whitelist/send-code
   用途：apply（申请）/ inquire（查询）/ modify（修改）
   - 服务端 Turnstile 校验
   - 邮箱 / IP 双维度限流
   - 命中黑名单的邮箱不发信（apply / modify 明确报错；inquire 返回统一提示以免枚举）
   - inquire / modify 无论记录是否匹配都返回同一句提示，防止探测
   ============================================================ */

import { clientIp, fail, ok, readJson, sameOriginStrict, str } from '../../_lib/http.js';
import { normEmail, normFactor, normFactorValue, normPurpose } from '../../_lib/validation.js';
import { checkBlacklist } from '../../_lib/blacklist.js';
import { CODE_TTL_SEC, issueCode, purgeExpired } from '../../_lib/codes.js';
import { buckets, hit } from '../../_lib/ratelimit.js';
import { verifyTurnstile } from '../../_lib/turnstile.js';
import { pepper, isProduction, emailDriver } from '../../_lib/env.js';
import { ipFingerprint } from '../../_lib/audit.js';
import { sendMail } from '../../_lib/email.js';
import { PURPOSE_LABEL, verifyCode } from '../../_lib/templates.js';

export const GENERIC_OK_MESSAGE = '如信息匹配，验证码已发送至该邮箱，请查收（10 分钟内有效）。';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!sameOriginStrict(request)) return fail('bad_origin', '来源校验失败', 403);

  const body = await readJson(request);
  if (!body) return fail('bad_request', '请求格式错误');

  const purposeV = normPurpose(body.purpose);
  if (!purposeV.ok) return fail('bad_purpose', purposeV.message);
  const purpose = purposeV.value;

  const emailV = normEmail(body.email);
  if (!emailV.ok) return fail('invalid_email', emailV.message);
  const email = emailV.value;

  /**
   * inquire：只验证邮箱（不再要求填游戏 ID）——验证码本身已证明邮箱控制权
   * modify ：邮箱必填 + QQ / Discord / 游戏 ID 三选一做辅助验证，
   *          用哪一项验证，本次就不能改哪一项（详见 verify-code / modify）
   * change_email：向「拟更换的新邮箱」发验证码
   */
  let factor = '';
  let factorValue = '';

  if (purpose === 'modify') {
    const f = normFactor(body.factor);
    if (!f.ok) return fail('invalid_factor', f.message);
    const fv = normFactorValue(f.value, body.factorValue !== undefined ? body.factorValue : body.ign);
    if (!fv.ok) return fail('invalid_factor_value', fv.message);
    factor = f.value;
    factorValue = fv.value;
  }

  // 人机验证
  const ts = await verifyTurnstile(env, request, str(body.turnstileToken, 4096));
  if (!ts.ok) return fail(ts.error || 'turnstile_failed', ts.message || '人机验证未通过', 400);

  const p = pepper(env);
  if (p.devFallback && isProduction(request, env)) {
    return fail('server_misconfigured', '服务端缺少 CODE_PEPPER 配置，请联系管理员', 500);
  }

  const ip = clientIp(request);
  const ipHash = await ipFingerprint(env, ip, p.value);
  const emailHash = (await ipFingerprint(env, `e:${email}`, p.value));

  /**
   * 生产环境必须真的能发信。
   * 没有 RESEND_API_KEY 时 emailDriver() 会降级成 log（只写日志 + 发件箱），
   * 而 simulated 状态在下面会被当成「发送成功」返回——
   * 结果是用户永远收不到验证码，页面却提示「已发送」，且没有任何告警。
   * 所以生产环境直接报错，让问题立刻暴露。
   */
  const driver = emailDriver(env);
  if (isProduction(request, env) && driver !== 'resend') {
    console.error('[send-code] 生产环境邮件驱动不是 resend（缺少 RESEND_API_KEY？），拒绝发送');
    return fail('server_misconfigured', '邮件服务未配置，请联系管理员', 502);
  }

  // 限流：邮箱 60 秒冷却 + 每小时 5 次；IP 每小时 20 次
  const cooldown = await hit(env, buckets.sendCooldown(emailHash, purpose), 1, 60);
  if (!cooldown.ok) return fail('rate_limited', '验证码已发送，请 60 秒后再试', 429);

  const perHour = await hit(env, buckets.sendHour(emailHash, purpose), 5, 3600);
  if (!perHour.ok) return fail('rate_limited', '该邮箱发送次数过多，请稍后再试', 429);

  /**
   * 发码按 IP 限流：20 → 30 次 / 小时。
   * 移动网 CGNAT 下同一个出口 IP 可能对应几十个真实用户，
   * 20 次/小时容易被正常用户挤爆。真正的防线是「每个邮箱」的
   * 60 秒冷却 + 5 次/小时，IP 桶只兜底。
   */
  const perIp = await hit(env, buckets.sendIp(ipHash), 30, 3600);
  if (!perIp.ok) return fail('rate_limited', '请求过于频繁，请稍后再试', 429);

  // 黑名单
  const bl = await checkBlacklist(env, email);
  if (bl.blocked) {
    if (purpose === 'inquire') {
      // 查询场景保持统一响应，避免暴露黑名单命中情况
      return ok({ sent: true, message: GENERIC_OK_MESSAGE, simulated: false });
    }
    return fail('blacklisted_email', bl.reason || '该邮箱不可用于白名单申请', 403);
  }

  // 低频清理过期的验证码与票据（约每 20 次发送触发一次），避免表无限增长
  if (Math.random() < 0.05) {
    purgeExpired(env).catch(() => {});
  }

  const { code } = await issueCode(env, { emailNorm: email, purpose, ipHash, ttlSec: CODE_TTL_SEC });

  const mail = verifyCode(env, {
    code,
    purpose,
    minutes: Math.round(CODE_TTL_SEC / 60),
  });

  const result = await sendMail(env, { to: email, subject: mail.subject, text: mail.text, html: mail.html, template: 'verifyCode' });

  if (result.status === 'failed') {
    console.error('[send-code] 邮件发送失败', result.error);
    return fail('email_failed', '验证码邮件发送失败，请稍后再试或联系管理员', 502);
  }

  const prod = isProduction(request, env);
  return ok({
    sent: true,
    message: GENERIC_OK_MESSAGE,
    purposeLabel: PURPOSE_LABEL[purpose],
    simulated: result.status === 'simulated',
    cooldownSec: 60,
    // 仅在「非生产 + 模拟发送」时回显验证码，方便本地端到端测试
    devCode: !prod && result.status === 'simulated' ? code : undefined,
  });
}
