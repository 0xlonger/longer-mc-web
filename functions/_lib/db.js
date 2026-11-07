/* ============================================================
   D1 访问封装
   ============================================================ */

import { randomBytes } from './crypto.js';

export function nowIso() {
  return new Date().toISOString();
}

export async function dbAll(env, sql, params = []) {
  const r = await env.DB.prepare(sql).bind(...params).all();
  return (r && r.results) || [];
}

export async function dbOne(env, sql, params = []) {
  return env.DB.prepare(sql).bind(...params).first();
}

export async function dbRun(env, sql, params = []) {
  return env.DB.prepare(sql).bind(...params).run();
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符

function randomCode(len = 6) {
  const buf = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return s;
}

/** 生成唯一申请编号（WL- / MR- 前缀） */
export async function uniqueRef(env, table, prefix) {
  for (let i = 0; i < 10; i++) {
    const ref = `${prefix}-${randomCode(6)}`;
    const row = await dbOne(env, `SELECT id FROM ${table} WHERE reference = ?`, [ref]);
    if (!row) return ref;
  }
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

/* ============================================================
   脱敏：公开接口一律返回脱敏后的个人信息
   ============================================================ */

export function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  const name = s.slice(0, at);
  const domain = s.slice(at + 1);
  const head = name.slice(0, 1);
  const tail = name.length >= 3 ? name.slice(-1) : '';
  const stars = '*'.repeat(Math.max(1, name.length - head.length - tail.length));
  const parts = domain.split('.');
  const main = parts[0] || '';
  const tld = parts.length > 1 ? '.' + parts.slice(1).join('.') : '';
  const maskedMain = main.length <= 1 ? main : main.slice(0, 1) + '*'.repeat(main.length - 1);
  return `${head}${stars}${tail}@${maskedMain}${tld}`;
}

export function maskQq(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 3) return '***';
  return s.slice(0, 2) + '*'.repeat(s.length - 4) + s.slice(-2);
}

export function maskDiscord(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 2) return '**';
  return s.slice(0, 2) + '*'.repeat(Math.max(1, s.length - 2));
}

/** 只保留 IGN 首尾各一位（用于查询结果的辅助展示，默认仍展示完整 IGN） */
export function maskIgn(v) {
  const s = String(v || '');
  if (s.length <= 2) return s ? '*' : '';
  return s.slice(0, 1) + '*'.repeat(s.length - 2) + s.slice(-1);
}
