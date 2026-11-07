/* ============================================================
   审计日志：所有审核 / 配置变更都必须留痕，detail 中不得写入验证码等敏感信息
   ============================================================ */

import { dbRun, nowIso } from './db.js';

export async function audit(env, { actor = '', action, objectType = '', objectId = '', note = '', detail = null, ipHash = '' }) {
  let payload = null;
  if (detail) {
    try {
      payload = JSON.stringify(detail).slice(0, 2000);
    } catch {
      payload = null;
    }
  }
  try {
    await dbRun(
      env,
      `INSERT INTO audit_logs (actor, action, object_type, object_id, note, detail, ip_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(actor || ''), String(action), String(objectType), String(objectId), String(note || '').slice(0, 500), payload, String(ipHash || ''), nowIso()]
    );
  } catch (e) {
    console.warn('[audit] 写入失败', e);
  }
}

export async function recentAudit(env, objectType, objectId, limit = 50) {
  const r = await env.DB.prepare(
    `SELECT * FROM audit_logs WHERE object_type = ? AND object_id = ? ORDER BY id DESC LIMIT ?`
  )
    .bind(String(objectType), String(objectId), limit)
    .all();
  return (r && r.results) || [];
}

/** 日志中使用的 IP 指纹（不落明文 IP） */
export async function ipFingerprint(env, ip, pepperValue) {
  const { hmacHex } = await import('./crypto.js');
  return (await hmacHex(pepperValue, `ip:${ip}`)).slice(0, 16);
}
