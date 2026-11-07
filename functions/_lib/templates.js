/* ============================================================
   邮件模板集中管理（业务代码不得内联文案）
   每个模板返回 { subject, text, html }
   ============================================================ */

import { appBaseUrl, fallbackContacts, SERVER_NAME } from './env.js';

export const PURPOSE_LABEL = {
  apply: '申请白名单',
  inquire: '查询申请状态',
  modify: '修改白名单信息',
  change_email: '更换绑定邮箱',
};

/**
 * 冲突类错误的统一文案（DUPLICATE_HINT_MODE=generic 时使用）。
 *
 * 不告诉玩家具体是 IGN 还是 QQ 撞了（否则等于给探测者一份字段级字典），
 * 但必须给出出路——否则玩家只会反复重试、越来越烦躁。
 * 所以文案里接上「反复失败可走全人工通道」。
 */
export function genericDuplicateMessage(env) {
  const f = fallbackContacts(env);
  const channels = [];
  if (f.qqGroup) channels.push(`QQ 群 ${f.qqGroup}`);
  if (f.discordInvite) channels.push('Discord');
  const tail = channels.length
    ? `如果反复失败，可到${channels.join(' / ')}联系管理员，说明情况后由人工帮你核对是哪一项冲突。`
    : '如果反复失败，请联系管理员人工核对是哪一项冲突。';
  return `你填写的信息与已有记录冲突（游戏 ID / QQ / Discord / 邮箱可能已被使用）。请检查后修改。${tail}`;
}

const esc = (s) =>
  String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);

/**
 * 「网页通道不可用 → 走全人工」的说明块。
 * 所有邮件的公共页脚上方都会带上：网页端（申请 / 查询 / 修改）出问题时，
 * 用户可以直接进 QQ 群或 Discord，说明自己无法在网页完成操作，
 * 由管理员手工核对并添加白名单。
 */
function fallbackText(env) {
  const c = fallbackContacts(env);
  if (!c.qqGroup && !c.discordInvite) return [];
  const lines = ['', '如果网页端无法完成操作（收不到验证码、页面报错等），'];
  lines.push('你也可以直接加入下面的社区，说明自己无法在网页完成申请 / 查询 / 修改，由管理员走全人工流程处理：');
  if (c.qqGroup) lines.push(`QQ 群：${c.qqGroup}`);
  if (c.discordInvite) lines.push(`Discord：${c.discordInvite}`);
  return lines;
}

function fallbackHtml(env) {
  const c = fallbackContacts(env);
  if (!c.qqGroup && !c.discordInvite) return '';
  const parts = [];
  if (c.qqGroup) parts.push(`QQ 群 <b style="color:#eef2f8;">${esc(c.qqGroup)}</b>`);
  if (c.discordInvite) {
    parts.push(
      `<a href="${esc(c.discordInvite)}" style="color:#8ae66c;text-decoration:none;">${esc(c.discordInvite)}</a>`
    );
  }
  return `<div style="margin-top:22px;padding:14px 16px;background:#171d28;border-left:3px solid #f2c14e;font-size:13px;color:#c7d0dd;line-height:1.8;">
      网页端无法完成操作时（例如收不到验证码、页面报错），
      可直接加入 ${parts.join(' 或 ')}，
      说明自己无法在网页完成申请 / 查询 / 修改，管理员会走<b style="color:#eef2f8;">全人工流程</b>为你处理白名单。
    </div>`;
}

function layout(env, title, inner, opts) {
  const showFallback = !opts || opts.showFallback !== false;
  const base = appBaseUrl(env);
  return `<div style="margin:0;padding:24px;background:#0a0d12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#eef2f8;">
  <div style="max-width:560px;margin:0 auto;background:#121721;border:1px solid #242c3a;border-radius:12px;padding:28px;">
    <div style="font-size:13px;letter-spacing:.15em;color:#8d99ac;margin-bottom:18px;">${esc(SERVER_NAME)} · 白名单系统</div>
    <h1 style="font-size:19px;margin:0 0 18px;color:#f2c14e;">${esc(title)}</h1>
    ${inner}
    ${showFallback ? fallbackHtml(env) : ''}
    <div style="margin-top:26px;padding-top:16px;border-top:1px solid #242c3a;font-size:12px;color:#76839a;line-height:1.7;">
      本邮件由 <a href="${esc(base)}" style="color:#8ae66c;text-decoration:none;">${esc(base)}</a> 自动发送，请勿直接回复。<br/>
      若非你本人操作，请忽略此邮件。
    </div>
  </div>
</div>`;
}

function codeBlock(text) {
  return `<div style="margin:16px 0;padding:14px 18px;background:#1d2532;border:1px dashed #333d4f;border-radius:8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:22px;letter-spacing:.35em;text-align:center;color:#65dbe8;">${esc(
    text
  )}</div>`;
}

function kv(rows) {
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:10px 0;">
    ${rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:8px 0;color:#8d99ac;width:110px;vertical-align:top;">${esc(k)}</td><td style="padding:8px 0;color:#eef2f8;">${v}</td></tr>`
      )
      .join('')}
  </table>`;
}

const b = (s) => `<b style="color:#eef2f8;">${esc(s)}</b>`;

/* ---------------- 邮箱验证码 ---------------- */
export function verifyCode(env, { code, purpose, minutes }) {
  const label = PURPOSE_LABEL[purpose] || '操作';
  // 验证码不写进主题：主题会在手机锁屏、邮件列表预览、通知栏直接显示，
  // 等于把一次性凭证公开贴出来。验证码只放在正文里。
  const subject = `【${SERVER_NAME}】${label} · 邮箱验证码`;
  const text = [
    `你正在进行「${label}」的邮箱验证。`,
    '',
    `验证码：${code}`,
    `有效期：${minutes} 分钟（一次性使用）`,
    '',
    '如果不是你本人操作，请忽略此邮件，不要向任何人透露验证码。',
    '',
    `— ${SERVER_NAME} 白名单系统`,
  ].join('\n');

  // 验证码邮件不放「全人工通道」提示块：这封信的唯一用途就是交付验证码，
  // 多余内容只会把真正重要的验证码挤下去。
  const html = layout(
    env,
    '邮箱验证码',
    `<p style="font-size:14px;line-height:1.8;color:#c7d0dd;margin:0;">你正在进行「${esc(label)}」的邮箱验证，请在页面中输入下面的验证码。</p>
     ${codeBlock(code)}
     <p style="font-size:13px;color:#8d99ac;line-height:1.8;margin:0;">验证码 ${esc(minutes)} 分钟内有效，且只可使用一次。请勿向任何人透露。</p>`,
    { showFallback: false }
  );

  return { subject, text, html };
}

/* ---------------- 申请已提交 ---------------- */
export function applicationSubmitted(env, { reference, ign }) {
  const base = appBaseUrl(env);
  const subject = `【${SERVER_NAME}】白名单申请已提交 · ${reference}`;
  const text = [
    '你的白名单申请已提交成功，正在等待人工审核。',
    '',
    `申请编号：${reference}`,
    `游戏 ID：${ign}`,
    '',
    '审核进度可在以下页面自助查询（需要邮箱验证码）：',
    `${base}/whitelist/inquire`,
    '',
    '注意：审核期间请留意你填写的 QQ / Discord 是否被管理员联系。',
    `— ${SERVER_NAME} 白名单系统`,
  ].concat(fallbackText(env)).join('\n');

  const html = layout(
    env,
    '白名单申请已提交',
    `<p style="font-size:14px;line-height:1.8;color:#c7d0dd;margin:0;">你的白名单申请已提交成功，正在等待人工审核。</p>
     ${kv([
       ['申请编号', b(reference)],
       ['游戏 ID', b(ign)],
       ['当前状态', '<span style="color:#f2c14e;">待人工审核</span>'],
     ])}
     <p style="font-size:13px;color:#8d99ac;line-height:1.8;margin:0;">
       可在 <a href="${esc(base)}/whitelist/inquire" style="color:#8ae66c;text-decoration:none;">状态查询页</a> 自助查询进度（需邮箱验证码）。
     </p>`
  );

  return { subject, text, html };
}

/* ---------------- 申请审核通过 ---------------- */
export function applicationApproved(env, { reference, ign, note, command }) {
  const subject = `【${SERVER_NAME}】白名单申请已通过 · ${reference}`;
  const text = [
    '恭喜，你的白名单申请已通过审核。',
    '',
    `申请编号：${reference}`,
    `游戏 ID：${ign}`,
    note ? `管理员备注：${note}` : '',
    '',
    '接下来由管理员把你的 ID 加入 Minecraft 原版白名单，',
    '加入完成后即可使用下面的地址进服：',
    'play.mc.longer.xin',
    '',
    command ? `（管理员参考命令：${command}）` : '',
    `— ${SERVER_NAME} 白名单系统`,
  ]
    .concat(fallbackText(env))
    .filter(Boolean)
    .join('\n');

  const html = layout(
    env,
    '白名单申请已通过',
    `<p style="font-size:14px;line-height:1.8;color:#c7d0dd;margin:0;">恭喜，你的白名单申请已通过审核。</p>
     ${kv([
       ['申请编号', b(reference)],
       ['游戏 ID', b(ign)],
       ['当前状态', '<span style="color:#8ae66c;">已通过（待管理员加入原版白名单）</span>'],
     ].concat(note ? [['管理员备注', esc(note)]] : []))}
     <p style="font-size:13px;color:#8d99ac;line-height:1.8;margin:0;">
       管理员会把 <b style="color:#eef2f8;">${esc(ign)}</b> 加入 Minecraft 原版白名单，完成后即可进服：<code style="color:#65dbe8;">play.mc.longer.xin</code>
     </p>`
  );

  return { subject, text, html };
}

/* ---------------- 申请审核拒绝 ---------------- */
export function applicationRejected(env, { reference, ign, reason }) {
  const subject = `【${SERVER_NAME}】白名单申请未通过 · ${reference}`;
  const text = [
    '很遗憾，你的白名单申请未通过审核。',
    '',
    `申请编号：${reference}`,
    `游戏 ID：${ign}`,
    `拒绝原因：${reason}`,
    '',
    '如认为有误，可在修正问题后重新提交申请，或到服务器 QQ 群 / Discord 联系管理员。',
    `— ${SERVER_NAME} 白名单系统`,
  ].concat(fallbackText(env)).join('\n');

  const html = layout(
    env,
    '白名单申请未通过',
    `<p style="font-size:14px;line-height:1.8;color:#c7d0dd;margin:0;">很遗憾，你的白名单申请未通过审核。</p>
     ${kv([
       ['申请编号', b(reference)],
       ['游戏 ID', b(ign)],
       ['拒绝原因', `<span style="color:#e85d5d;">${esc(reason)}</span>`],
     ])}
     <p style="font-size:13px;color:#8d99ac;line-height:1.8;margin:0;">如认为有误，可修正后重新提交，或到服务器 QQ 群 / Discord 联系管理员。</p>`
  );

  return { subject, text, html };
}

/* ---------------- 修改申请已提交 ---------------- */
export function modificationSubmitted(env, { reference, ign, changes }) {
  const base = appBaseUrl(env);
  const subject = `【${SERVER_NAME}】白名单信息修改申请已提交 · ${reference}`;
  const text = [
    '你的白名单信息修改申请已提交，正在等待人工审核。',
    '',
    `修改编号：${reference}`,
    `游戏 ID：${ign}`,
    ...changes.map((c) => `· ${c.label}：${c.prev || '（空）'} → ${c.next || '（空）'}`),
    '',
    '审核通过前，当前白名单信息保持不变。',
    `查询进度：${base}/whitelist/inquire`,
    '',
    `— ${SERVER_NAME} 白名单系统`,
  ].concat(fallbackText(env)).join('\n');

  const html = layout(
    env,
    '修改申请已提交',
    `<p style="font-size:14px;line-height:1.8;color:#c7d0dd;margin:0;">你的修改申请已提交，正在等待人工审核。审核通过前当前信息保持不变。</p>
     ${kv(
       [['修改编号', b(reference)], ['游戏 ID', b(ign)]].concat(
         changes.map((c) => [c.label, `${esc(c.prev || '（空）')} → ${b(c.next || '（空）')}`])
       )
     )}`
  );

  return { subject, text, html };
}

/* ---------------- 修改申请通过 ---------------- */
export function modificationApproved(env, { reference, ignChanged, prevIgn, newIgn, emailChanged, prevEmail, newEmail, note, command }) {
  const subject = `【${SERVER_NAME}】白名单信息修改已通过 · ${reference}`;
  const text = [
    '你的白名单信息修改申请已通过审核，系统记录已更新。',
    '',
    `修改编号：${reference}`,
    ignChanged ? `游戏 ID：${prevIgn} → ${newIgn}` : `游戏 ID：${newIgn}`,
    emailChanged ? `绑定邮箱：${prevEmail} → ${newEmail}` : '',
    note ? `管理员备注：${note}` : '',
    '',
    emailChanged ? '绑定邮箱已更新，之后的状态查询请使用新邮箱。' : '',
    ignChanged
      ? '注意：由于游戏 ID 发生变化，管理员需要到原版服务器手动替换白名单条目（先移除旧 ID，再添加新 ID），完成后新 ID 才能进服。'
      : '如涉及原版白名单变动，管理员会同步处理。',
    command ? `（管理员参考命令：${command}）` : '',
    '',
    `— ${SERVER_NAME} 白名单系统`,
  ]
    .concat(fallbackText(env))
    .filter(Boolean)
    .join('\n');

  const emailRow = emailChanged ? [['绑定邮箱', `${esc(prevEmail)} → ${b(newEmail)}`]] : [];

  const html = layout(
    env,
    '修改申请已通过',
    `<p style="font-size:14px;line-height:1.8;color:#c7d0dd;margin:0;">你的修改申请已通过审核，系统记录已更新。</p>
     ${kv(
       [
         ['修改编号', b(reference)],
         [
           '游戏 ID',
           ignChanged ? `${esc(prevIgn)} → ${b(newIgn)}` : b(newIgn),
         ],
       ].concat(emailRow)
         .concat(note ? [['管理员备注', esc(note)]] : [])
     )}
     ${
       ignChanged
         ? `<p style="font-size:13px;color:#ffad5c;line-height:1.8;margin:0;">游戏 ID 已变更，管理员需要到原版服务器手动替换白名单条目，完成后新 ID 才能进服。</p>`
         : ''
     }`
  );

  return { subject, text, html };
}

/* ---------------- 修改申请拒绝 ---------------- */
export function modificationRejected(env, { reference, ign, reason }) {
  const subject = `【${SERVER_NAME}】白名单信息修改未通过 · ${reference}`;
  const text = [
    '你的白名单信息修改申请未通过审核，当前白名单信息保持不变。',
    '',
    `修改编号：${reference}`,
    `游戏 ID：${ign}`,
    `拒绝原因：${reason}`,
    '',
    '如需再次申请，请在确认信息无误后重新提交修改申请。',
    `— ${SERVER_NAME} 白名单系统`,
  ].concat(fallbackText(env)).join('\n');

  const html = layout(
    env,
    '修改申请未通过',
    `<p style="font-size:14px;line-height:1.8;color:#c7d0dd;margin:0;">你的修改申请未通过审核，<b style="color:#eef2f8;">当前白名单信息保持不变</b>。</p>
     ${kv([
       ['修改编号', b(reference)],
       ['游戏 ID', b(ign)],
       ['拒绝原因', `<span style="color:#e85d5d;">${esc(reason)}</span>`],
     ])}`
  );

  return { subject, text, html };
}
