/* solver.worker.js — 在后台线程跑求解，避免阻塞界面 */
'use strict';

importScripts('solver.js');

self.onmessage = function (e) {
  var d = e.data || {};
  try {
    var parsed = self.NestSolver.parseInput(d.text);
    if (parsed.error) {
      self.postMessage({ type: 'error', message: parsed.error });
      return;
    }
    var res = self.NestSolver.solve(parsed, { quality: d.quality }, function (p) {
      self.postMessage({ type: 'progress', p: p });
    });
    self.postMessage({ type: 'done', data: res });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
