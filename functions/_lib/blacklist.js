/* ============================================================
   黑名单邮箱
   - 支持精确邮箱与正则两种规则
   - 校验顺序：先精确匹配，再逐条正则
   - ReDoS 防护：限制规则长度 / 条数、拒绝无效正则、捕获异常、限制输入长度
   ============================================================ */

import { dbAll, dbOne } from './db.js';
import { LIMITS } from './validation.js';

export const MAX_REGEX_RULES = 50;   // 单次校验最多加载的正则条数
export const MAX_REGEX_LEN = 200;    // 单条正则最大长度
export const MAX_INPUT_LEN = LIMITS.emailMax; // 输入邮箱最大长度

/** 安全编译正则：返回 RegExp 或 null（无效正则直接跳过，不抛错） */
export function compileRegex(pattern) {
  const p = String(pattern || '');
  if (!p || p.length > MAX_REGEX_LEN) return null;
  try {
    // 只允许大小写不敏感标志，禁止其它标志
    return new RegExp(p, 'i');
  } catch {
    return null;
  }
}

/** 新增/编辑规则时的可用性检查（含简单的灾难性回溯特征拦截） */
export function validateRule(rule, ruleType) {
  const r = String(rule || '').trim();
  if (!r) return { ok: false, message: '规则内容不能为空' };
  if (r.length > MAX_REGEX_LEN) return { ok: false, message: `规则最长 ${MAX_REGEX_LEN} 个字符` };
  if (ruleType === 'exact') {
    if (!/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[A-Za-z0-9-]{2,}$/.test(r.toLowerCase())) {
      return { ok: false, message: '精确规则必须是完整邮箱地址' };
    }
    return { ok: true, value: r.toLowerCase() };
  }
  if (ruleType === 'regex') {
    // ReDoS 特征拦截：这些写法都可能造成灾难性回溯
    const risky = [
      // (a+)+ 、(\w*)* 这类「分组 + 外层量词」
      /\((?:[^()]*[+*][^()]*)*\)\s*[+*]/,
      // (a|aa)+ 、(x|xy)* 这类「多分支 + 外层量词」
      /\([^()]*\|[^()]*\)\s*(?:[+*]|\{\s*\d+\s*(?:,\s*\d*\s*)?\})/,
      // ){n,} 这类无上界重复
      /\)\s*\{\s*\d+\s*,\s*\}/,
      // 说明：不拦截 .*? / .+? 这类惰性量词（安全且常用）
    ];
    if (risky.some((re) => re.test(r))) {
      return { ok: false, message: '正则规则含有嵌套量词或多分支重复，存在 ReDoS 风险，已被拒绝' };
    }
    const compiled = compileRegex(r);
    if (!compiled) return { ok: false, message: '无效的正则表达式' };
    // 编译后再试跑一次超长输入，捕获编译期无法发现的异常
    try {
      compiled.test('a'.repeat(64) + '@' + 'b'.repeat(64) + '.com');
    } catch {
      return { ok: false, message: '正则规则无法安全执行' };
    }
    return { ok: true, value: r };
  }
  return { ok: false, message: '未知的规则类型' };
}

/**
 * 校验邮箱是否命中黑名单
 * @returns {Promise<{blocked:boolean, ruleId?:number, ruleType?:string, reason?:string}>}
 */
export async function checkBlacklist(env, emailNorm) {
  const email = String(emailNorm || '').toLowerCase().slice(0, MAX_INPUT_LEN);
  if (!email) return { blocked: false };

  // 1) 精确匹配
  const exact = await dbOne(
    env,
    `SELECT id, reason FROM blacklisted_emails
     WHERE enabled = 1 AND rule_type = 'exact' AND lower(rule) = ? LIMIT 1`,
    [email]
  );
  if (exact) {
    return { blocked: true, ruleId: exact.id, ruleType: 'exact', reason: exact.reason || '该邮箱已被列入黑名单' };
  }

  // 2) 正则匹配（限量 + 单条失败不影响整体）
  const rules = await dbAll(
    env,
    `SELECT id, rule, reason FROM blacklisted_emails
     WHERE enabled = 1 AND rule_type = 'regex'
     ORDER BY id ASC LIMIT ?`,
    [MAX_REGEX_RULES]
  );

  for (const r of rules) {
    const re = compileRegex(r.rule);
    if (!re) continue;
    try {
      if (re.test(email)) {
        return { blocked: true, ruleId: r.id, ruleType: 'regex', reason: r.reason || '该邮箱已被列入黑名单' };
      }
    } catch {
      // 单条规则异常直接跳过
      continue;
    }
  }

  return { blocked: false };
}
