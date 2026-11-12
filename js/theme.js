/* ============================================================
   LongerMC · 主题切换：浅色 / 跟随系统 / 深色
   - 首次访问默认深色（各页 <head> 内联脚本与 <html> 静态属性兜底）
   - 用户偏好存 localStorage('lmc-theme')：'light' | 'system' | 'dark'
   - <html data-theme>      始终是解析后的实际外观（light / dark），供 CSS 使用
     <html data-theme-pref>  保存用户偏好，供按钮图标 / 文案使用
   - 点击 [data-theme-toggle] 按 浅色 → 跟随系统 → 深色 → 浅色 循环
   - 跟随系统时监听系统配色变化，实时切换外观与 theme-color
   ============================================================ */
(function () {
  'use strict';

  var KEY = 'lmc-theme';
  var VALID = { light: 1, system: 1, dark: 1 };
  var CYCLE = { light: 'system', system: 'dark', dark: 'light' };
  var LABEL = { light: '浅色', system: '跟随系统', dark: '深色' };
  var COLORS = { light: '#f4efe9', dark: '#171615' };

  var root = document.documentElement;
  var meta = document.querySelector('meta[name="theme-color"]');
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function pref() {
    var p = root.getAttribute('data-theme-pref');
    return VALID[p] ? p : 'dark';
  }

  function resolve(p) {
    if (p === 'system') return mq && mq.matches ? 'dark' : 'light';
    return p;
  }

  /* 同步外观、按钮文案与浏览器地址栏颜色 */
  function paint() {
    var p = pref(), theme = resolve(p), next = CYCLE[p];
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-theme-pref', p);
    if (meta) meta.setAttribute('content', COLORS[theme]);

    var label = '主题：' + LABEL[p] + '（点击切换为' + LABEL[next] + '）';
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-label', label);
      buttons[i].setAttribute('title', label);
    }
  }

  function set(p) {
    root.setAttribute('data-theme-pref', p);
    try { localStorage.setItem(KEY, p); } catch (e) { /* 隐私模式等场景静默 */ }
    paint();
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-theme-toggle]');
    if (!btn) return;
    set(CYCLE[pref()]);
  });

  /* 跟随系统时，系统配色变化即时生效 */
  if (mq) {
    var onChange = function () { if (pref() === 'system') paint(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  /* nav / footer 片段异步注入，按钮就位后补一次文案（3s 超时兜底） */
  function lmcPartialsReady(fn) {
    var pending = window.LMC_PARTIALS || [];
    if (!pending.length) { fn(); return; }
    var timeout = new Promise(function (resolve) { window.setTimeout(resolve, 3000); });
    Promise.race([Promise.all(pending).catch(function () {}), timeout]).then(fn);
  }

  paint();
  lmcPartialsReady(paint);
})();
