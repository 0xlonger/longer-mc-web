/* ============================================================
   限流：固定窗口计数，落在 D1 rate_limits 表
   ============================================================ */

import { dbOne, dbRun } from './db.js';

const nowSec = () => Math.floor(Date.now() / 1000);

/** 计数 +1 并判断是否超限 */
export async function hit(env, bucketKey, limit, windowSec) {
  const now = nowSec();
  const windowStart = Math.floor(now / windowSec) * windowSec;

  await dbRun(
    env,
    `INSERT INTO rate_limits (bucket_key, window_start, count, expires_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = count + 1`,
    [bucketKey, windowStart, now + windowSec]
  );

  const row = await dbOne(
    env,
    `SELECT count FROM rate_limits WHERE bucket_key = ? AND window_start = ?`,
    [bucketKey, windowStart]
  );
  const count = row ? row.count : 1;

  // 顺手清理过期窗口（低频，避免额外写入压力）
  if (count % 20 === 0) {
    await dbRun(env, `DELETE FROM rate_limits WHERE expires_at < ?`, [now]).catch(() => {});
  }

  return { ok: count <= limit, count, limit, windowSec };
}

/** 组合键：邮箱 / IP 维度的发送与验证频率 */
export const buckets = {
  sendHour: (h, purpose) => `send:h:${purpose}:${h}`,
  sendCooldown: (h, purpose) => `send:c:${purpose}:${h}`,
  sendIp: (h) => `send:ip:${h}`,
  verify: (h, purpose) => `vfy:h:${purpose}:${h}`,
  verifyIp: (h) => `vfy:ip:${h}`,
  /**
   * 写接口（提交申请 / 提交修改）按 IP 限流。
   * 早期 apply 与 modify 共用同一个桶 `w:ip:`，5 次 / 10 分钟——
   * 校园网、网吧、公司出口 IP 下第 6 个人就会被拒，而且改信息还要跟新申请抢额度。
   * 现在拆成两个桶，各自独立计数：
   *   applyIp  12 次 / 10 分钟
   *   modifyIp 12 次 / 10 分钟
   * 真正的滥用防线是「每个邮箱」的发送冷却（60 秒）与每小时上限，
   * IP 桶只兜底防刷，放宽到 12 不会削弱实际防护。
   */
  applyIp: (h) => `w:apply:ip:${h}`,
  modifyIp: (h) => `w:modify:ip:${h}`,
  adminIp: (h) => `adm:ip:${h}`,
};
