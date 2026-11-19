// bad.news 播放页增强 —— 注入到 Web Clip / 壳的 WKWebView 里，
// 把站点自带的"原生 video 元素 + 自绘细条进度"换成一套可用的播放器底栏：
//   · 长条进度条（可拖）+ 大触控区播放/暂停、±10s、倍速、全屏
//   · 记住播放位置（同一 m3u8 地址，7 天）
//
// v2 变化（按使用反馈）：
//   · 控制条整体下移到视频画面下方，不再盖住画面
//   · 快进/快退改为画面下方大按钮，不再挤在底栏小格子里
//   · 抹掉一切焦点高亮（-webkit-tap-highlight-color / :focus 描边 / 选中态），
//     点哪都不会让 video 或按钮"变色"
//
// 用法：
//   1. WKWebView / Android 壳：作为 user script 注入
//   2. 桌面浏览器调试：拖进控制台
//   3. Userscript（Stay / Userscripts）：@match https://ios-app.bad.news/*
//
// 不修改站点任何请求；只在 DOM 层接管 <video> 的 UI。

(function () {
  'use strict';

  const ROOT_ID = 'hs-player-root';
  const STORE_PREFIX = 'hs-pos:';
  const STORE_TTL = 7 * 24 * 3600 * 1000;   // 7 天
  const RATE_STEPS = [0.75, 1, 1.25, 1.5, 2];

  // ---------- 工具 ----------

  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    t = Math.floor(t);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }

  function nearestVideo() {
    const vids = Array.from(document.querySelectorAll('video'));
    let best = null, bestArea = 0;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      const area = w * h;
      if (area > bestArea) { bestArea = area; best = v; }
    }
    return best;
  }

  function toast(msg) {
    let el = document.getElementById('hs-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'hs-toast';
      el.style.cssText =
        'position:fixed;left:50%;bottom:150px;transform:translateX(-50%);' +
        'background:rgba(20,22,26,.92);color:#fff;padding:8px 16px;border-radius:20px;' +
        'font:14px -apple-system,sans-serif;z-index:2147483647;transition:opacity .3s;' +
        'pointer-events:none;outline:none;';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 1600);
  }

  // ---------- 播放位置记忆 ----------

  function keyFor(v) {
    return STORE_PREFIX + (v.currentSrc || v.src || '').split('#')[0];
  }

  function savePosition(v) {
    try {
      const k = keyFor(v);
      if (!k || k.length < STORE_PREFIX.length + 8) return;
      localStorage.setItem(k + ':t', String(v.currentTime));
      localStorage.setItem(k + ':at', String(Date.now()));
    } catch (e) {}
  }

  function restorePosition(v) {
    try {
      const k = keyFor(v);
      const at = Number(localStorage.getItem(k + ':at') || 0);
      if (!at || Date.now() - at > STORE_TTL) return;
      const t = Number(localStorage.getItem(k + ':t') || 0);
      if (t > 5 && t < (v.duration || Infinity) - 5) {
        v.currentTime = t;
        toast('已从 ' + fmt(t) + ' 继续');
      }
    } catch (e) {}
  }

  // ---------- 焦点/选中态抹除（在 shadow root 外也生效） ----------

  const FOCUS_KILL_CSS = `
    video:focus, video:focus-visible, video:active,
    video::-webkit-media-controls-panel,
    #${ROOT_ID}, #${ROOT_ID} *,
    #${ROOT_ID} *:focus, #${ROOT_ID} *:focus-visible, #${ROOT_ID} *:active {
      outline: none !important;
      outline-offset: 0 !important;
      -webkit-tap-highlight-color: transparent !important;
      -webkit-touch-callout: none !important;
    }
    video:focus:not(:focus-visible) { outline: none !important; }
  `;

  function installFocusKill() {
    if (document.getElementById('hs-focus-kill')) return;
    const st = document.createElement('style');
    st.id = 'hs-focus-kill';
    st.textContent = FOCUS_KILL_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // ---------- 面板 ----------

  let root = null;      // 外层容器（绝对定位到 video 下方）
  let cur = null;       // 当前接管的 video
  let hideTimer = null;

  const $ = (sel, scope) => (scope || document).querySelector(sel);

  function buildUI() {
    if (root) return root;

    root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = `
      <div class="hs-quick">
        <button class="hs-qbtn" data-role="back" aria-label="后退10秒">
          <span class="hs-qicon">↺</span><span class="hs-qlabel">10s</span>
        </button>
        <button class="hs-qbtn hs-qmain" data-role="toggle" aria-label="播放/暂停">
          <span class="hs-qicon" data-role="toggleIcon">▶</span>
        </button>
        <button class="hs-qbtn" data-role="fwd" aria-label="前进10秒">
          <span class="hs-qicon">↻</span><span class="hs-qlabel">10s</span>
        </button>
      </div>

      <div class="hs-bar">
        <div class="hs-seek" data-role="seek">
          <div class="hs-track">
            <div class="hs-buf" data-role="buf"></div>
            <div class="hs-play" data-role="play"></div>
            <div class="hs-knob" data-role="knob"></div>
          </div>
        </div>
        <div class="hs-bottom">
          <span class="hs-time"><span data-role="cur">0:00</span> / <span data-role="dur">0:00</span></span>
          <span class="hs-spacer"></span>
          <button class="hs-btn" data-role="rate" aria-label="倍速">1×</button>
          <button class="hs-btn" data-role="fs" aria-label="全屏">全屏</button>
        </div>
      </div>
    `;

    document.body.appendChild(root);
    injectStyle();
    wire();
    return root;
  }

  function injectStyle() {
    if (document.getElementById('hs-style')) return;
    const st = document.createElement('style');
    st.id = 'hs-style';
    st.textContent = `
      #${ROOT_ID} {
        position: fixed;
        left: 0; right: 0;
        display: flex; flex-direction: column;
        background: rgba(10,11,13,.96);
        border-top: 1px solid rgba(255,255,255,.09);
        font: 13px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
        color: #e9ecef;
        z-index: 2147483646;
        padding-bottom: env(safe-area-inset-bottom);
        -webkit-user-select: none; user-select: none;
        -webkit-tap-highlight-color: transparent;
        transition: opacity .22s ease, transform .22s ease;
        outline: none;
        visibility: hidden;
      }
      #${ROOT_ID}.hs-on { visibility: visible; }
      #${ROOT_ID}.hs-hidden { opacity: 0; transform: translateY(8px); pointer-events: none; }

      /* ---- 画面下方的大按钮区 ---- */
      #${ROOT_ID} .hs-quick {
        display: flex; align-items: center; justify-content: center;
        gap: 10px; padding: 10px 14px 6px;
      }
      #${ROOT_ID} .hs-qbtn {
        appearance: none; -webkit-appearance: none;
        border: 0; background: rgba(255,255,255,.10);
        color: #e9ecef; border-radius: 12px;
        height: 46px; min-width: 76px;
        display: inline-flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 2px;
        font: 11px/1 -apple-system, sans-serif;
        -webkit-tap-highlight-color: transparent;
        outline: none; transition: background .12s;
      }
      #${ROOT_ID} .hs-qbtn.hs-qmain {
        background: rgba(232,177,58,.92); color: #14160f;
        min-width: 92px; height: 50px;
      }
      #${ROOT_ID} .hs-qicon { font-size: 17px; line-height: 1; }
      #${ROOT_ID} .hs-qlabel { font-size: 10px; opacity: .85; letter-spacing: .02em; }
      /* 只允许按下态的临时变暗，不给 focus / active 留任何持久描边 */
      #${ROOT_ID} .hs-qbtn:active,
      #${ROOT_ID} .hs-btn:active { background: rgba(255,255,255,.22); }
      #${ROOT_ID} .hs-qbtn:focus,
      #${ROOT_ID} .hs-qbtn:focus-visible,
      #${ROOT_ID} .hs-btn:focus,
      #${ROOT_ID} .hs-btn:focus-visible { outline: none; }

      /* ---- 进度条 ---- */
      #${ROOT_ID} .hs-seek {
        position: relative; height: 30px;
        display: flex; align-items: center;
        padding: 0 14px; touch-action: none;
      }
      #${ROOT_ID} .hs-track {
        position: relative; width: 100%; height: 5px;
        background: rgba(255,255,255,.26); border-radius: 3px;
      }
      #${ROOT_ID} .hs-buf {
        position: absolute; inset: 0 auto 0 0; width: 0;
        background: rgba(255,255,255,.34); border-radius: 3px;
      }
      #${ROOT_ID} .hs-play {
        position: absolute; inset: 0 auto 0 0; width: 0;
        background: #e8b13a; border-radius: 3px;
      }
      #${ROOT_ID} .hs-knob {
        position: absolute; top: 50%; left: 0;
        width: 18px; height: 18px; margin-left: -9px; margin-top: -9px;
        border-radius: 50%; background: #fff;
        box-shadow: 0 1px 5px rgba(0,0,0,.55);
      }

      /* ---- 底部时间/倍速/全屏 ---- */
      #${ROOT_ID} .hs-bottom {
        display: flex; align-items: center; gap: 8px;
        padding: 2px 14px 10px;
      }
      #${ROOT_ID} .hs-time {
        font-variant-numeric: tabular-nums;
        color: #b7bec7; font-size: 12px;
      }
      #${ROOT_ID} .hs-spacer { flex: 1; }
      #${ROOT_ID} .hs-btn {
        appearance: none; -webkit-appearance: none; border: 0;
        background: rgba(255,255,255,.10); color: #e9ecef;
        height: 30px; min-width: 44px; padding: 0 12px; border-radius: 8px;
        font: 12px/1 -apple-system, sans-serif;
        -webkit-tap-highlight-color: transparent; outline: none;
      }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  function wire() {
    const quickBack = $('[data-role=back]', root);
    const quickFwd = $('[data-role=fwd]', root);
    const toggle = $('[data-role=toggle]', root);
    const rate = $('[data-role=rate]', root);
    const fs = $('[data-role=fs]', root);
    const seek = $('[data-role=seek]', root);
    const track = $('.hs-track', root);

    toggle.onclick = () => {
      const v = cur || nearestVideo();
      if (!v) return;
      v.paused ? v.play() : v.pause();
      sync();
    };

    quickBack.onclick = () => nudge(-10);
    quickFwd.onclick = () => nudge(+10);

    rate.onclick = () => {
      const v = cur || nearestVideo();
      if (!v) return;
      const i = RATE_STEPS.indexOf(v.playbackRate);
      const next = RATE_STEPS[(i + 1) % RATE_STEPS.length];
      v.playbackRate = next;
      rate.textContent = next + '×';
      toast('倍速 ' + next + '×');
    };

    fs.onclick = () => {
      const v = cur || nearestVideo();
      if (!v) return;
      const host = root.dataset.host;   // 面板所依附的容器
      const el = (host && document.querySelector(host)) || v.parentElement || v;
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
      } else {
        (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
      }
    };

    // ---- 拖动进度条
    let dragging = false;
    const seekTo = (clientX) => {
      const v = cur || nearestVideo();
      if (!v || !isFinite(v.duration)) return;
      const r = track.getBoundingClientRect();
      const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      v.currentTime = pct * v.duration;
      sync();
    };
    seek.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { seek.setPointerCapture(e.pointerId); } catch (_) {}
      seekTo(e.clientX);
      e.preventDefault();
    });
    seek.addEventListener('pointermove', (e) => { if (dragging) seekTo(e.clientX); });
    seek.addEventListener('pointerup', (e) => {
      dragging = false;
      try { seek.releasePointerCapture(e.pointerId); } catch (_) {}
    });
    seek.addEventListener('pointercancel', () => { dragging = false; });

    // ---- 自动淡出：播放中 3 秒无操作收起，点画面再出现
    const bump = () => {
      root.classList.remove('hs-hidden');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        const v = cur || nearestVideo();
        if (v && !v.paused) root.classList.add('hs-hidden');
      }, 3000);
    };
    root.addEventListener('pointerdown', bump);
    document.addEventListener('pointerdown', (e) => {
      if (root.contains(e.target)) { bump(); return; }
      const v = nearestVideo();
      if (!v) return;
      const r = v.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right &&
          e.clientY >= r.top && e.clientY <= r.bottom) bump();
    }, true);
    root._bump = bump;
    bump();
  }

  function nudge(delta) {
    const v = cur || nearestVideo();
    if (!v) return;
    v.currentTime = Math.min(
      Math.max(0, v.currentTime + delta),
      isFinite(v.duration) ? v.duration : 1e9
    );
    sync();
    if (root && root._bump) root._bump();
  }

  function sync() {
    if (!root) return;
    const v = cur;
    if (!v) return;

    const d = v.duration || 0;
    const pct = d ? (v.currentTime / d) * 100 : 0;

    $('[data-role=play]', root).style.width = pct + '%';
    $('[data-role=knob]', root).style.left = pct + '%';

    const b = v.buffered;
    let bufPct = 0;
    if (b && b.length && d) bufPct = (b.end(b.length - 1) / d) * 100;
    $('[data-role=buf]', root).style.width = bufPct + '%';

    $('[data-role=cur]', root).textContent = fmt(v.currentTime);
    $('[data-role=dur]', root).textContent = fmt(d);

    const ic = $('[data-role=toggleIcon]', root);
    if (ic) ic.textContent = v.paused ? '▶' : '❚❚';
    $('[data-role=rate]', root).textContent = v.playbackRate + '×';
  }

  // ---------- 把面板贴到视频下方 ----------

  function place() {
    if (!root || !cur) return;
    const r = cur.getBoundingClientRect();
    const rootH = root.offsetHeight || 140;

    // 目标位置：视频底边往下 4px；若会顶出屏幕，则贴在屏幕底部
    let top = r.bottom + 4;
    const maxTop = innerHeight - rootH - 4;
    if (top > maxTop) top = Math.max(r.top + 8, maxTop);
    if (top < 0) top = 0;

    root.style.top = top + 'px';
    root.style.left = Math.max(0, r.left) + 'px';
    root.style.right = Math.max(0, innerWidth - r.right) + 'px';
    root.classList.add('hs-on');
  }

  // ---------- 绑定 ----------

  function attach(v) {
    if (!v || v === cur) return;
    detach();
    cur = v;

    installFocusKill();

    // 站点设了 controls=false；不开它，只叠自己的面板
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    // 关键：video 被点/拖之后不能变蓝或出现描边
    v.style.outline = 'none';
    v.style.webkitTapHighlightColor = 'transparent';

    // 记住视频宿主，全屏时用它而不是 root
    const host = v.parentElement;
    if (host && !host.id) {
      host.id = 'hs-host-' + Math.random().toString(36).slice(2, 8);
      root && (root.dataset.host = '#' + host.id);
    }

    v.addEventListener('timeupdate', sync);
    v.addEventListener('durationchange', sync);
    v.addEventListener('progress', sync);
    v.addEventListener('play', sync);
    v.addEventListener('pause', sync);
    v.addEventListener('ratechange', sync);
    v.addEventListener('loadedmetadata', () => {
      sync();
      restorePosition(v);
      place();
    });

    v.addEventListener('pause', () => savePosition(v));
    v.addEventListener('seeked', () => savePosition(v));
    setInterval(() => { if (!v.paused) savePosition(v); }, 5000);

    buildUI();
    if (v.parentElement && !v.parentElement.id) {
      v.parentElement.id = 'hs-host-' + Math.random().toString(36).slice(2, 8);
    }
    if (v.parentElement) root.dataset.host = '#' + v.parentElement.id;

    sync();
    requestAnimationFrame(place);
  }

  function detach() {
    cur = null;
    if (root) {
      root.classList.remove('hs-on');
      sync();
    }
  }

  // 尺寸/滚动变化时重贴位置（面板跟着 video 走，但不能盖住它）
  let placeTimer = null;
  function schedulePlace() {
    clearTimeout(placeTimer);
    placeTimer = setTimeout(place, 60);
  }

  function scan() {
    const v = nearestVideo();
    if (v && v !== cur) attach(v);
    else if (cur) schedulePlace();
  }

  const mo = new MutationObserver(() => {
    if (!cur || !document.contains(cur)) scan();
  });
  if (document.documentElement) {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Flutter 的 canvas 布局会持续变化，滚动/缩放时也要重贴
  window.addEventListener('scroll', schedulePlace, true);
  window.addEventListener('resize', () => { schedulePlace(); scan(); });
  window.addEventListener('orientationchange', () => setTimeout(() => { scan(); place(); }, 400));
  setInterval(scan, 1500);
  setInterval(() => { if (cur) schedulePlace(); }, 1000);

  window.addEventListener('pagehide', () => { if (cur) savePosition(cur); });

  console.info('[hs-player] bad.news 播放器增强 v2 已加载');

  // SPA 路由切换时由外壳调用，重新扫描一次
  window.__hsPlayerRearm = function () {
    try { scan(); } catch (e) { console.warn('[hs-player] rearm failed', e); }
  };
})();
