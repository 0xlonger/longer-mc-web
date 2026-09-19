/* ============================================================
   LongerMC · 服务器状态脚本
   数据源：api.mcsrvstat.us
   仅在存在状态节点的页面（index.html）执行
   ============================================================ */
(function () {
  'use strict';

  var SERVER_IP = 'play.mc.longer.xin';
  var API = 'https://api.mcsrvstat.us/3/' + SERVER_IP;
  var REFRESH_MS = 60000;   // 刷新间隔
  var TIMEOUT_MS = 12000;   // 单次请求超时

  var dotEl = document.getElementById('statusDot');
  var stateEl = document.getElementById('statState');
  var playerEl = document.getElementById('statPlayer');
  var versionEl = document.getElementById('statVersion');
  var panelEl = document.getElementById('playersPanel');
  var listEl = document.getElementById('playerList');

  // 不是状态页，直接退出
  if (!dotEl || !stateEl || !playerEl) return;

  var timer = null;
  var loading = false;
  var hasResult = false; // 是否已经拿到过一次有效结果

  /* ---------- 工具函数 ---------- */
  function esc(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 去掉 Minecraft 格式化代码（§a、§l 之类）
  function clean(str) {
    return String(str == null ? '' : str).replace(/§./g, '').trim();
  }

  function setState(cls, text) {
    dotEl.className = 'dot' + (cls ? ' ' + cls : '');
    stateEl.textContent = text;
  }

  /* ---------- 渲染 ---------- */
  function renderUnknown() {
    setState('', '暂时无法获取');
    playerEl.textContent = '--';
    if (panelEl) panelEl.hidden = true;
  }

  function renderOffline() {
    hasResult = true;
    setState('off', '离线 / 维护中');
    playerEl.textContent = '0';
    if (panelEl) panelEl.hidden = true;
  }

  function renderOnline(data) {
    hasResult = true;
    setState('on', '在线');

    var players = data.players || {};
    var online = Number(players.online) || 0;
    var max = Number(players.max) || 0;
    playerEl.textContent = max > 0 ? online + ' / ' + max : String(online);

    // 版本号以接口返回为准（可能包含格式化代码）
    if (versionEl && data.version) {
      var v = clean(data.version);
      if (v) versionEl.textContent = v;
    }

    // 在线玩家名单
    var list = Array.isArray(players.list) ? players.list : null;
    if (list && list.length && panelEl && listEl) {
      listEl.innerHTML = list.slice(0, 60).map(function (name) {
        return '<span class="player-chip">' + esc(clean(name)) + '</span>';
      }).join('');
      panelEl.hidden = false;
    } else if (panelEl) {
      panelEl.hidden = true;
    }
  }

  /* ---------- 请求 ---------- */
  function load() {
    if (loading) return;
    loading = true;

    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timeoutId = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;

    fetch(API, {
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (data && data.online) {
          renderOnline(data);
        } else {
          renderOffline();
        }
      })
      .catch(function () {
        // 首次加载失败才提示；之后失败保留上一次的结果，避免闪烁
        if (!hasResult) renderUnknown();
      })
      .then(function () {
        if (timeoutId) clearTimeout(timeoutId);
        loading = false;
        schedule();
      });
  }

  /* ---------- 轮询调度 ---------- */
  function schedule() {
    clearTimeout(timer);
    if (document.hidden) { timer = null; return; }
    timer = setTimeout(load, REFRESH_MS);
  }

  // 页面切到后台时停止轮询，切回来立即刷新一次
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      clearTimeout(timer);
      timer = null;
    } else if (!timer && !loading) {
      load();
    }
  });

  // 首次加载
  load();
})();