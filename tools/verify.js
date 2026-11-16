/*
 * verify.js — Node 端自检 + 基准
 *   node tools/verify.js <input.in> [quality]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../assets/solver.js');

const file = process.argv[2] || path.join(__dirname, '..', 'data', 'default.in');
const quality = process.argv[3] || 'standard';
const text = fs.readFileSync(file, 'utf8');

const parsed = S.parseInput(text);
if (parsed.error) {
  console.error('解析失败:', parsed.error);
  process.exit(1);
}
console.log('边界顶点:', parsed.boundary.length, ' 多边形:', parsed.polys.length);

const t0 = Date.now();
const ctx = S.prepare(parsed);
const tPrep = Date.now() - t0;
let tris = 0;
for (const s of ctx.shapes) tris += s.tris.length;
console.log(`准备: ${ctx.shapes.length} 个去重形状, ${tris} 个三角形, 边界边索引 ${ctx.edgeIndex.nx}x${ctx.edgeIndex.ny}, ${tPrep}ms`);

// 三角剖分覆盖率检查：三角形面积和应等于多边形面积
console.log('\n--- 三角剖分自检 ---');
let worst = 0;
for (const s of ctx.shapes) {
  let area = 0;
  for (const t of s.tris) {
    const [a, b, c] = t.p;
    area += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  }
  const real = Math.abs(s.pts.reduce((acc, p, i) => {
    const q = s.pts[(i + 1) % s.pts.length];
    return acc + (p.x * q.y - p.y * q.x);
  }, 0)) / 2;
  const rel = Math.abs(area - real) / Math.max(real, 1e-9);
  if (rel > worst) worst = rel;
}
console.log('三角形面积和与多边形面积最大相对误差:', worst.toExponential(2), worst < 1e-6 ? 'OK' : '异常');

console.log('\n--- 求解 ---');
const t1 = Date.now();
const res = S.solve(parsed, { quality });
const dt = Date.now() - t1;

if (res.error) {
  console.error('求解失败:', res.error);
  process.exit(1);
}

console.log('总耗时:', dt + 'ms');
console.log('帧数:', res.frames.length);
console.log('Σ|trans| =', res.result.cost.toFixed(6));
console.log('合法:', res.stats.valid, '重叠对数:', res.stats.overlaps, '越界个数:', res.stats.outside);
console.log('退火改进次数:', res.stats.improved, ' 退火耗时:', res.stats.saMs + 'ms');
console.log('\n前 5 名顺序:');
for (const r of res.orderTable.slice(0, 5)) {
  console.log('  ', r.cost === 1e18 ? 'INFEASIBLE' : r.cost.toFixed(3), r.name);
}
console.log('\n最后 3 名顺序:');
for (const r of res.orderTable.slice(-3)) {
  console.log('  ', r.cost === 1e18 ? 'INFEASIBLE' : r.cost.toFixed(3), r.name);
}

// 独立复核：用原始多边形的三角形做全对检查
console.log('\n--- 独立复核 ---');
const ctx2 = S.prepare(parsed);
const bad = S.verifySolution(ctx2, res.result.trans.map(p => ({ x: p[0], y: p[1] })));
console.log('独立校验:', bad.valid ? '全部合法' : `重叠 ${bad.overlaps} 对 / 越界 ${bad.outside} 个`);

// 位移分布
const mags = res.result.trans.map(p => Math.hypot(p[0], p[1])).sort((a, b) => b - a);
console.log('最大位移:', mags[0].toFixed(3), ' 中位位移:', mags[Math.floor(mags.length / 2)].toFixed(3));
process.exit(bad.valid ? 0 : 2);
