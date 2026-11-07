/* ============================================================
   POST /api/whitelist/verify-code
   校验六位数邮箱验证码，通过后签发短期票据（ticket）
   - 验证码一次性、10 分钟有效、失败次数超限作废
   - apply  ：票据用于最终提交申请
   - inquire：票据用于查询申请状态
   - modify ：票据用于提交修改申请，同时返回当前信息供表单预填
   ============================================================ */

import { clientIp, fail, ok, readJson, sameOriginStrict, str } from '../../_lib/http.js';
import { FACTOR_LABEL, factorNormKey, normCode, normEmail, normFactor, normFactorValue, normPurpose } from '../../_lib/validation.js';
import { APPLY_TICKET_TTL_SEC, TICKET_TTL_SEC, consumeCode, issueTicket } from '../../_lib/codes.js';
import { buckets, hit } from '../../_lib/ratelimit.js';
import { verifyTurnstile } from '../../_lib/turnstile.js';
import { isProduction, pepper } from '../../_lib/env.js';
import { ipFingerprint } from '../../_lib/audit.js';
import { dbAll, dbOne } from '../../_lib/db.js';

/**
 * 「信息不匹配 / 验证码不正确」的统一响应形态。
 *
 * 为什么要完全一致（连状态码和错误码都一样）：
 * 早期实现在验证码「还没校验」时就先查记录，找到就往下走、找不到就返回
 * 404 not_found——于是攻击者根本不需要收到验证码，只要过一次 Turnstile，
 * 就能用返回值判断「某邮箱 + 某个 IGN / QQ / Discord 是不是一条申请记录」。
 * 文案统一了没用，404 与 400 的差别已经把答案说出来了。
 *
 * 现在：没有有效验证码的人，无论记录是否存在，拿到的都是同一个 400。
 */
export const NOT_MATCH_CODE = 'code_invalid';
export const NOT_MATCH_MESSAGE = '验证码不正确或信息不匹配，请确认后重试。';
export const NOT_MATCH_STATUS = 400;

/** 记录不存在：返回与「验证码不正确」完全同形的响应，且不消耗验证码 */
function notMatch() {
  return fail(NOT_MATCH_CODE, NOT_MATCH_MESSAGE, NOT_MATCH_STATUS);
}

/**
 * 查询场景：只按邮箱定位记录（不再要求填游戏 ID）。
 *
 * 安全性：邮箱验证码已经证明了「请求者控制着这个邮箱」，
 * 再要求填 IGN 只是增加一道无意义的摩擦——反而让记不清 ID 的用户查不了。
 *
 * 由于 email_norm 上有「待审核 + 已通过」的部分唯一索引，
 * 一个邮箱最多只有一条有效记录；历史被拒记录可能有多条，
 * 所以这里优先取待审核 / 已通过的那条。
 */
async function findApplicationByEmail(env, emailNorm) {
  const rows = await dbAll(
    env,
    `SELECT * FROM applications WHERE email_norm = ? ORDER BY id DESC LIMIT 20`,
    [emailNorm]
  );
  if (!rows.length) return null;
  const active = rows.find((r) => r.status === 'approved' || r.status === 'pending_review');
  return active || rows[0];
}

/**
 * 按「邮箱 + 辅助验证因子」找到当前生效的那条申请。
 * 因子可以是游戏 ID / QQ / Discord 中的任意一项，
 * 系统只负责比对这一项是否与记录里绑定的一致。
 * 选不出记录时返回 null（调用方统一按「信息不匹配」处理，不泄露是否存在）。
 */
async function findApplicationByFactor(env, emailNorm, factor, value) {
  const key = factorNormKey(factor, value);
  if (!key) return null;
  const column = factor === 'ign' ? 'ign_norm' : factor === 'qq' ? 'qq_norm' : 'discord_norm';
  const rows = await dbAll(
    env,
    `SELECT * FROM applications WHERE email_norm = ? AND ${column} = ? ORDER BY id DESC LIMIT 20`,
    [emailNorm, key]
  );
  if (!rows.length) return null;
  const active = rows.find((r) => r.status === 'approved' || r.status === 'pending_review');
  return active || rows[0];
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!sameOriginStrict(request)) return fail('bad_origin', '来源校验失败', 403);

  const body = await readJson(request);
  if (!body) return fail('bad_request', '请求格式错误');

  const purposeV = normPurpose(body.purpose);
  if (!purposeV.ok) return fail('bad_purpose', purposeV.message);
  const purpose = purposeV.value;

  /**
   * change_email 的验证码由 modify 接口在提交时直接消费，
   * 不走「换票」这条路。在这里签发只会白产生一张没人用的票据。
   */
  if (purpose === 'change_email') {
    return fail('bad_purpose', '该用途不需要换取票据，请直接提交修改申请');
  }

  const emailV = normEmail(body.email);
  if (!emailV.ok) return fail('invalid_email', emailV.message);
  const email = emailV.value;

  const codeV = normCode(body.code);
  if (!codeV.ok) return fail('invalid_code', codeV.message);

  let factor = '';
  let factorValue = '';

  // inquire：只验证邮箱，不再要求填游戏 ID（见 findApplicationByEmail 的说明）
  if (purpose === 'modify') {
    const f = normFactor(body.factor);
    if (!f.ok) return fail('invalid_factor', f.message);
    const fv = normFactorValue(f.value, body.factorValue !== undefined ? body.factorValue : body.ign);
    if (!fv.ok) return fail('invalid_factor_value', fv.message);
    factor = f.value;
    factorValue = fv.value;
  }

  const ts = await verifyTurnstile(env, request, str(body.turnstileToken, 4096));
  if (!ts.ok) return fail(ts.error || 'turnstile_failed', ts.message || '人机验证未通过', 400);

  const p = pepper(env);
  if (p.devFallback && isProduction(request, env)) {
    return fail('server_misconfigured', '服务端缺少 CODE_PEPPER 配置，请联系管理员', 500);
  }

  const ipHash = await ipFingerprint(env, clientIp(request), p.value);
  const emailHash = await ipFingerprint(env, `e:${email}`, p.value);

  const rlEmail = await hit(env, buckets.verify(emailHash, purpose), 12, 600);
  if (!rlEmail.ok) return fail('rate_limited', '验证尝试过于频繁，请稍后再试', 429);
  const rlIp = await hit(env, buckets.verifyIp(ipHash), 40, 600);
  if (!rlIp.ok) return fail('rate_limited', '请求过于频繁，请稍后再试', 429);

  /* ---------------- apply：只验证邮箱，票据用于提交申请 ---------------- */
  if (purpose === 'apply') {
    const verified = await consumeCode(env, { emailNorm: email, purpose, code: codeV.value });
    if (!verified.ok) return fail(verified.code, verified.message, 400, { remaining: verified.remaining });

    const ticket = await issueTicket(env, {
      kind: 'apply',
      emailNorm: email,
      ttlSec: APPLY_TICKET_TTL_SEC,
    });
    return ok({ ticket, purpose, expiresIn: APPLY_TICKET_TTL_SEC });
  }

  /* ---------------- inquire / modify：需要先匹配到申请记录 ---------------- */
  /**
   * 顺序很关键：先查记录，但**找不到时不消耗验证码**（用户填错一个字不至于
   * 白烧一封邮件、还要再等 60 秒冷却）；同时返回与「验证码不正确」完全同形的
   * 响应，不给探测者任何区分依据。
   */
  const app =
    purpose === 'modify'
      ? await findApplicationByFactor(env, email, factor, factorValue)
      : await findApplicationByEmail(env, email);
  if (!app) return notMatch();

  /**
   * 下面这些「记录存在但状态不允许」的判断，必须放在 consumeCode **之后**。
   * 如果放在前面：记录不存在返回 400、已拒绝返回 403、有待审修改返回 409，
   * 三种状态码就等于在回答「这条记录存不存在、是什么状态」。
   * 放在验证码校验之后，能走到这里的人都已证明了对邮箱的控制权，
   * 此时再说明具体原因才是安全的（也更有用）。
   */
  /**
   * 验证码校验失败也必须与「记录不存在」完全同形。
   *
   * 早期这里返回的是 consumeCode 的原始结果：
   * 文案是「验证码不正确，还可尝试 4 次」，还多带一个 remaining 字段，
   * 过期 / 锁定时错误码还会变成 code_expired / code_locked。
   * 而「记录不存在」走的是 notMatch()（另一套文案、无 remaining）。
   * 于是只要过一次 Turnstile，就能用响应形状区分
   * 「这个邮箱有没有申请记录」——而且全程不需要真的发验证码邮件，
   * 受害者收不到任何通知，完全静默。
   *
   * 代价：用户看不到「还剩几次」的提示。这是防枚举该付的成本。
   */
  const verdict = await consumeCode(env, { emailNorm: email, purpose, code: codeV.value });
  if (!verdict.ok) return notMatch();

  if (purpose === 'modify') {
    if (app.status === 'rejected') {
      return fail('not_modifiable', '该申请已被拒绝，无法修改；请重新提交申请', 403);
    }
    const pending = await dbOne(
      env,
      `SELECT reference FROM modification_requests
       WHERE application_id = ? AND status = 'pending_review' ORDER BY id DESC LIMIT 1`,
      [app.id]
    );
    if (pending) {
      return fail('pending_exists', `你已有一个待审核的修改申请（${pending.reference}），请等待审核结果`, 409, {
        reference: pending.reference,
      });
    }
  }

  const ticket = await issueTicket(env, {
    kind: purpose,
    emailNorm: email,
    ignNorm: app.ign_norm || '',
    applicationId: app.id,
    ttlSec: TICKET_TTL_SEC,
    // modify：记住本次用的是哪一项辅助验证，该项本次不可修改
    verifyFactor: purpose === 'modify' ? factor : null,
  });

  if (purpose === 'inquire') {
    return ok({ ticket, purpose, expiresIn: TICKET_TTL_SEC });
  }

  // modify：返回当前值供表单预填（用户已通过邮箱验证码 + 一项辅助验证）
  return ok({
    ticket,
    purpose,
    expiresIn: TICKET_TTL_SEC,
    // 本次验证所用的因子；该项本次不可修改，要改请换另一项验证
    lockedFactor: factor,
    lockedFactorLabel: FACTOR_LABEL[factor] || factor,
    // 供前端判断「还有哪些项可以作为下次验证的身份凭证」
    boundFactors: {
      ign: !!app.ign,
      qq: !!app.qq,
      discord: !!app.discord,
    },
    current: {
      ign: app.ign,
      qq: app.qq || '',
      discord: app.discord || '',
      status: app.status,
    },
  });
}
