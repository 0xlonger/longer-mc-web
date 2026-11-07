/* ============================================================
   POST /api/whitelist/inquire   { ticket }
   通过邮箱验证码签发的票据查询申请状态
   - 结果脱敏：不返回完整邮箱 / QQ / Discord
   - 只展示系统记录状态，不判定原版白名单 / QQ 群 / Discord 是否生效
   - 票据走 POST body，不放 URL query：
     query 会留在浏览器历史、服务器访问日志和 Referer 里
   ============================================================ */

import { fail, ok, readJson, sameOriginStrict, str } from '../../_lib/http.js';
import { consumeTicket, readTicket } from '../../_lib/codes.js';
import { dbAll, dbOne, maskDiscord, maskEmail, maskQq } from '../../_lib/db.js';

export const STATUS_TEXT = {
  pending_review: '待人工审核',
  approved: '审核已通过（待管理员加入原版白名单）',
  rejected: '未通过审核',
};

export const STATUS_HINT = {
  pending_review: '你的申请正在等待管理员人工审核，请耐心等待。',
  approved: '审核已通过。管理员会手动把你的游戏 ID 加入 Minecraft 原版白名单，加入后即可进服。',
  rejected: '该申请未通过审核，可参考拒绝原因修正后重新提交。',
};

export async function onRequestPost(context) {
  const { request, env } = context;

  // 改为 POST 后用严格模式：fetch 一定会带 Origin
  if (!sameOriginStrict(request)) return fail('bad_origin', '来源校验失败', 403);

  const body = await readJson(request);
  if (!body) return fail('bad_request', '请求格式错误');

  /**
   * 票据「查一次即作废」。
   *
   * 早期实现是不消耗的（15 分钟内可重复查），好处是刷新页面不用重新验码；
   * 但票据本身等同于「已验证邮箱的凭证」，长期存活会留在浏览器历史与日志里，
   * 而用户查询一次就够了解状态，重复查询的需求很弱。
   * 按产品决定改为一次性：查完即废，再查需重新做一次邮箱验证。
   */
  const ticket = await readTicket(env, str(body.ticket, 64), 'inquire', false);
  if (!ticket) return fail('ticket_invalid', '邮箱验证已失效，请重新完成邮箱验证后再查询', 401);

  /**
   * 直接用票据里绑定的 application_id，而不是再用 IGN + 邮箱查一遍。
   * 早期实现两边选取规则不一致（这里取最新一条，verify-code 那边优先取
   * approved / pending_review），同一邮箱 + IGN 存在多条记录时可能查到不同的记录。
   * 票据是在验证邮箱时锁定的，用它最可靠。
   */
  const app = ticket.application_id
    ? await dbOne(env, `SELECT * FROM applications WHERE id = ?`, [ticket.application_id])
    : await dbOne(
        env,
        `SELECT * FROM applications WHERE email_norm = ? ORDER BY id DESC LIMIT 20`,
        [ticket.email_norm]
      );
  if (!app) return fail('not_found', '未找到与该邮箱匹配的申请记录', 404);

  const pending = await dbAll(
    env,
    `SELECT reference, status, new_ign, new_qq, new_discord, created_at
     FROM modification_requests
     WHERE application_id = ? AND status = 'pending_review'
     ORDER BY id DESC LIMIT 1`,
    [app.id]
  );

  const latestMod = await dbOne(
    env,
    `SELECT reference, status, reject_reason, reviewed_at
     FROM modification_requests
     WHERE application_id = ? AND status IN ('approved','rejected')
     ORDER BY id DESC LIMIT 1`,
    [app.id]
  );

  // 返回前作废票据（一次性）
  await consumeTicket(env, ticket.id);

  return ok({
    record: {
      reference: app.reference,
      ign: app.ign,
      email: maskEmail(app.email_norm),
      qq: maskQq(app.qq),
      discord: maskDiscord(app.discord),
      hasQq: !!app.qq,
      hasDiscord: !!app.discord,
      status: app.status,
      statusText: STATUS_TEXT[app.status] || app.status,
      statusHint: STATUS_HINT[app.status] || '',
      rejectReason: app.status === 'rejected' ? app.reject_reason || '' : '',
      emailVerified: !!app.email_verified_at,
      submittedAt: app.created_at,
      updatedAt: app.updated_at,
      reviewedAt: app.reviewed_at || '',
      // 审核通过 ≠ 原版白名单已生效
      manualWhitelisted: !!app.manual_whitelisted_at,
      manualWhitelistedAt: app.manual_whitelisted_at || '',
      vanillaNote: app.status === 'approved'
        ? (app.manual_whitelisted_at
            ? '管理员已记录：该 ID 已加入 Minecraft 原版白名单。'
            : '审核已通过，但管理员尚未记录「已加入原版白名单」。若长时间无法进服，请到 QQ 群 / Discord 联系管理员。')
        : '',
    },
    pendingModification: pending.length
      ? {
          reference: pending[0].reference,
          status: pending[0].status,
          statusText: '待人工审核',
          newIgn: pending[0].new_ign || '',
          hasNewQq: !!pending[0].new_qq,
          hasNewDiscord: !!pending[0].new_discord,
          createdAt: pending[0].created_at,
        }
      : null,
    latestModification: latestMod
      ? {
          reference: latestMod.reference,
          status: latestMod.status,
          rejectReason: latestMod.status === 'rejected' ? latestMod.reject_reason || '' : '',
          reviewedAt: latestMod.reviewed_at || '',
        }
      : null,
    notice: '本页面只展示本系统的申请记录状态，不代表 QQ 群 / Discord 加入情况，也不代表 Minecraft 原版白名单是否已生效。',
  });
}
