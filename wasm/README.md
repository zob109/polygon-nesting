# 在浏览器里跑原版 C++（WASM）

页面上的「原版 C++（WASM）」引擎执行的是 `Solution.cpp` **本身的编译产物**，
不是 JS 复刻。帧数据来自它自己的 `saveFrame()`。

## 只改了三处

完整 diff 见 `changes.patch`，全部 63 行：

| 改动 | 位置 | 为什么 |
|---|---|---|
| 1. `g_vizEnable` 默认 `true` | 第 53 行 | 否则不输出任何可视化帧 |
| 2. `TIME_LIMIT_SEC` 由 `const` 改为可写，并从 `argv` 读 `--time-limit` | 第 59 行、`main()` 开头 | 57 秒在网页里没法交互，需要能调 |
| 3. `initVizDir()` 在 `__EMSCRIPTEN__` 下固定为 `visualizations/frames` 并改用 `create_directories` | 第 364 行 | 浏览器里建子目录会失败；目录名带本地时间戳网页侧也不好定位 |

**算法、判据、放置策略、压缩与退火逻辑一行未动。** 改动 3 用 `#ifdef __EMSCRIPTEN__`
包住，原生编译时行为与原来完全一致。

## 编译

```bash
emcc -O2 -std=c++17 Solution_wasm.cpp -o solver_wasm.js \
  -sMODULARIZE=1 -sEXPORT_NAME=createSolver \
  -sFORCE_FILESYSTEM=1 -sALLOW_MEMORY_GROWTH=1 \
  -sEXIT_RUNTIME=0 -sINVOKE_RUN=0 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain \
  -sENVIRONMENT=web,worker,node -sINITIAL_MEMORY=64MB
```

产物 `solver_wasm.js`（66 KB）+ `solver_wasm.wasm`（382 KB）放在 `assets/wasm/`。

几个参数不是随便加的：

- `-sINVOKE_RUN=0`：默认情况下 Emscripten 会在运行时初始化后**自动执行一次 main()**，
  我们再调 `callMain` 就会跑第二遍（第二次 stdin 已空，读到 0 个顶点直接退出）。
- `-sEXIT_RUNTIME=0`：main 返回后不销毁运行时，否则读不到虚拟文件系统里的帧。
- `-sFORCE_FILESYSTEM=1`：`saveFrame` 要写文件。
- `-sMODULARIZE=1`：让 `createSolver()` 返回 Promise，便于在 Worker 里控制执行时机。

## 调用方式

```js
createSolver({
  print:    (s) => stdout.push(s),      // 最终平移量从这里出
  printErr: (s) => { /* 阶段日志 */ },
  stdin:    () => /* 逐字符喂输入，读完返回 null */,
  locateFile: (p) => BASE + p
}).then((Module) => {
  Module.FS.mkdir('/visualizations');           // 父目录要先建
  Module.callMain(['--time-limit', '20']);
  const svg = Module.FS.readFile('/visualizations/frames/frame_0000.svg', { encoding: 'utf8' });
});
```

## 输入必须以 `OK` 结尾

`main()` 里有：

```cpp
string ok; cin >> ok; if (ok != "OK") return 1;
```

缺这个标记会**读完边界就退出**（退出码 1，不产生任何帧）。
`data/default.in` 原本没有，已在仓库里补上；`assets/wasm-worker.js` 也会在缺失时自动追加。

## 实测

| 时限参数 | 实际耗时 | Σ\|trans\| | 帧数 |
|---|---|---|---|
| 8 s | 11.5 s | 635.17 | 102 |
| 6 s（Node 测试） | 11.6 s | 632.44 | 103 |

注意 Phase 1 自身有 8 秒预算，且单次 `decodeOrder` 无法中断，所以实际会比参数略长；
时限给到 8 秒以内时，Phase 3 的退火基本没机会跑。

## 一点提醒

如果这个站点发布在公开的 GitHub Pages 上，任何人下载 `.wasm` 都能反编译出接近源码的中间码。
不想公开算法的话，要么别把 `assets/wasm/` 推上去（页面会自动只剩 JS 引擎），
要么把站点设为私有仓库 + 仅自己可见。
