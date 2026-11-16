/*
 * app.js — 界面、播放与 Canvas 渲染
 * 求解本身在 solver.js（通过 Worker 在后台线程跑）
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var S = window.NestSolver;
  var STORE = 'nest.customDatasets.v1';

  var state = {
    datasets: [],
    currentId: null,
    parsed: null,
    bbox: null,
    frames: [],
    idx: 0,
    playing: false,
    speed: 110,
    lastT: 0,
    raf: 0,
    stats: null,
    mode: 'js',          // 'js' = 移植版画布；'wasm' = 原版 C++ 的 SVG 帧
    wasmFrames: []
  };

  var cv = $('cv');
  var g = cv.getContext('2d');
  var view = { s: 1, ox: 0, oy: 0, w: 0, h: 0 };
  var worker = null;
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
    renderDatasetSelect();
    if (autoSolve) solveCurrent();
  }

  /* ---------------- 视图变换 ---------------- */

  function bboxOf(pts) {
    var l = Infinity, b = Infinity, r = -Infinity, t = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].x < l) l = pts[i].x;
      if (pts[i].x > r) r = pts[i].x;
      if (pts[i].y < b) b = pts[i].y;
      if (pts[i].y > t) t = pts[i].y;
    }
    return { l: l, b: b, r: r, t: t };
  }

  function fitView() {
    if (!state.bbox) return;
    var b = state.bbox;
    var W = Math.max(b.r - b.l, 1e-6), H = Math.max(b.t - b.b, 1e-6);
    var pad = 0.05;
    var s = Math.min(view.w / (W * (1 + pad * 2)), view.h / (H * (1 + pad * 2)));
    view.s = s;
    view.ox = view.w / 2 - ((b.l + b.r) / 2) * s;
    view.oy = view.h / 2 + ((b.b + b.t) / 2) * s;
  }

  function px(x) { return view.ox + x * view.s; }
  function py(y) { return view.oy - y * view.s; }

  function resize() {
    var wrap = cv.parentElement;
    var dpr = window.devicePixelRatio || 1;
    var w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    view.w = w;
    view.h = h;
    fitView();
    draw();
  }

  /* ---------------- 绘制 ---------------- */

  function hueOf(i) { return (i * 137.508) % 360; }

  function pathPoly(pts, tx, ty) {
    g.beginPath();
    g.moveTo(px(pts[0].x + tx), py(pts[0].y + ty));
    for (var i = 1; i < pts.length; i++) {
      g.lineTo(px(pts[i].x + tx), py(pts[i].y + ty));
    }
    g.closePath();
  }

  function drawIdle() {
    if (!state.parsed) return;
    pathPoly(state.parsed.boundary, 0, 0);
    g.fillStyle = '#f4f7fb';
    g.fill();
    g.strokeStyle = '#8d8d88';
    g.lineWidth = 1;
    g.stroke();

    g.save();
    g.setLineDash([4, 3]);
    g.strokeStyle = 'rgba(120,120,114,0.38)';
    g.fillStyle = 'rgba(120,120,114,0.04)';
    g.lineWidth = 0.8;
    for (var i = 0; i < state.parsed.polys.length; i++) {
      pathPoly(state.parsed.polys[i], 0, 0);
      g.fill();
      g.stroke();
    }
    g.restore();
  }

  function draw() {
    if (state.mode !== 'js') return;
    if (!view.w) return;
    g.clearRect(0, 0, view.w, view.h);
    if (!state.parsed) return;
    var f = state.frames[state.idx];
    if (!f) {
      // 还没开始求解：先画出边界与原始位置
      drawIdle();
      return;
    }

    var boundary = state.parsed.boundary;
    var polys = state.parsed.polys;

    // 边界
    pathPoly(boundary, 0, 0);
    g.fillStyle = '#f4f7fb';
    g.fill();
    g.strokeStyle = '#8d8d88';
    g.lineWidth = 1;
    g.stroke();

    var placed = null, i;
    if (f.placed) {
      placed = new Uint8Array(polys.length);
      for (i = 0; i < f.placed.length; i++) placed[f.placed[i]] = 1;
    }

    // 未放置：原位虚线
    if (placed && $('tgGhost').checked) {
      g.save();
      g.setLineDash([4, 3]);
      g.strokeStyle = 'rgba(120,120,114,0.42)';
      g.fillStyle = 'rgba(120,120,114,0.04)';
      g.lineWidth = 0.8;
      for (i = 0; i < polys.length; i++) {
        if (placed[i]) continue;
        pathPoly(polys[i], 0, 0);
        g.fill();
        g.stroke();
      }
      g.restore();
    }

    // 已放置
    for (i = 0; i < polys.length; i++) {
      if (placed && !placed[i]) continue;
      var t = f.trans[i] || [0, 0];
      var isFocus = (f.focus === i);
      var h = hueOf(i);
      pathPoly(polys[i], t[0], t[1]);
      g.fillStyle = isFocus ? 'hsl(212,70%,58%)' : 'hsl(' + h + ',40%,79%)';
      g.fill();
      g.strokeStyle = isFocus ? '#0f4c8a' : 'hsl(' + h + ',35%,45%)';
      g.lineWidth = isFocus ? 1.8 : 0.75;
      g.stroke();
    }

    // 候选位置：当前多边形被搜索过的合法落点
    if (f.cands && $('tgCands').checked && f.focus >= 0 && polys[f.focus]) {
      var ref = polys[f.focus][0];
      g.save();
      for (i = 0; i < f.cands.length; i++) {
        var cx = px(ref.x + f.cands[i][0]);
        var cy = py(ref.y + f.cands[i][1]);
        g.beginPath();
        g.arc(cx, cy, 2.4, 0, Math.PI * 2);
        g.fillStyle = 'rgba(255,255,255,0.9)';
        g.fill();
        g.strokeStyle = 'rgba(26,111,212,0.85)';
        g.lineWidth = 1;
        g.stroke();
      }
      g.restore();
    }

    // 编号
    if ($('tgTrail').checked) {
      g.save();
      g.fillStyle = 'rgba(30,30,28,0.72)';
      g.font = '9px -apple-system, "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (i = 0; i < polys.length; i++) {
        if (placed && !placed[i]) continue;
        var tt = f.trans[i] || [0, 0];
        var bb = bboxOf(polys[i]);
        var mx = px((bb.l + bb.r) / 2 + tt[0]);
        var my = py((bb.b + bb.t) / 2 + tt[1]);
        g.fillText(String(i), mx, my);
      }
      g.restore();
    }
  }

  /* ---------------- 播放控制 ---------------- */

  function phaseName(p) {
    return {
      init: '初始化', prep: '预处理', order: '排序筛选',
      place: '顺序放置', compact: '全局压缩', squeeze: '挤压救援',
      sa: '模拟退火', done: '完成'
    }[p] || p;
  }

  function goTo(i) {
    if (!state.frames.length) return;
    if (i < 0) i = 0;
    if (i > state.frames.length - 1) i = state.frames.length - 1;
    state.idx = i;
    var f = state.frames[i];
    $('slider').value = String(i);
    $('counter').textContent = (i + 1) + ' / ' + state.frames.length;
    $('mFrame').textContent = (i + 1) + '/' + state.frames.length;

    if (state.mode === 'wasm') {
      setFrameSvg(state.wasmFrames[i]);
      $('phaseBadge').textContent = '原版 C++';
      $('stepLabel').textContent = f.label || ('帧 ' + (i + 1));
      $('mCost').textContent = (f.sum != null) ? f.sum.toFixed(3) : '—';
      $('mPlaced').textContent = (f.placed != null) ? String(f.placed) : '—';
      return;
    }

    $('phaseBadge').textContent = phaseName(f.phase);
    $('stepLabel').textContent = f.label;
    $('mCost').textContent = f.cost.toFixed(3);
    $('mPlaced').textContent = f.placed ? String(f.placed.length) : String(state.parsed.polys.length);
    draw();
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

  function progressPct(p) {
    if (!p) return 0;
    if (p.stage === 'orders') return 5 + Math.round((p.done / Math.max(1, p.total)) * 50);
    if (p.stage === 'replay') return 58 + Math.round((p.done / Math.max(1, p.total)) * 14);
    if (p.stage === 'sa') return 74 + Math.round((p.done / Math.max(1, p.total)) * 24);
    return 0;
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

    // 先做完整校验：结构、自交、零面积、面积上界。不合法就不提交给求解器。
    var v = S.validateInput(text);
    if (!showCheck(v)) return;

    var parsed = S.parseInput(text);
    if (parsed.error) {
      $('editorErr').textContent = '解析失败：' + parsed.error;
      return;
    }
    state.parsed = parsed;
    state.ghostD = null;
    state.bbox = bboxOf(parsed.boundary);
    // 换了数据就必须丢掉旧帧，否则帧里的 focus / trans 索引会跟新多边形对不上
    state.frames = [];
    state.idx = 0;
    $('slider').max = '0';
    $('slider').value = '0';
    $('counter').textContent = '0 / 0';
    $('mFrame').textContent = '0/0';
    $('mPlaced').textContent = '0';
    fitView();
    draw();

    pause();
    setBusy(true);
    $('stepLabel').textContent = '正在求解：先枚举启发式放置顺序，再逐块放置。';
    $('mCost').textContent = '—';
    setOverlay('正在求解…', true);
    $('overlayBar').style.width = '2%';

    var engine = $('engineSel').value;
    if (engine === 'wasm') {
      if (!wasmWorker) { fail('WASM 引擎没有就绪，请切换到 JS 快速预览'); return; }
      var lim = parseInt($('limitSel').value, 10) || 20;
      $('overlayText').textContent = '正在运行原始 C++ 求解器（WASM），时限 ' + lim + ' 秒…';
      wasmWorker.postMessage({ type: 'solve', text: text, limit: lim });
      return;
    }

    var quality = $('qualitySel').value;
    if (worker) {
      worker.postMessage({ text: text, quality: quality });
    } else {
      setTimeout(function () {
        try {
          var res = S.solve(parsed, { quality: quality }, function (p) {
            $('overlayBar').style.width = progressPct(p) + '%';
          });
          finish(res);
        } catch (e) {
          fail(String(e && e.message || e));
        }
      }, 40);
    }
  }

  function finish(res) {
    setBusy(false);
    if (!res || res.error) { fail(res && res.error || '求解失败'); return; }
    setOverlay('', false);
    state.mode = 'js';
    showViewer('js');
    state.frames = res.frames;
    state.stats = res.stats;
    $('slider').max = String(res.frames.length - 1);
    $('slider').value = '0';
    renderOrders(res.orderTable);
    $('topMeta').textContent =
      res.stats.n + ' 个多边形 · ' + res.stats.shapes + ' 种形状 · ' +
      res.stats.tris + ' 个三角形 · ' + (res.stats.ms / 1000).toFixed(1) + ' s';
    goTo(0);
    renderPhaseJump();
    play();
  }

  function finishWasm(res) {
    setBusy(false);
    if (!res || res.error) { fail(res && res.error || '求解失败'); return; }
    if (!res.frames || !res.frames.length) { fail('求解器没有产出可视化帧'); return; }

    state.wasmFrames = res.frames;
    state.frames = res.frames;
    state.mode = 'wasm';
    showViewer('wasm');

    setOverlay('', false);
    $('slider').max = String(res.frames.length - 1);
    $('slider').value = '0';
    $('topMeta').textContent =
      res.trans.length + ' 个多边形 · 原版 C++ · 时限 ' + res.limit + ' s · ' +
      (res.ms / 1000).toFixed(1) + ' s 实际耗时';
    $('orderCard').hidden = true;
    $('phaseJump').innerHTML = '';
    goTo(0);
    play();
  }

  // 直接把求解器产出的 SVG 内联进 DOM：viewBox + preserveAspectRatio 会自己等比缩放，
  // 比 <img> + object-fit 稳（后者对这种只有 viewBox、没有宽高的 SVG 会拉伸）
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

  function showViewer(mode) {
    var box = $('frameBox'), cvEl = $('cv');
    var isWasm = (mode === 'wasm');
    document.querySelector('.canvas-wrap').classList.toggle('wasm-mode', isWasm);
    if (isWasm) { box.hidden = false; cvEl.style.display = 'none'; }
    else { box.hidden = true; box.innerHTML = ''; cvEl.style.display = 'block'; resize(); }

    // 这些只对 JS 画布有意义（原位虚线、候选点、编号、阶段跳转）
    var legend = document.querySelector('.legend');
    if (legend) legend.style.display = isWasm ? 'none' : '';
    // 候选点、编号只对 JS 画布有效；"未放置"两种模式都适用
    $('tgCandsWrap').style.display = isWasm ? 'none' : '';
    $('tgTrailWrap').style.display = isWasm ? 'none' : '';
    $('phaseJump').style.display = isWasm ? 'none' : '';
  }

  function fail(msg) {
    setBusy(false);
    setOverlay('', false);
    $('editorErr').textContent = '求解失败：' + msg;
  }

  function renderOrders(table) {
    if (!table || !table.length) { $('orderCard').hidden = true; return; }
    $('orderCard').hidden = false;
    var els = $('orderTable');
    els.innerHTML = '';
    var best = table[0].cost;
    var worst = 0;
    table.forEach(function (r) {
      if (r.feasible !== false && isFinite(r.cost) && r.cost > worst) worst = r.cost;
    });
    if (!worst || worst > 1e15) worst = best || 1;

    table.slice(0, 10).forEach(function (r, i) {
      var tr = document.createElement('tr');
      if (i === 0) tr.className = 'best';

      var td1 = document.createElement('td');
      td1.className = 'name';
      td1.textContent = r.name;

      var td2 = document.createElement('td');
      var track = document.createElement('div');
      track.className = 'track';
      var fill = document.createElement('i');
      var ok = (r.feasible !== false) && isFinite(r.cost) && r.cost < 1e15;
      var w = ok ? Math.max(3, Math.round((r.cost / worst) * 100)) : 100;
      fill.style.width = w + '%';
      fill.style.background = ok ? '' : '#e0d3c8';
      track.appendChild(fill);
      td2.appendChild(track);

      var td3 = document.createElement('td');
      td3.className = 'val';
      td3.textContent = (r.feasible !== false && isFinite(r.cost) && r.cost < 1e15)
        ? r.cost.toFixed(1) : '不可行';

      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      els.appendChild(tr);
    });
  }

  /* ---------------- 阶段跳转 ---------------- */

  function renderPhaseJump() {
    var bar = $('phaseJump');
    if (!bar) return;
    bar.innerHTML = '';
    var seen = {}, i;
    for (i = 0; i < state.frames.length; i++) {
      var p = state.frames[i].phase;
      if (!seen[p]) { seen[p] = i; }
    }
    Object.keys(seen).forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost';
      b.textContent = phaseName(p);
      b.onclick = function () { pause(); goTo(seen[p]); };
      bar.appendChild(b);
    });
  }

  /* ---------------- Worker ---------------- */

  function initWorker() {
    try {
      worker = new Worker('assets/solver.worker.js?v=20261117c');
      worker.onmessage = function (e) {
        var d = e.data || {};
        if (d.type === 'progress') {
          $('overlayBar').style.width = progressPct(d.p) + '%';
        } else if (d.type === 'done') {
          finish(d.data);
        } else if (d.type === 'error') {
          fail(d.message);
        }
      };
      worker.onerror = function () {
        worker = null;
      };
    } catch (e) {
      worker = null;
    }
  }

  function initWasmWorker() {
    try {
      wasmWorker = new Worker('assets/wasm-worker.js?v=20261117c');
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
      if (state.mode === 'wasm') setFrameSvg(state.wasmFrames[state.idx]);
      else draw();
    };
    $('tgCands').onchange = draw;
    $('tgTrail').onchange = draw;

    $('datasetSel').onchange = function () { selectDataset(this.value, true); };

    $('engineSel').onchange = function () {
      var isWasm = this.value === 'wasm';
      $('limitSel').hidden = !isWasm;
      $('qualitySel').hidden = isWasm;
    };

    $('btnAdd').onclick = function () {
      var name = window.prompt('给这个数据集起个名字：', '我的算例 ' + (loadCustom().length + 1));
      if (!name) return;
      var text = $('editor').value;
      var v = S.validateInput(text);
      if (!v.ok) {
        $('editorErr').classList.remove('ok');
        $('editorErr').textContent = '输入不合法，未添加：' + v.errors.slice(0, 3).join('；');
        return;
      }
      var check = S.parseInput(text);
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
        showCheck(S.validateInput(t), '输入不合法：');
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

    window.addEventListener('resize', resize);
    if (window.ResizeObserver) {
      new ResizeObserver(function () { resize(); }).observe(cv.parentElement);
    }
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    rebuild();
    initWorker();
    initWasmWorker();
    bind();
    resize();

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
