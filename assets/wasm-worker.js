/*
 * wasm-worker.js — 在后台线程里跑**原始 C++ 求解器**（经 Emscripten 编译）
 *
 * 与 assets/solver.js（JS 移植版）完全独立：这里执行的是 Solution.cpp 本身，
 * 帧来自它自己的 saveFrame()，写进 Emscripten 的虚拟文件系统后读出来。
 */
'use strict';

// 继承父页面的版本号，保证 worker 内部加载的脚本也跟着刷新，不被 10 分钟缓存卡住
var VER = self.location.search || '';
var BASE = new URL('wasm/', self.location.href).href;
importScripts('wasm/solver_wasm.js' + VER);

function extractCaption(svg) {
  var texts = [];
  var re = /<text[^>]*>([^<]*)<\/text>/g;
  var m;
  while ((m = re.exec(svg)) !== null) texts.push(m[1]);
  var label = '', sum = null, placed = null;
  for (var i = 0; i < texts.length; i++) {
    var t = texts[i];
    if (/^(Place|Squeeze|Final|Phase|Best|Initial|sumDisp)/.test(t)) {
      if (/sumDisp=/.test(t)) {
        var a = t.match(/sumDisp=([\d.eE+-]+)/);
        var b = t.match(/placed=(\d+)\/(\d+)/);
        if (a) sum = parseFloat(a[1]);
        if (b) placed = parseInt(b[1], 10);
      } else if (/^(Place|Squeeze|Final)/.test(t)) {
        label = t;
      } else if (/^Phase\d/.test(t)) {
        var bc = t.match(/bestCost=([\d.eE+-]+)/);
        if (!label) label = '阶段最优快照' + (bc ? ' · Σ=' + parseFloat(bc[1]).toFixed(2) : '');
      } else if (!label) {
        label = t;
      }
    }
  }
  return { label: label, sum: sum, placed: placed };
}

self.onmessage = function (e) {
  var d = e.data || {};
  if (d.type !== 'solve') return;

  var text = String(d.text || '');
  // C++ 的 main() 要求输入以 "OK" 结尾，缺失会直接 return 1
  var tail = text.trim().split(/\s+/).pop();
  if (tail !== 'OK') text += '\nOK\n';
  var limit = Number(d.limit) || 12;
  var pos = 0;
  var stdout = [];
  var started = Date.now();

  createSolver({
    print: function (s) { stdout.push(s); },
    printErr: function (s) {
      var m = /Phase[0-9]|Total time/.exec(s);
      if (m) {
        self.postMessage({ type: 'log', text: s.trim() });
      }
    },
    stdin: function () { return pos < text.length ? text.charCodeAt(pos++) : null; },
    locateFile: function (p) { return BASE + p + VER; }
  }).then(function (Module) {
    try { Module.FS.mkdir('/visualizations'); } catch (err) { /* 已存在 */ }

    try {
      Module.callMain(['--time-limit', String(limit)]);
    } catch (err) {
      self.postMessage({ type: 'error', message: '求解器异常：' + (err && err.message || err) });
      return;
    }

    var dir = '/visualizations/frames';
    var ok = false;
    try { ok = Module.FS.analyzePath(dir).exists; } catch (err) {}
    if (!ok) {
      var diag = ' cwd=' + Module.FS.cwd();
      try {
        var root = Module.FS.readdir('/');
        diag += ' root=' + JSON.stringify(root);
        for (var ri = 0; ri < root.length; ri++) {
          var nm = root[ri];
          if (nm === '.' || nm === '..') continue;
          try {
            var st = Module.FS.stat('/' + nm);
            if (Module.FS.isDir(st.mode)) diag += ' | /' + nm + '=' + JSON.stringify(Module.FS.readdir('/' + nm));
          } catch (e2) {}
        }
        diag += ' | 相对路径解析=' + JSON.stringify(Module.FS.analyzePath('visualizations').exists);
      } catch (e) { diag += ' FS 读取失败:' + e.message; }
      self.postMessage({ type: 'error', message: '求解器没有产出可视化帧。' + diag });
      return;
    }
    var files = Module.FS.readdir(dir).filter(function (f) { return /^frame_\d+\.svg$/.test(f); });
    files.sort();

    var frames = [];
    var totalBytes = 0;
    for (var i = 0; i < files.length; i++) {
      var svg = Module.FS.readFile(dir + '/' + files[i], { encoding: 'utf8' });
      totalBytes += svg.length;
      var cap = extractCaption(svg);
      frames.push({ svg: svg, label: cap.label, sum: cap.sum, placed: cap.placed });
    }

    var out = stdout.join('\n').split('\n').filter(function (x) { return x.trim(); });
    var trans = out.slice(1, 1 + (parseInt(out[0], 10) || 0)).map(function (l) {
      var p = l.trim().split(/\s+/).map(Number);
      return [p[0], p[1]];
    });
    var cost = trans.reduce(function (a, t) { return a + Math.hypot(t[0], t[1]); }, 0);

    self.postMessage({
      type: 'done',
      data: {
        frames: frames,
        trans: trans,
        cost: cost,
        ms: Date.now() - started,
        limit: limit,
        bytes: totalBytes,
        log: out.slice(0, 1)
      }
    });
  }).catch(function (err) {
    self.postMessage({ type: 'error', message: 'WASM 初始化失败：' + (err && err.message || err) });
  });
};
