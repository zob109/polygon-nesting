/*
 * solver.js — 多边形排样求解器（浏览器可运行版）
 *
 * 移植自 Solution.cpp。原算法的五个阶段：
 *   1. 三角剖分 + BVH 构建
 *   2. NFP 凸包近似（Minkowski 差的凸包）
 *   3. 顺序放置（NFP 顶点 / 边采样 / 网格回退 / 边交点）
 *   4. 全局压缩（所有多边形朝原点收缩）
 *   5. 模拟退火（扰动放置顺序）
 *
 * 问题定义不变：最小化 Σ|trans_i|，约束为两两不重叠、全部位于边界多边形内、只允许平移。
 *
 * 与原 C++ 实现的差异（为了让浏览器跑得动，不改变问题定义）：
 *   1. NFP 用两条凸包的 Minkowski 和做边归并，O(n+m)，数学上等价于原点集两两差值的凸包；
 *   2. 边界内含判定加了均匀网格索引，避免 172 边形 × 28 条边界边的全对检测；
 *   3. 严格 inner-NFP（栅格化 + Moore 轮廓追踪，约 400 行）未移植，
 *      改用边界顶点作候选种子；合法性仍由 polyInBoundary 严格校验，不会产生越界解；
 *   4. 候选采样步长、顺序数量、退火迭代次数由 quality 预设控制，可用参数覆盖。
 */
(function (global) {
  'use strict';

  var EPS = 1e-8;
  var INF = 1e18;
  var _dbg = { tryV: 0, check: 0, boundary: 0, bvh: 0, place: 0 };

  /* ============================ 基础几何 ============================ */

  function V(x, y) { return { x: x, y: y }; }
  function vsub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
  function vadd(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
  function vdot(a, b) { return a.x * b.x + a.y * b.y; }
  function vcross(a, b) { return a.x * b.y - a.y * b.x; }
  function vnorm(a) { return Math.sqrt(a.x * a.x + a.y * a.y); }
  var ZERO = V(0, 0);

  function boxNew() { return { l: INF, b: INF, r: -INF, t: -INF }; }
  function boxExpand(bx, p) {
    if (p.x < bx.l) bx.l = p.x;
    if (p.x > bx.r) bx.r = p.x;
    if (p.y < bx.b) bx.b = p.y;
    if (p.y > bx.t) bx.t = p.y;
  }
  function boxOf(pts) {
    var bx = boxNew();
    for (var i = 0; i < pts.length; i++) boxExpand(bx, pts[i]);
    return bx;
  }
  function boxMoved(bx, off) {
    return { l: bx.l + off.x, b: bx.b + off.y, r: bx.r + off.x, t: bx.t + off.y };
  }
  function boxIntersects(a, b) {
    return !(a.r < b.l - EPS || a.l > b.r + EPS || a.t < b.b - EPS || a.b > b.t + EPS);
  }
  function boxArea(bx) {
    if (bx.r < bx.l || bx.t < bx.b) return 0;
    return (bx.r - bx.l) * (bx.t - bx.b);
  }
  function polyAreaAbs(pts) {
    var s = 0, n = pts.length;
    for (var i = 0; i < n; i++) s += vcross(pts[i], pts[(i + 1) % n]);
    return Math.abs(s) * 0.5;
  }

  /* ============================ 三角剖分（Ear Clipping） ============================ */

  function isPointInTri(p, a, b, c) {
    var c1 = vcross(vsub(b, a), vsub(p, a));
    var c2 = vcross(vsub(c, b), vsub(p, b));
    var c3 = vcross(vsub(a, c), vsub(p, c));
    var hasNeg = (c1 < -EPS) || (c2 < -EPS) || (c3 < -EPS);
    var hasPos = (c1 > EPS) || (c2 > EPS) || (c3 > EPS);
    return !(hasNeg && hasPos);
  }

  function makeTri(a, b, c) {
    var t = { p: [a, b, c], bbox: boxNew() };
    boxExpand(t.bbox, a); boxExpand(t.bbox, b); boxExpand(t.bbox, c);
    return t;
  }

  function triangulate(src) {
    var res = [];
    if (!src || src.length < 3) return res;
    var pts = src.slice();
    var a = 0, n = pts.length, i;
    for (i = 0; i < n; i++) a += vcross(pts[i], pts[(i + 1) % n]);
    if (a < 0) pts.reverse();

    var rem = pts.slice();
    var guard = n * n;
    while (rem.length > 3 && guard-- > 0) {
      var ok = false;
      for (i = 0; i < rem.length; i++) {
        var pv = (i === 0) ? rem.length - 1 : i - 1;
        var nx = (i + 1) % rem.length;
        var p0 = rem[pv], p1 = rem[i], p2 = rem[nx];
        if (vcross(vsub(p1, p0), vsub(p2, p1)) <= EPS) continue;
        var ear = true;
        for (var j = 0; j < rem.length; j++) {
          if (j === pv || j === i || j === nx) continue;
          if (isPointInTri(rem[j], p0, p1, p2)) { ear = false; break; }
        }
        if (ear) {
          res.push(makeTri(p0, p1, p2));
          rem.splice(i, 1);
          ok = true;
          break;
        }
      }
      if (!ok) break;
    }
    if (rem.length >= 3) res.push(makeTri(rem[0], rem[1], rem[2]));
    return res;
  }

  /* ============================ BVH ============================ */

  function buildBVH(tris) {
    var nodes = [];
    if (!tris.length) return nodes;
    var idx = [];
    for (var i = 0; i < tris.length; i++) idx.push(i);

    function build(s, e) {
      if (s >= e) return -1;
      var n = nodes.length;
      var node = { bbox: boxNew(), left: -1, right: -1, tri: -1 };
      nodes.push(node);
      var k;
      for (k = s; k < e; k++) {
        var tb = tris[idx[k]].bbox;
        if (tb.l < node.bbox.l) node.bbox.l = tb.l;
        if (tb.r > node.bbox.r) node.bbox.r = tb.r;
        if (tb.b < node.bbox.b) node.bbox.b = tb.b;
        if (tb.t > node.bbox.t) node.bbox.t = tb.t;
      }
      if (e - s === 1) { node.tri = idx[s]; return n; }

      var mid = s + ((e - s) >> 1);
      var cl = INF, cr = -INF, cb = INF, ct = -INF;
      for (k = s; k < e; k++) {
        var b2 = tris[idx[k]].bbox;
        var cx = (b2.l + b2.r) * 0.5, cy = (b2.b + b2.t) * 0.5;
        if (cx < cl) cl = cx;
        if (cx > cr) cr = cx;
        if (cy < cb) cb = cy;
        if (cy > ct) ct = cy;
      }
      var part = idx.slice(s, e);
      if (cr - cl > ct - cb) {
        part.sort(function (x, y) {
          var A = tris[x].bbox, B = tris[y].bbox;
          return (A.l + A.r) - (B.l + B.r);
        });
      } else {
        part.sort(function (x, y) {
          var A = tris[x].bbox, B = tris[y].bbox;
          return (A.b + A.t) - (B.b + B.t);
        });
      }
      for (k = 0; k < part.length; k++) idx[s + k] = part[k];

      node.left = build(s, mid);
      node.right = build(mid, e);
      return n;
    }
    build(0, idx.length);
    return nodes;
  }

  function makeShape(pts) {
    var tris = triangulate(pts);
    return { pts: pts, tris: tris, bbox: boxOf(pts), bvh: buildBVH(tris), _hull: null };
  }

  /* ============================ 三角形 SAT ============================ */

  // 三角形 SAT（全部用数值参数，避免热路径上的对象分配）
  function overlapTri(t1, ox1, oy1, t2, ox2, oy2) {
    var p;
    for (var s = 0; s < 2; s++) {
      var a = s === 0 ? t1 : t2;
      var oax = s === 0 ? ox1 : ox2, oay = s === 0 ? oy1 : oy2;
      var b = s === 0 ? t2 : t1;
      var obx = s === 0 ? ox2 : ox1, oby = s === 0 ? oy2 : oy1;
      p = a.p;
      for (var i = 0; i < 3; i++) {
        var p0 = p[i], p1 = p[(i + 1) % 3];
        var axr = -(p1.y - p0.y), axy = (p1.x - p0.x);
        var mnA = INF, mxA = -INF, mnB = INF, mxB = -INF, j, v;
        for (j = 0; j < 3; j++) {
          v = (p[j].x + oax) * axr + (p[j].y + oay) * axy;
          if (v < mnA) mnA = v;
          if (v > mxA) mxA = v;
        }
        var q = b.p;
        for (j = 0; j < 3; j++) {
          v = (q[j].x + obx) * axr + (q[j].y + oby) * axy;
          if (v < mnB) mnB = v;
          if (v > mxB) mxB = v;
        }
        if (mxA <= mnB + EPS || mxB <= mnA + EPS) return false;
      }
    }
    return true;
  }

  function overlapBVH(nA, sA, oax, oay, nB, sB, obx, oby) {
    _dbg.bvh++;
    var nodeA = sA.bvh[nA], nodeB = sB.bvh[nB];
    var bA = nodeA.bbox, bB = nodeB.bbox;
    var al = bA.l + oax, ar = bA.r + oax, ab = bA.b + oay, at = bA.t + oay;
    var bl = bB.l + obx, br = bB.r + obx, bb = bB.b + oby, bt = bB.t + oby;
    if (ar < bl - EPS || al > br + EPS || at < bb - EPS || ab > bt + EPS) return false;

    var lA = nodeA.left === -1, lB = nodeB.left === -1;
    if (lA && lB) return overlapTri(sA.tris[nodeA.tri], oax, oay, sB.tris[nodeB.tri], obx, oby);
    if (lA) {
      return overlapBVH(nA, sA, oax, oay, nodeB.left, sB, obx, oby) ||
        overlapBVH(nA, sA, oax, oay, nodeB.right, sB, obx, oby);
    }
    if (lB) {
      return overlapBVH(nodeA.left, sA, oax, oay, nB, sB, obx, oby) ||
        overlapBVH(nodeA.right, sA, oax, oay, nB, sB, obx, oby);
    }
    return overlapBVH(nodeA.left, sA, oax, oay, nB, sB, obx, oby) ||
      overlapBVH(nodeA.right, sA, oax, oay, nB, sB, obx, oby);
  }

  /* ============================ 边界内含判定 ============================ */

  // 线段严格内部相交（纯数值版，供热路径使用，避免构造点对象）
  function segInteriorNum(ax, ay, bx, by, cx, cy, dx, dy) {
    var rx = bx - ax, ry = by - ay;
    var sx = dx - cx, sy = dy - cy;
    var rxs = rx * sy - ry * sx;
    if (rxs < 1e-14 && rxs > -1e-14) return false;
    var qx = cx - ax, qy = cy - ay;
    var t = (qx * sy - qy * sx) / rxs;
    if (!(t > 1e-10 && t < 1 - 1e-10)) return false;
    var u = (qx * ry - qy * rx) / rxs;
    return (u > 1e-10 && u < 1 - 1e-10);
  }

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

  function pointInPoly(p, poly) {
    var n = poly.length;
    if (n < 3) return false;
    var inside = false;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var a = poly[j], b = poly[i];
      if ((a.y > p.y) !== (b.y > p.y)) {
        var x = a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y);
        if (p.x < x) inside = !inside;
      }
    }
    return inside;
  }

  function makeEdgeIndex(poly, bbox) {
    var w = Math.max(bbox.r - bbox.l, 1e-6), h = Math.max(bbox.t - bbox.b, 1e-6);
    var cell = Math.max(0.4, Math.min(w, h) / 26);
    var nx = Math.max(1, Math.ceil(w / cell) + 1);
    var ny = Math.max(1, Math.ceil(h / cell) + 1);
    var grid = new Array(nx * ny);
    var n = poly.length;
    for (var i = 0; i < n; i++) {
      var a = poly[i], b = poly[(i + 1) % n];
      var x0 = Math.floor((Math.min(a.x, b.x) - bbox.l) / cell);
      var x1 = Math.floor((Math.max(a.x, b.x) - bbox.l) / cell);
      var y0 = Math.floor((Math.min(a.y, b.y) - bbox.b) / cell);
      var y1 = Math.floor((Math.max(a.y, b.y) - bbox.b) / cell);
      if (x0 < 0) x0 = 0;
      if (y0 < 0) y0 = 0;
      if (x1 > nx - 1) x1 = nx - 1;
      if (y1 > ny - 1) y1 = ny - 1;
      for (var gy = y0; gy <= y1; gy++) {
        for (var gx = x0; gx <= x1; gx++) {
          var k = gy * nx + gx;
          if (!grid[k]) grid[k] = [];
          grid[k].push(i);
        }
      }
    }
    return { poly: poly, bbox: bbox, cell: cell, nx: nx, ny: ny, grid: grid, stamp: new Int32Array(n), tick: 0 };
  }

  // 边界格子状态：1=整格在内部，2=整格在外部，3=边界穿过（需精确判定）
  // 用来给 polyInBoundary 做快速通道：包围盒只覆盖 1 类格子时直接判为内含。
  // 线段与矩形是否相交（Liang-Barsky 裁剪）
  function segRectHit(ax, ay, bx, by, xmin, ymin, xmax, ymax) {
    var dx = bx - ax, dy = by - ay;
    var p = [-dx, dx, -dy, dy];
    var q = [ax - xmin, xmax - ax, ay - ymin, ymax - ay];
    var t0 = 0, t1 = 1;
    for (var i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return false;
      } else {
        var r = q[i] / p[i];
        if (p[i] < 0) {
          if (r > t1) return false;
          if (r > t0) t0 = r;
        } else {
          if (r < t0) return false;
          if (r < t1) t1 = r;
        }
      }
    }
    return true;
  }

  function makeBoundaryCells(poly, bbox, cell) {
    var nx = Math.max(1, Math.ceil((bbox.r - bbox.l) / cell) + 1);
    var ny = Math.max(1, Math.ceil((bbox.t - bbox.b) / cell) + 1);
    var state = new Uint8Array(nx * ny);
    var n = poly.length, i, gx, gy, k;

    // 精确标记：只有线段真正穿过的格子才算"边界格"
    for (i = 0; i < n; i++) {
      var a = poly[i], b = poly[(i + 1) % n];
      var x0 = Math.floor((Math.min(a.x, b.x) - bbox.l) / cell);
      var x1 = Math.floor((Math.max(a.x, b.x) - bbox.l) / cell);
      var y0 = Math.floor((Math.min(a.y, b.y) - bbox.b) / cell);
      var y1 = Math.floor((Math.max(a.y, b.y) - bbox.b) / cell);
      if (x0 < 0) x0 = 0;
      if (y0 < 0) y0 = 0;
      if (x1 > nx - 1) x1 = nx - 1;
      if (y1 > ny - 1) y1 = ny - 1;
      for (gy = y0; gy <= y1; gy++) {
        for (gx = x0; gx <= x1; gx++) {
          var k2 = gy * nx + gx;
          if (state[k2] === 3) continue;
          var rx0 = bbox.l + gx * cell, ry0 = bbox.b + gy * cell;
          if (segRectHit(a.x, a.y, b.x, b.y, rx0, ry0, rx0 + cell, ry0 + cell)) state[k2] = 3;
        }
      }
    }
    for (gy = 0; gy < ny; gy++) {
      for (gx = 0; gx < nx; gx++) {
        k = gy * nx + gx;
        if (state[k] !== 0) continue;
        var cx = bbox.l + (gx + 0.5) * cell;
        var cy = bbox.b + (gy + 0.5) * cell;
        state[k] = pointInPoly(V(cx, cy), poly) ? 1 : 2;
      }
    }
    return { state: state, nx: nx, ny: ny, l: bbox.l, b: bbox.b, cell: cell };
  }

  function bboxInsideBoundary(ctx, l, b, r, t) {
    var C = ctx.cells;
    var x0 = Math.floor((l - C.l) / C.cell);
    var x1 = Math.floor((r - C.l) / C.cell);
    var y0 = Math.floor((b - C.b) / C.cell);
    var y1 = Math.floor((t - C.b) / C.cell);
    if (x0 < 0 || y0 < 0 || x1 >= C.nx || y1 >= C.ny) return false;
    for (var gy = y0; gy <= y1; gy++) {
      for (var gx = x0; gx <= x1; gx++) {
        if (C.state[gy * C.nx + gx] !== 1) return false;
      }
    }
    return true;
  }

  // 已放置多边形的空间哈希：按包围盒落格，把"跟谁比"从 100 次降到 2~5 次
  function makeOcc(bbox, cell, n) {
    var nx = Math.max(1, Math.ceil((bbox.r - bbox.l) / cell) + 1);
    var ny = Math.max(1, Math.ceil((bbox.t - bbox.b) / cell) + 1);
    return {
      cell: cell, nx: nx, ny: ny, l: bbox.l, b: bbox.b,
      bins: new Array(nx * ny), stamp: new Int32Array(n), tick: 0, out: []
    };
  }

  function occInsert(occ, idx, bx) {
    var x0 = Math.floor((bx.l - occ.l) / occ.cell);
    var x1 = Math.floor((bx.r - occ.l) / occ.cell);
    var y0 = Math.floor((bx.b - occ.b) / occ.cell);
    var y1 = Math.floor((bx.t - occ.b) / occ.cell);
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > occ.nx - 1) x1 = occ.nx - 1;
    if (y1 > occ.ny - 1) y1 = occ.ny - 1;
    for (var gy = y0; gy <= y1; gy++) {
      for (var gx = x0; gx <= x1; gx++) {
        var k = gy * occ.nx + gx;
        if (!occ.bins[k]) occ.bins[k] = [];
        occ.bins[k].push(idx);
      }
    }
  }

  function occQuery(occ, l, b, r, t) {
    var x0 = Math.floor((l - occ.l) / occ.cell);
    var x1 = Math.floor((r - occ.l) / occ.cell);
    var y0 = Math.floor((b - occ.b) / occ.cell);
    var y1 = Math.floor((t - occ.b) / occ.cell);
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > occ.nx - 1) x1 = occ.nx - 1;
    if (y1 > occ.ny - 1) y1 = occ.ny - 1;
    var out = occ.out;
    out.length = 0;
    var tick = ++occ.tick, stamp = occ.stamp;
    for (var gy = y0; gy <= y1; gy++) {
      for (var gx = x0; gx <= x1; gx++) {
        var arr = occ.bins[gy * occ.nx + gx];
        if (!arr) continue;
        for (var i = 0; i < arr.length; i++) {
          var o = arr[i];
          if (stamp[o] === tick) continue;
          stamp[o] = tick;
          out.push(o);
        }
      }
    }
    return out;
  }

  /* ============================ 上下文构建 ============================ */

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

  function shapesMatch(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (Math.abs((a[i].x - a[0].x) - (b[i].x - b[0].x)) > 1e-9) return false;
      if (Math.abs((a[i].y - a[0].y) - (b[i].y - b[0].y)) > 1e-9) return false;
    }
    return true;
  }

  function prepare(input) {
    var boundary = input.boundary, polysIn = input.polys;
    var GBound = boxOf(boundary);
    var shapes = [], polys = [];

    for (var i = 0; i < polysIn.length; i++) {
      var pts = polysIn[i];
      var off = pts[0];
      var nm = new Array(pts.length);
      for (var q = 0; q < pts.length; q++) nm[q] = V(pts[q].x - off.x, pts[q].y - off.y);

      var sid = -1;
      for (var j = 0; j < shapes.length; j++) {
        if (shapesMatch(shapes[j].pts, nm)) { sid = j; break; }
      }
      if (sid === -1) { sid = shapes.length; shapes.push(makeShape(nm)); }

      polys.push({
        id: i,
        shape_id: sid,
        shape_offset: off,
        bbox: boxOf(pts),
        area: polyAreaAbs(pts)
      });
    }

    return {
      boundary: boundary,
      GBound: GBound,
      bbox: GBound,
      shapes: shapes,
      polys: polys,
      n: polys.length,
      edgeIndex: makeEdgeIndex(boundary, GBound),
      cells: makeBoundaryCells(boundary, GBound, Math.max(0.4, Math.min(GBound.r - GBound.l, GBound.t - GBound.b) / 26)),
      nfp: [],
      grid: null,
      occ: null
    };
  }

  /* ============================ 碰撞 / 边界检查 ============================ */

  function polyInBoundary(ctx, idx, tx, ty) {
    _dbg.boundary++;
    var pbox = ctx.polys[idx].bbox;
    var wl = pbox.l + tx, wr = pbox.r + tx;
    var wbb = pbox.b + ty, wtt = pbox.t + ty;
    // 快速通道：包围盒完全落在"确定在内部"的格子里
    if (bboxInsideBoundary(ctx, wl, wbb, wr, wtt)) return true;

    var shape = ctx.shapes[ctx.polys[idx].shape_id];
    var off = ctx.polys[idx].shape_offset;
    var ocx = off.x + tx, ocy = off.y + ty;
    var innerPts = shape.pts;
    var boundary = ctx.boundary;
    var nm = innerPts.length, nb = boundary.length;
    if (nm < 3 || nb < 3) return false;

    var GB = ctx.GBound;
    var ei = ctx.edgeIndex;
    var stamp = ei.stamp;
    var cell = ei.cell, nx = ei.nx;
    var gx0, gy0, gx1, gy1, gx, gy, arr, ai;

    for (var i = 0; i < nm; i++) {
      // 去重表必须按"内边"重置：同一条边界边要和每一条内边都比较一次
      var tick = ++ei.tick;
      var p0 = innerPts[i], p1 = innerPts[(i + 1) % nm];
      var ax = p0.x + ocx, ay = p0.y + ocy;
      var bx = p1.x + ocx, by = p1.y + ocy;
      var iml = ax < bx ? ax : bx, imr = ax < bx ? bx : ax;
      var imb = ay < by ? ay : by, imt = ay < by ? by : ay;
      if (imr < GB.l - EPS || iml > GB.r + EPS) continue;
      if (imt < GB.b - EPS || imb > GB.t + EPS) continue;

      gx0 = Math.floor((iml - ei.bbox.l) / cell);
      gx1 = Math.floor((imr - ei.bbox.l) / cell);
      gy0 = Math.floor((imb - ei.bbox.b) / cell);
      gy1 = Math.floor((imt - ei.bbox.b) / cell);
      if (gx0 < 0) gx0 = 0;
      if (gy0 < 0) gy0 = 0;
      if (gx1 > ei.nx - 1) gx1 = ei.nx - 1;
      if (gy1 > ei.ny - 1) gy1 = ei.ny - 1;

      for (gy = gy0; gy <= gy1; gy++) {
        for (gx = gx0; gx <= gx1; gx++) {
          arr = ei.grid[gy * nx + gx];
          if (!arr) continue;
          for (ai = 0; ai < arr.length; ai++) {
            var j = arr[ai];
            if (stamp[j] === tick) continue;
            stamp[j] = tick;
            var c = boundary[j], d = boundary[(j + 1) % nb];
            if (imr < Math.min(c.x, d.x) - EPS || iml > Math.max(c.x, d.x) + EPS) continue;
            if (imt < Math.min(c.y, d.y) - EPS || imb > Math.max(c.y, d.y) + EPS) continue;
            if (segInteriorNum(ax, ay, bx, by, c.x, c.y, d.x, d.y)) return false;
          }
        }
      }
    }

    // 判定点必须是多边形内部的一个点：凹多边形的包围盒中心可能落在自己外面，
    // 也可能正好压在边界顶点上（射线法在顶点上结果不确定）。
    // 用第一个三角形的重心，保证严格在内部。
    var tris = shape.tris;
    if (tris.length) {
      var t0 = tris[0].p;
      return pointInPoly(V((t0[0].x + t0[1].x + t0[2].x) / 3 + ocx,
                           (t0[0].y + t0[1].y + t0[2].y) / 3 + ocy), boundary);
    }
    return pointInPoly(V((wl + wr) * 0.5, (wbb + wtt) * 0.5), boundary);
  }

  function checkCollision(ctx, idx, tx, ty, placed, trs) {
    _dbg.check++;
    var P = ctx.polys[idx];
    var pb = P.bbox;
    var ml = pb.l + tx, mr = pb.r + tx;
    var mbb = pb.b + ty, mt = pb.t + ty;
    var GB = ctx.GBound;
    if (ml < GB.l - EPS || mr > GB.r + EPS || mbb < GB.b - EPS || mt > GB.t + EPS) return true;
    if (!polyInBoundary(ctx, idx, tx, ty)) return true;

    var shape = ctx.shapes[P.shape_id];
    var ocx = P.shape_offset.x + tx, ocy = P.shape_offset.y + ty;

    var occ = ctx.occ;
    var list = occ ? occQuery(occ, ml, mbb, mr, mt) : placed;
    for (var k = 0; k < list.length; k++) {
      var o = list[k];
      if (o === idx) continue;
      var Q = ctx.polys[o];
      var qb = Q.bbox, qt = trs[o];
      var ql = qb.l + qt.x, qr = qb.r + qt.x;
      var qbb = qb.b + qt.y, qtt = qb.t + qt.y;
      if (qr < ml - EPS || ql > mr + EPS || qtt < mbb - EPS || qbb > mt + EPS) continue;
      var so = ctx.shapes[Q.shape_id];
      if (overlapBVH(0, shape, ocx, ocy, 0, so, Q.shape_offset.x + qt.x, Q.shape_offset.y + qt.y)) return true;
    }
    return false;
  }

  function checkCollisionAll(ctx, idx, tx, ty, trs) {
    var P = ctx.polys[idx];
    var pb = P.bbox;
    var ml = pb.l + tx, mr = pb.r + tx;
    var mbb = pb.b + ty, mt = pb.t + ty;
    var GB = ctx.GBound;
    if (ml < GB.l - EPS || mr > GB.r + EPS || mbb < GB.b - EPS || mt > GB.t + EPS) return true;
    if (!polyInBoundary(ctx, idx, tx, ty)) return true;

    var shape = ctx.shapes[P.shape_id];
    var ocx = P.shape_offset.x + tx, ocy = P.shape_offset.y + ty;

    for (var o = 0; o < ctx.n; o++) {
      if (o === idx) continue;
      var Q = ctx.polys[o];
      var qb = Q.bbox, qt = trs[o];
      var ql = qb.l + qt.x, qr = qb.r + qt.x;
      var qbb = qb.b + qt.y, qtt = qb.t + qt.y;
      if (qr < ml - EPS || ql > mr + EPS || qtt < mbb - EPS || qbb > mt + EPS) continue;
      var so = ctx.shapes[Q.shape_id];
      if (overlapBVH(0, shape, ocx, ocy, 0, so, Q.shape_offset.x + qt.x, Q.shape_offset.y + qt.y)) return true;
    }
    return false;
  }

  /* ============================ 凸包 / NFP ============================ */

  function convexHull(pts) {
    if (pts.length < 3) return pts.slice();
    var p = pts.slice().sort(function (a, b) {
      return Math.abs(a.x - b.x) > EPS ? a.x - b.x : a.y - b.y;
    });
    var uniq = [p[0]];
    for (var i = 1; i < p.length; i++) {
      var last = uniq[uniq.length - 1];
      if (Math.abs(last.x - p[i].x) < 1e-9 && Math.abs(last.y - p[i].y) < 1e-9) continue;
      uniq.push(p[i]);
    }
    p = uniq;
    var n = p.length;
    if (n < 3) return p;

    var h = new Array(2 * n);
    var k = 0, t;
    for (i = 0; i < n; i++) {
      while (k >= 2 && vcross(vsub(h[k - 1], h[k - 2]), vsub(p[i], h[k - 2])) <= EPS) k--;
      h[k++] = p[i];
    }
    t = k + 1;
    for (i = n - 2; i >= 0; i--) {
      while (k >= t && vcross(vsub(h[k - 1], h[k - 2]), vsub(p[i], h[k - 2])) <= EPS) k--;
      h[k++] = p[i];
    }
    h.length = k - 1;
    return h;
  }

  // 两个逆时针凸包的 Minkowski 和（边向量按极角归并，O(n+m)）
  function minkowskiSum(P, Q) {
    var n = P.length, m = Q.length;
    if (!n || !m) return [];
    if (n === 1) return Q.map(function (q) { return V(P[0].x + q.x, P[0].y + q.y); });
    if (m === 1) return P.map(function (p) { return V(p.x + Q[0].x, p.y + Q[0].y); });

    function lowest(A) {
      var best = 0;
      for (var i = 1; i < A.length; i++) {
        if (A[i].y < A[best].y || (A[i].y === A[best].y && A[i].x < A[best].x)) best = i;
      }
      return best;
    }
    var pi = lowest(P), qi = lowest(Q);
    var eP = [], eQ = [], i;
    for (i = 0; i < n; i++) {
      var a = P[(pi + i) % n], b = P[(pi + i + 1) % n];
      eP.push({ x: b.x - a.x, y: b.y - a.y });
    }
    for (i = 0; i < m; i++) {
      var c = Q[(qi + i) % m], d = Q[(qi + i + 1) % m];
      eQ.push({ x: d.x - c.x, y: d.y - c.y });
    }

    var cur = V(P[pi].x + Q[qi].x, P[pi].y + Q[qi].y);
    var out = [V(cur.x, cur.y)];
    var ia = 0, ib = 0;
    while (ia < n || ib < m) {
      if (ia >= n) {
        cur = vadd(cur, eQ[ib]); ib++;
      } else if (ib >= m) {
        cur = vadd(cur, eP[ia]); ia++;
      } else {
        var cr = vcross(eP[ia], eQ[ib]);
        if (cr > 0) { cur = vadd(cur, eP[ia]); ia++; }
        else if (cr < 0) { cur = vadd(cur, eQ[ib]); ib++; }
        else { cur = vadd(cur, vadd(eP[ia], eQ[ib])); ia++; ib++; }
      }
      out.push(V(cur.x, cur.y));
    }
    out.pop();
    return out;
  }

  function shapeHull(shape) {
    if (!shape._hull) shape._hull = convexHull(shape.pts);
    return shape._hull;
  }

  function getNFP(ctx, a, b) {
    var row = ctx.nfp[a];
    if (!row) row = ctx.nfp[a] = [];
    var nd = row[b];
    if (nd) return nd;

    var hA = shapeHull(ctx.shapes[a]);
    var hB = shapeHull(ctx.shapes[b]);
    // 取负是 180° 旋转，不改变绕向，因此仍为逆时针，不需要 reverse
    var negB = hB.map(function (p) { return V(-p.x, -p.y); });
    var hull = minkowskiSum(hA, negB);

    var edges = new Array(hull.length);
    for (var k = 0; k < hull.length; k++) {
      var A = hull[k], B = hull[(k + 1) % hull.length];
      edges[k] = { A: A, B: B, d2: Math.min(A.x * A.x + A.y * A.y, B.x * B.x + B.y * B.y) };
    }
    nd = { hull: hull, edges: edges };
    row[b] = nd;
    return nd;
  }

  /* ============================ 放置 ============================ */

  function ensureGrid(ctx) {
    if (ctx.grid) return ctx.grid;
    var w = ctx.GBound.r - ctx.GBound.l, h = ctx.GBound.t - ctx.GBound.b;
    var step = Math.max(0.06, Math.min(w, h) / 40);
    var arr = [];
    for (var x = -w; x <= w; x += step) {
      for (var y = -h; y <= h; y += step) {
        arr.push({ x: x, y: y, d: x * x + y * y });
      }
    }
    arr.sort(function (a, b) { return a.d - b.d; });
    ctx.grid = arr;
    return arr;
  }

  function placePoly(ctx, idx, placed, trs, opts, rec) {
    // 原位置就合法 → 无需移动
    if (!checkCollision(ctx, idx, 0, 0, placed, trs)) return ZERO;

    var P = ctx.polys[idx];
    var sb = P.bbox;
    var GB = ctx.GBound;
    var bestD = INF, bestV = V(INF, INF);

    var cd = [], cx = [], cy = [];
    var eX1 = [], eY1 = [], eX2 = [], eY2 = [], eD2 = [];
    var j, k;

    // 候选池：只做包围盒粗筛，不做碰撞检测
    function addCand(x, y) {
      if (sb.l + x < GB.l - EPS || sb.r + x > GB.r + EPS) return;
      if (sb.b + y < GB.b - EPS || sb.t + y > GB.t + EPS) return;
      cd.push(x * x + y * y); cx.push(x); cy.push(y);
    }

    // 逐个精确校验（带 |trans| 上界剪枝）
    function tryV(x, y, d) {
      _dbg.tryV++;
      if (d === undefined) d = x * x + y * y;
      if (d >= bestD) return;
      if (!checkCollision(ctx, idx, x, y, placed, trs)) { bestD = d; bestV = V(x, y); }
    }

    // 近原点的网格种子：NFP 只覆盖"贴着已放置多边形"的位置，网格补上空白区
    var gseed = ensureGrid(ctx);
    var gcap = Math.min(gseed.length, opts.gridSeed);
    for (j = 0; j < gcap; j++) addCand(gseed[j].x, gseed[j].y);

    var cix = (sb.l + sb.r) * 0.5, ciy = (sb.b + sb.t) * 0.5;

    // 候选源 1：边界顶点（严格 inner-NFP 的轻量替代）
    for (j = 0; j < ctx.boundary.length; j++) {
      addCand(ctx.boundary[j].x - cix, ctx.boundary[j].y - ciy);
    }
    // 矩形内缩兜底边，参与交点候选
    var rl = GB.l - sb.l, rr = GB.r - sb.r, rb = GB.b - sb.b, rt = GB.t - sb.t;
    eX1.push(rl); eY1.push(rb); eX2.push(rr); eY2.push(rb); eD2.push(0);
    eX1.push(rr); eY1.push(rb); eX2.push(rr); eY2.push(rt); eD2.push(0);
    eX1.push(rr); eY1.push(rt); eX2.push(rl); eY2.push(rt); eD2.push(0);
    eX1.push(rl); eY1.push(rt); eX2.push(rl); eY2.push(rb); eD2.push(0);

    // 候选源 2：已放置多边形的 NFP 顶点 + 边采样
    var step = opts.sampleStep;
    var maxS = opts.maxEdgeSamples;
    for (k = 0; k < placed.length; k++) {
      var p = placed[k];
      var Q = ctx.polys[p];
      var shiftX = Q.shape_offset.x + trs[p].x - P.shape_offset.x;
      var shiftY = Q.shape_offset.y + trs[p].y - P.shape_offset.y;
      var nd = getNFP(ctx, Q.shape_id, P.shape_id);
      var es = nd.edges;
      for (var e = 0; e < es.length; e++) {
        var Ax = es[e].A.x + shiftX, Ay = es[e].A.y + shiftY;
        var Bx = es[e].B.x + shiftX, By = es[e].B.y + shiftY;
        eX1.push(Ax); eY1.push(Ay); eX2.push(Bx); eY2.push(By);
        eD2.push(Math.min(Ax * Ax + Ay * Ay, Bx * Bx + By * By));
        addCand(Ax, Ay);
        var ex = Bx - Ax, ey = By - Ay;
        var len = Math.sqrt(ex * ex + ey * ey);
        if (len > 0.1) {
          var cnt = Math.floor(len / step);
          if (cnt > maxS) cnt = maxS;
          if (cnt < 1) cnt = 1;
          for (var s = 1; s < cnt; s++) addCand(Ax + ex * (s / cnt), Ay + ey * (s / cnt));
        }
      }
    }

    // 按 |trans| 升序检查：首个合法位置就是池内最优，可以直接停
    // 计数排序（按距离分桶）比比较排序快一个量级，桶内误差远小于可视精度
    var nc = cd.length;
    var order = new Array(nc);
    var maxD = 0;
    for (j = 0; j < nc; j++) { if (cd[j] > maxD) maxD = cd[j]; }
    var KB = 1024;
    var bw = (maxD + 1e-12) / KB;
    var cntB = new Int32Array(KB + 1);
    var bk = new Int32Array(nc);
    for (j = 0; j < nc; j++) {
      var bi = (cd[j] / bw) | 0;
      if (bi > KB - 1) bi = KB - 1;
      bk[j] = bi;
      cntB[bi + 1]++;
    }
    for (j = 0; j < KB; j++) cntB[j + 1] += cntB[j];
    for (j = 0; j < nc; j++) order[cntB[bk[j]]++] = j;
    for (j = 0; j < nc; j++) {
      var i0 = order[j];
      var d0 = cd[i0];
      if (d0 >= bestD) break;
      if (!checkCollision(ctx, idx, cx[i0], cy[i0], placed, trs)) {
        bestD = d0; bestV = V(cx[i0], cy[i0]);
        break;
      }
    }

    // 候选源 3：最近约束边的两两交点（只在已有解不理想时补充）
    var ne = eD2.length;
    var lim = Math.min(ne, 80);
    var sel = null;
    if (ne > lim) {
      sel = new Array(ne);
      var mx = 0;
      for (j = 0; j < ne; j++) { if (eD2[j] > mx) mx = eD2[j]; }
      var KB2 = 1024;
      var bw2 = (mx + 1e-12) / KB2;
      var cnt2 = new Int32Array(KB2 + 1);
      var bk2 = new Int32Array(ne);
      for (j = 0; j < ne; j++) {
        var bj = (eD2[j] / bw2) | 0;
        if (bj > KB2 - 1) bj = KB2 - 1;
        bk2[j] = bj;
        cnt2[bj + 1]++;
      }
      for (j = 0; j < KB2; j++) cnt2[j + 1] += cnt2[j];
      for (j = 0; j < ne; j++) sel[cnt2[bk2[j]]++] = j;
    }
    for (var m1 = 0; m1 < lim; m1++) {
      var i1 = sel ? sel[m1] : m1;
      var ax1 = eX1[i1], ay1 = eY1[i1];
      if (ax1 * ax1 + ay1 * ay1 >= bestD) continue;
      var r1x = eX2[i1] - ax1, r1y = eY2[i1] - ay1;
      for (var m2 = m1 + 1; m2 < lim; m2++) {
        var i2 = sel ? sel[m2] : m2;
        var ax2 = eX1[i2], ay2 = eY1[i2];
        var s2x = eX2[i2] - ax2, s2y = eY2[i2] - ay2;
        var rxs = r1x * s2y - r1y * s2x;
        if (rxs < 1e-9 && rxs > -1e-9) continue;
        var ddx = ax2 - ax1, ddy = ay2 - ay1;
        var t = (ddx * s2y - ddy * s2x) / rxs;
        if (t < -EPS || t > 1 + EPS) continue;
        var u = (ddx * r1y - ddy * r1x) / rxs;
        if (u < -EPS || u > 1 + EPS) continue;
        tryV(ax1 + r1x * t, ay1 + r1y * t);
      }
    }

    // 候选源 4：网格回退（仅当前面全部失败）
    if (bestD >= INF * 0.5) {
      var grid = ensureGrid(ctx);
      var glim = Math.min(grid.length, gcap + opts.gridChecks);
      for (var gi = gcap; gi < glim; gi++) {
        var g = grid[gi];
        if (g.d >= bestD) break;
        if (!checkCollision(ctx, idx, g.x, g.y, placed, trs)) {
          bestD = g.d; bestV = V(g.x, g.y);
          break;
        }
      }
    }

    // 可视化用：在已找到的最优解附近再采几个合法位置，展示"可选区域"
    if (rec) {
      var cands = [{ x: bestV.x, y: bestV.y, d: bestD }];
      var cap = bestD * 2.5 + 1e-9;
      for (j = 0; j < nc && cands.length < 16; j++) {
        var i3 = order[j];
        if (cd[i3] <= bestD * 1.0000001 || cd[i3] > cap) continue;
        if (!checkCollision(ctx, idx, cx[i3], cy[i3], placed, trs)) {
          cands.push({ x: cx[i3], y: cy[i3], d: cd[i3] });
        }
      }
      rec.cands = cands;
      rec.best = bestV;
      rec.bestD = bestD;
      rec.pool = nc + ne;
    }
    return bestV;
  }

  /* ============================ 全局压缩 ============================ */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function compact(ctx, trans, rounds, trace, opts) {
    var rng = mulberry32(20260428);
    var dirs = [0.0, 0.2, -0.2, 0.4, -0.4, 0.7, -0.7, 1.0, -1.0];
    for (var r = 0; r < rounds; r++) {
      var any = false;
      var ord = [];
      for (var i = 0; i < ctx.n; i++) ord.push(i);
      for (var si = ord.length - 1; si > 0; si--) {
        var sj = Math.floor(rng() * (si + 1));
        var tmp = ord[si]; ord[si] = ord[sj]; ord[sj] = tmp;
      }

      for (var k = 0; k < ord.length; k++) {
        var idx = ord[k];
        var cur = trans[idx];
        var cl = vnorm(cur);
        if (cl < 1e-6) continue;

        var baseAng = Math.atan2(-cur.y, -cur.x);
        var bestGain = 0, bestT = cur;
        for (var di = 0; di < dirs.length; di++) {
          var ang = baseAng + dirs[di];
          var dx = Math.cos(ang), dy = Math.sin(ang);
          var lo = 0, hi = Math.min(cl * 1.3, 5.0), fnd = false;
          for (var s = 0; s < 14; s++) {
            var mid = (lo + hi) * 0.5;
            if (!checkCollisionAll(ctx, idx, cur.x + dx * mid, cur.y + dy * mid, trans)) { fnd = true; lo = mid; }
            else hi = mid;
          }
          if (fnd) {
            var nv = V(cur.x + dx * lo, cur.y + dy * lo);
            var gain = cl - vnorm(nv);
            if (gain > bestGain) { bestGain = gain; bestT = nv; }
          }
        }
        if (bestGain > 1e-4) { trans[idx] = bestT; any = true; }
      }

      if (trace) {
        trace.push(snapshot(ctx, 'compact', '全局压缩 · 第 ' + (r + 1) + ' 轮（' + (any ? '仍在向原点收缩' : '已无可行收缩') + '）', trans, null, -1, null));
      }
      if (!any) break;
    }
  }

  /* ============================ 快照 ============================ */

  function sumAbs(trans) {
    var s = 0;
    for (var i = 0; i < trans.length; i++) s += vnorm(trans[i]);
    return s;
  }

  function snapshot(ctx, phase, label, trans, placed, focus, extra) {
    var t = new Array(trans.length);
    for (var i = 0; i < trans.length; i++) t[i] = [+trans[i].x.toFixed(6), +trans[i].y.toFixed(6)];
    var fr = {
      phase: phase,
      label: label,
      trans: t,
      placed: placed ? placed.slice() : null,
      focus: focus === undefined ? -1 : focus,
      cost: sumAbs(trans)
    };
    if (extra) {
      if (extra.cands) fr.cands = extra.cands.map(function (c) { return [+c.x.toFixed(4), +c.y.toFixed(4)]; });
      if (extra.meta) fr.meta = extra.meta;
    }
    return fr;
  }

  function rebuildOcc(ctx, placed, trs) {
    var cell = Math.max(0.5, Math.min(ctx.GBound.r - ctx.GBound.l, ctx.GBound.t - ctx.GBound.b) / 24);
    ctx.occ = makeOcc(ctx.GBound, cell, ctx.n);
    for (var i = 0; i < placed.length; i++) {
      var p = placed[i];
      occInsert(ctx.occ, p, boxMoved(ctx.polys[p].bbox, trs[p]));
    }
  }

  /* ============================ 解码一个放置顺序 ============================ */

  function decodeOrder(ctx, order, out, compactRounds, opts, trace) {
    var n = ctx.n, i;
    out.length = n;
    for (i = 0; i < n; i++) out[i] = ZERO;
    var placed = [];
    var cell = Math.max(0.5, Math.min(ctx.GBound.r - ctx.GBound.l, ctx.GBound.t - ctx.GBound.b) / 24);
    ctx.occ = makeOcc(ctx.GBound, cell, n);

    for (var oi = 0; oi < order.length; oi++) {
      var idx = order[oi];
      var rec = trace ? { cands: [] } : null;
      var pos = placePoly(ctx, idx, placed, out, opts, rec);

      if (pos.x > 1e10) {
        compact(ctx, out, 2, trace, opts);
        rebuildOcc(ctx, placed, out);
        pos = placePoly(ctx, idx, placed, out, opts, rec);
        if (pos.x > 1e10) return INF;
      }
      out[idx] = pos;
      placed.push(idx);
      occInsert(ctx.occ, idx, boxMoved(ctx.polys[idx].bbox, pos));

      if (trace) {
        trace.push(snapshot(ctx, 'place',
          '放置第 ' + (oi + 1) + '/' + order.length + ' 个 · 多边形 #' + idx +
          '（|trans| = ' + vnorm(pos).toFixed(3) + '）',
          out, placed, idx, rec));
      }
    }

    if (compactRounds > 0) {
      ctx.occ = null;
      compact(ctx, out, compactRounds, trace, opts);
    }

    // 全局漂移：整体平移，让总位移尽量小
    var GB = ctx.GBound;
    var dxl = -INF, dxr = INF, dyl = -INF, dyt = INF;
    for (i = 0; i < n; i++) {
      var b = boxMoved(ctx.polys[i].bbox, out[i]);
      if (GB.l - b.l > dxl) dxl = GB.l - b.l;
      if (GB.r - b.r < dxr) dxr = GB.r - b.r;
      if (GB.b - b.b > dyl) dyl = GB.b - b.b;
      if (GB.t - b.t < dyt) dyt = GB.t - b.t;
    }

    var cost;
    if (dxl <= dxr && dyl <= dyt) {
      var sxs = [dxl, (dxl + dxr) * 0.5, 0.0, dxr];
      var sys = [dyl, (dyl + dyt) * 0.5, 0.0, dyt];
      var bestSum = INF, bestSh = V(0, 0);
      for (var ai = 0; ai < sxs.length; ai++) {
        for (var bi = 0; bi < sys.length; bi++) {
          var sx = sxs[ai], sy = sys[bi];
          if (sx < dxl - EPS || sx > dxr + EPS || sy < dyl - EPS || sy > dyt + EPS) continue;
          var sum = 0;
          for (i = 0; i < n; i++) sum += vnorm(V(out[i].x + sx, out[i].y + sy));
          if (sum < bestSum) {
            var ok = true;
            for (i = 0; i < n && ok; i++) {
              if (!polyInBoundary(ctx, i, out[i].x + sx, out[i].y + sy)) ok = false;
            }
            if (ok) { bestSum = sum; bestSh = V(sx, sy); }
          }
        }
      }
      if (vnorm(bestSh) > EPS) {
        for (i = 0; i < n; i++) out[i] = V(out[i].x + bestSh.x, out[i].y + bestSh.y);
        cost = bestSum;
      } else {
        cost = 0;
        for (i = 0; i < n; i++) cost += vnorm(out[i]);
      }
    } else {
      cost = 0;
      for (i = 0; i < n; i++) cost += vnorm(out[i]);
    }
    return cost;
  }

  /* ============================ 放置顺序生成 ============================ */

  function generateOrders(ctx) {
    var n = ctx.n;
    var areas = new Array(n), perims = new Array(n), widths = new Array(n),
      heights = new Array(n), elong = new Array(n), hollow = new Array(n),
      vcount = new Array(n), centerDist = new Array(n), layoutDist = new Array(n);

    var cxSum = 0, cySum = 0, areaSum = 0, i;
    for (i = 0; i < n; i++) {
      var P = ctx.polys[i];
      var b = P.bbox;
      areas[i] = P.area;
      widths[i] = b.r - b.l;
      heights[i] = b.t - b.b;
      perims[i] = widths[i] + heights[i];
      elong[i] = perims[i] / Math.max(1e-6, Math.sqrt(Math.max(1e-6, areas[i])));
      hollow[i] = (boxArea(b) - P.area) / Math.max(1e-6, P.area);
      vcount[i] = ctx.shapes[P.shape_id].pts.length;
      var cx = (b.l + b.r) * 0.5, cy = (b.b + b.t) * 0.5;
      centerDist[i] = Math.sqrt(cx * cx + cy * cy);
      cxSum += cx * areas[i];
      cySum += cy * areas[i];
      areaSum += areas[i];
    }
    var lcx = areaSum > EPS ? cxSum / areaSum : 0;
    var lcy = areaSum > EPS ? cySum / areaSum : 0;
    for (i = 0; i < n; i++) {
      var bb = ctx.polys[i].bbox;
      var mx = (bb.l + bb.r) * 0.5 - lcx, my = (bb.b + bb.t) * 0.5 - lcy;
      layoutDist[i] = Math.sqrt(mx * mx + my * my);
    }

    var squareness = new Array(n);
    for (i = 0; i < n; i++) {
      var w = widths[i], h = heights[i];
      var mbr = Math.max(1e-12, w * h);
      var R = areas[i] / mbr;
      var ar = Math.max(w, h) / Math.max(1e-12, Math.min(w, h));
      squareness[i] = R * 2.0 / (ar + 1.0 / ar);
    }

    var out = [];
    var ids = [];
    for (i = 0; i < n; i++) ids.push(i);

    function add(name, key, desc) {
      var arr = ids.slice().sort(function (a, b) {
        return desc ? key[b] - key[a] : key[a] - key[b];
      });
      out.push({ name: name, order: arr, key: desc ? '降序' : '升序' });
    }

    add('凹陷度 降序（最凹的先放）', hollow, true);
    add('凹陷度 升序（凸的先放）', hollow, false);
    add('面积 降序（大件先放）', areas, true);
    add('面积 升序（小件先放）', areas, false);
    add('半周长 降序', perims, true);
    add('半周长 升序', perims, false);
    add('宽度 降序', widths, true);
    add('宽度 升序', widths, false);
    add('高度 降序', heights, true);
    add('高度 升序', heights, false);
    add('伸长率 降序（细长先放）', elong, true);
    add('伸长率 升序（细长后放）', elong, false);
    add('顶点数 降序（复杂先放）', vcount, true);
    add('顶点数 升序（复杂后放）', vcount, false);
    add('正方形度 降序', squareness, true);
    add('正方形度 升序', squareness, false);
    add('初始离心距离 降序（远的先锚定）', centerDist, true);
    add('初始离心距离 升序（近的先安顿）', centerDist, false);
    add('到布局重心距离 降序', layoutDist, true);
    add('到布局重心距离 升序', layoutDist, false);

    return out;
  }

  /* ============================ 模拟退火 ============================ */

  function mutate(order, rng) {
    var nx = order.slice();
    var L = nx.length;
    if (L < 3) {
      if (L === 2) { var t0 = nx[0]; nx[0] = nx[1]; nx[1] = t0; }
      return nx;
    }
    var op = Math.floor(rng() * 100);
    var v, from, to, len;

    if (op < 35) {
      // 靶向重置：把位移最大的若干元素之一插到靠前位置
      var pairs = [];
      for (var i = 0; i < L; i++) pairs.push({ i: i, k: nx[i] });
      pairs.sort(function (a, b) { return b.k - a.k; });
      var pick = Math.floor(rng() * Math.max(1, Math.floor(L * 0.2)));
      from = pairs[pick].i;
      to = Math.floor(rng() * L);
      if (rng() < 0.6) to = Math.floor(rng() * Math.max(1, Math.floor(L / 2)));
      if (from !== to) {
        v = nx[from]; nx.splice(from, 1); nx.splice(to, 0, v);
      }
    } else if (op < 60 && L >= 4) {
      // 块移动
      len = Math.floor(rng() * Math.max(2, Math.floor(L / 4))) + 2;
      if (len > L) len = L;
      from = Math.floor(rng() * (L - len + 1));
      to = Math.floor(rng() * (L - len + 1));
      if (from !== to) {
        var block = nx.splice(from, len);
        nx.splice(to, 0, block[0]);
        for (var q = 1; q < block.length; q++) nx.splice(to + q, 0, block[q]);
      }
    } else if (op < 78) {
      from = Math.floor(rng() * L);
      to = Math.floor(rng() * L);
      if (from !== to) {
        v = nx[from]; nx.splice(from, 1); nx.splice(to, 0, v);
      }
    } else if (op < 90 && L >= 4) {
      var a = Math.floor(rng() * L), b = Math.floor(rng() * L);
      var tt = nx[a]; nx[a] = nx[b]; nx[b] = tt;
    } else if (L >= 4) {
      len = Math.floor(rng() * Math.max(2, Math.floor(L / 2) - 1)) + 2;
      if (len > L) len = L;
      from = Math.floor(rng() * (L - len + 1));
      var seg = nx.slice(from, from + len).reverse();
      for (var s = 0; s < seg.length; s++) nx[from + s] = seg[s];
    } else {
      var p = Math.floor(rng() * L), r = Math.floor(rng() * L);
      var tmp = nx[p]; nx[p] = nx[r]; nx[r] = tmp;
    }
    return nx;
  }

  /* ============================ 总控 ============================ */

  var QUALITY = {
    fast: { sampleStep: 0.4, maxEdgeSamples: 6, gridSeed: 360, gridChecks: 300, orderLimit: 10, compactRounds: 5, saIter: 10 },
    standard: { sampleStep: 0.2, maxEdgeSamples: 10, gridSeed: 520, gridChecks: 800, orderLimit: 14, compactRounds: 7, saIter: 16 },
    thorough: { sampleStep: 0.06, maxEdgeSamples: 24, gridSeed: 900, gridChecks: 2400, orderLimit: 20, compactRounds: 10, saIter: 40 }
  };

  function mergeOpts(o) {
    var base = QUALITY[(o && o.quality) || 'standard'] || QUALITY.standard;
    var r = {};
    for (var k in base) r[k] = base[k];
    if (o) for (var k2 in o) if (o[k2] !== undefined) r[k2] = o[k2];
    return r;
  }

  function solve(input, options, onProgress) {
    var opts = mergeOpts(options || {});
    var t0 = Date.now();
    var ctx = prepare(input);
    var n = ctx.n, i;
    var frames = [];
    var zero = new Array(n);
    for (i = 0; i < n; i++) zero[i] = ZERO;

    var triCount = 0;
    for (i = 0; i < ctx.shapes.length; i++) triCount += ctx.shapes[i].tris.length;

    var initCheck = verifyIndependent(ctx, zero);
    var initDesc = '初始状态 · ' + n + ' 个多边形全部停在输入坐标上：' +
      initCheck.outside + ' 个越出边界、' + initCheck.overlaps + ' 对互相重叠，约束一条都没满足';
    frames.push(snapshot(ctx, 'init', initDesc, zero, [], -1, {
      meta: { n: n, shapes: ctx.shapes.length, tris: triCount }
    }));

    frames.push(snapshot(ctx, 'prep',
      '预处理 · 形状去重为 ' + ctx.shapes.length + ' 个，三角剖分共 ' + triCount +
      ' 个三角形，BVH 与边界网格索引就绪',
      zero, [], -1, null));

    if (onProgress) onProgress({ stage: 'orders', done: 0, total: opts.orderLimit });

    var orders = generateOrders(ctx);
    var limit = Math.min(orders.length, opts.orderLimit);
    var table = [];
    var bestCost = INF, bestOrder = null, bestTrans = null, bestName = '';

    for (i = 0; i < limit; i++) {
      var trs = [];
      var c = decodeOrder(ctx, orders[i].order, trs, opts.compactRounds, opts, null);
      table.push({ name: orders[i].name, dir: orders[i].key, cost: c, feasible: c < INF * 0.5 });
      if (c < bestCost) {
        bestCost = c; bestOrder = orders[i].order; bestTrans = trs; bestName = orders[i].name;
      }
      if (onProgress) onProgress({ stage: 'orders', done: i + 1, total: limit, best: bestCost });
    }

    if (!bestOrder) {
      return { error: '所有启发式顺序都无法完成放置，可能面积超出边界。' };
    }

    table.sort(function (a, b) { return a.cost - b.cost; });

    frames.push(snapshot(ctx, 'order',
      '启发式筛选 · 比较了 ' + limit + ' 种放置顺序，最优为「' + bestName +
      '」，此时 Σ|trans| = ' + bestCost.toFixed(3) + '。下面按这个顺序重新逐个放置',
      zero, [], -1, { meta: { table: table.slice(0, limit), best: bestName } }));

    // 逐步重放最优顺序
    if (onProgress) onProgress({ stage: 'replay', done: 0, total: n });
    var trace = [];
    var replayCost = decodeOrder(ctx, bestOrder, bestTrans, opts.compactRounds, opts, trace);
    for (i = 0; i < trace.length; i++) frames.push(trace[i]);
    if (onProgress) onProgress({ stage: 'replay', done: n, total: n });

    var trueCost = replayCost < bestCost ? replayCost : bestCost;
    var trueTrans = replayCost < bestCost ? bestTrans : bestTrans;

    // 模拟退火
    var saStart = Date.now();
    var improved = 0;
    // 退火只需要相对排序，用更粗的采样评估即可（对应原实现的 fast/full 两级漏斗）
    var saOpts = mergeOpts({ quality: opts.quality });
    saOpts.sampleStep = Math.max(0.5, opts.sampleStep * 3);
    saOpts.maxEdgeSamples = 3;
    saOpts.gridSeed = Math.min(opts.gridSeed, 120);
    saOpts.gridChecks = 120;
    saOpts.compactRounds = 0;
    if (opts.saIter > 0) {
      frames.push(snapshot(ctx, 'sa',
        '模拟退火 · 以「' + bestName + '」为起点，对放置顺序做 ' + opts.saIter +
        ' 次扰动，温度从 2000 线性退火到 0.02',
        trueTrans, null, -1, null));
      var rng = mulberry32(20260428);
      var T0 = 2000.0, Tend = 0.02;
      var cur = bestOrder.slice();
      var fastTrs = [];
      var bestFast = decodeOrder(ctx, cur, fastTrs, 0, saOpts, null);
      var bestFull = bestCost;

      for (var it = 0; it < opts.saIter; it++) {
        var f = opts.saIter > 1 ? it / (opts.saIter - 1) : 1;
        var T = T0 * Math.pow(Tend / T0, f);
        var nx = mutate(cur, rng);
        var trs2 = [];
        var nc = decodeOrder(ctx, nx, trs2, 0, saOpts, null);
        if (onProgress) onProgress({ stage: 'sa', done: it + 1, total: opts.saIter, best: bestFull });
        if (nc >= INF * 0.5) continue;

        if (nc < bestFast - 1e-6) {
          bestFast = nc;
          cur = nx;
          // 用带压缩的完整评估确认真实收益
          var fullTrs = [];
          var fc = decodeOrder(ctx, nx, fullTrs, opts.compactRounds, opts, null);
          if (fc < bestFull - 1e-6) {
            bestFull = fc;
            trueCost = fc;
            trueTrans = fullTrs;
            bestOrder = nx;
            improved++;
            frames.push(snapshot(ctx, 'sa',
              '退火改进 #' + improved + ' · 交换放置顺序后 Σ|trans| 降到 ' + fc.toFixed(3),
              fullTrs, null, -1, null));
          }
        } else if (Math.exp(-(nc - bestFast) / Math.max(T, 1e-8)) > rng()) {
          cur = nx;
        }
      }
    }

    if (opts.saIter > 0) {
      frames.push(snapshot(ctx, 'sa',
        improved > 0
          ? '退火结束 · 共找到 ' + improved + ' 次改进，当前 Σ|trans| = ' + trueCost.toFixed(3)
          : '退火结束 · ' + opts.saIter + ' 次扰动都没有得到更小的 Σ|trans|，保留原解（说明启发式排序已经比较接近局部最优）',
        trueTrans, null, -1, null));
    }

    // 收尾：最终压缩
    var finalTrs = trueTrans.slice();
    var finalTrace = [];
    compact(ctx, finalTrs, Math.max(2, opts.compactRounds), finalTrace, opts);
    var finalCost = sumAbs(finalTrs);
    if (finalCost <= trueCost + 1e-6) {
      trueCost = finalCost;
      trueTrans = finalTrs;
      for (i = 0; i < finalTrace.length; i++) frames.push(finalTrace[i]);
    }

    var verify = verifyIndependent(ctx, trueTrans);
    var checkDesc = verify.valid
      ? '独立校验通过：0 越界、0 重叠'
      : '独立校验未通过：越界 ' + verify.outside + ' 个、重叠 ' + verify.overlaps + ' 对';
    frames.push(snapshot(ctx, 'done',
      '完成 · Σ|trans| = ' + trueCost.toFixed(3) + ' · ' + checkDesc,
      trueTrans, null, -1, { meta: { cost: trueCost } }));

     return {
      frames: frames,
      orderTable: table,
      result: {
        trans: trueTrans.map(function (p) { return [p.x, p.y]; }),
        cost: trueCost
      },
      stats: {
        n: n,
        shapes: ctx.shapes.length,
        tris: triCount,
        orderLimit: limit,
        saIter: opts.saIter,
        improved: improved,
        quality: (options && options.quality) || 'standard',
        ms: Date.now() - t0,
        saMs: Date.now() - saStart,
        valid: verify.valid,
        overlaps: verify.overlaps,
        outside: verify.outside,
        depth: verify.depth
      }
    };
  }

  /* ============================ 结果校验 ============================ */
  /*
   * 独立校验：刻意不复用求解器里的 polyInBoundary / overlapBVH。
   * 边界判定改为"沿每条边密集采样 + 射线法"，与求解器的"边相交 + 单点判定"
   * 是两套完全不同的方法，避免同一处 bug 让求解器和校验器一起说谎。
   */

  function distToSeg(px, py, a, b) {
    var vx = b.x - a.x, vy = b.y - a.y;
    var wx = px - a.x, wy = py - a.y;
    var L2 = vx * vx + vy * vy;
    if (L2 < 1e-18) return Math.sqrt(wx * wx + wy * wy);
    var t = (wx * vx + wy * vy) / L2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var dx = px - (a.x + vx * t), dy = py - (a.y + vy * t);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function sampleOutside(pts, tx, ty, boundary, step) {
    var bad = 0, worst = 0;
    var n = pts.length;
    for (var i = 0; i < n; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      var dx = b.x - a.x, dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      var k = Math.floor(len / step) + 2;
      if (k < 2) k = 2;
      if (k > 40) k = 40;
      for (var s = 0; s < k; s++) {
        var t = s / (k - 1);
        var px = a.x + tx + dx * t, py = a.y + ty + dy * t;
        if (!pointInPoly(V(px, py), boundary)) {
          bad++;
          // 越界深度：该点到边界各边的最近距离
          var dp = Infinity;
          for (var q = 0; q < boundary.length; q++) {
            var dd = distToSeg(px, py, boundary[q], boundary[(q + 1) % boundary.length]);
            if (dd < dp) dp = dd;
          }
          if (dp > worst) worst = dp;
        }
      }
    }
    return bad;
  }

  // 与求解器分开写的三角形 SAT，只用于校验
  function satTri(t1, o1x, o1y, t2, o2x, o2y) {
    var sets = [[t1, o1x, o1y, t2, o2x, o2y], [t2, o2x, o2y, t1, o1x, o1y]];
    for (var k = 0; k < 2; k++) {
      var A = sets[k][0], ax = sets[k][1], ay = sets[k][2];
      var B = sets[k][3], bx = sets[k][4], by = sets[k][5];
      for (var i = 0; i < 3; i++) {
        var p0 = A.p[i], p1 = A.p[(i + 1) % 3];
        var nx = -(p1.y - p0.y), ny = (p1.x - p0.x);
        var a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
        for (var j = 0; j < 3; j++) {
          var va = (A.p[j].x + ax) * nx + (A.p[j].y + ay) * ny;
          var vb = (B.p[j].x + bx) * nx + (B.p[j].y + by) * ny;
          if (va < a0) a0 = va;
          if (va > a1) a1 = va;
          if (vb < b0) b0 = vb;
          if (vb > b1) b1 = vb;
        }
        if (a1 <= b0 + 1e-8 || b1 <= a0 + 1e-8) return false;
      }
    }
    return true;
  }

  var DEPTH_TOL = 1e-3;   // 与题面"超出面积 < 1e-3"同一量级

  function verifyIndependent(ctx, trans) {
    var outside = 0, deep = 0, pairs = 0;
    var i, j;
    var step = 0.02;

    for (i = 0; i < ctx.n; i++) {
      var Pi = ctx.polys[i];
      var bad = sampleOutside(ctx.shapes[Pi.shape_id].pts,
        Pi.shape_offset.x + trans[i].x, Pi.shape_offset.y + trans[i].y,
        ctx.boundary, step);
      if (bad > 0) {
        outside++;
        if (bad > deep) deep = bad;
      }
    }

    var boxes = [];
    for (i = 0; i < ctx.n; i++) {
      var b = boxMoved(ctx.polys[i].bbox, trans[i]);
      boxes.push(b);
    }
    for (i = 0; i < ctx.n; i++) {
      for (j = i + 1; j < ctx.n; j++) {
        if (!boxIntersects(boxes[i], boxes[j])) continue;
        var Si = ctx.shapes[ctx.polys[i].shape_id];
        var Sj = ctx.shapes[ctx.polys[j].shape_id];
        var oix = ctx.polys[i].shape_offset.x + trans[i].x;
        var oiy = ctx.polys[i].shape_offset.y + trans[i].y;
        var ojx = ctx.polys[j].shape_offset.x + trans[j].x;
        var ojy = ctx.polys[j].shape_offset.y + trans[j].y;
        var hit = false;
        for (var a = 0; a < Si.tris.length && !hit; a++) {
          for (var c = 0; c < Sj.tris.length; c++) {
            if (satTri(Si.tris[a], oix, oiy, Sj.tris[c], ojx, ojy)) { hit = true; break; }
          }
        }
        if (hit) pairs++;
      }
    }
    return {
      valid: deep <= DEPTH_TOL && pairs === 0,
      outside: outside,
      depth: deep,
      overlaps: pairs
    };
  }



  function verifySolution(ctx, trans) {
    var overlaps = 0, outside = 0;
    for (var i = 0; i < ctx.n; i++) {
      if (!polyInBoundary(ctx, i, trans[i].x, trans[i].y)) outside++;
      var mi = boxMoved(ctx.polys[i].bbox, trans[i]);
      for (var j = i + 1; j < ctx.n; j++) {
        var mj = boxMoved(ctx.polys[j].bbox, trans[j]);
        if (!boxIntersects(mi, mj)) continue;
        var A = ctx.shapes[ctx.polys[i].shape_id];
        var B = ctx.shapes[ctx.polys[j].shape_id];
        if (overlapBVH(0, A,
          ctx.polys[i].shape_offset.x + trans[i].x,
          ctx.polys[i].shape_offset.y + trans[i].y,
          0, B,
          ctx.polys[j].shape_offset.x + trans[j].x,
          ctx.polys[j].shape_offset.y + trans[j].y)) overlaps++;
      }
    }
    return { valid: overlaps === 0 && outside === 0, overlaps: overlaps, outside: outside };
  }

  var API = {
    parseInput: parseInput,
    prepare: prepare,
    solve: solve,
    verifySolution: verifyIndependent,
    _verifySolutionOld: verifySolution,
    generateOrders: generateOrders,
    decodeOrder: decodeOrder,
    QUALITY: QUALITY,
    _internals: { convexHull: convexHull, minkowskiSum: minkowskiSum, shapeHull: shapeHull, getNFP: getNFP, polyInBoundary: polyInBoundary, bboxInsideBoundary: bboxInsideBoundary, pointInPoly: pointInPoly },
    _dbg: _dbg,
    _resetDbg: function () { _dbg.tryV = 0; _dbg.check = 0; _dbg.boundary = 0; _dbg.bvh = 0; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.NestSolver = API;
})(typeof self !== 'undefined' ? self : this);
