/*
 * shot.js — 用 Chrome DevTools Protocol 按真实时间等待后截图
 *   node tools/shot.js <url> <out.png> [waitMs] [width] [height] [evalScript]
 * 依赖 Node 22 自带的全集 WebSocket 与 fetch，无需安装任何包。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const url = process.argv[2];
const out = process.argv[3];
const waitMs = parseInt(process.argv[4] || '6000', 10);
const W = parseInt(process.argv[5] || '1440', 10);
const H = parseInt(process.argv[6] || '900', 10);
const evalScript = process.argv[7] || 'null';
const PORT = 9333 + Math.floor(Math.random() * 200);

const CHROME = process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT,
    '--window-size=' + W + ',' + H,
    '--user-data-dir=' + path.join(require('os').tmpdir(), 'shot-prof-' + PORT),
    url
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80; i++) {
    await sleep(150);
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await r.json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch (e) { /* 还没起来 */ }
  }
  if (!target) { console.error('无法连接 Chrome'); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result || {});
      pending.delete(msg.id);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');

  // 让页面按真实时间跑完求解与播放
  await sleep(waitMs);

  if (evalScript !== 'null') {
    const r = await send('Runtime.evaluate', {
      expression: evalScript,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('EVAL:', JSON.stringify(r.result && r.result.value));
    await sleep(800);
  }

  const diag = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      step: (document.getElementById('stepLabel')||{}).textContent,
      cost: (document.getElementById('mCost')||{}).textContent,
      counter: (document.getElementById('counter')||{}).textContent,
      err: (document.getElementById('editorErr')||{}).textContent,
      meta: (document.getElementById('topMeta')||{}).textContent
    })`,
    returnByValue: true
  });
  console.log('DIAG:', diag.result && diag.result.value);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) {
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('保存:', out);
  } else {
    console.error('截图为空');
  }

  ws.close();
  chrome.kill();
  await sleep(200);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
