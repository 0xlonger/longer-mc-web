/* ============================================================
   POST /api/whitelist/apply
   提交新的白名单申请
   前置：邮箱验证码已通过（有效 ticket，kind=apply）
   ============================================================ */

import { clientIp, fail, ok, readJson, sameOriginStrict, str } from '../../_lib/http.js';
import { normDiscord, normIgn, normQq } from '../../_lib/validation.js';
import { consumeTicket, failTicketAttempt, readTicket } from '../../_lib/codes.js';
import { buckets, hit } from '../../_lib/ratelimit.js';
import { verifyTurnstile } from '../../_lib/turnstile.js';
import { checkBlacklist } from '../../_lib/blacklist.js';
import { duplicateHintMode, isProduction, pepper } from '../../_lib/env.js';
import { ipFingerprint, audit } from '../../_lib/audit.js';
import { dbOne, dbRun, nowIso, uniqueRef } from '../../_lib/db.js';
import { sendMail } from '../../_lib/email.js';
import { applicationSubmitted, genericDuplicateMessage } from '../../_lib/templates.js';

const ACTIVE = "('pending_review','approved')";

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!sameOriginStrict(request)) return fail('bad_origin', '来源校验失败', 403);

  const body = await readJson(request);
  if (!body) return fail('bad_request', '请求格式错误');

  const p = pepper(env);
  if (p.devFallback && isProduction(request, env)) {
    return fail('server_misconfigured', '服务端缺少 CODE_PEPPER 配置，请联系管理员', 500);
  }

  const ipHash = await ipFingerprint(env, clientIp(request), p.value);
  // 12 次 / 10 分钟（独立桶，不与 modify 共用）。
  // 本接口能触发「重复检查」，是探测风险最高的写接口；
  // 但真正的防线是每个邮箱的发送冷却 + 每小时上限，以及票据的 5 次失败作废。
  const rl = await hit(env, buckets.applyIp(ipHash), 12, 600);
  if (!rl.ok) return fail('rate_limited', '提交过于频繁，请稍后再试', 429);

  // 先读取票据（不作废），字段校验全部通过后才作废
  const ticket = await readTicket(env, str(body.ticket, 64), 'apply', false);
  if (!ticket) return fail('ticket_invalid', '邮箱验证已失效，请重新完成邮箱验证', 401);

  /**
   * 任何「业务校验失败」都要记一次票据失败次数，超过上限直接作废票据。
   * 否则一张票据在有效期内可以被无限次使用，配合重复检查的返回值
   * 就能反复探测「某个 IGN / QQ / Discord / 邮箱是否已被申请过」。
   */
  const deny = async (code, message, status = 400, extra = undefined) => {
    const r = await failTicketAttempt(env, ticket);
    if (!r.ok) {
      return fail('ticket_invalid', '尝试次数过多，邮箱验证已失效，请重新完成邮箱验证', 401);
    }
    return fail(code, message, status, extra);
  };

  const email = ticket.email_norm;

  // 保留用户填写的原始大小写用于展示（email_norm 始终为小写规范化值）
  // 仅当页面传回的邮箱与票据中的邮箱「忽略大小写后一致」时才采用，避免张冠李戴
  const rawEmail = str(body.email, 254);
  const displayEmail =
    rawEmail && rawEmail.toLowerCase() === email ? rawEmail : email;

  const ignV = normIgn(body.ign);
  if (!ignV.ok) return deny('invalid_ign', ignV.message);
  const ign = ignV.value;

  const qqV = normQq(body.qq);
  if (!qqV.ok) return deny('invalid_qq', qqV.message);
  const qq = qqV.value;

  const discordV = normDiscord(body.discord);
  if (!discordV.ok) return deny('invalid_discord', discordV.message);
  const discord = discordV.value;

  if (!qq && !discord) return deny('contact_required', 'QQ 号和 Discord 至少需要填写其中一个');

  /**
   * 人机验证失败也计入票据失败次数：
   * AGENTS.md 约定「任何业务校验失败都要计次」，否则攻击者可以拿一张票据
   * 反复提交、拿返回值做字段探测（只要每次都故意不勾人机验证）。
   */
  const ts = await verifyTurnstile(env, request, str(body.turnstileToken, 4096));
  if (!ts.ok) return deny(ts.error || 'turnstile_failed', ts.message || '人机验证未通过', 400);

  // 黑名单（申请与修改都要校验）
  const bl = await checkBlacklist(env, email);
  if (bl.blocked) return deny('blacklisted_email', bl.reason || '该邮箱不可用于白名单申请', 403);

  /**
   * 防重复：邮箱 / IGN / QQ / Discord 已存在待审核或已通过记录。
   *
   * 提示粒度由 DUPLICATE_HINT_MODE 决定，默认 generic：
   * 不区分是哪个字段冲突、也不返回对方的申请编号——否则任何人只要给自己
   * 邮箱发一次验证码，就能拿这张票据去探测别人的 IGN / QQ / Discord 是否被申请过。
   * 需要字段级提示时设 DUPLICATE_HINT_MODE=detailed（见 .dev.vars.example）。
   */
  const hintMode = duplicateHintMode(env);
  const dupFail = (field, message, reference) => {
    if (hintMode === 'detailed') {
      return deny('duplicate_' + field, message, 409, { reference });
    }
    return deny('duplicate_field', genericDuplicateMessage(env), 409);
  };

  const dupEmail = await dbOne(env, `SELECT reference, status FROM applications WHERE email_norm = ? AND status IN ${ACTIVE} LIMIT 1`, [email]);
  if (dupEmail) return dupFail('email', '该邮箱已存在待审核或已通过的申请', dupEmail.reference);

  const dupIgn = await dbOne(env, `SELECT reference, status FROM applications WHERE ign_norm = ? AND status IN ${ACTIVE} LIMIT 1`, [ign.toLowerCase()]);
  if (dupIgn) return dupFail('ign', '该游戏 ID 已存在待审核或已通过的申请', dupIgn.reference);

  if (qq) {
    const dupQq = await dbOne(env, `SELECT reference FROM applications WHERE qq_norm = ? AND status IN ${ACTIVE} LIMIT 1`, [qq]);
    if (dupQq) return dupFail('qq', '该 QQ 号已存在待审核或已通过的申请', dupQq.reference);
  }
  if (discord) {
    const dupDc = await dbOne(env, `SELECT reference FROM applications WHERE discord_norm = ? AND status IN ${ACTIVE} LIMIT 1`, [discord.toLowerCase()]);
    if (dupDc) return dupFail('discord', '该 Discord 已存在待审核或已通过的申请', dupDc.reference);
  }

  const now = nowIso();
  const reference = await uniqueRef(env, 'applications', 'WL');

  let appId = null;
  try {
    const res = await dbRun(
    env,
    `INSERT INTO applications
      (reference, email, email_norm, qq, qq_norm, discord, discord_norm, ign, ign_norm,
       email_verified_at, turnstile_ok, turnstile_checked_at, status,
       submit_ip_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?)`,
    [
      reference,
      displayEmail,
      email,
      qq || null,
      qq || null,
      discord || null,
      discord ? discord.toLowerCase() : null,
      ign,
      ign.toLowerCase(),
      now,
      ts.ok ? 1 : 0,
      now,
      ipHash,
      now,
      now,
    ]
  );

    appId = (res && res.meta && res.meta.last_row_id) || null;

  // 写入成功后作废票据，保证一张票据只能提交一次
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/UNIQUE constraint failed/i.test(msg)) {
      return deny('duplicate_field', genericDuplicateMessage(env), 409);
    }
    throw e;
  }

  await consumeTicket(env, ticket.id);

  await audit(env, {
    actor: `visitor:${email.slice(0, 3)}***`,
    action: 'application.created',
    objectType: 'application',
    objectId: String(appId || reference),
    note: '提交新申请',
    detail: { reference, ign, hasQq: !!qq, hasDiscord: !!discord, turnstile: ts.ok, simulated: !!ts.simulated },
    ipHash,
  });

  const mail = applicationSubmitted(env, { reference, ign });
  await sendMail(env, { to: email, subject: mail.subject, text: mail.text, html: mail.html, template: 'applicationSubmitted' });

  return ok({ reference, status: 'pending_review', message: '申请已提交，请等待人工审核。申请编号已发送至你的邮箱。' });
}
