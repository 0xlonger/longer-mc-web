/* ============================================================
   LongerMC · 通用交互脚本
   负责：年份、复制地址、滚动渐入、回到顶部
   ============================================================ */
(function () {
  'use strict';

  /* ----------------------------------------------------------
     1. 页脚年份
     ---------------------------------------------------------- */
  var yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  /* ----------------------------------------------------------
     2. 复制文本（带降级方案）
     ---------------------------------------------------------- */
  function fallbackCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);

      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }

      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () {
        return fallbackCopy(text);
      });
    }
    return fallbackCopy(text);
  }

  var RESTORE_MS = 1800;

  function handleCopy(el) {
    if (el.dataset.busy === '1') return;

    var text = el.getAttribute('data-copy');
    if (!text) return;

    // 优先更新带 data-copy-text 的子元素，否则更新元素自身文本
    var target = el.querySelector('[data-copy-text]') || el;
    var doneText = el.getAttribute('data-copy-done') || '已复制 ✓';
    var failText = el.getAttribute('data-copy-fail') || '复制失败';

    el.dataset.busy = '1';

    copyText(text).then(
      function () { flash(doneText, 'copied'); },
      function () { flash(failText, 'failed'); }
    );

    function flash(text, cls) {
      var original = target.textContent;
      target.textContent = text;
      target.classList.add(cls);

      setTimeout(function () {
        target.textContent = original;
        target.classList.remove(cls);
        el.dataset.busy = '0';
      }, RESTORE_MS);
    }
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-copy]');
    if (el) handleCopy(el);
  });

  // 非按钮元素（如状态卡片）的键盘支持
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;

    var el = e.target.closest('[data-copy][role="button"]');
    if (!el || el.tagName === 'BUTTON') return; // BUTTON 自身会派发 click

    e.preventDefault();
    handleCopy(el);
  });

  /* ----------------------------------------------------------
     3. 滚动渐入
     ---------------------------------------------------------- */
  var reveals = document.querySelectorAll('.reveal');

  if (reveals.length) {
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

      reveals.forEach(function (el) { io.observe(el); });
    } else {
      reveals.forEach(function (el) { el.classList.add('in'); });
    }
  }

  /* ----------------------------------------------------------
     4. 回到顶部按钮
     ---------------------------------------------------------- */
  var toTop = document.querySelector('.to-top');

  if (toTop) {
    var ticking = false;

    function syncToTop() {
      toTop.classList.toggle('show', window.scrollY > 600);
      ticking = false;
    }

    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(syncToTop);
    }, { passive: true });

    syncToTop();

    toTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
})();