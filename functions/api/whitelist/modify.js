/* ============================================================
   POST /api/whitelist/modify
   提交白名单信息修改申请（QQ / Discord / IGN）
   - 前置：当前生效 IGN + 邮箱 + 六位数验证码（ticket kind=modify）
   - 修改理由必填
   - 提交后进入待人工审核，不改变当前白名单状态
   - 字段语义：留空 = 不修改；清空 QQ / Discord 必须显式传 clearQq / clearDiscord=true
     （详见下方 hasNewQq 附近的注释）
   ============================================================ */

import { clientIp, fail, ok, readJson, sameOriginStrict, str } from '../../_lib/http.js';
import { FACTOR_LABEL, normCode, normDiscord, normEmail, normIgn, normQq, normReason } from '../../_lib/validation.js';
import { consumeCode, consumeTicket, failTicketAttempt, readTicket } from '../../_lib/codes.js';
import { buckets, hit } from '../../_lib/ratelimit.js';
import { verifyTurnstile } from '../../_lib/turnstile.js';
import { checkBlacklist } from '../../_lib/blacklist.js';
import { duplicateHintMode, isProduction, pepper } from '../../_lib/env.js';
import { audit, ipFingerprint } from '../../_lib/audit.js';
import { dbOne, dbRun, nowIso, uniqueRef } from '../../_lib/db.js';
import { sendMail } from '../../_lib/email.js';
import { genericDuplicateMessage, modificationSubmitted } from '../../_lib/templates.js';

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
  const rl = await hit(env, buckets.modifyIp(ipHash), 12, 600);
  if (!rl.ok) return fail('rate_limited', '提交过于频繁，请稍后再试', 429);

  // 先读取票据（不作废），全部校验通过后再作废
  const ticket = await readTicket(env, str(body.ticket, 64), 'modify', false);
  if (!ticket) return fail('ticket_invalid', '邮箱验证已失效，请重新完成邮箱验证', 401);

  // 业务校验失败也计次，防止用一张票据反复探测
  const deny = async (code, message, status = 400, extra = undefined) => {
    const r = await failTicketAttempt(env, ticket);
    if (!r.ok) {
      return fail('ticket_invalid', '尝试次数过多，邮箱验证已失效，请重新完成邮箱验证', 401);
    }
    return fail(code, message, status, extra);
  };

  const app = await dbOne(env, `SELECT * FROM applications WHERE id = ?`, [ticket.application_id]);
  if (!app) return fail('not_found', '未找到对应的申请记录', 404);
  if (app.status === 'rejected') return deny('not_modifiable', '该申请已被拒绝，无法修改', 403);

  /**
   * 辅助验证锁定：本次用哪一项完成验证，该项就不能改。
   * 例：用游戏 ID 验证 → 本次不能改游戏 ID；要改游戏 ID 就得改用 QQ 或 Discord 验证。
   * 这样"邮箱 + 一项已知信息"只能换来"另一项未知信息的修改权"，
   * 避免有人拿到邮箱验证码后把整条记录的联系方式一次性改光。
   */
  const isTrue = (v) => v === true || v === 1 || v === '1' || v === 'true';
  const locked = ticket.verify_factor || '';
  const wantIgn = String(body.newIgn || '').trim() !== '';
  const wantQq = String(body.newQq || '').trim() !== '' || isTrue(body.clearQq);
  const wantDiscord = String(body.newDiscord || '').trim() !== '' || isTrue(body.clearDiscord);
  const lockedLabel = FACTOR_LABEL[locked] || locked;

  if (locked && locked === 'ign' && wantIgn) {
    return deny(
      'factor_locked',
      `你本次使用「${lockedLabel}」完成验证，因此不能修改${lockedLabel}。请返回上一步，改用 QQ 或 Discord 作为辅助验证方式。`,
      403,
      { lockedFactor: locked }
    );
  }
  if (locked && locked === 'qq' && wantQq) {
    return deny(
      'factor_locked',
      `你本次使用「${lockedLabel}」完成验证，因此不能修改${lockedLabel}。请返回上一步，改用游戏 ID 或 Discord 作为辅助验证方式。`,
      403,
      { lockedFactor: locked }
    );
  }
  if (locked && locked === 'discord' && wantDiscord) {
    return deny(
      'factor_locked',
      `你本次使用「${lockedLabel}」完成验证，因此不能修改${lockedLabel}。请返回上一步，改用游戏 ID 或 QQ 作为辅助验证方式。`,
      403,
      { lockedFactor: locked }
    );
  }

  // 黑名单（修改同样校验）
  const bl = await checkBlacklist(env, app.email_norm);
  if (bl.blocked) return deny('blacklisted_email', bl.reason || '该邮箱已被限制', 403);

  const hasNewIgn = String(body.newIgn || '').trim() !== '';
  const hasNewQq = String(body.newQq || '').trim() !== '';
  const hasNewDiscord = String(body.newDiscord || '').trim() !== '';

  /**
   * 字段语义（重要，前后端必须一致）：
   *   new_ign / new_qq / new_discord = null → 该项「不修改」（表单留空）
   *   new_qq / new_discord = ''            → 清空该项（必须显式勾选 clearQq / clearDiscord）
   *   其余值                                → 改为新值
   * 为什么清空需要显式标志：如果「留空即清空」，用户只想改 IGN 时顺手留空 QQ
   * 就会把联系方式弄丢；而早期实现是「留空 = 不变」，导致清空请求存得进去、
   * 审核时却被回退成原值，改了个寂寞。现在两种语义用 null / '' 明确区分。
   * 游戏 ID（IGN）不允许清空，只能改成另一个合法 ID。
   */
  const clearQq = isTrue(body.clearQq);
  const clearDiscord = isTrue(body.clearDiscord);

  if (hasNewQq && clearQq) return deny('bad_request', 'QQ 号不能同时填写新值并勾选「清空」');
  if (hasNewDiscord && clearDiscord) return deny('bad_request', 'Discord 不能同时填写新值并勾选「清空」');

  let newIgn = null; // null = 不修改
  let newQq = null;
  let newDiscord = null;

  if (hasNewIgn) {
    const v = normIgn(body.newIgn);
    if (!v.ok) return deny('invalid_ign', v.message);
    newIgn = v.value;
  }
  if (hasNewQq) {
    const v = normQq(body.newQq);
    if (!v.ok) return deny('invalid_qq', v.message);
    newQq = v.value;
  } else if (clearQq) {
    newQq = ''; // 空串 = 清空
  }
  if (hasNewDiscord) {
    const v = normDiscord(body.newDiscord);
    if (!v.ok) return deny('invalid_discord', v.message);
    newDiscord = v.value;
  } else if (clearDiscord) {
    newDiscord = '';
  }

  // 修改后的结果不能把 QQ 与 Discord 同时清空（至少要保留一个联系方式）
  const finalQqPreview = newQq === null ? app.qq || '' : newQq;
  const finalDiscordPreview = newDiscord === null ? app.discord || '' : newDiscord;
  if (!finalQqPreview && !finalDiscordPreview) {
    return deny('contact_required', 'QQ 与 Discord 不能同时为空，请至少保留一个联系方式');
  }

  // 冲突提示（提前定义：更换邮箱的查重也要用）
  const hintMode = duplicateHintMode(env);
  const dupFail = (field, message, reference) => {
    if (hintMode === 'detailed') return deny('duplicate_' + field, message, 409, { reference });
    return deny('duplicate_field', genericDuplicateMessage(env), 409);
  };

  /**
   * 更换绑定邮箱（可选）：
   * - 主身份仍由「当前邮箱验证码 + 辅助验证」保证（ticket）
   * - 新邮箱必须独立完成一次验证码验证，证明控制权
   * - 新邮箱也要过黑名单；是否撞到别人的记录在这里查
   *   （放在提交阶段而不是发码阶段，避免用返回值探测某邮箱是否被注册）
   */
  const wantEmail = String(body.newEmail || '').trim() !== '';
  let newEmail = null; // null = 不修改邮箱
  let pendingNewEmail = '';    // 待消耗的新邮箱
  let pendingNewEmailCode = '';// 待消耗的新邮箱验证码

  if (wantEmail) {
    const ev = normEmail(body.newEmail);
    if (!ev.ok) return deny('invalid_email', ev.message);
    if (ev.value === String(app.email_norm).toLowerCase()) {
      return deny('no_change', '新邮箱与当前绑定的邮箱相同，无需修改');
    }

    const codeV2 = normCode(body.newEmailCode);
    if (!codeV2.ok) return deny('invalid_code', '请先完成新邮箱的验证码验证');

    const blNew = await checkBlacklist(env, ev.value);
    if (blNew.blocked) return deny('blacklisted_email', blNew.reason || '该邮箱不可用于白名单', 403);

    const dupEmail = await dbOne(
      env,
      `SELECT reference FROM applications WHERE email_norm = ? AND id != ? AND status IN ${ACTIVE} LIMIT 1`,
      [ev.value, app.id]
    );
    if (dupEmail) return dupFail('email', '该邮箱已被其它待审核或已通过的申请使用', dupEmail.reference);

    /**
     * 注意：这里**不立刻消耗**新邮箱的验证码，只暂存。
     * 早期实现在这里就 consumeCode，于是「修改理由太短」「人机验证没勾」
     * 这类低级错误也会把验证码烧掉，用户得重发一次邮件、再等 60 秒冷却。
     * 改成全部校验通过后才消耗（见下方 consumeNewEmailCode）。
     */
    pendingNewEmail = ev.value;
    pendingNewEmailCode = codeV2.value;
  }

  const reasonV = normReason(body.reason, '修改理由');
  if (!reasonV.ok) return deny('invalid_reason', reasonV.message);

  const emailChanged = !!pendingNewEmail;
  const ignChanged = newIgn !== null && newIgn.toLowerCase() !== String(app.ign_norm).toLowerCase();
  const qqChanged = newQq !== null && newQq !== (app.qq || '');
  const discordChanged = newDiscord !== null && newDiscord !== (app.discord || '');

  if (!ignChanged && !qqChanged && !discordChanged && !emailChanged) {
    return deny('no_change', '没有检测到任何变更。可修改 QQ / Discord / 游戏 ID / 绑定邮箱，或勾选「清空」后再提交', 400);
  }

  /**
   * 人机验证失败也计入票据失败次数：
   * AGENTS.md 约定「任何业务校验失败都要计次」，否则攻击者可以拿一张票据
   * 反复提交、拿返回值做字段探测（只要每次都故意不勾人机验证）。
   */
  const ts = await verifyTurnstile(env, request, str(body.turnstileToken, 4096));
  if (!ts.ok) return deny(ts.error || 'turnstile_failed', ts.message || '人机验证未通过', 400);

  if (newIgn) {
    const dup = await dbOne(env, `SELECT reference FROM applications WHERE ign_norm = ? AND id != ? AND status IN ${ACTIVE} LIMIT 1`, [newIgn.toLowerCase(), app.id]);
    if (dup) return dupFail('ign', '该游戏 ID 已被其它待审核或已通过的申请占用', dup.reference);
  }
  if (newQq) {
    const dup = await dbOne(env, `SELECT reference FROM applications WHERE qq_norm = ? AND id != ? AND status IN ${ACTIVE} LIMIT 1`, [newQq, app.id]);
    if (dup) return dupFail('qq', '该 QQ 号已被其它待审核或已通过的申请占用', dup.reference);
  }
  if (newDiscord) {
    const dup = await dbOne(env, `SELECT reference FROM applications WHERE discord_norm = ? AND id != ? AND status IN ${ACTIVE} LIMIT 1`, [newDiscord.toLowerCase(), app.id]);
    if (dup) return dupFail('discord', '该 Discord 已被其它待审核或已通过的申请占用', dup.reference);
  }

  /**
   * 全部校验（理由、人机验证、各项冲突）都通过之后，才消耗新邮箱的验证码。
   * 这样前面任何一步填错都不会浪费用户刚收到的那封邮件。
   */
  if (pendingNewEmail) {
    const v2 = await consumeCode(env, {
      emailNorm: pendingNewEmail,
      purpose: 'change_email',
      code: pendingNewEmailCode,
    });
    /**
     * 这里必须走 deny() 而不是 fail()：
     * AGENTS.md 约定「任何业务校验失败都要计次」，否则攻击者可以拿一张
     * 主票据反复提交、用返回值去试新邮箱的验证码，且不受 5 次作废约束。
     * consumeCode 自身的 5 次限制只保护「单个验证码」，不消耗主票据。
     */
    if (!v2.ok) return deny(v2.code, v2.message, 400, { remaining: v2.remaining });
    newEmail = pendingNewEmail;
  }

  const now = nowIso();
  const reference = await uniqueRef(env, 'modification_requests', 'MR');

  await dbRun(
    env,
    `INSERT INTO modification_requests
      (reference, application_id, email_norm, prev_qq, prev_discord, prev_ign,
       new_qq, new_discord, new_ign, ign_changed, reason, verify_factor,
       prev_email, new_email, email_changed,
       email_verified_at, turnstile_ok, status, request_ip_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?)`,
    [
      reference,
      app.id,
      app.email_norm,
      app.qq || null,
      app.discord || null,
      app.ign,
      newQq,
      newDiscord,
      newIgn,
      ignChanged ? 1 : 0,
      reasonV.value,
      locked || null,
      app.email_norm,
      newEmail,
      emailChanged ? 1 : 0,
      now,
      ts.ok ? 1 : 0,
      ipHash,
      now,
      now,
    ]
  );

  // 写入成功后作废票据
  await consumeTicket(env, ticket.id);

  await audit(env, {
    actor: `visitor:${String(app.email_norm).slice(0, 3)}***`,
    action: 'modification.created',
    objectType: 'application',
    objectId: String(app.id),
    note: `提交修改申请 ${reference}`,
    detail: { reference, ignChanged, qqChanged, discordChanged, emailChanged, turnstile: ts.ok, verifyFactor: locked || '' },
    ipHash,
  });

  const changes = [];
  if (emailChanged) changes.push({ label: '绑定邮箱', prev: app.email_norm, next: newEmail });
  if (ignChanged) changes.push({ label: '游戏 ID', prev: app.ign, next: newIgn });
  if (qqChanged) changes.push({ label: 'QQ', prev: app.qq || '', next: newQq === '' ? '（清空）' : newQq });
  if (discordChanged) changes.push({ label: 'Discord', prev: app.discord || '', next: newDiscord === '' ? '（清空）' : newDiscord });

  const mail = modificationSubmitted(env, { reference, ign: app.ign, changes });
  /**
   * 提交确认信的收件人：
   * 换绑邮箱的常见原因就是旧邮箱停用，只发旧邮箱的话用户根本收不到。
   * 所以换绑时两个邮箱都发一份——旧邮箱作为「变更告知」，新邮箱作为「后续联系方式」。
   * 不换绑时保持原样，只发当前邮箱。
   */
  await sendMail(env, { to: app.email_norm, subject: mail.subject, text: mail.text, html: mail.html, template: 'modificationSubmitted' });
  if (emailChanged && newEmail && newEmail !== app.email_norm) {
    await sendMail(env, { to: newEmail, subject: mail.subject, text: mail.text, html: mail.html, template: 'modificationSubmitted' });
  }

  return ok({
    reference,
    status: 'pending_review',
    lockedFactor: locked || '',
    emailChanged: emailChanged,
    message: '修改申请已提交，等待人工审核。审核通过前当前白名单信息保持不变。',
    changes: changes.map((c) => ({ label: c.label, from: c.prev || '', to: c.next || '' })),
  });
}
