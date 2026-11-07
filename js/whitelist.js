/* ============================================================
   LongerMC · 白名单系统前端逻辑（申请 / 查询 / 修改）
   依赖：js/icons.js（图标）、css/whitelist.css
   页面通过 <body data-page="apply|inquire|modify"> 区分
   ============================================================ */
(function () {
  'use strict';

  var CFG = null;
  var lastErrCode = ''; // 最近一次接口错误的 code，供页面做针对性引导
  var widgets = []; // 页面上的 Turnstile 控件，可能不止一个
  var lastUsedWidget = null; // 最近一次取到 token 的控件，重置时只重置它
  var tsLoaded = false;

  function el(sel) {
    return document.querySelector(sel);
  }

  function showAlert(node, type, msg) {
    if (!node) return;
    node.className = 'wl-alert wl-alert--' + (type || 'info');
    node.textContent = msg || '';
  }

  function clearAlert(node) {
    if (!node) return;
    node.className = 'wl-alert';
    node.textContent = '';
  }

  function setBusy(btn, busy, busyText) {
    if (!btn) return;
    if (btn.dataset.locked === '1') return; // 已锁定（如提交成功后）
    if (busy) {
      btn.dataset.text = btn.textContent;
      btn.textContent = busyText || '处理中…';
      btn.disabled = true;
    } else {
      if (btn.dataset.text) btn.textContent = btn.dataset.text;
      btn.disabled = false;
    }
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  }

  /* ------------------------- 接口 ------------------------- */

  async function api(path, payload, method) {
    var opts = {
      method: method || 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
    };
    if (payload) opts.body = JSON.stringify(payload);
    var res = await fetch(path, opts);
    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = { ok: false, error: { code: 'bad_response', message: '服务端返回异常（HTTP ' + res.status + '）' } };
    }
    return data;
  }

  function errMsg(data, fallback) {
    lastErrCode = (data && data.error && data.error.code) || '';
    return (data && data.error && data.error.message) || fallback || '请求失败，请稍后再试';
  }

  /* ------------------------- Turnstile ------------------------- */

  function renderTurnstile() {
    if (!CFG) return;
    var boxes = document.querySelectorAll('[data-turnstile]');
    if (!boxes.length) return;

    Array.prototype.forEach.call(boxes, function (box) {
      if (box.dataset.rendered === '1') return;

      if (CFG.turnstile.mockMode) {
        box.dataset.rendered = '1';
        var tip = document.createElement('div');
        tip.className = 'wl-alert wl-alert--warn';
        tip.textContent = '本地开发模拟模式：未配置 Turnstile 密钥，将使用模拟 token 通过服务端校验。';
        box.appendChild(tip);
        return;
      }
      if (!CFG.turnstile.enabled) {
        box.dataset.rendered = '1';
        var tip2 = document.createElement('div');
        tip2.className = 'wl-alert wl-alert--warn';
        tip2.textContent = '未配置 Turnstile 站点密钥，人机验证不可用（无法提交）。';
        box.appendChild(tip2);
        return;
      }
      if (!tsLoaded || !window.turnstile) return;

      box.dataset.rendered = '1';
      var id = window.turnstile.render(box, {
        sitekey: CFG.turnstile.siteKey,
        theme: 'dark',
        'refresh-expired': 'auto',
        size: 'normal',
      });
      widgets.push({ box: box, id: id });
    });
  }

  function markTsReady() {
    tsLoaded = true;
    renderTurnstile();
  }

  // 页面里已预置 window.lmcTurnstileReady / __lmcTsCb，避免回调早于本脚本执行
  function bindTsReady() {
    if (window.__lmcTsReady) {
      markTsReady();
      return;
    }
    window.__lmcTsCb = window.__lmcTsCb || [];
    window.__lmcTsCb.push(markTsReady);
    // 兜底：脚本已加载但回调未触发时也能渲染
    window.setTimeout(function () {
      if (!tsLoaded && window.turnstile) markTsReady();
    }, 2000);
  }

  function takeToken() {
    if (!CFG) return '';
    if (CFG.turnstile.mockMode) return CFG.turnstile.mockToken || '';
    if (!window.turnstile) return '';
    for (var i = 0; i < widgets.length; i++) {
      var t = window.turnstile.getResponse(widgets[i].id);
      if (t) {
        lastUsedWidget = widgets[i].id;
        return t;
      }
    }
    lastUsedWidget = null;
    return '';
  }

  /**
   * 只重置「刚刚用过的那一个」控件。
   * Turnstile token 是一次性的，每个请求都必须用一个新的，
   * 所以申请页的 3 次请求（发送验证码 / 验证邮箱 / 提交）本来就要各勾一次；
   * 但早期实现会重置页面上「全部」控件，导致用户填完上一步后
   * 连下一步已经勾好的验证也被清掉，白白多勾一次。
   */
  function resetTurnstile() {
    if (!CFG || CFG.turnstile.mockMode || !window.turnstile) return;
    if (lastUsedWidget !== null) {
      try {
        window.turnstile.reset(lastUsedWidget);
      } catch (e) {
        /* ignore */
      }
      lastUsedWidget = null;
      return;
    }
    for (var i = 0; i < widgets.length; i++) {
      try {
        window.turnstile.reset(widgets[i].id);
      } catch (e) {
        /* ignore */
      }
    }
  }

  /* ------------------------- 验证码倒计时 ------------------------- */

  function cooldown(btn, sec) {
    if (!btn) return;
    var left = sec;
    var label = btn.dataset.text || btn.textContent;
    btn.dataset.text = label;
    btn.disabled = true;
    btn.textContent = left + ' 秒后可重发';
    var timer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        btn.textContent = label;
        btn.disabled = false;
      } else {
        btn.textContent = left + ' 秒后可重发';
      }
    }, 1000);
  }

  /* ------------------------- 发送验证码（公共） ------------------------- */

  async function sendCode(opts) {
    var token = takeToken();
    if (!token) {
      showAlert(opts.alert, 'err', '请先完成人机验证（勾选「我不是机器人」）。');
      return null;
    }
    var payload = { purpose: opts.purpose, email: opts.email, turnstileToken: token };
    if (opts.ign) payload.ign = opts.ign;
    if (opts.factor) { payload.factor = opts.factor; payload.factorValue = opts.factorValue; }

    setBusy(opts.btn, true, '发送中…');
    var result = null;
    try {
      var data = await api('/api/whitelist/send-code', payload);
      if (!data.ok) {
        showAlert(opts.alert, 'err', errMsg(data, '验证码发送失败'));
        return null;
      }
      var msg = data.message || '验证码已发送。';
      if (data.devCode) {
        msg += ' 开发环境模拟验证码：' + data.devCode;
      }
      showAlert(opts.alert, data.simulated ? 'warn' : 'ok', msg);
      result = data;
    } finally {
      setBusy(opts.btn, false);
      resetTurnstile();
    }
    // 倒计时要在 setBusy 复原之后再启动，否则会被按钮状态复原覆盖
    if (result) cooldown(opts.btn, result.cooldownSec || 60);
    return result;
  }

  /* ------------------------- 校验验证码（公共） ------------------------- */

  async function verifyCode(opts) {
    var token = takeToken();
    if (!token) {
      showAlert(opts.alert, 'err', '请先完成人机验证。');
      return null;
    }
    var payload = { purpose: opts.purpose, email: opts.email, code: opts.code, turnstileToken: token };
    if (opts.ign) payload.ign = opts.ign;
    if (opts.factor) { payload.factor = opts.factor; payload.factorValue = opts.factorValue; }

    setBusy(opts.btn, true, '验证中…');
    try {
      var data = await api('/api/whitelist/verify-code', payload);
      if (!data.ok) {
        var code = data.error && data.error.code;
        /**
         * 后端为防枚举，已把「记录不存在 / 验证码错 / 辅助项对不上」
         * 统一成 code_invalid，不再返回 not_found。
         * 所以这里两个码都按「中性警告」展示（红色 error 会让用户以为
         * 自己填错了而反复重试，实际可能只是记录不存在）。
         */
        if (code === 'not_found' || code === 'code_invalid') {
          showAlert(opts.alert, 'warn', errMsg(data));
        } else {
          showAlert(opts.alert, 'err', errMsg(data, '验证码校验失败'));
        }
        return null;
      }
      return data;
    } finally {
      setBusy(opts.btn, false);
      resetTurnstile();
    }
  }

  /* =========================================================
     申请页 /whitelist/apply
     ========================================================= */

  function initApply() {
    var alertBox = el('#applyAlert');
    var btnSend = el('#btnSendCode');
    var btnVerify = el('#btnVerify');
    var btnSubmit = el('#btnSubmit');
    var ticketInput = el('#ticket');
    var infoBox = el('#applyInfo');
    var fEmail = el('#email');
    var fCode = el('#code');
    var fIgn = el('#ign');
    var fQq = el('#qq');
    var fDiscord = el('#discord');

    if (!btnSubmit || !btnVerify) return;

    // 步骤 1：发送验证码
    btnSend.addEventListener('click', function () {
      clearAlert(alertBox);
      var email = (fEmail.value || '').trim();
      if (!email) return showAlert(alertBox, 'err', '请先填写邮箱。');
      sendCode({ alert: alertBox, btn: btnSend, purpose: 'apply', email: email });
    });

    // 步骤 2：校验验证码换取票据
    btnVerify.addEventListener('click', async function () {
      clearAlert(alertBox);
      var email = (fEmail.value || '').trim();
      var code = (fCode.value || '').trim();
      if (!email) return showAlert(alertBox, 'err', '请填写邮箱。');
      if (!code) return showAlert(alertBox, 'err', '请填写邮箱收到的 6 位验证码。');

      var v = await verifyCode({ alert: alertBox, btn: btnVerify, purpose: 'apply', email: email, code: code });
      if (!v) return;
      ticketInput.value = v.ticket;
      if (infoBox) infoBox.hidden = false;
      btnVerify.dataset.locked = '1';
      showAlert(alertBox, 'ok', '邮箱验证通过，请继续填写申请信息并提交。');
    });

    // 步骤 3：提交申请（需要再做一次人机验证）
    btnSubmit.addEventListener('click', async function () {
      clearAlert(alertBox);

      var email = (fEmail.value || '').trim();
      var ign = (fIgn.value || '').trim();
      var qq = (fQq.value || '').trim();
      var discord = (fDiscord.value || '').trim();

      if (!ticketInput.value) return showAlert(alertBox, 'err', '请先完成邮箱验证。');
      if (!ign) return showAlert(alertBox, 'err', '请填写 Minecraft 游戏 ID。');
      if (!/^[A-Za-z0-9_]{3,16}$/.test(ign)) return showAlert(alertBox, 'err', '游戏 ID 只能包含字母、数字和下划线，长度 3-16 位。');
      if (!qq && !discord) return showAlert(alertBox, 'err', 'QQ 号和 Discord 至少需要填写一个。');
      if (qq && !/^[1-9][0-9]{4,10}$/.test(qq)) return showAlert(alertBox, 'err', 'QQ 号格式不正确（5-11 位数字）。');

      var token = takeToken();
      if (!token) return showAlert(alertBox, 'err', '请先完成人机验证。');

      setBusy(btnSubmit, true, '提交中…');
      try {
        var data = await api('/api/whitelist/apply', {
          ticket: ticketInput.value,
          email: email,
          ign: ign,
          qq: qq,
          discord: discord,
          turnstileToken: token,
        });

        if (!data.ok) {
          if (data.error && data.error.code === 'ticket_invalid') {
            ticketInput.value = '';
            if (infoBox) infoBox.hidden = true;
            delete btnVerify.dataset.locked;
          }
          return showAlert(alertBox, 'err', errMsg(data, '提交失败'));
        }

        var done = el('#applyDone');
        if (done) {
          done.hidden = false;
          var refEl = el('#applyRef');
          if (refEl) refEl.textContent = data.reference;
        }
        btnSubmit.dataset.locked = '1';
        showAlert(alertBox, 'ok', '提交成功！申请编号：' + data.reference + '（已发送至你的邮箱），请等待人工审核。');
      } finally {
        setBusy(btnSubmit, false);
        resetTurnstile();
      }
    });
  }

  /* =========================================================
     查询页 /whitelist/inquire
     ========================================================= */

  function initInquire() {
    var alertBox = el('#inqAlert');
    var btnSend = el('#btnSendCode');
    var btnQuery = el('#btnQuery');
    var fEmail = el('#email');
    var fCode = el('#code');
    var result = el('#inqResult');

    if (!btnQuery) return;

    // 查询只验证邮箱：验证码本身就证明了对该邮箱的控制权，
    // 再要求填游戏 ID 只是给记不清 ID 的用户添麻烦。
    btnSend.addEventListener('click', function () {
      clearAlert(alertBox);
      var email = (fEmail.value || '').trim();
      if (!email) return showAlert(alertBox, 'err', '请填写邮箱。');
      sendCode({ alert: alertBox, btn: btnSend, purpose: 'inquire', email: email });
    });

    btnQuery.addEventListener('click', async function () {
      clearAlert(alertBox);
      var email = (fEmail.value || '').trim();
      var code = (fCode.value || '').trim();
      if (!email) return showAlert(alertBox, 'err', '请填写邮箱。');
      if (!code) return showAlert(alertBox, 'err', '请填写邮箱收到的 6 位验证码。');

      setBusy(btnQuery, true, '查询中…');
      try {
        var v = await verifyCode({ alert: alertBox, btn: btnQuery, purpose: 'inquire', email: email, code: code });
        if (!v) {
          // 邮箱无记录 / 验证码不对：统一提示，不区分（防探测）
          if (lastErrCode === 'code_invalid') renderInquireNoMatch(alertBox);
          return;
        }

        // 票据走 POST body，不放在 URL 上（避免留在浏览器历史与访问日志里）
        var data = await api('/api/whitelist/inquire', { ticket: v.ticket });
        if (!data.ok) return showAlert(alertBox, 'err', errMsg(data, '查询失败'));

        renderInquire(result, data);
        showAlert(alertBox, 'ok', '验证通过，以下是你的申请状态（信息已脱敏）。');
      } finally {
        setBusy(btnQuery, false);
        resetTurnstile();
      }
    });
  }

  /** 查询无匹配时的统一引导（不透露该邮箱有没有申请记录） */
  function renderInquireNoMatch(alertBox) {
    var f = (CFG && CFG.fallback) || {};
    var msg = '验证码不正确，或该邮箱没有匹配的申请记录。请确认邮箱是否填对（更换过绑定邮箱的请用新邮箱）。';
    if (f.qqGroup || f.discordInvite) {
      msg += ' 若邮箱已无法使用，可前往 QQ 群 / Discord 联系管理员人工查询。';
    }
    showAlert(alertBox, 'warn', msg);
  }

  function renderInquire(root, data) {
    if (!root) return;
    var r = data.record;
    root.hidden = false;
    root.innerHTML = '';

    var badge = document.createElement('span');
    var cls = r.status === 'approved' ? 'approved' : r.status === 'rejected' ? 'rejected' : 'pending';
    badge.className = 'wl-status-badge wl-status-badge--' + cls;
    badge.textContent = r.statusText;
    root.appendChild(badge);

    var hint = document.createElement('p');
    hint.className = 'wl-note';
    hint.textContent = r.statusHint || '';
    root.appendChild(hint);

    var dl = document.createElement('dl');
    dl.className = 'wl-kv';

    function row(k, v) {
      var dt = document.createElement('dt');
      dt.textContent = k;
      var dd = document.createElement('dd');
      dd.textContent = v;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }

    row('申请编号', r.reference);
    row('游戏 ID', r.ign);
    row('邮箱', r.email);
    row('QQ', r.qq || '未填写');
    row('Discord', r.discord || '未填写');
    row('提交时间', fmtTime(r.submittedAt));
    row('更新时间', fmtTime(r.updatedAt));
    if (r.status === 'rejected' && r.rejectReason) row('拒绝原因', r.rejectReason);
    row('邮箱已验证', r.emailVerified ? '是' : '否');
    row('已加入原版白名单', r.manualWhitelisted ? '是（' + fmtTime(r.manualWhitelistedAt) + '）' : '否（仅代表本系统记录）');
    root.appendChild(dl);

    if (r.vanillaNote) {
      var note = document.createElement('div');
      note.className = 'wl-alert wl-alert--info';
      note.style.marginTop = '14px';
      note.textContent = r.vanillaNote;
      root.appendChild(note);
    }

    if (data.pendingModification) {
      var pm = document.createElement('div');
      pm.className = 'wl-alert wl-alert--warn';
      pm.style.marginTop = '14px';
      pm.textContent =
        '你有一个待审核的修改申请（' + data.pendingModification.reference + '），审核通过前当前信息保持不变。';
      root.appendChild(pm);
    }

    var notice = document.createElement('p');
    notice.className = 'wl-note';
    notice.textContent = data.notice || '';
    root.appendChild(notice);
  }

  /* =========================================================
     修改页 /whitelist/modify
     ========================================================= */

  function initModify() {
    var alertBox = el('#modAlert');
    var btnSend = el('#btnSendCode');
    var btnVerify = el('#btnVerify');
    var btnSubmit = el('#btnSubmit');
    var fEmail = el('#email');
    var fFactor = el('#factor');
    var fFactorValue = el('#factorValue');
    var fFactorLabel = el('[data-factor-label]');
    var fFactorTip = el('#factorTip');
    var fCode = el('#code');
    var ticketInput = el('#ticket');
    var formBox = el('#modForm');
    var curBox = el('#modCurrent');
    var fNewIgn = el('#newIgn');
    var fNewQq = el('#newQq');
    var fNewDiscord = el('#newDiscord');
    var fClearQq = el('#clearQq');
    var fClearDiscord = el('#clearDiscord');
    var fReason = el('#reason');
    var fChangeEmail = el('#changeEmail');
    var fEmailBox = el('#emailChangeBox');
    var fNewEmail = el('#newEmail');
    var fNewEmailCode = el('#newEmailCode');
    var btnSendEmailCode = el('#btnSendEmailCode');
    var curQq = '';      // 当前生效的 QQ（验证通过后回填）
    var curDiscord = ''; // 当前生效的 Discord
    var curIgn = '';     // 当前生效的游戏 ID
    var lockedFactor = ''; // 本次用哪一项做的辅助验证（该项本次不可修改）

    var FACTOR_META = {
      ign: { label: '当前游戏 ID', tip: '请填写当前生效的游戏 ID。', placeholder: '当前生效的游戏 ID', max: 16 },
      qq: { label: '当前 QQ 号', tip: '请填写当前绑定的 QQ 号（5-11 位数字）。', placeholder: '当前绑定的 QQ 号', max: 11 },
      discord: { label: '当前 Discord', tip: '请填写当前绑定的 Discord（新版用户名或旧版 name#1234）。', placeholder: '当前绑定的 Discord', max: 40 },
    };

    /**
     * 锁定「本次验证所用的那一项」：禁用它的输入框与清空开关，并给出说明。
     * 想改这一项，只能回到第 1 步换另一项做辅助验证。
     */
    function lockField(factor) {
      // 重新验证（换了验证方式）时先全部解锁，避免上一次的锁定残留
      var all = [[fNewIgn, null], [fNewQq, fClearQq], [fNewDiscord, fClearDiscord]];
      all.forEach(function (pair) {
        if (pair[0]) pair[0].disabled = false;
        if (pair[1]) pair[1].disabled = false;
      });
      var staleNotes = document.querySelectorAll('.wl-lock-note');
      Array.prototype.forEach.call(staleNotes, function (n) {
        if (n.parentNode) n.parentNode.removeChild(n);
      });

      var map = {
        ign: [fNewIgn, null],
        qq: [fNewQq, fClearQq],
        discord: [fNewDiscord, fClearDiscord],
      };
      var pair = map[factor];
      if (!pair) return;
      var input = pair[0];
      var checkbox = pair[1];
      if (input) {
        input.disabled = true;
        input.value = '';
        var note = document.createElement('p');
        note.className = 'wl-note wl-lock-note';
        note.textContent = '本次用这一项完成验证，不可修改。要修改它，请返回上一步改用别的验证方式。';
        if (input.parentNode) input.parentNode.insertBefore(note, input.nextSibling);
      }
      if (checkbox) {
        checkbox.disabled = true;
        checkbox.checked = false;
      }
    }

    /**
     * 三项都无法在线验证时的全人工通道引导。
     * 说明要走 QQ 群 / Discord，并提示提交时附上足够证据。
     */
    function renderManualHelp(factor, noAlternative) {
      var box = el('#modManual');
      if (!box) return;
      var f = (CFG && CFG.fallback) || {};
      box.hidden = false;
      box.innerHTML = '';

      var h = document.createElement('h2');
      h.textContent = '无法通过在线验证修改？';
      box.appendChild(h);

      var p = document.createElement('p');
      p.className = 'wl-hint';
      p.textContent = noAlternative
        ? '你的记录里没有其它可用于验证的联系方式，因此这一项无法在线自助修改。'
        : '如果邮箱与所选验证项都对不上（例如记不清当时填的 QQ / Discord），在线流程无法确认你的身份。';
      box.appendChild(p);

      var ul = document.createElement('ul');
      ul.className = 'wl-fallback-list';
      if (f.qqGroup) {
        var li = document.createElement('li');
        li.textContent = 'QQ 群：';
        var b1 = document.createElement('b');
        b1.className = 'wl-mono';
        b1.textContent = f.qqGroup;
        li.appendChild(b1);
        ul.appendChild(li);
      }
      if (f.discordInvite) {
        var li2 = document.createElement('li');
        li2.textContent = 'Discord：';
        var a = document.createElement('a');
        a.href = f.discordInvite;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = f.discordInvite;
        li2.appendChild(a);
        ul.appendChild(li2);
      }
      box.appendChild(ul);

      var ev = document.createElement('p');
      ev.className = 'wl-hint';
      ev.textContent =
        '请说明「网页无法完成修改」，并提供充足证据以便管理员人工核对：' +
        'Minecraft 游戏 ID、申请时使用的邮箱、能证明你拥有该账号的材料' +
        '（如原绑定 QQ / Discord 的截图、历史通知邮件、曾进服的记录或好友佐证等）。' +
        '材料越充分，人工审核越快。';
      box.appendChild(ev);
    }

    function applyFactorMeta() {
      var key = (fFactor && fFactor.value) || 'ign';
      var meta = FACTOR_META[key] || FACTOR_META.ign;
      if (fFactorLabel) fFactorLabel.textContent = meta.label;
      if (fFactorTip) fFactorTip.textContent = meta.tip;
      if (fFactorValue) {
        fFactorValue.placeholder = meta.placeholder;
        fFactorValue.maxLength = meta.max;
        fFactorValue.value = '';
      }
    }
    if (fFactor) {
      fFactor.addEventListener('change', applyFactorMeta);
      applyFactorMeta();
    }

    // 「更换绑定邮箱」开关
    if (fChangeEmail) {
      fChangeEmail.addEventListener('change', function () {
        if (fEmailBox) fEmailBox.hidden = !fChangeEmail.checked;
        if (!fChangeEmail.checked) {
          if (fNewEmail) fNewEmail.value = '';
          if (fNewEmailCode) fNewEmailCode.value = '';
        }
      });
    }

    // 向新邮箱发验证码（用途 change_email，与主身份的验证码互不影响）
    if (btnSendEmailCode) {
      btnSendEmailCode.addEventListener('click', function () {
        clearAlert(alertBox);
        var ne = (fNewEmail && fNewEmail.value || '').trim();
        if (!ne) return showAlert(alertBox, 'err', '请填写新的邮箱地址。');
        sendCode({ alert: alertBox, btn: btnSendEmailCode, purpose: 'change_email', email: ne });
      });
    }

    if (!btnVerify) return;

    // 「清空」与「填新值」互斥：勾了清空就禁用输入框，反之亦然
    function syncClear(input, checkbox) {
      if (!input || !checkbox) return;
      var on = checkbox.checked;
      input.disabled = on;
      if (on) input.value = '';
    }
    if (fClearQq) fClearQq.addEventListener('change', function () { syncClear(fNewQq, fClearQq); });
    if (fClearDiscord) fClearDiscord.addEventListener('change', function () { syncClear(fNewDiscord, fClearDiscord); });
    if (fNewQq) fNewQq.addEventListener('input', function () { if (fClearQq && (fNewQq.value || '').trim()) fClearQq.checked = false; });
    if (fNewDiscord) fNewDiscord.addEventListener('input', function () { if (fClearDiscord && (fNewDiscord.value || '').trim()) fClearDiscord.checked = false; });

    btnSend.addEventListener('click', function () {
      clearAlert(alertBox);
      var email = (fEmail.value || '').trim();
      var factor = (fFactor && fFactor.value) || '';
      var fv = (fFactorValue && fFactorValue.value || '').trim();
      if (!email) return showAlert(alertBox, 'err', '请填写邮箱。');
      if (!factor) return showAlert(alertBox, 'err', '请选择辅助验证方式。');
      if (!fv) return showAlert(alertBox, 'err', '请填写' + (FACTOR_META[factor] || {}).label + '。');
      sendCode({
        alert: alertBox, btn: btnSend, purpose: 'modify',
        email: email, factor: factor, factorValue: fv,
      });
    });

    btnVerify.addEventListener('click', async function () {
      clearAlert(alertBox);
      var email = (fEmail.value || '').trim();
      var factor = (fFactor && fFactor.value) || '';
      var fv = (fFactorValue && fFactorValue.value || '').trim();
      var code = (fCode.value || '').trim();
      if (!email) return showAlert(alertBox, 'err', '请填写邮箱。');
      if (!factor) return showAlert(alertBox, 'err', '请选择辅助验证方式。');
      if (!fv) return showAlert(alertBox, 'err', '请填写' + (FACTOR_META[factor] || {}).label + '。');
      if (!code) return showAlert(alertBox, 'err', '请填写邮箱收到的 6 位验证码。');

      setBusy(btnVerify, true, '验证中…');
      try {
        var v = await verifyCode({
          alert: alertBox, btn: btnVerify, purpose: 'modify',
          email: email, factor: factor, factorValue: fv, code: code,
        });
        if (!v) {
          /**
           * 引导走全人工通道。
           * 后端为防枚举，早已把「记录不存在 / 验证码错 / 辅助项对不上」
           * 统一成 code_invalid，不会再返回 not_found——
           * 早期这里只认 not_found，导致用户填错辅助验证项时只会看到
           * 「验证码不正确或信息不匹配」，反复重试却拿不到人工出口。
           */
          var errCode = lastErrCode || '';
          if (errCode === 'code_invalid' || errCode === 'not_found') renderManualHelp(factor);
          return;
        }

        ticketInput.value = v.ticket;
        var cur = v.current || {};
        curQq = cur.qq || '';
        curDiscord = cur.discord || '';
        curIgn = cur.ign || '';
        lockedFactor = v.lockedFactor || factor;

        if (curBox) {
          curBox.hidden = false;
          curBox.innerHTML = '';
          var h = document.createElement('p');
          h.className = 'wl-hint';
          h.textContent =
            '本次验证方式：' + (v.lockedFactorLabel || (FACTOR_META[lockedFactor] || {}).label || lockedFactor) +
            '（该项本次不可修改，要修改它请改用另外两项之一重新验证）。';
          curBox.appendChild(h);
          var dl = document.createElement('dl');
          dl.className = 'wl-kv';
          [['当前游戏 ID', cur.ign], ['当前 QQ', cur.qq || '未填写'], ['当前 Discord', cur.discord || '未填写']].forEach(
            function (pair) {
              var dt = document.createElement('dt');
              dt.textContent = pair[0];
              var dd = document.createElement('dd');
              dd.textContent = pair[1];
              dl.appendChild(dt);
              dl.appendChild(dd);
            }
          );
          curBox.appendChild(dl);
        }

        // 锁定「本次验证所用的那一项」：禁用其输入，避免白跑一趟被后端拒绝
        lockField(lockedFactor);
        if (fNewIgn) fNewIgn.placeholder = cur.ign || '';
        if (fNewQq) fNewQq.placeholder = cur.qq || '未填写';
        if (fNewDiscord) fNewDiscord.placeholder = cur.discord || '未填写';
        if (formBox) formBox.hidden = false;

        // 若唯一想改的那一项恰好被锁死、又没有其它可验证项，直接给出全人工通道
        var bound = v.boundFactors || {};
        var others = ['ign', 'qq', 'discord'].filter(function (k) {
          return k !== lockedFactor && bound[k];
        });
        if (!others.length) renderManualHelp(lockedFactor, true);

        showAlert(alertBox, 'ok', '验证通过，请填写需要修改的内容与修改理由。');
      } finally {
        setBusy(btnVerify, false);
        resetTurnstile();
      }
    });

    btnSubmit.addEventListener('click', async function () {
      clearAlert(alertBox);
      if (!ticketInput.value) {
        return showAlert(alertBox, 'err', '请先完成邮箱验证。');
      }

      var newIgn = (fNewIgn.value || '').trim();
      var newQq = (fNewQq && !fNewQq.disabled ? fNewQq.value : '') || '';
      newQq = newQq.trim();
      var newDiscord = (fNewDiscord && !fNewDiscord.disabled ? fNewDiscord.value : '') || '';
      newDiscord = newDiscord.trim();
      var clearQq = !!(fClearQq && fClearQq.checked);
      var clearDiscord = !!(fClearDiscord && fClearDiscord.checked);
      var reason = (fReason.value || '').trim();

      if (newIgn && !/^[A-Za-z0-9_]{3,16}$/.test(newIgn)) {
        return showAlert(alertBox, 'err', '新游戏 ID 只能包含字母、数字和下划线，长度 3-16 位。');
      }
      if (newQq && !/^[1-9][0-9]{4,10}$/.test(newQq)) {
        return showAlert(alertBox, 'err', 'QQ 号格式不正确（5-11 位数字）。');
      }
      /**
       * 后端把「邮箱变更」单独算一项有效变更，前端这里必须同步——
       * 早期漏了，导致只想换绑邮箱的用户（最常见的场景就是旧邮箱停用）
       * 被这句挡住，而且提示文案还是误导性的（没提邮箱）。
       */
      var changeEmail = !!(fChangeEmail && fChangeEmail.checked);
      if (!newIgn && !newQq && !newDiscord && !clearQq && !clearDiscord && !changeEmail) {
        return showAlert(alertBox, 'err', '请至少修改一项（游戏 ID / QQ / Discord / 绑定邮箱），或勾选「清空」。');
      }
      // 不能把 QQ 与 Discord 同时清空：至少要保留一个联系方式
      var keepQq = clearQq ? '' : newQq || (curQq || '');
      var keepDiscord = clearDiscord ? '' : newDiscord || (curDiscord || '');
      if (!keepQq && !keepDiscord) {
        return showAlert(alertBox, 'err', 'QQ 与 Discord 不能同时为空，请至少保留一个联系方式。');
      }
      // 本来就是空的再勾「清空」= 没有实际变更，后端会拒（no_change），这里提前挡掉
      if (clearQq && !curQq) {
        return showAlert(alertBox, 'err', '当前没有绑定 QQ，无需清空。如要补充 QQ，请直接填写新值。');
      }
      if (clearDiscord && !curDiscord) {
        return showAlert(alertBox, 'err', '当前没有绑定 Discord，无需清空。如要补充 Discord，请直接填写新值。');
      }
      if (reason.length < 5) {
        return showAlert(alertBox, 'err', '请填写修改理由（至少 5 个字）。');
      }
      if (changeEmail) {
        var ne2 = (fNewEmail && fNewEmail.value || '').trim();
        var nec = (fNewEmailCode && fNewEmailCode.value || '').trim();
        if (!ne2) return showAlert(alertBox, 'err', '请填写新的邮箱地址。');
        if (!/^\S+@\S+\.\S+$/.test(ne2)) return showAlert(alertBox, 'err', '新邮箱格式不正确。');
        if (!/^[0-9]{6}$/.test(nec)) return showAlert(alertBox, 'err', '请填写新邮箱收到的 6 位验证码。');
      }

      var token = takeToken();
      if (!token) return showAlert(alertBox, 'err', '请先完成人机验证。');

      setBusy(btnSubmit, true, '提交中…');
      try {
        var payload = {
          ticket: ticketInput.value,
          newIgn: newIgn,
          newQq: newQq,
          newDiscord: newDiscord,
          clearQq: clearQq,
          clearDiscord: clearDiscord,
          reason: reason,
          turnstileToken: token,
        };
        if (changeEmail) {
          payload.newEmail = (fNewEmail && fNewEmail.value || '').trim();
          payload.newEmailCode = (fNewEmailCode && fNewEmailCode.value || '').trim();
        }
        var data = await api('/api/whitelist/modify', payload);
        if (!data.ok) {
          if (data.error && data.error.code === 'ticket_invalid') ticketInput.value = '';
          return showAlert(alertBox, 'err', errMsg(data, '提交失败'));
        }
        var doneBox = el('#modDone');
        if (doneBox) {
          doneBox.hidden = false;
          var refEl = el('#modRef');
          if (refEl) refEl.textContent = data.reference;
        }
        showAlert(alertBox, 'ok', '修改申请已提交：' + data.reference + '。审核通过前当前白名单信息保持不变。');
        // 用 dataset.locked 而不是 disabled：finally 里的 setBusy(false) 会把 disabled 复原
        btnSubmit.dataset.locked = '1';
      } finally {
        setBusy(btnSubmit, false);
        resetTurnstile();
      }
    });
  }

  /* =========================================================
     启动
     ========================================================= */

  async function boot() {
    try {
      var res = await fetch('/api/whitelist/config', { credentials: 'same-origin' });
      CFG = await res.json();
    } catch (e) {
      CFG = { turnstile: { enabled: false, mockMode: false } };
    }
    bindTsReady();
    renderTurnstile();
    renderFallback();

    var page = document.body.dataset.page;
    if (page === 'apply') initApply();
    else if (page === 'inquire') initInquire();
    else if (page === 'modify') initModify();
  }

  /**
   * 「网页通道不可用 → 走全人工」提示块。
   * 内容由后端 /api/whitelist/config 下发（QQ 群号 / Discord 邀请链接），
   * 不写死在页面里，改群号只改环境变量即可。
   */
  function renderFallback() {
    var box = el('[data-fallback]');
    if (!box) return;
    var f = (CFG && CFG.fallback) || {};
    var qq = f.qqGroup || '';
    var dc = f.discordInvite || '';
    if (!qq && !dc) return;

    box.hidden = false;
    box.innerHTML = '';

    var h2 = document.createElement('h2');
    h2.textContent = '网页用不了？可以直接找管理员';
    box.appendChild(h2);

    var p = document.createElement('p');
    p.className = 'wl-hint';
    p.textContent =
      '如果本页面的申请 / 查询 / 修改功能无法正常使用（例如收不到验证码、页面报错、验证码一直不通过），' +
      '你可以直接加入下面的社区，说明自己无法在网页完成操作，管理员会走全人工流程为你添加白名单。';
    box.appendChild(p);

    var ul = document.createElement('ul');
    ul.className = 'wl-fallback-list';

    if (qq) {
      var liQq = document.createElement('li');
      liQq.textContent = 'QQ 群：';
      var strongQq = document.createElement('b');
      strongQq.className = 'wl-mono';
      strongQq.textContent = qq;
      liQq.appendChild(strongQq);
      ul.appendChild(liQq);
    }

    if (dc) {
      var liDc = document.createElement('li');
      liDc.textContent = 'Discord：';
      var a = document.createElement('a');
      a.href = dc;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = dc;
      liDc.appendChild(a);
      ul.appendChild(liDc);
    }

    box.appendChild(ul);

    var tip = document.createElement('p');
    tip.className = 'wl-note';
    tip.textContent = '进群 / 进 Discord 后，请说明「网页无法提交白名单申请」，并提供你的 Minecraft 游戏 ID。';
    box.appendChild(tip);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
