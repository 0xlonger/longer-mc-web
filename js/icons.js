/* ============================================================
   LongerMC · 白名单相关页面的图标 sprite
   说明：index.html / 404.html 自带完整 sprite；
   新增的 /whitelist/* 与 /admin/* 页面用本脚本同步注入精简版，
   保证 nav / footer 片段中的 <use href="#i-xxx"> 能正常渲染。
   使用方式（放在 <body> 最前面，不要加 defer）：
     <script src="/js/icons.js"></script>
   ============================================================ */
(function () {
  'use strict';

  var SPRITE =
    '<svg class="svg-sprite" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden">' +
    '<symbol id="i-copy" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"><path d="M9 3h11v14h-4"/><path d="M4 8h11v13H4z"/></g></symbol>' +
    '<symbol id="i-home" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"><path d="M3 11 12 3l9 8v10H3z"/><path d="M10 21v-6h4v6"/></g></symbol>' +
    '<symbol id="i-check" viewBox="0 0 24 24"><path d="m4 12 5 5L20 5" fill="none" stroke="currentColor" stroke-width="2"/></symbol>' +
    '<symbol id="i-arrow" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><path d="M4 12h15"/><path d="m13 6 6 6-6 6"/></g></symbol>' +
    '<symbol id="i-external" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"><path d="M13 4h7v7"/><path d="M20 4 11 13"/><path d="M18 14v6H4V6h6"/></g></symbol>' +
    '<symbol id="i-shield" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"><path d="M12 2 4 5v7c0 5 3.5 8 8 10 4.5-2 8-5 8-10V5l-8-3Z"/><path d="m8 12 3 3 5-6"/></g></symbol>' +
    '<symbol id="i-lock" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"><path d="M7 10V7a5 5 0 0 1 10 0v3"/><path d="M4 10h16v11H4z"/></g><rect x="11" y="14" width="2" height="4" fill="currentColor"/></symbol>' +
    '<symbol id="i-chat" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"><path d="M3 5h18v11H8l-5 4V5Z"/><path d="M7 9h10M7 12h6"/></g></symbol>' +
    '<symbol id="i-refresh" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><path d="M20 6v5h-5"/><path d="M19.4 11A8 8 0 1 0 12 20a8 8 0 0 0 6.9-4"/></g></symbol>' +
    '<symbol id="i-terminal" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"><path d="M3 4h18v16H3z"/><path d="m7 9 3 3-3 3M13 15h4"/></g></symbol>' +
    '<symbol id="i-door" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"><path d="M4 3h16v18H4z"/><path d="M14 12h2"/></g></symbol>' +
    '<symbol id="i-sword" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"><path d="M20 3 9 14l-2 5 2-2 5-2L20 4l-1 12 1 5 5-5-5-13Z"/></g></symbol>' +
    '<symbol id="i-mail" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"><path d="M3 5h18v14H3z"/><path d="m3 6 9 7 9-7"/></g></symbol>' +
    '<symbol id="i-search" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="6"/><path d="m16 16 5 5" stroke-linecap="square"/></g></symbol>' +
    '<symbol id="i-edit" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"><path d="M4 20h4L20 8l-4-4L4 16v4Z"/><path d="m14 6 4 4"/></g></symbol>' +
    '<symbol id="i-clock" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2" stroke-linecap="square"/></g></symbol>' +
    '<symbol id="i-head" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"><path d="M4 4h16v16H4z"/><path d="M9 10h2v2H9zM13 10h2v2h-2zM10 14h4v3h-4z"/></g></symbol>' +
    '<symbol id="i-discord" viewBox="0 0 24 24"><path d="M8 5c3-1.2 5-1.2 8 0 2.5 2.4 3.5 6 3 9.5-.8.6-1.7 1-2.6 1.3l-.8-1.4c-1.4.5-3 .5-4.4 0L10.4 16c-1-.3-1.8-.7-2.6-1.3C7.3 11 8.3 7.4 8 5Zm2.4 7.2a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8Zm3.2 0a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8Z" fill="currentColor"/></symbol>' +
    '<symbol id="i-signal" viewBox="0 0 24 24"><g fill="currentColor"><rect x="3" y="15" width="3" height="6"/><rect x="8" y="11" width="3" height="10"/><rect x="13" y="7" width="3" height="14"/><rect x="18" y="3" width="3" height="18"/></g></symbol>' +
    '</svg>';

  var script = document.currentScript;
  if (script && script.parentNode) {
    script.insertAdjacentHTML('afterend', SPRITE);
  } else {
    document.body.insertAdjacentHTML('afterbegin', SPRITE);
  }
})();
