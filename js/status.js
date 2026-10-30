/* ============================================================
   LongerMC · 服务器状态脚本
   数据源：api.mcsrvstat.us
   首页渲染完整状态面板；404 页只更新导航上的状态小圆点
   ============================================================ */
(function () {
  'use strict';

  // 导航、页脚由片段异步注入，等它们就位后再初始化
  lmcReady(function () {

    var SERVER_IP = 'play.mc.longer.xin';
    var API = 'https://api.mcsrvstat.us/3/' + SERVER_IP;
    var REFRESH_MS = 60000;   // 刷新间隔
    var TIMEOUT_MS = 12000;   // 单次请求超时

    function byId(id) { return document.getElementById(id); }

    var el = {
      dot: byId('statusDot'),
      state: byId('statState'),
      player: byId('statPlayer'),
      version: byId('statVersion'),
      motd: byId('statMotd'),
      updated: byId('statUpdated'),
      ping: byId('pingBars'),
      refresh: byId('refreshStatus'),
      panel: byId('playersPanel'),
      list: byId('playerList'),
      count: byId('playerCount'),
      heroDot: byId('heroDot'),
      heroState: byId('heroState'),
      heroOnline: byId('heroOnline'),
      navDot: byId('navDot'),
      navState: byId('navState')
    };

    // 既没有状态面板、也没有导航状态节点，才退出
    var isStatusPage = !!(el.dot && el.state);
    if (!isStatusPage && !el.navState) return;

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

    function pad(n) { return n < 10 ? '0' + n : String(n); }

    function timeText() {
      var d = new Date();
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    /* ---------- 状态渲染 ---------- */
    // kind: '' | 'on' | 'off'
    function setState(kind, text) {
      if (el.dot) el.dot.className = 'dot' + (kind ? ' ' + kind : '');
      if (el.state) el.state.textContent = text;

      if (el.ping) el.ping.className = 'ping-bars' + (kind ? ' ' + kind : '');

      if (el.heroDot) el.heroDot.className = 'dot' + (kind ? ' ' + kind : '');
      if (el.navDot) el.navDot.className = 'dot' + (kind ? ' ' + kind : '');

      if (el.heroState) {
        el.heroState.textContent = kind === 'on' ? '服务器在线'
          : kind === 'off' ? '服务器维护中'
          : '正在连接服务器…';
      }

      if (el.navState) {
        el.navState.textContent = kind === 'on' ? '在线'
          : kind === 'off' ? '离线'
          : '检测中';
      }
    }

    function setUpdated(text, isError) {
      if (!el.updated) return;
      el.updated.textContent = text;
      el.updated.classList.toggle('is-error', !!isError);
    }

    function setHeroPlayers(online, max) {
      if (!el.heroOnline) return;
      el.heroOnline.textContent = max > 0 ? online + ' / ' + max : String(online);
    }

    function setRefreshing(on) {
      if (!el.refresh) return;
      el.refresh.classList.toggle('is-spinning', on);
      el.refresh.setAttribute('aria-busy', on ? 'true' : 'false');
    }

    function renderUnknown() {
      setState('', '暂时无法获取');
      if (el.player) el.player.textContent = '--';
      setHeroPlayers(0, 0);
      if (el.heroOnline) el.heroOnline.textContent = '--';
      if (el.panel) el.panel.hidden = true;
      setUpdated('同步失败，稍后重试', true);
    }

    function renderOffline() {
      hasResult = true;
      setState('off', '离线 / 维护中');
      if (el.player) el.player.textContent = '0';
      setHeroPlayers(0, 0);
      if (el.panel) el.panel.hidden = true;
      setUpdated('更新于 ' + timeText());
    }

    // 玩家名可能是字符串，也可能是 { name, uuid } 对象（API v3）
    function playerName(item) {
      if (item == null) return '';
      if (typeof item === 'string') return clean(item);
      if (typeof item === 'object') {
        return clean(item.name || item.username || item.uuid || '');
      }
      return clean(item);
    }

    function renderOnline(data) {
      hasResult = true;
      setState('on', '在线');

      var players = data.players || {};
      var online = Number(players.online) || 0;
      var max = Number(players.max) || 0;
      if (el.player) el.player.textContent = max > 0 ? online + ' / ' + max : String(online);
      setHeroPlayers(online, max);

      // 版本号以接口返回为准（可能包含格式化代码）
      if (el.version && data.version) {
        var v = clean(data.version);
        if (v) el.version.textContent = v;
      }

      // MOTD
      if (el.motd && data.motd) {
        var lines = data.motd.clean;
        if (Array.isArray(lines)) {
          var motd = lines.map(clean).filter(Boolean).join(' · ');
          if (motd) el.motd.textContent = motd;
        } else if (typeof lines === 'string') {
          var single = clean(lines);
          if (single) el.motd.textContent = single;
        }
      }

      // 在线玩家名单
      var rawList = Array.isArray(players.list) ? players.list : null;
      var names = rawList ? rawList.map(playerName).filter(Boolean) : [];

      if (names.length && el.panel && el.list) {
        el.list.innerHTML = names.slice(0, 60).map(function (name) {
          var safe = esc(name);
          var skin = 'https://minotar.net/helm/' + encodeURIComponent(name) + '/40.png';
          return '<span class="player-chip" title="' + safe + '">' +
            '<span class="player-avatar">' +
              '<svg class="pixel-head" aria-hidden="true"><use href="#i-head"/></svg>' +
              '<img src="' + skin + '" alt="" width="20" height="20" loading="lazy" decoding="async" onerror="this.remove()">' +
            '</span>' +
            '<span>' + safe + '</span></span>';
        }).join('');

        if (el.count) {
          el.count.textContent = names.length > 60
            ? '显示前 60 / 共 ' + names.length + ' 人'
            : '共 ' + names.length + ' 人';
        }
        el.panel.hidden = false;
      } else if (el.panel) {
        el.panel.hidden = true;
      }

      setUpdated('更新于 ' + timeText());
    }

    /* ---------- 请求 ---------- */
    function load(manual) {
      if (loading) return;
      loading = true;
      setRefreshing(true);
      if (manual) setUpdated('正在同步…');

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
          else setUpdated('同步失败，稍后重试', true);
        })
        .then(function () {
          if (timeoutId) clearTimeout(timeoutId);
          loading = false;
          setRefreshing(false);
          schedule();
        });
    }

    /* ---------- 轮询调度 ---------- */
    function schedule() {
      clearTimeout(timer);
      if (document.hidden) { timer = null; return; }
      timer = setTimeout(function () { load(false); }, REFRESH_MS);
    }

    if (el.refresh) {
      el.refresh.addEventListener('click', function () { load(true); });
    }

    // 页面切到后台时停止轮询，切回来立即刷新一次
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        clearTimeout(timer);
        timer = null;
      } else if (!timer && !loading) {
        load(false);
      }
    });

    // 首次加载
    load(false);
  });

  /* 等待 nav / footer 片段注入完成；异常或超时也会执行，保证交互不失效 */
  function lmcReady(fn) {
    var pending = window.LMC_PARTIALS || [];
    if (!pending.length) { fn(); return; }
    var timeout = new Promise(function (resolve) { setTimeout(resolve, 3000); });
    Promise.race([Promise.all(pending).catch(function () {}), timeout]).then(fn);
  }
})();
