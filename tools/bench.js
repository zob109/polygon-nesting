'use strict';
const fs=require('fs'),path=require('path');
const S=require('../assets/solver.js');
const text=fs.readFileSync(process.argv[2]||path.join(__dirname,'..','data','default.in'),'utf8');
const parsed=S.parseInput(text);
const ctx=S.prepare(parsed);
const orders=S.generateOrders(ctx);
const opts={...S.QUALITY.standard, compactRounds:0, quality:'standard'};

function time(label,fn){const t=Date.now();const r=fn();console.log(label, (Date.now()-t)+'ms');return r;}

S._resetDbg();
const order=orders[2].order;
const trs=[];
time('decodeOrder(1 个顺序, 0 轮压缩)', ()=>S.decodeOrder(ctx, order, trs, 0, opts, null));
console.log('  Σ|trans| =', trs.reduce((a,v)=>a+Math.hypot(v.x,v.y),0).toFixed(3));
console.log('  计数:', JSON.stringify(S._dbg));
console.log('  每次碰撞检查的 BVH 节点访问:', (S._dbg.bvh/Math.max(1,S._dbg.check)).toFixed(1));

S._resetDbg();
time('compact 1 轮', ()=>S.decodeOrder(ctx, order, trs, 1, opts, null));
console.log('  计数:', JSON.stringify(S._dbg));

const t2=Date.now();
for(let i=0;i<5;i++){const tt=[];S.decodeOrder(ctx, orders[i].order, tt, 0, opts, null);}
console.log('5 个顺序平均:', ((Date.now()-t2)/5).toFixed(0)+'ms');
