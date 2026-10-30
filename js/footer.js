/* ============================================================
   LongerMC · 页脚片段
   从 /partials/footer.html 载入，index.html 与 404.html 共用同一份
   ============================================================ */
(function () {
  'use strict';

  // 供 main.js / status.js 等待片段注入完成
  window.LMC_PARTIALS = window.LMC_PARTIALS || [];

  var root = document.getElementById('footer-root');
  if (!root) return;

  var pending = fetch('/partials/footer.html')
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    })
    .then(function (html) {
      root.outerHTML = html; // 用真实页脚替换占位容器
    })
    .catch(function (error) {
      console.error('Error loading footer:', error);
    });

  window.LMC_PARTIALS.push(pending);
})();
