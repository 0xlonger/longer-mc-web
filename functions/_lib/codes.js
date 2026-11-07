/* ============================================================
   邮箱验证码 + 验证票据
   - 验证码：6 位数字，只存 HMAC 哈希，一次性，默认 10 分钟有效
   - 失败次数超限即作废，需重新发送
   - 票据：验证码通过后签发，短期有效，用于后续提交 / 查询
   ============================================================ */

import { dbOne, dbRun, nowIso } from './db.js';
import { hmacHex, randomDigits, randomHex, safeEqual } from './crypto.js';
import { pepper } from './env.js';

export const CODE_TTL_SEC = 600;      // 验证码有效期 10 分钟
export const CODE_MAX_ATTEMPTS = 5;   // 单个验证码最多尝试 5 次
export const TICKET_TTL_SEC = 900;    // 票据有效期 15 分钟
export const APPLY_TICKET_TTL_SEC = 1800; // 申请页：填表时间更长一些
export const TICKET_MAX_ATTEMPTS = 5; // 单张票据允许的「校验失败」次数，超过即作废

function codeHash(env, emailNorm, purpose, code) {
  return hmacHex(pepper(env).value, `${emailNorm}|${purpose}|${code}`);
}

/** 失效同邮箱同用途的旧验证码，再签发新的 */
export async function issueCode(env, { emailNorm, purpose, ipHash, ttlSec = CODE_TTL_SEC }) {
  const now = nowIso();
  await dbRun(
    env,
    `UPDATE email_verifications SET consumed_at = ?
     WHERE email_norm = ? AND purpose = ? AND consumed_at IS NULL`,
    [now, emailNorm, purpose]
  );

  const code = randomDigits(6);
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();

  await dbRun(
    env,
    `INSERT INTO email_verifications
       (email_norm, purpose, code_hash, expires_at, attempts, max_attempts, request_ip_hash, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
    [emailNorm, purpose, await codeHash(env, emailNorm, purpose, code), expiresAt, CODE_MAX_ATTEMPTS, ipHash || '', now]
  );

  return { code, expiresAt, ttlSec };
}

/**
 * 校验验证码
 * 无论成功失败都不回显验证码本身；失败累计到上限后该验证码作废
 */
export async function consumeCode(env, { emailNorm, purpose, code }) {
  const row = await dbOne(
    env,
    `SELECT * FROM email_verifications
     WHERE email_norm = ? AND purpose = ? AND consumed_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    [emailNorm, purpose]
  );

  if (!row) return { ok: false, code: 'code_invalid', message: '验证码不正确或已失效' };

  if (new Date(row.expires_at).getTime() < Date.now()) {
    await dbRun(env, `UPDATE email_verifications SET consumed_at = ? WHERE id = ?`, [nowIso(), row.id]);
    return { ok: false, code: 'code_expired', message: '验证码已过期，请重新发送' };
  }

  if (row.attempts >= row.max_attempts) {
    await dbRun(env, `UPDATE email_verifications SET consumed_at = ? WHERE id = ?`, [nowIso(), row.id]);
    return { ok: false, code: 'code_locked', message: '验证码失败次数过多，请重新发送' };
  }

  const candidate = await codeHash(env, emailNorm, purpose, code);
  if (!safeEqual(candidate, row.code_hash)) {
    await dbRun(env, `UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?`, [row.id]);
    const left = Math.max(0, row.max_attempts - row.attempts - 1);
    return {
      ok: false,
      code: 'code_invalid',
      message: left > 0 ? `验证码不正确，还可尝试 ${left} 次` : '验证码失败次数过多，请重新发送',
      remaining: left,
    };
  }

  await dbRun(env, `UPDATE email_verifications SET consumed_at = ? WHERE id = ?`, [nowIso(), row.id]);
  return { ok: true, verificationId: row.id };
}

/* ------------------------- 票据 ------------------------- */

/**
 * 签发票据
 * verifyFactor：仅用于 modify 票据，记录本次用的是哪一项辅助验证
 * （ign / qq / discord）。用哪一项验证，本次就不能改哪一项——
 * modify 接口靠这个字段来拦截「拿游戏 ID 验证完又改游戏 ID」。
 */
export async function issueTicket(env, { kind, emailNorm, ignNorm = '', applicationId = null, ttlSec = TICKET_TTL_SEC, verifyFactor = null }) {
  const id = randomHex(24);
  const now = nowIso();
  await dbRun(
    env,
    `INSERT INTO auth_tickets (id, kind, email_norm, ign_norm, application_id, verify_factor, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      kind,
      emailNorm,
      String(ignNorm || '').toLowerCase(),
      applicationId,
      verifyFactor && ['ign', 'qq', 'discord'].includes(verifyFactor) ? verifyFactor : null,
      new Date(Date.now() + ttlSec * 1000).toISOString(),
      now,
    ]
  );
  return id;
}

/**
 * 读取票据；consume=true 时一次性作废
 * 注意：业务侧应先完成字段校验再作废，避免用户填错一次就被迫重新验证邮箱
 */
export async function readTicket(env, id, kind, consume = false) {
  const clean = String(id || '').toLowerCase();
  if (!/^[a-f0-9]{16,64}$/.test(clean)) return null;

  const row = await dbOne(env, `SELECT * FROM auth_tickets WHERE id = ? AND kind = ?`, [clean, kind]);
  if (!row) return null;
  if (row.consumed_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  if (consume) {
    await dbRun(env, `UPDATE auth_tickets SET consumed_at = ? WHERE id = ?`, [nowIso(), row.id]);
  }
  return row;
}

/** 在业务校验全部通过、写入成功后才调用，作废票据 */
export async function consumeTicket(env, id) {
  await dbRun(env, `UPDATE auth_tickets SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`, [
    nowIso(),
    String(id || ''),
  ]);
}

/**
 * 记录一次「用这张票据提交但校验失败」，超过上限则作废票据。
 *
 * 存在的理由：票据在有效期内可以被无限次使用，如果失败不计数，
 * 攻击者只要给自己邮箱发一次验证码拿到票据，就能在 30 分钟内反复提交，
 * 用 duplicate_ign / duplicate_qq 之类的返回值去探测「某个 IGN / QQ / Discord
 * 是否已经被别人申请过」。计次后，每张票据只能试探 5 次，探测成本大幅抬高。
 *
 * @returns {Promise<{ok:boolean, remaining:number}>} ok=false 表示票据已作废
 */
export async function failTicketAttempt(env, ticket) {
  if (!ticket || !ticket.id) return { ok: false, remaining: 0 };
  const max = TICKET_MAX_ATTEMPTS;
  const used = Number(ticket.attempts || 0) + 1;

  if (used >= max) {
    await dbRun(env, `UPDATE auth_tickets SET attempts = ?, consumed_at = ? WHERE id = ?`, [
      used,
      nowIso(),
      ticket.id,
    ]);
    return { ok: false, remaining: 0 };
  }

  await dbRun(env, `UPDATE auth_tickets SET attempts = ? WHERE id = ?`, [used, ticket.id]);
  return { ok: true, remaining: max - used };
}

/**
 * 清理过期的验证码与票据（低频调用，见 send-code.js）。
 * 验证码记录里只有 HMAC 哈希，但保留时间越短越好；
 * 票据同理，过期后没有保留价值。
 */
export async function purgeExpired(env) {
  const now = nowIso();
  await dbRun(env, `DELETE FROM email_verifications WHERE expires_at < ? OR consumed_at IS NOT NULL`, [now]);
  await dbRun(env, `DELETE FROM auth_tickets WHERE expires_at < ? OR consumed_at IS NOT NULL`, [now]);
}
