/* ============================================================
   输入校验
   所有外部输入都必须先过这里，再做业务处理
   ============================================================ */

export const LIMITS = {
  emailMax: 254,
  ignMax: 16,
  qqMax: 11,
  discordMax: 40,
  reasonMin: 5,
  reasonMax: 500,
  noteMax: 500,
  ruleMax: 200,
};

export const RE = {
  ign: /^[A-Za-z0-9_]{3,16}$/,
  qq: /^[1-9][0-9]{4,10}$/,                 // 5~11 位，首位非 0
  discordNew: /^[a-z0-9._]{2,32}$/,         // 新版用户名
  // 旧版 name#1234：只放行真实 Discord 允许的字符。
  // 早期写法是排除式黑名单 [^\s@#:`]，会把 < > " / = 等一并放进来
  // （例如 <svg/onload=...>#1234 能通过）。虽然所有输出都做了转义、不构成 XSS，
  // 但这些值会原样存进数据库并在后台展示，没必要放行。
  // Discord 旧版用户名允许字母、数字、点、下划线、连字符与空格（不连续空格、不以空格结尾）。
  discordOld: /^[a-z0-9._-][a-z0-9._ -]{0,30}[a-z0-9._-]#[0-9]{4}$/, // 名称 2~32 位，首尾非空格
  email: /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[A-Za-z0-9-]{2,}$/,
  code: /^[0-9]{6}$/,
  ticket: /^[a-f0-9]{16,64}$/,
};

function bad(message) {
  return { ok: false, value: '', message };
}
function good(value) {
  return { ok: true, value, message: '' };
}

export function normEmail(v) {
  const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  if (s.length > LIMITS.emailMax) return bad('邮箱过长');
  if (!RE.email.test(s)) return bad('邮箱格式不正确');
  return good(s);
}

export function normIgn(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return bad('请填写 Minecraft 游戏 ID');
  if (s.length > LIMITS.ignMax) return bad('游戏 ID 最长 16 位');
  if (!RE.ign.test(s)) return bad('游戏 ID 只能包含字母、数字和下划线，长度 3-16 位');
  return good(s);
}

export function normQq(v) {
  const raw = String(v === undefined || v === null ? '' : v).trim();
  if (!raw) return good(''); // QQ 可空（但 QQ 与 Discord 至少填一个，业务层判断）
  if (raw.length > LIMITS.qqMax) return bad('QQ 号最长 11 位数字');
  if (!RE.qq.test(raw)) return bad('QQ 号格式不正确（5-11 位数字）');
  return good(raw);
}

export function normDiscord(v) {
  const raw = String(v === undefined || v === null ? '' : v).trim();
  if (!raw) return good('');
  if (raw.length > LIMITS.discordMax) return bad('Discord 标识过长');
  const lower = raw.toLowerCase();
  if (RE.discordNew.test(lower) || RE.discordOld.test(lower)) return good(raw);
  return bad('Discord 格式不正确（新版用户名或旧版 name#1234）');
}

/* ---------------- 修改流程的「辅助验证因子」 ----------------
   规则（与产品约定一致）：
   - 邮箱必填且必须通过六位数验证码（证明邮箱控制权）
   - 再选 QQ / Discord / 游戏 ID 中的任意一项做辅助验证，
     系统比对「该邮箱绑定的记录里这一项是否与填写值一致」
   - 用哪一项验证，本次就不能改哪一项；要改它就得换另一项来验证
   - 三项都对不上（或没有其它可选项）时，只能走全人工通道
---------------------------------------------------------------- */

export const MODIFY_FACTORS = ['ign', 'qq', 'discord'];

export const FACTOR_LABEL = {
  ign: '游戏 ID',
  qq: 'QQ 号',
  discord: 'Discord',
};

export function normFactor(v) {
  const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  if (!s) return bad('请选择辅助验证方式（QQ / Discord / 游戏 ID 任选其一）');
  if (!MODIFY_FACTORS.includes(s)) return bad('辅助验证方式不正确');
  return good(s);
}

/**
 * 按因子类型校验并规范化「辅助验证值」。
 * 只做格式校验与归一化，不判断该值是否真的绑在某个记录上（那是业务层的事）。
 */
export function normFactorValue(factor, v) {
  if (factor === 'ign') return normIgn(v);
  if (factor === 'qq') {
    const r = normQq(v);
    if (!r.ok) return r;
    if (!r.value) return bad('请填写当前绑定的 QQ 号');
    return r;
  }
  if (factor === 'discord') {
    const r = normDiscord(v);
    if (!r.ok) return r;
    if (!r.value) return bad('请填写当前绑定的 Discord');
    return r;
  }
  return bad('辅助验证方式不正确');
}

/** 归一化后的比较键：与库里 *_norm 列的存法保持一致 */
export function factorNormKey(factor, value) {
  if (factor === 'ign') return String(value || '').trim().toLowerCase();
  if (factor === 'qq') return String(value || '').trim();
  if (factor === 'discord') return String(value || '').trim().toLowerCase();
  return '';
}

export function normCode(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!RE.code.test(s)) return bad('验证码为 6 位数字');
  return good(s);
}

export function normReason(v, label = '理由') {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (s.length < LIMITS.reasonMin) return bad(`${label}至少 ${LIMITS.reasonMin} 个字`);
  if (s.length > LIMITS.reasonMax) return bad(`${label}最长 ${LIMITS.reasonMax} 个字`);
  return good(s);
}

export function normNote(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (s.length > LIMITS.noteMax) return bad(`备注最长 ${LIMITS.noteMax} 个字`);
  return good(s);
}

export function normRule(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return bad('规则内容不能为空');
  if (s.length > LIMITS.ruleMax) return bad(`规则最长 ${LIMITS.ruleMax} 个字符`);
  return good(s);
}

export const PURPOSES = ['apply', 'inquire', 'modify', 'change_email'];

export function normPurpose(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!PURPOSES.includes(s)) return bad('未知的用途');
  return good(s);
}
