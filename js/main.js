/* ============================================================
   LongerMC · 通用交互脚本
   负责：年份、复制地址、滚动进度、导航高亮、渐入、回到顶部
   ============================================================ */
(function () {
  'use strict';

  // 导航、页脚由片段异步注入，等它们就位后再初始化
  lmcReady(function () {

    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    var announcer = document.getElementById('copyAnnouncer');

    function announce(message) {
      if (!announcer) return;
      announcer.textContent = '';
      window.setTimeout(function () { announcer.textContent = message; }, 30);
    }

    function handleCopy(el) {
      if (el.dataset.busy === '1') return;

      var text = el.getAttribute('data-copy');
      if (!text) return;

      var label = el.querySelector('[data-copy-label]');
      var target = label || el.querySelector('[data-copy-text]') || null;
      var doneText = el.getAttribute('data-copy-done') || '已复制';
      var failText = el.getAttribute('data-copy-fail') || '复制失败';
      var original = target ? target.textContent : null;

      el.dataset.busy = '1';

      copyText(text).then(
        function () { flash(doneText, true); announce('已复制：' + text); },
        function () { flash(failText, false); announce('复制失败，请手动选择地址复制'); }
      );

      function flash(message, ok) {
        el.classList.toggle('is-copied', ok);
        el.classList.toggle('is-failed', !ok);
        if (target) target.textContent = message;

        window.setTimeout(function () {
          el.classList.remove('is-copied', 'is-failed');
          if (target && original !== null) target.textContent = original;
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
      if (!el || el.tagName === 'BUTTON') return;

      e.preventDefault();
      handleCopy(el);
    });

    /* ----------------------------------------------------------
       3. 滚动渐入
       ---------------------------------------------------------- */
    var reveals = document.querySelectorAll('.reveal');

    if (reveals.length) {
      if ('IntersectionObserver' in window && !reduceMotion) {
        var io = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            entry.target.classList.add('in');
            io.unobserve(entry.target);
          });
        }, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });

        reveals.forEach(function (el) { io.observe(el); });
      } else {
        reveals.forEach(function (el) { el.classList.add('in'); });
      }
    }

    /* ----------------------------------------------------------
       4. 滚动进度 / 导航状态 / 回到顶部 / 当前区块
       ---------------------------------------------------------- */
    var nav = document.getElementById('nav');
    var progress = document.getElementById('scrollProgress');
    var toTop = document.querySelector('.to-top');
    var hotbar = document.querySelector('.hotbar');
    var navLinks = Array.prototype.slice.call(document.querySelectorAll('[data-nav]'));
    var sections = Array.prototype.slice.call(document.querySelectorAll('main section[id]'));
    var ticking = false;

    function updateScrollUI() {
      var y = window.scrollY || window.pageYOffset;
      var doc = document.documentElement;
      var max = doc.scrollHeight - window.innerHeight;

      if (progress) {
        var ratio = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0;
        progress.style.transform = 'scaleX(' + ratio + ')';
      }

      if (nav) nav.classList.toggle('scrolled', y > 8);
      if (toTop) toTop.classList.toggle('show', y > 720);
      if (hotbar) hotbar.classList.toggle('show', y > 320);

      // 当前区块
      var current = '';
      for (var i = 0; i < sections.length; i++) {
        if (sections[i].getBoundingClientRect().top <= 150) current = sections[i].id;
      }

      navLinks.forEach(function (link) {
        var active = link.getAttribute('data-nav') === current;
        link.classList.toggle('active', active);
        if (active) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      });

      ticking = false;
    }

    function requestScrollUpdate() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(updateScrollUI);
    }

    window.addEventListener('scroll', requestScrollUpdate, { passive: true });
    window.addEventListener('resize', requestScrollUpdate);
    updateScrollUI();

    if (toTop) {
      toTop.addEventListener('click', function () {
        window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
      });
    }

    /* ----------------------------------------------------------
       5. 减少动效时，锚点跳转不用平滑滚动
       ---------------------------------------------------------- */
    if (reduceMotion) {
      document.documentElement.style.scrollBehavior = 'auto';
    }
  });

  /* 等待 nav / footer 片段注入完成；异常或超时也会执行，保证交互不失效 */
  function lmcReady(fn) {
    var pending = window.LMC_PARTIALS || [];
    if (!pending.length) { fn(); return; }
    var timeout = new Promise(function (resolve) { setTimeout(resolve, 3000); });
    Promise.race([Promise.all(pending).catch(function () {}), timeout]).then(fn);
  }
})();
