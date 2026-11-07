/* ============================================================
   LongerMC · 白名单审核后台前端
   依赖 Cloudflare Access 保护 /admin*
   ============================================================ */
(function () {
  'use strict';

  var API = '/admin/api/whitelist';

  var TABS = [
    { key: 'applications:pending_review', label: '待审核新申请', stat: 'pendingApplications' },
    { key: 'modifications:pending_review', label: '待审核修改', stat: 'pendingModifications' },
    { key: 'applications:manual_pending', label: '待人工加入原版白名单', stat: 'manualPending' },
    { key: 'applications:approved', label: '已通过', stat: 'approved' },
    { key: 'applications:rejected', label: '已拒绝', stat: 'rejected' },
    { key: 'applications:all', label: '全部申请' },
    { key: 'modifications:all', label: '全部修改申请' },
    { key: 'blacklist', label: '黑名单邮箱', stat: 'blacklistRules' },
    { key: 'outbox', label: '邮件发送记录' },
  ];

  var state = {
    tab: 'applications:pending_review',
    stats: {},
    actor: '',
    appCache: {},
    modCache: {},
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmt(t) {
    if (!t) return '—';
    var d = new Date(t);
    if (isNaN(d.getTime())) return esc(t);
    return d.toLocaleString('zh-CN', { hour12: false });
  }

  /**
   * 邮箱脱敏（发件箱列表用）。
   * 数据库里存的是完整地址（排查投递失败需要），这里只在展示层打码：
   * 后台页面可能被投屏 / 截图分享，列表批量暴露完整邮箱没必要。
   * 需要看完整地址时，打开对应申请的详情页即可。
   */
  function maskEmail(email) {
    var s = String(email || '');
    var at = s.indexOf('@');
    if (at <= 0) return s ? '***' : '—';
    var name = s.slice(0, at);
    var domain = s.slice(at + 1);
    var head = name.slice(0, 1);
    var tail = name.length >= 3 ? name.slice(-1) : '';
    var stars = '*'.repeat(Math.max(1, name.length - head.length - tail.length));
    var parts = domain.split('.');
    var main = parts[0] || '';
    var tld = parts.length > 1 ? '.' + parts.slice(1).join('.') : '';
    var maskedMain = main.length <= 1 ? main : main.slice(0, 1) + '*'.repeat(main.length - 1);
    return head + stars + tail + '@' + maskedMain + tld;
  }

  function alertBox(type, msg) {
    var box = byId('adminAlert');
    if (!box) return;
    box.className = 'wl-alert wl-alert--' + type;
    box.textContent = msg || '';
  }

  async function api(path, payload, method) {
    var opts = { method: method || 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin' };
    if (payload) opts.body = JSON.stringify(payload);
    var res = await fetch(API + path, opts);
    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = { ok: false, error: { code: 'bad_response', message: '服务端返回异常（HTTP ' + res.status + '）' } };
    }
    return data;
  }

  function errMsg(data, fallback) {
    return (data && data.error && data.error.message) || fallback || '操作失败';
  }

  /* ------------------------- 标签页 ------------------------- */

  function renderTabs() {
    var host = byId('adminTabs');
    if (!host) return;
    host.innerHTML = TABS.map(function (t) {
      var n = t.stat && state.stats[t.stat] !== undefined ? state.stats[t.stat] : '';
      return (
        '<button class="wl-tab' +
        (t.key === state.tab ? ' active' : '') +
        '" type="button" data-tab="' +
        esc(t.key) +
        '">' +
        esc(t.label) +
        (n !== '' ? '<span class="wl-count">(' + esc(n) + ')</span>' : '') +
        '</button>'
      );
    }).join('');

    Array.prototype.forEach.call(host.querySelectorAll('[data-tab]'), function (btn) {
      btn.addEventListener('click', function () {
        state.tab = btn.getAttribute('data-tab');
        renderTabs();
        loadPanel();
      });
    });
  }

  /* ------------------------- 列表 ------------------------- */

  var STATUS_TEXT = { pending_review: '待人工审核', approved: '已通过', rejected: '已拒绝' };

  function statusBadge(s) {
    var cls = s === 'approved' ? 'approved' : s === 'rejected' ? 'rejected' : 'pending';
    return '<span class="wl-status-badge wl-status-badge--' + cls + '">' + esc(STATUS_TEXT[s] || s) + '</span>';
  }

  function renderAppTable(items) {
    if (!items.length) return '<div class="wl-empty">暂无记录</div>';
    var rows = items
      .map(function (a) {
        var manual = a.status === 'approved'
          ? a.manual_whitelisted_at
            ? '<span style="color:var(--grass-2);">已加入</span>'
            : '<span style="color:var(--gold);">未加入</span>'
          : '—';
        return (
          '<tr>' +
          '<td class="wl-mono">' + esc(a.reference) + '</td>' +
          '<td>' + esc(a.ign) + '</td>' +
          '<td>' + esc(a.email) + '</td>' +
          '<td>' + esc(a.qq || '—') + '</td>' +
          '<td>' + esc(a.discord || '—') + '</td>' +
          '<td>' + statusBadge(a.status) + '</td>' +
          '<td>' + manual + '</td>' +
          '<td class="wl-mono">' + fmt(a.created_at) + '</td>' +
          '<td><a class="wl-link" data-app="' + a.id + '">详情 / 审核</a></td>' +
          '</tr>'
        );
      })
      .join('');

    return (
      '<div class="wl-table-wrap"><table class="wl-table"><thead><tr>' +
      '<th>编号</th><th>游戏 ID</th><th>邮箱</th><th>QQ</th><th>Discord</th><th>状态</th><th>原版白名单</th><th>提交时间</th><th>操作</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    );
  }

  /**
   * 格式化修改申请里的「新值」：
   *   null / undefined → 「（不变）」
   *   ''               → 「（清空）」
   *   其它             → 值本身
   */
  function fmtNew(v) {
    if (v === null || v === undefined) return '（不变）';
    if (String(v) === '') return '（清空）';
    return String(v);
  }

  function renderModTable(items) {
    if (!items.length) return '<div class="wl-empty">暂无记录</div>';
    var rows = items
      .map(function (m) {
        var changed = [];
        /**
         * 字段语义（与后端 pick() 一致，勿改）：
         *   null / undefined = 不变
         *   ''               = 清空
         *   其它             = 新值
         * 早期这里用 `m.new_qq || '（不变）'` 判断，空串被 || 吞掉，
         * 于是「清空」在页面上显示成「不变」——审核员看到的和执行的不一致。
         */
        var qqChanged = m.new_qq !== null && m.new_qq !== undefined;
        var dcChanged = m.new_discord !== null && m.new_discord !== undefined;
        if (m.ign_changed) changed.push('IGN');
        if (qqChanged) changed.push(m.new_qq === '' ? 'QQ（清空）' : 'QQ');
        if (dcChanged) changed.push(m.new_discord === '' ? 'Discord（清空）' : 'Discord');
        // 邮箱：换新值算变更；清空语义不适用（邮箱必填），所以只判非空新值
        if (m.email_changed && m.new_email) changed.push('邮箱');
        return (
          '<tr>' +
          '<td class="wl-mono">' + esc(m.reference) + '</td>' +
          '<td class="wl-mono">' + esc(m.app_reference || '#' + m.application_id) + '</td>' +
          '<td>' + esc(m.prev_ign) + (m.ign_changed ? ' → <b>' + esc(m.new_ign) + '</b>' : '') + '</td>' +
          '<td>' + esc(changed.join(' / ') || '—') + '</td>' +
          '<td>' + statusBadge(m.status) + '</td>' +
          '<td class="wl-mono">' + fmt(m.created_at) + '</td>' +
          '<td><a class="wl-link" data-mod="' + m.id + '">详情 / 审核</a></td>' +
          '</tr>'
        );
      })
      .join('');

    return (
      '<div class="wl-table-wrap"><table class="wl-table"><thead><tr>' +
      '<th>修改编号</th><th>关联申请</th><th>游戏 ID</th><th>变更项</th><th>状态</th><th>提交时间</th><th>操作</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    );
  }

  async function loadPanel() {
    var panel = byId('adminPanel');
    if (!panel) return;
    var key = state.tab;

    if (key === 'blacklist') return loadBlacklist(panel);
    if (key === 'outbox') return loadOutbox(panel);

    panel.innerHTML = '<div class="wl-empty">加载中…</div>';

    if (key.indexOf('applications:') === 0) {
      var status = key.split(':')[1];
      var data = await api('/applications?status=' + encodeURIComponent(status) + '&limit=100', null, 'GET');
      if (!data.ok) {
        panel.innerHTML = '';
        return alertBox('err', errMsg(data, '加载失败'));
      }
      (data.items || []).forEach(function (a) {
        state.appCache[a.id] = a;
      });
      panel.innerHTML = renderAppTable(data.items || []) + truncatedHint(data);
      bindRowLinks(panel, 'app', openApplication);
      return;
    }

    if (key.indexOf('modifications:') === 0) {
      var st = key.split(':')[1];
      var d2 = await api('/modifications?status=' + encodeURIComponent(st) + '&limit=100', null, 'GET');
      if (!d2.ok) {
        panel.innerHTML = '';
        return alertBox('err', errMsg(d2, '加载失败'));
      }
      (d2.items || []).forEach(function (m) {
        state.modCache[m.id] = m;
      });
      panel.innerHTML = renderModTable(d2.items || []) + truncatedHint(d2);
      bindRowLinks(panel, 'mod', openModification);
      return;
    }
  }

  /** 结果被 limit 截断时给出明确提示，避免静默少看数据 */
  function truncatedHint(data) {
    var total = data && typeof data.total === 'number' ? data.total : 0;
    var items = (data && data.items) || [];
    if (!total || total <= items.length) return '';
    return (
      '<p class="wl-note" style="padding:10px 14px;">共 ' +
      total +
      ' 条，当前只显示前 ' +
      items.length +
      ' 条。请用搜索框缩小范围，或调整请求参数 limit / offset。</p>'
    );
  }

  function bindRowLinks(panel, attr, handler) {
    Array.prototype.forEach.call(panel.querySelectorAll('[data-' + attr + ']'), function (link) {
      link.addEventListener('click', function () {
        handler(parseInt(link.getAttribute('data-' + attr), 10));
      });
    });
  }

  /* ------------------------- 弹窗 ------------------------- */

  function openModal(html) {
    var root = byId('modalRoot');
    root.innerHTML = '<div class="wl-modal-backdrop"><div class="wl-modal">' + html + '</div></div>';
    var close = root.querySelector('[data-close]');
    if (close) {
      close.addEventListener('click', closeModal);
    }
    var backdrop = root.querySelector('.wl-modal-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) closeModal();
      });
    }
  }

  function closeModal() {
    var root = byId('modalRoot');
    if (root) root.innerHTML = '';
  }

  function modalNode() {
    return document.querySelector('#modalRoot .wl-modal');
  }

  /* ------------------------- 申请详情 ------------------------- */

  async function openApplication(id) {
    var data = await api('/applications/' + id, null, 'GET');
    if (!data.ok) return alertBox('err', errMsg(data, '加载详情失败'));
    var a = data.application;

    var html =
      '<button class="wl-close" type="button" data-close aria-label="关闭">×</button>' +
      '<h3>申请详情 · <span class="wl-mono">' + esc(a.reference) + '</span></h3>' +
      '<dl class="wl-kv">' +
      kv('申请类型', '新申请') +
      kv('游戏 ID', esc(a.ign)) +
      kv('邮箱', esc(a.email)) +
      kv('邮箱验证', a.email_verified_at ? '已验证（' + fmt(a.email_verified_at) + '）' : '未验证') +
      kv('Turnstile', a.turnstile_ok ? '服务端校验通过' : '未通过') +
      kv('QQ', esc(a.qq || '未填写')) +
      kv('Discord', esc(a.discord || '未填写')) +
      kv('提交时间', fmt(a.created_at)) +
      kv('当前状态', statusBadge(a.status)) +
      (a.reject_reason ? kv('拒绝原因', esc(a.reject_reason)) : '') +
      (a.review_note ? kv('管理员备注', esc(a.review_note)) : '') +
      kv('审核人', esc(a.reviewed_by || '—')) +
      kv('审核时间', fmt(a.reviewed_at)) +
      kv('已加入原版白名单', a.manual_whitelisted_at ? '是（' + fmt(a.manual_whitelisted_at) + '，' + esc(a.manual_whitelist_by || '') + '）' : '否') +
      '</dl>' +
      '<h3 style="margin-top:20px;">原版命令</h3>' +
      '<div class="wl-cmd">' +
      '<code>' + esc(data.vanillaCommand) + '</code>' +
      '<button class="wl-btn" type="button" data-copy="' + esc(data.vanillaCommand) + '" data-copy-done="已复制"><span data-copy-label>复制命令</span></button>' +
      '</div>' +
      '<p class="wl-note">请手动到 Minecraft 服务器执行以上命令；本系统不会自动修改 whitelist.json。</p>' +
      '<div style="margin-top:16px;">' +
      '<label class="wl-switch"><input type="checkbox" id="manualDone"' + (a.manual_whitelisted_at ? ' checked' : '') + '> 已人工加入原版白名单</label>' +
      '<input class="wl-input" id="manualNote" style="margin-top:8px;" maxlength="500" placeholder="备注（可选）" value="' + esc(a.manual_whitelist_note || '') + '" />' +
      '<div class="wl-actions"><button class="wl-btn" id="btnManual" type="button">保存标记</button></div>' +
      '</div>' +
      modsHtml(data.modifications || []) +
      '<h3 style="margin-top:20px;">审核操作</h3>' +
      '<div class="wl-field"><label class="wl-label">通过备注（可选）</label>' +
      '<textarea class="wl-textarea" id="reviewNote" maxlength="500" placeholder="例如：已确认 QQ 群成员，QQ 等级满 15"></textarea></div>' +
      '<div class="wl-actions"><button class="wl-btn wl-btn--primary" id="btnApprove" type="button">通过申请</button></div>' +
      '<div class="wl-field" style="margin-top:14px;"><label class="wl-label">拒绝原因（必填）</label>' +
      '<textarea class="wl-textarea" id="rejectReason" maxlength="500" placeholder="例如：未加入 QQ 群，QQ 等级不足 15 级"></textarea></div>' +
      '<div class="wl-actions"><button class="wl-btn" id="btnReject" type="button">拒绝申请</button></div>' +
      '<h3 style="margin-top:20px;">审核日志</h3>' +
      logsHtml(data.auditLogs || []);

    openModal(html);
    var modal = modalNode();

    var btnManual = modal.querySelector('#btnManual');
    if (btnManual) {
      btnManual.addEventListener('click', async function () {
        var done = modal.querySelector('#manualDone').checked;
        var r = await api('/applications/' + a.id + '/manual', {
          done: done,
          note: modal.querySelector('#manualNote').value,
        });
        if (!r.ok) return alertBox('err', errMsg(r, '保存失败'));
        alertBox('ok', done ? '已标记为「已人工加入原版白名单」。' : '已取消标记。');
        closeModal();
        refreshAll();
      });
    }

    bindReview(modal, 'applications', a.id, '#reviewNote', '#btnApprove', '#rejectReason', '#btnReject', 'applications/' + a.id);
  }

  function kv(k, v) {
    return '<dt>' + k + '</dt><dd>' + v + '</dd>';
  }

  function modsHtml(mods) {
    if (!mods.length) return '';
    var rows = mods
      .map(function (m) {
        return (
          '<tr><td class="wl-mono">' + esc(m.reference) + '</td>' +
          '<td>' + esc(m.prev_ign) + ' → ' + esc(m.new_ign || m.prev_ign) + '</td>' +
          '<td>' + esc(m.prev_qq || '—') + ' → ' + esc(fmtNew(m.new_qq)) + '</td>' +
          '<td>' + esc(m.prev_discord || '—') + ' → ' + esc(fmtNew(m.new_discord)) + '</td>' +
          '<td>' + statusBadge(m.status) + '</td>' +
          '<td><a class="wl-link" data-mod="' + m.id + '">查看</a></td></tr>'
        );
      })
      .join('');
    return (
      '<h3 style="margin-top:20px;">关联修改申请</h3>' +
      '<table class="wl-diff"><thead><tr><th>编号</th><th>游戏 ID</th><th>QQ</th><th>Discord</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
      rows +
      '</tbody></table>'
    );
  }

  function logsHtml(logs) {
    if (!logs.length) return '<p class="wl-note">暂无日志</p>';
    return (
      '<ul class="wl-log">' +
      logs
        .map(function (l) {
          return (
            '<li><time>' + fmt(l.created_at) + '</time><b>' + esc(l.actor || 'system') + '</b> · ' +
            esc(l.action) + (l.note ? ' · ' + esc(l.note) : '') +
            (l.ip_hash ? ' <span class="wl-mono" style="color:var(--muted-2);">ip:' + esc(l.ip_hash) + '</span>' : '') +
            '</li>'
          );
        })
        .join('') +
      '</ul>'
    );
  }

  /* ------------------------- 修改申请详情 ------------------------- */

  async function openModification(id) {
    var data = await api('/modifications/' + id, null, 'GET');
    if (!data.ok) return alertBox('err', errMsg(data, '加载详情失败'));
    var m = data.modification;
    var a = data.application || {};

    var html =
      '<button class="wl-close" type="button" data-close aria-label="关闭">×</button>' +
      '<h3>修改申请 · <span class="wl-mono">' + esc(m.reference) + '</span></h3>' +
      '<dl class="wl-kv">' +
      kv('申请类型', '信息修改') +
      kv('关联申请', esc(a.reference || '#' + m.application_id)) +
      kv('邮箱', esc(m.email_norm)) +
      kv('邮箱验证', m.email_verified_at ? '已验证（' + fmt(m.email_verified_at) + '）' : '未验证') +
      kv('Turnstile', m.turnstile_ok ? '服务端校验通过' : '未通过') +
      kv('提交时间', fmt(m.created_at)) +
      kv('当前状态', statusBadge(m.status)) +
      (m.reject_reason ? kv('拒绝原因', esc(m.reject_reason)) : '') +
      kv('审核人', esc(m.reviewed_by || '—')) +
      kv('审核时间', fmt(m.reviewed_at)) +
      '</dl>' +
      '<h3 style="margin-top:18px;">修改前后对比</h3>' +
      '<table class="wl-diff"><thead><tr><th>字段</th><th>原值</th><th>新值</th></tr></thead><tbody>' +
      '<tr><td>游戏 ID</td><td>' + esc(m.prev_ign) + '</td><td>' + esc(fmtNew(m.new_ign)) + '</td></tr>' +
      '<tr><td>QQ</td><td>' + esc(m.prev_qq || '未填写') + '</td><td>' + esc(fmtNew(m.new_qq)) + '</td></tr>' +
      '<tr><td>Discord</td><td>' + esc(m.prev_discord || '未填写') + '</td><td>' + esc(fmtNew(m.new_discord)) + '</td></tr>' +
      /**
       * 换绑邮箱必须能在详情里看到前后值：
       * 换绑等于「账户归属转移」——审核员如果看不到新地址就点了通过，
       * 等于把别人的白名单交给了提交者。后端字段与接口早就返回了，
       * 列表页也能显示「邮箱」标签，唯独详情缺这一行。
       */
      (m.email_changed
        ? '<tr><td>绑定邮箱</td><td>' + esc(m.prev_email || '—') + '</td><td>' + esc(m.new_email || '（清空）') + '</td></tr>'
        : '<tr><td>绑定邮箱</td><td colspan="2">' + esc(m.prev_email || m.email_norm || '—') + '（不变）</td></tr>') +
      '</tbody></table>' +
      '<div class="wl-field" style="margin-top:14px;"><label class="wl-label">修改理由</label>' +
      '<div class="wl-alert wl-alert--info">' + esc(m.reason) + '</div></div>' +
      (m.ign_changed
        ? '<div class="wl-alert wl-alert--warn">游戏 ID 发生变更：审核通过后，你必须到原版服务器手动移除旧 ID 并添加新 ID。</div>'
        : '') +
      (m.email_changed
        ? '<div class="wl-alert wl-alert--warn">绑定邮箱将变更：请确认新邮箱确实由本人控制（系统已独立验证过新邮箱的验证码）。通过后，通知邮件会发往新邮箱。</div>'
        : '') +
      '<h3 style="margin-top:18px;">原版命令</h3>' +
      '<div class="wl-cmd"><code>' + esc(data.vanillaAdd) + '</code>' +
      '<button class="wl-btn" type="button" data-copy="' + esc(data.vanillaAdd) + '" data-copy-done="已复制"><span data-copy-label>复制命令</span></button></div>' +
      (data.vanillaRemove
        ? '<div class="wl-cmd"><code>' + esc(data.vanillaRemove) + '</code>' +
          '<button class="wl-btn" type="button" data-copy="' + esc(data.vanillaRemove) + '" data-copy-done="已复制"><span data-copy-label>复制移除命令</span></button></div>'
        : '') +
      '<h3 style="margin-top:20px;">审核操作</h3>' +
      '<div class="wl-field"><label class="wl-label">通过备注（可选）</label>' +
      '<textarea class="wl-textarea" id="reviewNote" maxlength="500"></textarea></div>' +
      '<div class="wl-actions"><button class="wl-btn wl-btn--primary" id="btnApprove" type="button">通过修改</button></div>' +
      '<div class="wl-field" style="margin-top:14px;"><label class="wl-label">拒绝原因（必填）</label>' +
      '<textarea class="wl-textarea" id="rejectReason" maxlength="500" placeholder="说明为什么不能修改"></textarea></div>' +
      '<div class="wl-actions"><button class="wl-btn" id="btnReject" type="button">拒绝修改</button></div>' +
      '<h3 style="margin-top:20px;">审核日志</h3>' +
      logsHtml(data.auditLogs || []);

    openModal(html);
    bindReview(modalNode(), 'modifications', m.id, '#reviewNote', '#btnApprove', '#rejectReason', '#btnReject', 'modifications/' + m.id);
  }

  function bindReview(modal, kind, id, noteSel, approveSel, reasonSel, rejectSel, path) {
    var btnApprove = modal.querySelector(approveSel);
    var btnReject = modal.querySelector(rejectSel);

    if (btnApprove) {
      btnApprove.addEventListener('click', async function () {
        var note = modal.querySelector(noteSel).value || '';
        btnApprove.disabled = true;
        var r = await api('/' + path + '/approve', { note: note });
        btnApprove.disabled = false;
        if (!r.ok) return alertBox('err', errMsg(r, '操作失败'));
        alertBox('ok', (r.hint || '已通过') + ' 邮件状态：' + (r.email && r.email.status));
        closeModal();
        refreshAll();
      });
    }

    if (btnReject) {
      btnReject.addEventListener('click', async function () {
        var reason = (modal.querySelector(reasonSel).value || '').trim();
        if (reason.length < 5) return alertBox('err', '拒绝原因至少 5 个字');
        btnReject.disabled = true;
        var r = await api('/' + path + '/reject', { reason: reason });
        btnReject.disabled = false;
        if (!r.ok) return alertBox('err', errMsg(r, '操作失败'));
        alertBox('ok', '已拒绝，邮件状态：' + (r.email && r.email.status));
        closeModal();
        refreshAll();
      });
    }
  }

  /* ------------------------- 黑名单 ------------------------- */

  async function loadBlacklist(panel) {
    var data = await api('/blacklist', null, 'GET');
    if (!data.ok) {
      panel.innerHTML = '';
      return alertBox('err', errMsg(data, '加载失败'));
    }
    var items = data.items || [];

    var rows = items
      .map(function (b) {
        return (
          '<tr>' +
          '<td>' + esc(b.rule_type === 'exact' ? '精确' : '正则') + '</td>' +
          '<td class="wl-mono" style="word-break:break-all;">' + esc(b.rule) + '</td>' +
          '<td>' + esc(b.reason || '—') + '</td>' +
          '<td>' + (b.enabled ? '<span style="color:var(--grass-2);">启用</span>' : '<span style="color:var(--muted);">停用</span>') + '</td>' +
          '<td class="wl-mono">' + fmt(b.created_at) + '</td>' +
          '<td>' +
          '<a class="wl-link" data-toggle="' + b.id + '" data-enabled="' + (b.enabled ? '0' : '1') + '">' + (b.enabled ? '停用' : '启用') + '</a> · ' +
          '<a class="wl-link" data-del="' + b.id + '">删除</a>' +
          '</td>' +
          '</tr>'
        );
      })
      .join('');

    panel.innerHTML =
      '<div class="wl-card">' +
      '<h2>新增黑名单规则</h2>' +
      '<p class="wl-hint">精确规则填写完整邮箱；正则规则填写正则表达式（长度 ≤ 200，禁止嵌套量词以避免 ReDoS）。</p>' +
      '<div class="wl-row">' +
      '<div class="wl-field"><label class="wl-label">类型</label>' +
      '<select class="wl-select" id="blType"><option value="exact">精确邮箱</option><option value="regex">正则</option></select></div>' +
      '<div class="wl-field"><label class="wl-label">规则值</label>' +
      '<input class="wl-input" id="blRule" maxlength="200" placeholder="spam@example.com 或 ^.*@example\\.com$" /></div>' +
      '<div class="wl-field"><label class="wl-label">原因</label>' +
      '<input class="wl-input" id="blReason" maxlength="200" placeholder="例如：滥用申请" /></div>' +
      '</div>' +
      '<div class="wl-actions"><button class="wl-btn wl-btn--primary" id="blAdd" type="button">新增规则</button></div>' +
      '</div>' +
      '<div class="wl-card">' +
      '<h2>规则列表</h2>' +
      (items.length
        ? '<div class="wl-table-wrap"><table class="wl-table"><thead><tr><th>类型</th><th>规则值</th><th>原因</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>' +
          rows +
          '</tbody></table></div>'
        : '<div class="wl-empty">暂无规则（初始规则由管理员提供后在此维护）</div>') +
      '</div>';

    var addBtn = byId('blAdd');
    if (addBtn) {
      addBtn.addEventListener('click', async function () {
        var r = await api('/blacklist', {
          ruleType: byId('blType').value,
          rule: byId('blRule').value,
          reason: byId('blReason').value,
          enabled: true,
        });
        if (!r.ok) return alertBox('err', errMsg(r, '新增失败'));
        alertBox('ok', '规则已新增');
        loadPanel();
        refreshStats();
      });
    }

    Array.prototype.forEach.call(panel.querySelectorAll('[data-toggle]'), function (link) {
      link.addEventListener('click', async function () {
        var id = link.getAttribute('data-toggle');
        var enabled = link.getAttribute('data-enabled') === '1';
        var r = await api('/blacklist/' + id + '/update', { enabled: enabled });
        if (!r.ok) return alertBox('err', errMsg(r, '更新失败'));
        loadPanel();
        refreshStats();
      });
    });

    Array.prototype.forEach.call(panel.querySelectorAll('[data-del]'), function (link) {
      link.addEventListener('click', async function () {
        if (!window.confirm('确认删除该黑名单规则？')) return;
        var r = await api('/blacklist/' + link.getAttribute('data-del') + '/delete', {});
        if (!r.ok) return alertBox('err', errMsg(r, '删除失败'));
        alertBox('ok', '已删除');
        loadPanel();
        refreshStats();
      });
    });
  }

  /* ------------------------- 邮件记录 ------------------------- */

  async function loadOutbox(panel) {
    var data = await api('/outbox?limit=50', null, 'GET');
    if (!data.ok) {
      panel.innerHTML = '';
      return alertBox('err', errMsg(data, '加载失败'));
    }
    var items = data.items || [];
    var rows = items
      .map(function (e) {
        var color = e.status === 'sent' ? 'var(--grass-2)' : e.status === 'failed' ? 'var(--red)' : 'var(--gold)';
        return (
          '<tr>' +
          '<td class="wl-mono">' + fmt(e.created_at) + '</td>' +
          '<td>' + esc(maskEmail(e.to_email)) + '</td>' +
          '<td>' + esc(e.subject) + '</td>' +
          '<td>' + esc(e.template || '—') + '</td>' +
          '<td style="color:' + color + ';">' + esc(e.status) + '</td>' +
          '<td class="wl-mono" style="word-break:break-all;">' + esc(e.error || '') + '</td>' +
          '</tr>'
        );
      })
      .join('');

    panel.innerHTML =
      '<div class="wl-card"><h2>邮件发送记录</h2>' +
      '<p class="wl-hint">status=sent 表示已通过 Resend 真实发送；simulated 表示未配置 RESEND_API_KEY，仅写入本地发件箱（开发环境）。收件人已脱敏显示，完整地址见申请详情。</p>' +
      (items.length
        ? '<div class="wl-table-wrap"><table class="wl-table"><thead><tr><th>时间</th><th>收件人</th><th>主题</th><th>模板</th><th>状态</th><th>错误</th></tr></thead><tbody>' +
          rows +
          '</tbody></table></div>'
        : '<div class="wl-empty">暂无记录</div>') +
      '</div>';
  }

  /* ------------------------- 启动 ------------------------- */

  async function refreshStats() {
    var data = await api('/stats', null, 'GET');
    if (data && data.ok) {
      state.stats = data.stats || {};
      renderTabs();
    }
  }

  async function refreshAll() {
    await refreshStats();
    await loadPanel();
  }

  async function boot() {
    var me = await api('/me', null, 'GET');
    if (!me.ok) {
      var box = byId('adminPanel');
      if (box) box.innerHTML = '';
      alertBox(
        'err',
        '未通过管理员认证：' +
          errMsg(me, '请确认已用 Cloudflare Access 登录，且 Access 应用覆盖了 /admin* 路径') +
          '（来自 Functions 的身份校验）'
      );
      return;
    }
    state.actor = me.actor;
    var actorEl = byId('adminActor');
    if (actorEl) actorEl.textContent = me.actor;

    renderTabs();
    await refreshStats();
    await loadPanel();

    var btn = byId('btnRefresh');
    if (btn) btn.addEventListener('click', refreshAll);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
