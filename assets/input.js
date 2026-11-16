/*
 * input.js — 输入数据的解析与合法性检查
 *
 * 这个文件**不含任何求解逻辑**。求解全部由原版 C++（编译成 WASM）完成。
 * 页面需要自己读输入，只有两个用途：
 *   1. 把还没被放置的多边形按原始坐标画成虚线底图（否则看起来像凭空出现）；
 *   2. 提交前做一遍合法性检查（自交、零面积、面积超界……），
 *      否则原始求解器会白跑满整个时限最后返回 INF。
 *
 * 注意：这里的判定故意写得直白（全对边相交检测、鞋带公式算面积），
 * 不追求性能——一个算例只调用一次。
 */
(function () {
  'use strict';

  function V(x, y) { return { x: x, y: y }; }

  function vcross(a, b) { return a.x * b.y - a.y * b.x; }

  function boxOf(pts) {
    var l = Infinity, b = Infinity, r = -Infinity, t = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.x < l) l = p.x;
      if (p.x > r) r = p.x;
      if (p.y < b) b = p.y;
      if (p.y > t) t = p.y;
    }
    return { l: l, b: b, r: r, t: t };
  }

  function signedArea2(pts) {
    var s = 0, n = pts.length;
    for (var i = 0; i < n; i++) s += vcross(pts[i], pts[(i + 1) % n]);
    return s * 0.5;
  }

  // 两条线段是否在内部真正相交（不把共享端点、共线接触算作相交）
  function segmentsIntersectInterior(a, b, c, d) {
    var rx = b.x - a.x, ry = b.y - a.y;
    var sx = d.x - c.x, sy = d.y - c.y;
    var rxs = rx * sy - ry * sx;
    if (Math.abs(rxs) < 1e-14) return false;
    var dx = c.x - a.x, dy = c.y - a.y;
    var t = (dx * sy - dy * sx) / rxs;
    var u = (dx * ry - dy * rx) / rxs;
    var te = 1e-10;
    return (t > te && t < 1.0 - te && u > te && u < 1.0 - te);
  }

  // 返回第一处自交的边对 [i, j]，没有则返回 null
  function findSelfIntersection(pts) {
    var n = pts.length;
    for (var i = 0; i < n; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      for (var j = i + 1; j < n; j++) {
        if (j === i || (j + 1) % n === i || j === (i + 1) % n) continue;
        var c = pts[j], d = pts[(j + 1) % n];
        if (segmentsIntersectInterior(a, b, c, d)) return [i, j];
      }
    }
    return null;
  }

  /*
   * 解析输入格式：
   *   <边界顶点数>
   *   x1 y1 x2 y2 ...
   *   <多边形个数>
   *   <顶点数> x1 y1 ...        （重复「多边形个数」次）
   * 末尾允许出现独立的 OK（原版求解器的结束标记）。
   */
  function parseInput(text) {
    var raw = String(text).split(/\s+/).filter(function (t) { return t.length > 0; });
    if (!raw.length) return { error: '输入为空' };
    var i = 0;

    var bn = parseInt(raw[i++], 10);
    if (!(bn >= 3)) return { error: '第一行应是边界多边形顶点数（≥3），实际读到 "' + raw[0] + '"' };
    if (raw.length < 1 + bn * 2) return { error: '边界顶点数 ' + bn + ' 之后缺少足够的坐标' };

    var boundary = [];
    for (var k = 0; k < bn; k++) {
      var bx = parseFloat(raw[i++]), by = parseFloat(raw[i++]);
      if (!isFinite(bx) || !isFinite(by)) return { error: '边界第 ' + (k + 1) + ' 个顶点坐标无法解析' };
      boundary.push(V(bx, by));
    }
    if (i >= raw.length) return { error: '缺少多边形数量' };
    var gn = parseInt(raw[i++], 10);
    if (!(gn > 0)) return { error: '多边形数量必须是正整数，实际读到 "' + raw[i - 1] + '"' };

    var polys = [];
    for (var p = 0; p < gn; p++) {
      if (i >= raw.length) return { error: '声明了 ' + gn + ' 个多边形，但第 ' + (p + 1) + ' 个缺失' };
      var vn = parseInt(raw[i++], 10);
      if (!(vn >= 3)) return { error: '第 ' + (p + 1) + ' 个多边形顶点数为 ' + vn + '，至少需要 3' };
      if (i + vn * 2 > raw.length) return { error: '第 ' + (p + 1) + ' 个多边形坐标数量不足（需要 ' + vn + ' 对）' };
      var pts = [];
      for (var q = 0; q < vn; q++) {
        pts.push(V(parseFloat(raw[i++]), parseFloat(raw[i++])));
      }
      polys.push(pts);
    }
    return { boundary: boundary, polys: polys };
  }

  function validateInput(text) {
    var parsed = parseInput(text);
    if (parsed.error) return { ok: false, errors: [parsed.error], warnings: [], stats: null };

    var boundary = parsed.boundary, polys = parsed.polys;
    var errors = [], warnings = [];
    var i, j;

    // 1. 坐标必须是有限数
    for (i = 0; i < boundary.length; i++) {
      if (!isFinite(boundary[i].x) || !isFinite(boundary[i].y)) {
        return { ok: false, errors: ['边界第 ' + (i + 1) + ' 个顶点坐标不是有效数字'], warnings: [], stats: null };
      }
    }
    for (i = 0; i < polys.length; i++) {
      for (j = 0; j < polys[i].length; j++) {
        if (!isFinite(polys[i][j].x) || !isFinite(polys[i][j].y)) {
          return { ok: false, errors: ['第 ' + (i + 1) + ' 个多边形第 ' + (j + 1) + ' 个顶点坐标不是有效数字'], warnings: [], stats: null };
        }
      }
    }

    // 2. 边界
    var bArea = Math.abs(signedArea2(boundary));
    if (bArea < 1e-9) errors.push('边界多边形面积为 0（顶点重合或共线）');
    var bSi = findSelfIntersection(boundary);
    if (bSi) {
      errors.push('边界多边形自相交：第 ' + bSi[0] + ' 条边与第 ' + bSi[1] + ' 条边交叉');
    }
    var bb = boxOf(boundary);

    // 3. 每个多边形
    var totalArea = 0, badArea = [], badSelf = [], tooBig = [];
    for (i = 0; i < polys.length; i++) {
      var pts = polys[i];
      var a = Math.abs(signedArea2(pts));
      totalArea += a;
      var si = findSelfIntersection(pts);
      if (si) badSelf.push(i + '(' + si[0] + '×' + si[1] + ')');
      if (a < 1e-12) badArea.push(i);
      if (!si) {
        var pb = boxOf(pts);
        if (pb.r - pb.l > bb.r - bb.l + 1e-9 || pb.t - pb.b > bb.t - bb.b + 1e-9) tooBig.push(i);
      }
    }
    if (badArea.length) {
      errors.push('有 ' + badArea.length + ' 个多边形面积为 0（顶点重合或共线），例：#' + badArea.slice(0, 5).join(', #'));
    }
    if (badSelf.length) {
      errors.push('有 ' + badSelf.length + ' 个多边形自相交，例：#' + badSelf.slice(0, 5).join(', #'));
    }
    if (tooBig.length) {
      errors.push('有 ' + tooBig.length + ' 个多边形的包围盒比边界还大，肯定放不进去，例：#' + tooBig.slice(0, 5).join(', #'));
    }

    // 4. 面积上界（必要条件）
    if (bArea > 1e-12 && totalArea > bArea * (1 + 1e-9)) {
      errors.push('多边形总面积 ' + totalArea.toFixed(2) + ' 超过边界面积 ' + bArea.toFixed(2) + '，无解');
    }

    // 5. 提示
    if (bArea > 1e-12 && totalArea > bArea * 0.95) {
      warnings.push('面积占比 ' + (totalArea / bArea * 100).toFixed(1) + '%，非常高，可能放不下');
    }
    if (polys.length > 400) warnings.push('多边形数量 ' + polys.length + ' 偏多，求解会明显变慢');

    return {
      ok: errors.length === 0,
      errors: errors,
      warnings: warnings,
      stats: {
        n: polys.length,
        boundaryVerts: boundary.length,
        boundaryArea: bArea,
        totalArea: totalArea,
        ratio: bArea > 1e-12 ? totalArea / bArea : 0
      }
    };
  }

  window.NestInput = {
    parseInput: parseInput,
    validateInput: validateInput,
    boxOf: boxOf,
    signedArea2: signedArea2
  };
})();
