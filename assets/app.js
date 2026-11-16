/*
 * app.js — 界面与播放控制
 *
 * 求解只有一条路径：原版 C++ 编译成的 WebAssembly，在 assets/wasm-worker.js 里跑，
 * 帧由求解器自己的 saveFrame() 写出。本文件不参与任何求解计算，
 * 只负责播放、指标显示，以及把求解器没画出来的「未放置多边形」补成虚线底图。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var IN = window.NestInput;      // 仅用于解析输入 / 合法性检查，不含求解
  var STORE = 'nest.customDatasets.v1';

  var state = {
    datasets: [],
    currentId: null,
    parsed: null,
    frames: [],
    idx: 0,
    playing: false,
    speed: 110,
    lastT: 0,
    raf: 0,
    ghostD: null
  };

  var wasmWorker = null;
  var busy = false;

  /* ---------------- 数据集 ---------------- */

  function loadCustom() {
    try {
      var raw = localStorage.getItem(STORE);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveCustom(list) {
    try { localStorage.setItem(STORE, JSON.stringify(list)); } catch (e) {}
  }

  function rebuild() {
    var builtin = (window.NEST_DATASETS || []).map(function (d) {
      return { id: d.id, name: d.name, note: d.note || '', text: d.text, builtin: true };
    });
    var custom = loadCustom().map(function (d) {
      return { id: d.id, name: d.name, note: d.note || '', text: d.text, builtin: false, createdAt: d.createdAt };
    });
    state.datasets = builtin.concat(custom);
  }

  function currentDataset() {
    for (var i = 0; i < state.datasets.length; i++) {
      if (state.datasets[i].id === state.currentId) return state.datasets[i];
    }
    return null;
  }

  function renderDatasetSelect() {
    var sel = $('datasetSel');
    sel.innerHTML = '';
    var groupBuiltin = document.createElement('optgroup');
    groupBuiltin.label = '内置';
    var groupCustom = document.createElement('optgroup');
    groupCustom.label = '自定义';
    state.datasets.forEach(function (d) {
      var o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.name;
      (d.builtin ? groupBuiltin : groupCustom).appendChild(o);
    });
    if (groupBuiltin.children.length) sel.appendChild(groupBuiltin);
    if (groupCustom.children.length) sel.appendChild(groupCustom);
    sel.value = state.currentId;

    var d = currentDataset();
    $('datasetNote').textContent = d ? d.note : '';
    markDirty();
    $('btnDelete').disabled = !d || d.builtin;
  }

  // 编辑器和所选数据集内容不一致时，提示一下
  function markDirty() {
    var note = $('datasetNote');
    var d = currentDataset();
    if (!d) return;
    var edited = $('editor').value !== d.text;
    note.textContent = d.note + (edited ? ' · 已修改，尚未保存' : '');
  }

  function selectDataset(id, autoSolve) {
    state.currentId = id;
    var d = currentDataset();
    if (!d) return;
    $('editor').value = d.text;
    $('editorErr').textContent = '';
    $('editorErr').classList.remove('ok');
    renderDatasetSelect();
    if (autoSolve) solveCurrent();
  }

  /* ---------------- 播放控制 ---------------- */

  function goTo(i) {
    if (!state.frames.length) return;
    if (i < 0) i = 0;
    if (i > state.frames.length - 1) i = state.frames.length - 1;
    state.idx = i;
    var f = state.frames[i];
    $('slider').value = String(i);
    $('counter').textContent = (i + 1) + ' / ' + state.frames.length;
    $('mFrame').textContent = (i + 1) + '/' + state.frames.length;
    $('stepLabel').textContent = f.label || ('帧 ' + (i + 1));
    $('mCost').textContent = (f.sum != null) ? f.sum.toFixed(3) : '—';
    $('mPlaced').textContent = (f.placed != null) ? String(f.placed) : '—';
    setFrameSvg(f);
  }

  function play() {
    if (state.playing || !state.frames.length) return;
    if (state.idx >= state.frames.length - 1) goTo(0);
    state.playing = true;
    state.lastT = 0;
    $('playIcon').innerHTML = '<rect x="2.5" y="2" width="2.6" height="8"/><rect x="6.9" y="2" width="2.6" height="8"/>';
    state.raf = requestAnimationFrame(tick);
  }

  function pause() {
    state.playing = false;
    cancelAnimationFrame(state.raf);
    $('playIcon').innerHTML = '<path d="M3 2l7 4-7 4z"/>';
  }

  function tick(t) {
    if (!state.playing) return;
    if (!state.lastT) state.lastT = t;
    if (t - state.lastT >= state.speed) {
      state.lastT = t;
      if (state.idx >= state.frames.length - 1) { pause(); return; }
      goTo(state.idx + 1);
    }
    state.raf = requestAnimationFrame(tick);
  }

  /* ---------------- 帧渲染 ---------------- */

  // 直接把求解器产出的 SVG 内联进 DOM：viewBox + preserveAspectRatio 会自己等比缩放
  function setFrameSvg(f) {
    if (!f) return;
    var svg = f.svg.replace(/<\?xml[^>]*\?>/, '');
    $('frameBox').innerHTML = svg;
    paintGhosts($('frameBox').querySelector('svg'));
  }

  // 单个多边形的路径片段（原位坐标，缓存一次）
  function polyPathD(i) {
    if (!state.ghostD) state.ghostD = [];
    if (state.ghostD[i]) return state.ghostD[i];
    var pts = state.parsed.polys[i];
    var s = 'M' + pts[0].x.toFixed(3) + ' ' + pts[0].y.toFixed(3);
    for (var k = 1; k < pts.length; k++) s += 'L' + pts[k].x.toFixed(3) + ' ' + pts[k].y.toFixed(3);
    s += 'Z';
    state.ghostD[i] = s;
    return s;
  }

  /*
   * 求解器输出的帧里只有"已放置"的多边形，未放置的那些看不见，
   * 会让人以为多边形是凭空出现的。这里把它们按输入位置画成虚线底图。
   * 已放置集合从帧里每个多边形中心的编号 <text> 反推。
   */
  function paintGhosts(svg) {
    if (!svg || !state.parsed) return;
    if (!$('tgGhost').checked) return;
    var g = svg.querySelector('g');
    if (!g) return;

    var placed = {}, cnt = 0, texts = svg.querySelectorAll('text');
    var n = state.parsed.polys.length;
    for (var i = 0; i < texts.length; i++) {
      var t = (texts[i].textContent || '').trim();
      if (!/^\d+$/.test(t)) continue;
      var v = +t;
      if (v < n && !placed[v]) { placed[v] = 1; cnt++; }
    }
    if (!cnt) return;   // 反推不出已放置集合就不画，宁缺勿错

    var d = '';
    for (var k = 0; k < n; k++) if (!placed[k]) d += polyPathD(k);
    if (!d) return;

    var el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('d', d);
    el.setAttribute('fill', 'rgba(120,120,114,0.045)');
    el.setAttribute('fill-rule', 'nonzero');
    el.setAttribute('stroke', 'rgba(120,120,114,0.5)');
    el.setAttribute('stroke-width', '0.02');
    el.setAttribute('stroke-dasharray', '0.1 0.07');
    g.insertBefore(el, g.firstChild);
  }

  /* ---------------- 求解 ---------------- */

  function setOverlay(text, show) {
    $('overlay').hidden = !show;
    if (text) $('overlayText').textContent = text;
    if (!show) $('overlayBar').style.width = '0%';
  }

  function setBusy(v) {
    busy = v;
    $('btnSolve').disabled = v;
    $('btnPlay').disabled = v;
    $('btnPrev').disabled = v;
    $('btnNext').disabled = v;
    $('slider').disabled = v;
  }

  function showCheck(v, prefix) {
    var el = $('editorErr');
    if (!v.ok) {
      el.classList.remove('ok');
      var msg = v.errors.slice(0, 3).join('；');
      if (v.errors.length > 3) msg += ' …共 ' + v.errors.length + ' 项';
      el.textContent = (prefix || '输入不合法：') + msg;
      return false;
    }
    el.classList.add('ok');
    el.textContent = '✓ ' + v.stats.n + ' 个多边形 · 面积占比 ' +
      (v.stats.ratio * 100).toFixed(1) + '%' +
      (v.warnings.length ? ' · ' + v.warnings[0] : '');
    return true;
  }

  function solveCurrent() {
    if (busy) return;
    var text = $('editor').value;

    // 先做完整校验：结构、自交、零面积、面积上界。不合法就不提交给求解器——
    // 求解器自己不查这些，喂进去只会白跑满整个时限然后返回 INF。
    var v = IN.validateInput(text);
    if (!showCheck(v)) return;

    var parsed = IN.parseInput(text);
    if (parsed.error) {
      $('editorErr').textContent = '解析失败：' + parsed.error;
      return;
    }
    state.parsed = parsed;
    state.ghostD = null;

    // 换了数据就必须丢掉旧帧，否则滑块长度和实际帧数对不上
    state.frames = [];
    state.idx = 0;
    $('slider').max = '0';
    $('slider').value = '0';
    $('counter').textContent = '0 / 0';
    $('mFrame').textContent = '0/0';
    $('mPlaced').textContent = '0';
    $('mCost').textContent = '—';
    $('frameBox').innerHTML = '';

    pause();
    setBusy(true);
    $('phaseBadge').textContent = '求解中';
    $('stepLabel').textContent = '正在运行求解器本体…';
    setOverlay('正在求解…', true);
    $('overlayBar').style.width = '2%';

    if (!wasmWorker) {
      fail('WASM 模块没有就绪，请刷新页面重试');
      return;
    }
    var lim = parseInt($('limitSel').value, 10) || 57;
    $('overlayText').textContent = '正在运行求解器（WASM），时限 ' + lim + ' 秒…';
    wasmWorker.postMessage({ type: 'solve', text: text, limit: lim });
  }

  function finishWasm(res) {
    setBusy(false);
    if (!res || res.error) { fail(res && res.error || '求解失败'); return; }
    if (!res.frames || !res.frames.length) { fail('求解器没有产出可视化帧'); return; }

    setOverlay('', false);
    state.frames = res.frames;
    $('slider').max = String(res.frames.length - 1);
    $('slider').value = '0';
    $('topMeta').textContent =
      res.trans.length + ' 个多边形 · 时限 ' + res.limit + ' s · ' +
      (res.ms / 1000).toFixed(1) + ' s 实际耗时';
    $('phaseBadge').textContent = '求解器输出';
    goTo(0);
    play();
  }

  function fail(msg) {
    setBusy(false);
    setOverlay('', false);
    $('phaseBadge').textContent = '出错';
    $('editorErr').classList.remove('ok');
    $('editorErr').textContent = '求解失败：' + msg;
  }

  /* ---------------- Worker ---------------- */

  function initWasmWorker() {
    try {
      wasmWorker = new Worker('assets/wasm-worker.js?v=20261117f');
      wasmWorker.onmessage = function (e) {
        var d = e.data || {};
        if (d.type === 'log') {
          var t = d.text;
          var pct = 8;
          if (/Phase0/.test(t)) pct = 6;
          else if (/innerNFP/.test(t)) pct = 14;
          else if (/Phase1/.test(t)) pct = 40;
          else if (/Phase2/.test(t)) pct = 62;
          else if (/Phase3/.test(t)) pct = 78;
          else if (/Phase4/.test(t)) pct = 92;
          else if (/Phase5/.test(t)) pct = 96;
          $('overlayBar').style.width = pct + '%';
        } else if (d.type === 'done') {
          finishWasm(d.data);
        } else if (d.type === 'error') {
          fail(d.message);
        }
      };
      wasmWorker.onerror = function (ev) {
        wasmWorker = null;
        $('editorErr').textContent = 'WASM worker 加载失败：' + (ev && ev.message || '未知');
      };
    } catch (e) {
      wasmWorker = null;
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    $('btnPlay').onclick = function () { state.playing ? pause() : play(); };
    $('btnPrev').onclick = function () { pause(); goTo(state.idx - 1); };
    $('btnNext').onclick = function () { pause(); goTo(state.idx + 1); };
    $('btnReset').onclick = function () { pause(); goTo(0); };

    $('slider').oninput = function () { pause(); goTo(parseInt(this.value, 10)); };
    $('speed').onchange = function () { state.speed = parseInt(this.value, 10); };

    $('tgGhost').onchange = function () {
      setFrameSvg(state.frames[state.idx]);
    };

    $('datasetSel').onchange = function () { selectDataset(this.value, true); };

    $('btnCheckVer').onclick = function () {
      var btn = this;
      var label = btn.textContent;
      btn.disabled = true;
      btn.textContent = '检查中…';
      var done = function (msg) {
        btn.textContent = msg;
        btn.disabled = false;
        setTimeout(function () { btn.textContent = label; }, 2200);
      };
      if (typeof window.__nestVersionCheck !== 'function') { done('无自检'); return; }
      window.__nestVersionCheck().then(function (r) {
        if (r === 'same') done('已是最新');
        else if (r === 'reloading') done('发现新版，正在重载');
        else if (r === 'offline') done('离线，无法检查');
        else done('检查失败');
      });
    };

    $('btnAdd').onclick = function () {
      var name = window.prompt('给这个数据集起个名字：', '我的算例 ' + (loadCustom().length + 1));
      if (!name) return;
      var text = $('editor').value;
      var v = IN.validateInput(text);
      if (!v.ok) {
        $('editorErr').classList.remove('ok');
        $('editorErr').textContent = '输入不合法，未添加：' + v.errors.slice(0, 3).join('；');
        return;
      }
      var check = IN.parseInput(text);
      var list = loadCustom();
      var id = 'custom-' + Date.now().toString(36);
      list.push({
        id: id, name: name,
        note: check.boundary.length + ' 边边界 · ' + check.polys.length + ' 个多边形',
        text: text, createdAt: Date.now()
      });
      saveCustom(list);
      rebuild();
      selectDataset(id, false);
      $('datasetNote').textContent += '（已保存到本机浏览器）';
    };

    $('btnDelete').onclick = function () {
      var d = currentDataset();
      if (!d || d.builtin) return;
      if (!window.confirm('删除数据集「' + d.name + '」？')) return;
      var list = loadCustom().filter(function (x) { return x.id !== d.id; });
      saveCustom(list);
      rebuild();
      var first = state.datasets[0];
      if (first) selectDataset(first.id, true);
    };

    $('btnExport').onclick = function () {
      var blob = new Blob([$('editor').value], { type: 'text/plain;charset=utf-8' });
      var a = document.createElement('a');
      var d = currentDataset();
      a.href = URL.createObjectURL(blob);
      a.download = (d ? d.name : 'input').replace(/[^\w\u4e00-\u9fa5.-]+/g, '_') + '.in';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    };

    $('btnSolve').onclick = solveCurrent;
    var checkTimer = 0;
    $('editor').addEventListener('input', function () {
      markDirty();
      clearTimeout(checkTimer);
      checkTimer = setTimeout(function () {
        var t = $('editor').value;
        if (!t.trim()) return;
        showCheck(IN.validateInput(t), '输入不合法：');
      }, 700);
    });
    $('editor').addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); solveCurrent(); }
    });

    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); state.playing ? pause() : play(); }
      else if (e.code === 'ArrowRight') { e.preventDefault(); pause(); goTo(state.idx + 1); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); pause(); goTo(state.idx - 1); }
    });
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    rebuild();
    initWasmWorker();
    bind();

    var initial = state.datasets[0];
    if (!initial) {
      $('stepLabel').textContent = '没有可用数据集。';
      return;
    }
    state.currentId = initial.id;
    $('editor').value = initial.text;
    renderDatasetSelect();
    solveCurrent();
  }

  // 调试出口（也方便在控制台里手动跳帧）
  window.__nest = {
    state: state,
    checkVersion: function () { return window.__nestVersionCheck && window.__nestVersionCheck(); },
    isBusy: function () { return busy; },
    solve: solveCurrent,
    goTo: function (i) { pause(); goTo(i); },
    play: play,
    pause: pause
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
