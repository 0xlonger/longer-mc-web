/* ============================================================
   管理后台 API（由 Cloudflare Access 保护 /admin*）
   GET    /admin/api/whitelist/me
   GET    /admin/api/whitelist/stats
   GET    /admin/api/whitelist/applications?status=&q=&limit=&offset=
   GET    /admin/api/whitelist/applications/:id
   POST   /admin/api/whitelist/applications/:id/approve      {note}
   POST   /admin/api/whitelist/applications/:id/reject       {reason}
   POST   /admin/api/whitelist/applications/:id/manual       {done,note}
   GET    /admin/api/whitelist/modifications?status=&q=
   GET    /admin/api/whitelist/modifications/:id
   POST   /admin/api/whitelist/modifications/:id/approve     {note}
   POST   /admin/api/whitelist/modifications/:id/reject      {reason}
   GET    /admin/api/whitelist/blacklist
   POST   /admin/api/whitelist/blacklist                     {rule,ruleType,reason,enabled}
   POST   /admin/api/whitelist/blacklist/:id/update          {rule?,reason?,enabled?}
   POST   /admin/api/whitelist/blacklist/:id/delete
   GET    /admin/api/whitelist/outbox?limit=
   GET    /admin/api/whitelist/audit?objectType=&objectId=
   ============================================================ */

import { clientIp, fail, ok, readJson, sameOrigin, sameOriginStrict, str } from '../../../_lib/http.js';
import { requireAdmin } from '../../../_lib/access.js';
import { audit, ipFingerprint, recentAudit } from '../../../_lib/audit.js';
import { validateRule } from '../../../_lib/blacklist.js';
import { dbAll, dbOne, dbRun, nowIso } from '../../../_lib/db.js';
import { cfg, pepper } from '../../../_lib/env.js';
import { buckets, hit } from '../../../_lib/ratelimit.js';
import { normNote, normReason } from '../../../_lib/validation.js';
import { sendMail } from '../../../_lib/email.js';
import {
  applicationApproved,
  applicationRejected,
  modificationApproved,
  modificationRejected,
} from '../../../_lib/templates.js';

const VANILLA_ADD = (ign) => `whitelist add ${ign}`;
const VANILLA_REMOVE = (ign) => `whitelist remove ${ign}`;

/** 「仍然有效」的申请状态，用于冲突检查 */
const ACTIVE = "('pending_review','approved')";

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = (request.method || 'GET').toUpperCase();

  /**
   * 与 functions/admin/_middleware.js 同款的「测试锁定」判断（双保险）。
   * middleware 本应覆盖整个 /admin*，但它是 Pages 平台特有的路由机制；
   * 万一某个 Pages 版本没识别到、或以后目录结构被调整，
   * 这里仍能保证所有后台 API 都被锁住，不泄露任何申请数据。
   * 必须与 middleware 用同一个严格判定（只认 '1'）。
   */
  if (cfg(env, 'ADMIN_LOCKDOWN_TEST', '') === '1') {
    return fail('admin_lockdown', '后台处于测试锁定状态，仅 /admin/test 可访问。配置完成请把 ADMIN_LOCKDOWN_TEST 设为 0。', 403);
  }

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { allow: 'GET, POST, OPTIONS' } });
  }

  const admin = await requireAdmin(request, env);
  if (!admin.ok) return fail(admin.code || 'unauthenticated', admin.message || '未授权', admin.status || 401);

  /**
   * 来源校验：GET 也校验，但强度按方法区分。
   * - 写操作（POST 等）用严格模式：既无 Origin 也无 Sec-Fetch-Site 的请求一律拒绝
   *   （早期实现在这种情况下直接放行，等于 curl 一条命令就能绕过）；
   * - 读操作（GET）用宽松模式：浏览器同源 GET 通常不带 Origin，必须放行，否则会误伤正常用户。
   *
   * 注意：这只是第二道防线，第一道永远是 Cloudflare Access（必须覆盖 /admin*，不能只写 /admin/）。
   */
  const writeMethod = request.method !== 'GET' && request.method !== 'HEAD';
  if (!(writeMethod ? sameOriginStrict(request) : sameOrigin(request))) {
    return fail('bad_origin', '来源校验失败', 403);
  }

  const url = new URL(request.url);
  const segs = url.pathname.replace(/^\/admin\/api\/whitelist\/?/, '').split('/').filter(Boolean);
  const actor = admin.actor;
  const ipHash = await ipFingerprint(env, clientIp(request), pepper(env).value);

  // 管理端也做一层限流（Access 之外的兜底）：300 次 / 10 分钟
  const rl = await hit(env, buckets.adminIp(ipHash), 300, 600);
  if (!rl.ok) return fail('rate_limited', '操作过于频繁，请稍后再试', 429);

  try {
    return await route({ env, method, segs, url, actor, ipHash, request });
  } catch (e) {
    console.error('[admin api] 处理失败', e);
    return fail('server_error', '服务端处理失败，请查看 Functions 日志', 500);
  }
}

async function route({ env, method, segs, url, actor, ipHash, request }) {
  const [head, second, third] = segs;

  /* ---------------- 当前管理员 ---------------- */
  if (!head && method === 'GET') {
    return ok({ actor, dev: false, mode: 'access' });
  }
  if (head === 'me' && method === 'GET') {
    return ok({ actor });
  }

  /* ---------------- 概览统计 ---------------- */
  if (head === 'stats' && method === 'GET') {
    const q = async (sql, params = []) => {
      const r = await dbOne(env, sql, params);
      return r ? Object.values(r)[0] : 0;
    };
    const stats = {
      pendingApplications: await q(`SELECT COUNT(*) FROM applications WHERE status = 'pending_review'`),
      pendingModifications: await q(`SELECT COUNT(*) FROM modification_requests WHERE status = 'pending_review'`),
      approved: await q(`SELECT COUNT(*) FROM applications WHERE status = 'approved'`),
      rejected: await q(`SELECT COUNT(*) FROM applications WHERE status = 'rejected'`),
      manualPending: await q(`SELECT COUNT(*) FROM applications WHERE status = 'approved' AND (manual_whitelisted_at IS NULL OR manual_whitelisted_at = '')`),
      blacklistRules: await q(`SELECT COUNT(*) FROM blacklisted_emails WHERE enabled = 1`),
    };
    return ok({ stats });
  }

  /* ---------------- 申请列表 ---------------- */
  if (head === 'applications' && !second && method === 'GET') {
    const status = (url.searchParams.get('status') || 'all').trim();
    const kw = (url.searchParams.get('q') || '').trim().slice(0, 60);
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);

    const where = [];
    const params = [];
    if (status === 'pending_review' || status === 'approved' || status === 'rejected') {
      where.push(`status = ?`);
      params.push(status);
    } else if (status === 'manual_pending') {
      where.push(`status = 'approved' AND (manual_whitelisted_at IS NULL OR manual_whitelisted_at = '')`);
    }
    if (kw) {
      where.push(`(reference LIKE ? OR ign LIKE ? OR email_norm LIKE ? OR IFNULL(qq,'') LIKE ? OR IFNULL(discord,'') LIKE ?)`);
      const like = `%${kw}%`;
      params.push(like, like, like, like, like);
    }
    const sql = `SELECT * FROM applications ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY id DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const items = await dbAll(env, sql, params);
    const totalRow = await dbOne(
      env,
      `SELECT COUNT(*) AS c FROM applications ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
      params.slice(0, where.length ? params.length - 2 : 0)
    );
    return ok({ items, total: totalRow ? totalRow.c : items.length, limit, offset });
  }

  /* ---------------- 申请详情 ---------------- */
  if (head === 'applications' && second && !third && method === 'GET') {
    const id = parseInt(second, 10);
    const app = await dbOne(env, `SELECT * FROM applications WHERE id = ?`, [id]);
    if (!app) return fail('not_found', '记录不存在', 404);
    const logs = await recentAudit(env, 'application', String(id), 100);
    const mods = await dbAll(env, `SELECT * FROM modification_requests WHERE application_id = ? ORDER BY id DESC`, [id]);
    return ok({ application: app, auditLogs: logs, modifications: mods, vanillaCommand: VANILLA_ADD(app.ign) });
  }

  /* ---------------- 申请：通过 ---------------- */
  if (head === 'applications' && third === 'approve' && method === 'POST') {
    const body = (await readJson(request)) || {};
    const id = parseInt(second, 10);
    const app = await dbOne(env, `SELECT * FROM applications WHERE id = ?`, [id]);
    if (!app) return fail('not_found', '记录不存在', 404);

    // 幂等：已经是通过状态就别再点一次，否则会重复写审计日志、重复发邮件
    if (app.status === 'approved') {
      return fail('already_reviewed', '该申请已是「已通过」状态，无需重复通过', 409, {
        status: app.status,
        reviewedBy: app.reviewed_by || '',
        reviewedAt: app.reviewed_at || '',
      });
    }

    const noteV = normNote(body.note);
    if (!noteV.ok) return fail('invalid_note', noteV.message);

    /**
     * 改判通过前必须重跑冲突检查。
     *
     * 为什么这里需要、而新建申请时不需要：
     * 0003 的「有效申请」唯一索引只覆盖 pending_review / approved，
     * 一条被拒绝的记录可以和另一条有效记录共用同一个 IGN / 邮箱（插入时不冲突）。
     * 一旦把这条被拒绝的记录改判为 approved，UPDATE 就会撞上唯一索引抛错，
     * 被外层 catch 吞成 500「服务端处理失败」——管理员既改判不了，也看不出原因。
     *
     * 修改申请的 approve 分支早就做了这一步，这里是补上遗漏。
     */
    const dupOf = async (col, val, code, msg) => {
      if (!val) return null;
      const d = await dbOne(
        env,
        `SELECT reference FROM applications WHERE ${col} = ? AND id != ? AND status IN ${ACTIVE} LIMIT 1`,
        [val, app.id]
      );
      return d
        ? fail(code, `${msg}（占用方：${d.reference}），请先处理冲突再改判`, 409, { reference: d.reference })
        : null;
    };

    for (const r of [
      await dupOf('ign_norm', app.ign_norm, 'duplicate_ign', '该游戏 ID 已被其它待审核或已通过的申请占用'),
      await dupOf('email_norm', app.email_norm, 'duplicate_email', '该邮箱已被其它待审核或已通过的申请使用'),
      await dupOf('qq_norm', app.qq_norm, 'duplicate_qq', '该 QQ 号已被其它待审核或已通过的申请占用'),
      await dupOf('discord_norm', app.discord_norm, 'duplicate_discord', '该 Discord 已被其它待审核或已通过的申请占用'),
    ]) {
      if (r) return r;
    }

    const now = nowIso();
    await dbRun(
      env,
      `UPDATE applications SET status = 'approved', reject_reason = NULL, review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`,
      [noteV.value, actor, now, now, id]
    );

    await audit(env, {
      actor,
      action: 'application.approved',
      objectType: 'application',
      objectId: String(id),
      note: noteV.value,
      detail: { reference: app.reference, ign: app.ign, command: VANILLA_ADD(app.ign) },
      ipHash,
    });

    const mail = applicationApproved(env, {
      reference: app.reference,
      ign: app.ign,
      note: noteV.value,
      command: VANILLA_ADD(app.ign),
    });
    const sent = await sendMail(env, { to: app.email_norm, subject: mail.subject, text: mail.text, html: mail.html, template: 'applicationApproved' });

    return ok({
      status: 'approved',
      vanillaCommand: VANILLA_ADD(app.ign),
      manualWhitelisted: !!app.manual_whitelisted_at,
      email: { status: sent.status },
      hint: '审核通过仅代表系统记录已通过；请到原版服务器执行 whitelist add 命令后，再勾选「已人工加入原版白名单」。',
    });
  }

  /* ---------------- 申请：拒绝（原因必填） ---------------- */
  if (head === 'applications' && third === 'reject' && method === 'POST') {
    const body = (await readJson(request)) || {};
    const id = parseInt(second, 10);
    const app = await dbOne(env, `SELECT * FROM applications WHERE id = ?`, [id]);
    if (!app) return fail('not_found', '记录不存在', 404);

    // 幂等：已经是拒绝状态就别再点一次（如需改判为通过，直接点「通过申请」即可）
    if (app.status === 'rejected') {
      return fail('already_reviewed', '该申请已是「已拒绝」状态，如需改判请直接执行「通过申请」', 409, {
        status: app.status,
        reviewedBy: app.reviewed_by || '',
        reviewedAt: app.reviewed_at || '',
      });
    }

    const reasonV = normReason(body.reason, '拒绝原因');
    if (!reasonV.ok) return fail('invalid_reason', reasonV.message);

    const now = nowIso();
    await dbRun(
      env,
      `UPDATE applications SET status = 'rejected', reject_reason = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`,
      [reasonV.value, str(body.note, 500), actor, now, now, id]
    );

    await audit(env, {
      actor,
      action: 'application.rejected',
      objectType: 'application',
      objectId: String(id),
      note: reasonV.value,
      detail: { reference: app.reference, ign: app.ign },
      ipHash,
    });

    const mail = applicationRejected(env, { reference: app.reference, ign: app.ign, reason: reasonV.value });
    const sent = await sendMail(env, { to: app.email_norm, subject: mail.subject, text: mail.text, html: mail.html, template: 'applicationRejected' });

    return ok({ status: 'rejected', email: { status: sent.status } });
  }

  /* ---------------- 标记「已人工加入原版白名单」 ---------------- */
  if (head === 'applications' && third === 'manual' && method === 'POST') {
    const body = (await readJson(request)) || {};
    const id = parseInt(second, 10);
    const app = await dbOne(env, `SELECT * FROM applications WHERE id = ?`, [id]);
    if (!app) return fail('not_found', '记录不存在', 404);
    if (app.status !== 'approved') return fail('not_approved', '只有已通过的申请才能标记原版白名单状态', 400);

    const done = String(body.done) === 'true' || body.done === true || body.done === 1 || body.done === '1';
    const noteV = normNote(body.note);
    if (!noteV.ok) return fail('invalid_note', noteV.message);
    const now = nowIso();

    await dbRun(
      env,
      `UPDATE applications SET manual_whitelisted_at = ?, manual_whitelist_by = ?, manual_whitelist_note = ?, updated_at = ? WHERE id = ?`,
      [done ? now : null, done ? actor : null, noteV.value, now, id]
    );

    await audit(env, {
      actor,
      action: done ? 'application.manual_whitelisted' : 'application.manual_whitelist_cleared',
      objectType: 'application',
      objectId: String(id),
      note: noteV.value,
      detail: { reference: app.reference, ign: app.ign, command: VANILLA_ADD(app.ign) },
      ipHash,
    });

    return ok({ manualWhitelisted: done, at: done ? now : null });
  }

  /* ---------------- 修改申请列表 ---------------- */
  if (head === 'modifications' && !second && method === 'GET') {
    const status = (url.searchParams.get('status') || 'all').trim();
    const kw = (url.searchParams.get('q') || '').trim().slice(0, 60);
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);

    const where = [];
    const params = [];
    if (['pending_review', 'approved', 'rejected'].includes(status)) {
      where.push('m.status = ?');
      params.push(status);
    }
    if (kw) {
      where.push(`(m.reference LIKE ? OR m.prev_ign LIKE ? OR IFNULL(m.new_ign,'') LIKE ? OR m.email_norm LIKE ?)`);
      const like = `%${kw}%`;
      params.push(like, like, like, like);
    }
    const sql = `SELECT m.*, a.reference AS app_reference, a.status AS app_status
                 FROM modification_requests m LEFT JOIN applications a ON a.id = m.application_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY m.id DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    const items = await dbAll(env, sql, params);

    // 返回总数，避免前端写死 limit 后被静默截断还看不出来
    const totalRow = await dbOne(
      env,
      `SELECT COUNT(*) AS c
         FROM modification_requests m LEFT JOIN applications a ON a.id = m.application_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
      where.length ? params.slice(0, params.length - 2) : []
    );
    return ok({ items, total: totalRow ? totalRow.c : items.length, limit, offset });
  }

  /* ---------------- 修改申请详情 ---------------- */
  if (head === 'modifications' && second && !third && method === 'GET') {
    const id = parseInt(second, 10);
    const m = await dbOne(env, `SELECT * FROM modification_requests WHERE id = ?`, [id]);
    if (!m) return fail('not_found', '记录不存在', 404);
    const app = await dbOne(env, `SELECT * FROM applications WHERE id = ?`, [m.application_id]);
    const logs = await recentAudit(env, 'application', String(m.application_id), 100);
    return ok({
      modification: m,
      application: app,
      auditLogs: logs,
      vanillaAdd: VANILLA_ADD(m.new_ign || m.prev_ign),
      vanillaRemove: m.ign_changed ? VANILLA_REMOVE(m.prev_ign) : null,
    });
  }

  /* ---------------- 修改申请：通过 ---------------- */
  if (head === 'modifications' && third === 'approve' && method === 'POST') {
    const body = (await readJson(request)) || {};
    const id = parseInt(second, 10);
    const m = await dbOne(env, `SELECT * FROM modification_requests WHERE id = ?`, [id]);
    if (!m) return fail('not_found', '记录不存在', 404);
    if (m.status !== 'pending_review') return fail('already_reviewed', '该修改申请已审核过', 409);

    const app = await dbOne(env, `SELECT * FROM applications WHERE id = ?`, [m.application_id]);
    if (!app) return fail('application_missing', '关联申请不存在', 404);

    const noteV = normNote(body.note);
    if (!noteV.ok) return fail('invalid_note', noteV.message);

    const finalIgn = m.new_ign || m.prev_ign;
    // 语义：null = 不修改（沿用原值）；'' = 清空；其它 = 新值
    const pick = (newVal, oldVal) => {
      if (newVal === null || newVal === undefined) return oldVal || null;
      return String(newVal) === '' ? null : String(newVal);
    };
    const finalQq = pick(m.new_qq, app.qq);
    const finalDiscord = pick(m.new_discord, app.discord);
    // 邮箱：null / 空 = 不修改（沿用原值），其余 = 新邮箱（提交时已独立验过验证码）
    const finalEmail = m.new_email ? String(m.new_email) : app.email_norm;
    const finalEmailDisplay = m.new_email ? String(m.new_email) : app.email;
    const emailChanged = !!m.email_changed;

    // 审核时重新跑一次冲突检查：提交时没撞，不代表审核时还没被别人占用
    const dupIgn = await dbOne(
      env,
      `SELECT reference FROM applications WHERE ign_norm = ? AND id != ? AND status IN ${ACTIVE} LIMIT 1`,
      [finalIgn.toLowerCase(), app.id]
    );
    if (dupIgn) {
      return fail('duplicate_ign', '该游戏 ID 已被其它待审核或已通过的申请占用，请改为拒绝本次修改', 409, { reference: dupIgn.reference });
    }
    if (finalQq) {
      const dupQq = await dbOne(
        env,
        `SELECT reference FROM applications WHERE qq_norm = ? AND id != ? AND status IN ${ACTIVE} LIMIT 1`,
        [finalQq, app.id]
      );
      if (dupQq) {
        return fail('duplicate_qq', '该 QQ 号已被其它待审核或已通过的申请占用，请改为拒绝本次修改', 409, { reference: dupQq.reference });
      }
    }
    if (finalDiscord) {
      const dupDc = await dbOne(
        env,
        `SELECT reference FROM applications WHERE discord_norm = ? AND id != ? AND status IN ${ACTIVE} LIMIT 1`,
        [finalDiscord.toLowerCase(), app.id]
      );
      if (dupDc) {
        return fail('duplicate_discord', '该 Discord 已被其它待审核或已通过的申请占用，请改为拒绝本次修改', 409, { reference: dupDc.reference });
      }
    }
    if (emailChanged) {
      const dupEm = await dbOne(
        env,
        `SELECT reference FROM applications WHERE email_norm = ? AND id != ? AND status IN ${ACTIVE} LIMIT 1`,
        [finalEmail.toLowerCase(), app.id]
      );
      if (dupEm) {
        return fail('duplicate_email', '该邮箱已被其它待审核或已通过的申请使用，请改为拒绝本次修改', 409, { reference: dupEm.reference });
      }
    }

    if (!finalQq && !finalDiscord) {
      return fail('contact_required', 'QQ 与 Discord 不能同时为空，本次修改会导致没有任何联系方式，请改为拒绝', 409);
    }

    const ignChanged = !!m.ign_changed;
    const now = nowIso();

    /**
     * 游戏 ID 变了 → 原版白名单必须重做（remove 旧 ID + add 新 ID），
     * 所以这里必须清空「已人工加入原版白名单」标记，
     * 否则后台会继续显示「已加入」，管理员很容易漏掉 add 新 ID，
     * 结果是玩家换了 ID 后进不了服还查不出原因。
     */
    await dbRun(
      env,
      `UPDATE applications SET ign = ?, ign_norm = ?, qq = ?, qq_norm = ?, discord = ?, discord_norm = ?,
         email = ?, email_norm = ?,
         manual_whitelisted_at = ?, manual_whitelist_by = ?, manual_whitelist_note = ?, updated_at = ?
       WHERE id = ?`,
      [
        finalIgn,
        finalIgn.toLowerCase(),
        finalQq || null,
        finalQq || null,
        finalDiscord || null,
        finalDiscord ? finalDiscord.toLowerCase() : null,
        finalEmailDisplay,
        finalEmail.toLowerCase(),
        ignChanged ? null : app.manual_whitelisted_at || null,
        ignChanged ? null : app.manual_whitelist_by || null,
        ignChanged ? null : app.manual_whitelist_note || null,
        now,
        app.id,
      ]
    );

    await dbRun(
      env,
      `UPDATE modification_requests SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = ?, applied_at = ?, updated_at = ? WHERE id = ?`,
      [noteV.value, actor, now, now, now, id]
    );

    await audit(env, {
      actor,
      action: 'modification.approved',
      objectType: 'application',
      objectId: String(app.id),
      note: noteV.value,
      detail: {
        modification: m.reference,
        ignChanged,
        manualWhitelistReset: ignChanged, // IGN 变化 → 已清空「已加入原版白名单」标记
        from: { ign: m.prev_ign, qq: m.prev_qq, discord: m.prev_discord, email: app.email_norm },
        to: { ign: finalIgn, qq: finalQq || '', discord: finalDiscord || '', email: finalEmail },
        command: ignChanged ? [VANILLA_REMOVE(m.prev_ign), VANILLA_ADD(finalIgn)] : [VANILLA_ADD(finalIgn)],
      },
      ipHash,
    });

    const mail = modificationApproved(env, {
      reference: m.reference,
      ignChanged: !!m.ign_changed,
      prevIgn: m.prev_ign,
      newIgn: finalIgn,
      emailChanged,
      prevEmail: m.email_changed ? m.prev_email || app.email_norm : '',
      newEmail: m.email_changed ? finalEmail : '',
      note: noteV.value,
      command: m.ign_changed ? `${VANILLA_REMOVE(m.prev_ign)} ; ${VANILLA_ADD(finalIgn)}` : VANILLA_ADD(finalIgn),
    });
    /**
     * 收件人用「生效后的邮箱」：换绑邮箱的用户往往旧邮箱已经停用，
     * 继续发到旧地址等于没通知到。
     */
    const sent = await sendMail(env, { to: finalEmail, subject: mail.subject, text: mail.text, html: mail.html, template: 'modificationApproved' });

    return ok({
      status: 'approved',
      applied: true,
      ignChanged,
      emailChanged,
      newEmail: emailChanged ? finalEmail : '',
      // IGN 变化后旧标记已作废，必须重新到服务器执行 add 再勾选
      manualWhitelisted: ignChanged ? false : !!app.manual_whitelisted_at,
      manualWhitelistReset: ignChanged,
      vanillaAdd: VANILLA_ADD(finalIgn),
      vanillaRemove: ignChanged ? VANILLA_REMOVE(m.prev_ign) : null,
      email: { status: sent.status },
      hint: ignChanged
        ? '游戏 ID 已变更：系统记录已更新，且「已人工加入原版白名单」标记已自动清空。必须由你到原版服务器手动移除旧 ID、添加新 ID，再回来重新勾选。'
        : '系统记录已更新（不会自动修改服务器 whitelist.json）。',
    });
  }

  /* ---------------- 修改申请：拒绝（原因必填，原状态不变） ---------------- */
  if (head === 'modifications' && third === 'reject' && method === 'POST') {
    const body = (await readJson(request)) || {};
    const id = parseInt(second, 10);
    const m = await dbOne(env, `SELECT * FROM modification_requests WHERE id = ?`, [id]);
    if (!m) return fail('not_found', '记录不存在', 404);
    if (m.status !== 'pending_review') return fail('already_reviewed', '该修改申请已审核过', 409);

    const app = await dbOne(env, `SELECT * FROM applications WHERE id = ?`, [m.application_id]);
    if (!app) return fail('application_missing', '关联申请不存在', 404);

    const reasonV = normReason(body.reason, '拒绝原因');
    if (!reasonV.ok) return fail('invalid_reason', reasonV.message);

    const now = nowIso();
    await dbRun(
      env,
      `UPDATE modification_requests SET status = 'rejected', reject_reason = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`,
      [reasonV.value, str(body.note, 500), actor, now, now, id]
    );

    await audit(env, {
      actor,
      action: 'modification.rejected',
      objectType: 'application',
      objectId: String(app.id),
      note: reasonV.value,
      detail: { modification: m.reference, ign: app.ign },
      ipHash,
    });

    const mail = modificationRejected(env, { reference: m.reference, ign: app.ign, reason: reasonV.value });
    const sent = await sendMail(env, { to: app.email_norm, subject: mail.subject, text: mail.text, html: mail.html, template: 'modificationRejected' });

    return ok({ status: 'rejected', applicationUnchanged: true, email: { status: sent.status } });
  }

  /* ---------------- 黑名单：列表 ---------------- */
  if (head === 'blacklist' && !second && method === 'GET') {
    const items = await dbAll(env, `SELECT * FROM blacklisted_emails ORDER BY id DESC`);
    return ok({ items });
  }

  /* ---------------- 黑名单：新增 ---------------- */
  if (head === 'blacklist' && !second && method === 'POST') {
    const body = (await readJson(request)) || {};
    const ruleType = String(body.ruleType || '').trim();
    if (!['exact', 'regex'].includes(ruleType)) return fail('bad_rule_type', '规则类型必须是 exact 或 regex');

    const v = validateRule(body.rule, ruleType);
    if (!v.ok) return fail('bad_rule', v.message);

    const now = nowIso();
    try {
      const res = await dbRun(
        env,
        `INSERT INTO blacklisted_emails (rule, rule_type, reason, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [v.value, ruleType, str(body.reason, 200), body.enabled === false || body.enabled === '0' ? 0 : 1, now, now]
      );
      const id = (res && res.meta && res.meta.last_row_id) || null;
      await audit(env, {
        actor,
        action: 'blacklist.created',
        objectType: 'blacklisted_email',
        objectId: String(id || ''),
        note: `${ruleType}:${v.value}`,
        detail: { reason: str(body.reason, 200) },
        ipHash,
      });
      return ok({ id });
    } catch (e) {
      return fail('duplicate_rule', '该规则已存在', 409);
    }
  }

  /* ---------------- 黑名单：修改 ---------------- */
  if (head === 'blacklist' && third === 'update' && method === 'POST') {
    const id = parseInt(second, 10);
    const row = await dbOne(env, `SELECT * FROM blacklisted_emails WHERE id = ?`, [id]);
    if (!row) return fail('not_found', '规则不存在', 404);

    const body = (await readJson(request)) || {};
    let rule = row.rule;
    if (body.rule !== undefined && String(body.rule).trim() !== String(row.rule)) {
      const v = validateRule(body.rule, row.rule_type);
      if (!v.ok) return fail('bad_rule', v.message);
      rule = v.value;
    }
    const enabled = body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0;
    const reason = body.reason === undefined ? row.reason : str(body.reason, 200);

    try {
      await dbRun(env, `UPDATE blacklisted_emails SET rule = ?, reason = ?, enabled = ?, updated_at = ? WHERE id = ?`, [
        rule,
        reason,
        enabled,
        nowIso(),
        id,
      ]);
    } catch (e) {
      return fail('duplicate_rule', '该规则已存在', 409);
    }

    await audit(env, {
      actor,
      action: 'blacklist.updated',
      objectType: 'blacklisted_email',
      objectId: String(id),
      note: `enabled=${enabled}`,
      detail: { rule, reason },
      ipHash,
    });
    return ok({ id });
  }

  /* ---------------- 黑名单：删除 ---------------- */
  if (head === 'blacklist' && third === 'delete' && method === 'POST') {
    const id = parseInt(second, 10);
    const row = await dbOne(env, `SELECT * FROM blacklisted_emails WHERE id = ?`, [id]);
    if (!row) return fail('not_found', '规则不存在', 404);
    await dbRun(env, `DELETE FROM blacklisted_emails WHERE id = ?`, [id]);
    await audit(env, {
      actor,
      action: 'blacklist.deleted',
      objectType: 'blacklisted_email',
      objectId: String(id),
      note: `${row.rule_type}:${row.rule}`,
      ipHash,
    });
    return ok({ id });
  }

  /* ---------------- 邮件发件箱（真实发送记录 / 模拟发送记录） ---------------- */
  if (head === 'outbox' && method === 'GET') {
    const limit = clampInt(url.searchParams.get('limit'), 30, 1, 100);
    const items = await dbAll(env, `SELECT * FROM email_outbox ORDER BY id DESC LIMIT ?`, [limit]);
    return ok({ items });
  }

  /* ---------------- 审计日志 ---------------- */
  if (head === 'audit' && method === 'GET') {
    const objectType = (url.searchParams.get('objectType') || '').trim();
    const objectId = (url.searchParams.get('objectId') || '').trim();
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
    const items = objectType && objectId
      ? await dbAll(env, `SELECT * FROM audit_logs WHERE object_type = ? AND object_id = ? ORDER BY id DESC LIMIT ?`, [objectType, objectId, limit])
      : await dbAll(env, `SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?`, [limit]);
    return ok({ items });
  }

  return fail('not_found', '接口不存在', 404);
}
