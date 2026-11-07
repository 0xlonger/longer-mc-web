/* ============================================================
   邮件服务 provider
   - driver=resend：调用 Resend HTTP API（https://api.resend.com/emails）
     注意：这里使用的是 Resend 第三方邮件 API，不是 Cloudflare Email Routing /
     Email Workers，两者不要混用。
   - driver=log ：开发环境模拟发送（控制台日志 + D1 email_outbox），不发真实邮件
   - 所有发送都会落 email_outbox，便于排查与端到端测试
   ============================================================ */

import { dbRun, maskEmail, nowIso } from './db.js';
import { cfg, emailDriver, emailFrom } from './env.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** 主题里若含验证码（历史模板曾把验证码写进主题），存发件箱时抹掉 */
function subjectWithoutSecret(subject, template) {
  if (template !== 'verifyCode') return subject;
  return String(subject).replace(/\d{6}/g, '******');
}

function splitFrom(from) {
  // 支持 "LongerMC 白名单 <whitelist@notify.longer.xin>" 或纯地址
  const m = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(from || '');
  if (m) return { name: m[1], address: m[2] };
  return { name: '', address: (from || '').trim() };
}

/**
 * 发送邮件
 * @returns {Promise<{ok:boolean,status:'sent'|'simulated'|'failed',driver:string,error:string|null}>}
 */
export async function sendMail(env, opts) {
  const to = String((opts && opts.to) || '').trim();
  const subject = String((opts && opts.subject) || '').trim();
  const text = String((opts && opts.text) || '');
  const html = String((opts && opts.html) || '');
  const template = String((opts && opts.template) || '');

  const driver = emailDriver(env);
  let status = 'simulated';
  let error = null;

  if (!to) return { ok: false, status: 'failed', driver, error: 'missing recipient' };

  if (driver === 'resend') {
    const apiKey = cfg(env, 'RESEND_API_KEY', '');
    const from = emailFrom(env);
    if (!apiKey) {
      status = 'failed';
      error = 'RESEND_API_KEY 未配置';
    } else if (!from) {
      status = 'failed';
      error = 'EMAIL_FROM 未配置';
    } else {
      const { name, address } = splitFrom(from);
      const payload = {
        from: name ? `${name} <${address}>` : address,
        to: [to],
        subject,
        text,
      };
      if (html) payload.html = html;
      const replyTo = cfg(env, 'EMAIL_REPLY_TO', '');
      if (replyTo) payload.reply_to = replyTo;

      try {
        const res = await fetch(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          status = 'sent';
        } else {
          status = 'failed';
          error = `Resend HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
        }
      } catch (e) {
        status = 'failed';
        error = String((e && e.message) || e);
      }
    }
  } else {
    // 模拟发送：日志脱敏，不打印完整邮箱
    console.log(`[email:simulated] to=${maskEmail(to)} subject=${subject}`);
    if (text) console.log(text.split('\n').slice(0, 12).join('\n'));
  }

  /**
   * 落发件箱时用「脱敏后的正文」：
   * 验证码邮件会把 6 位验证码原样写进正文，如果这里存原文，
   * 就等于「验证码只存哈希」在发件箱这一侧被绕过了——
   * 后台邮件记录页能直接看到所有人的验证码。
   * 所以验证码类邮件只留一句占位说明，其余邮件保留原文（排障需要）。
   */
  const SENSITIVE_TEMPLATES = new Set(['verifyCode']);
  const storedBody = SENSITIVE_TEMPLATES.has(template)
    ? `[内容含一次性验证码，按安全策略不予存储。收件人：${maskEmail(to)}]`
    : text.slice(0, 4000);

  try {
    await dbRun(
      env,
      `INSERT INTO email_outbox (to_email, subject, template, body_text, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [to, subjectWithoutSecret(subject, template), template, storedBody, status, error ? String(error).slice(0, 500) : null, nowIso()]
    );
  } catch (e) {
    console.warn('[email] outbox 写入失败', e);
  }

  return { ok: status !== 'failed', status, driver, error };
}
