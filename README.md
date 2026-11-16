# 多边形排样求解器 · 过程可视化

把二维多边形排样（nesting）求解器的每一步拆成可播放的帧：它能一块一块地把多边形放进边界里，
也能直接改输入数据重新跑一遍。纯静态前端，不需要后端。

- **问题**：给定一个边界多边形和若干小多边形，每个小多边形**只能平移**，
  要求两两不重叠、全部落在边界内，并让总位移 **Σ|trans|** 尽量小。
- **算法**：三角剖分 + BVH → NFP → 顺序放置 → 全局压缩 → 模拟退火。
- **实现**：**原版 C++ 求解器**（`Solution.cpp`）编译成 WebAssembly，在浏览器里跑本身。
  页面显示的每一帧都是求解器自己 `saveFrame()` 写出的 SVG，不是另写的近似实现。

## 五个阶段

| 阶段 | 做了什么 |
|---|---|
| 预处理 | 按形状去重、耳切法三角剖分、建 BVH、建边界网格索引 |
| 排序筛选 | 用多种启发式（面积 / 周长 / 凹陷度 / 初始位置……）各跑一遍，取最好的顺序 |
| 顺序放置 | 逐个多边形搜索合法且最近的位置：NFP 顶点 → 边采样 → 网格种子 → 约束边交点 |
| 全局压缩 | 所有多边形同时朝原点收缩，二分搜索可行距离 |
| 模拟退火 | 扰动放置顺序，温度 2000 → 0.02，接受更优解 |

## 输入格式

第一行是边界多边形顶点数，第二行是它的坐标；接着是多边形数量，再逐个给出
「顶点数 + 坐标」。坐标是 `x y` 交替的浮点数。

```
4                        ← 边界顶点数
0 0  10 0  10 10  0 10   ← 边界顶点（建议逆时针）
6                        ← 多边形数量
4                        ← 第 1 个多边形的顶点数
0 0  3 0  3 2  0 2       ← 第 1 个多边形的顶点
4
...
```

**末尾必须有一行 `OK`。** 求解器的 `main()` 里有：

```cpp
string ok; cin >> ok; if (ok != "OK") return 1;
```

缺了这个标记会读完边界就直接退出，一帧都不会输出。页面的默认数据集已经带上，
自定义数据如果是别的脚本生成的，记得检查这一点。

## 本地运行

用到了 Web Worker 和 `.wasm`，必须走 HTTP，`file://` 双击打不开：

```bash
cd polygon-nesting
python -m http.server 8000
# 打开 http://localhost:8000
```

## 部署到 GitHub Pages

纯静态站点，放到任意仓库、开启 Pages 就能用。

```bash
git init -b main
git add -A
git commit -m "多边形排样求解器可视化"
git remote add origin https://github.com/zob109/polygon-nesting.git
git push -u origin main
```

然后在仓库 **Settings → Pages** 里把 Source 设为 `Deploy from a branch`、分支 `main`、目录 `/ (root)`，
访问 [https://zob109.github.io/polygon-nesting/](https://zob109.github.io/polygon-nesting/)

所有资源都用相对路径（`assets/...`），挂在子路径下不会失效。`.nojekyll` 用来关掉 Jekyll 构建，
避免以后出现以下划线开头的文件被吞掉。

## 加自己的算例

**页面里加**（存在浏览器 localStorage，不上传）：改文本框 → 点「添加」→ 起个名字。
之后可以随时在下拉框里切换、删除、导出 `.in`。

**代码里加**（对所有访客可见）：编辑 `assets/data.js`，往 `NEST_DATASETS` 里追加一项：

```js
{
  id: 'my-case',
  name: '我的算例',
  note: '一句话说明',
  text: `...输入文本...`
}
```

## 怎么把 C++ 编成 WASM

`Solution.cpp` 只改了三处，算法一行没动（diff 见 [`wasm/changes.patch`](wasm/changes.patch)）。
源码本身没有放进这个仓库，`.wasm` 由你自己编译。

1. `g_vizEnable = true` —— 否则不输出任何帧；
2. `TIME_LIMIT_SEC` 去掉 `const`，`main(argc, argv)` 读 `--time-limit` —— 57 秒在网页里没法交互；
3. `initVizDir()` 在 `#ifdef __EMSCRIPTEN__` 下固定目录名并改用 `create_directories` ——
   浏览器里 `create_directory` 建子目录会失败。

把上面三处改到一份 `Solution.cpp` 的副本上（假设叫 `Solution_wasm.cpp`），然后：

```bash
emcc -O2 -std=c++17 Solution_wasm.cpp -o assets/wasm/solver_wasm.js \
  -sMODULARIZE=1 -sEXPORT_NAME=createSolver -sFORCE_FILESYSTEM=1 \
  -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=0 -sINVOKE_RUN=0 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain -sENVIRONMENT=web,worker -sINITIAL_MEMORY=64MB
```

第 3 处用 `#ifdef __EMSCRIPTEN__` 包住，原生编译时行为跟以前完全一致。
编译细节与踩过的坑见 [`wasm/README.md`](wasm/README.md)。

## 时限档位

下面是在默认算例上的实测（WASM，Node 22 与浏览器一致）：

| 档位 | `--time-limit` | 实际耗时 | 帧数 | Σ\|trans\| |
|---|---|---|---|---|
| 快 | 8 s | 11.5 s | 102 | 635.170 |
| 标准 | 20 s | 18.8 s | 107 | 628.512 |
| 完整 | 57 s | 55.8 s | 112 | 626.524 |

实际耗时总比参数长一点：Phase 1 自带 8 秒预算，且单次 `decodeOrder` 不可中断。
时限 ≤ 8 s 时退火基本跑不到。

参考对照：MSVC 原生编译、57 秒预算跑出 **625.716**，与 WASM 的 626.524 差 0.13%——
同一个二进制、同一份 wall-clock，差异来自迭代次数不同。

## 未放置的多边形

求解器输出的帧里只有"已经放下去"的多边形。如果只显示这些，会让人以为多边形是凭空出现的，
所以页面会把**还没放进去的**多边形按输入坐标画成灰色虚线底图，随着放置推进逐块消失。
最后一帧虚线全部消失，说明全部落位。

已放置集合是从帧里每个多边形中心的编号 `<text>` 反推出来的——不额外改动求解器的输出格式。
如果某一帧反推不出编号（比如格式变了），页面宁可不画，也不会画错。

## 输入校验

求解器本身不检查输入：自交的边界、零面积多边形、面积超过边界，都会让放置无解，
而它会跑满整个时限再返回 INF。所以提交求解前先检查一遍（`assets/input.js`，不含求解逻辑）：

| 检查项 | 说明 |
|---|---|
| 结构 | 顶点数、坐标数量是否配得上 |
| 坐标有效性 | 必须是有限数字，拒绝 `NaN` / `inf` |
| 边界 | 顶点数 ≥ 3、面积 > 0、**不自交** |
| 每个多边形 | 顶点数 ≥ 3、面积 > 0、不自交、包围盒不超过边界 |
| 面积上界 | 所有多边形面积和不能超过边界面积（必要条件） |

不合法时右侧会列出具体原因（哪条边和哪条边交叉、第几个多边形退化了），并且**不会**提交给求解器。
编辑时会防抖 700ms 自动检查，合法则显示 `✓ 100 个多边形 · 面积占比 37.7%`。

## 结果校验

页面只负责展示，不做判定。要核对求解器输出的合法性，用这份**纯 Python** 的独立实现
（与页面、与求解器都不共享代码）：

```bash
python tools/check_solution.py data/default.in reference/cpp_out_default.txt
```

它沿多边形每条边按 0.02 步长密集采样做射线法判断是否越界，再用三角形 SAT 取最小分离间隙判断重叠
（容差 1e-6）。`reference/cpp_out_default.txt` 是原始 C++ 编译后实跑的结果，
详见 [`reference/README.md`](reference/README.md)。

## 为什么打开总是最新版

GitHub Pages 给**所有**资源（包括 `index.html` 自己）都返回 `Cache-Control: max-age=600`。
只给 CSS/JS 加 `?v=` 版本号是不够的：如果浏览器缓存了旧的 `index.html`，
它引用的仍然是旧版本号，用户就会一直看到旧页面，最多要等 10 分钟。

所以页面自带一次版本自检：

1. `index.html` 里写死一个 `build` 号（`<meta name="nest-build">`）；
2. 页面加载最早期去拉 `version.json?t=<时间戳>`（唯一 URL + `cache: no-store`，必走网络）；
3. 两边不一致 → `location.replace(pathname + '?v=' + 新版本号)`。带查询串的 URL 是独立的缓存条目，
   等于强制重新取 HTML；
4. 用 `sessionStorage` 挡一次死循环：万一 CDN 上 `version.json` 比 `index.html` 先更新，
   不会无限重载。

版本一致时顺手把地址栏的 `?v=` 用 `history.replaceState` 去掉，URL 保持干净。
页脚会显示当前版本号，旁边有「检查更新」按钮可以手动触发。

### 发版流程

改完代码后**必须同时改版本号**，否则自检会认为"已经是最新"。需要改三处：

| 文件 | 位置 |
|---|---|
| `index.html` | `<meta name="nest-build">` + 3 处资源引用 `?v=` |
| `assets/app.js` | 1 处 `new Worker('...?v=')` |
| `version.json` | `v` 字段 |

```bash
OLD=20261117f NEW=20261118a
sed -i "s/$OLD/$NEW/g" index.html assets/app.js version.json
```

`assets/wasm-worker.js` 不用改——它从 `self.location.search` 继承父页面的版本号，
连 `importScripts` 和 Emscripten 的 `locateFile` 也跟着继承。

## 键盘

`空格` 播放 / 暂停，`←` `→` 上一帧 / 下一帧，`Ctrl/Cmd + Enter` 重新求解。

## 目录结构

```
polygon-nesting/
├── index.html              页面骨架（含版本自检）
├── favicon.svg
├── version.json            页面版本号（供自检比对）
├── assets/
│   ├── app.css             样式
│   ├── app.js              界面与播放控制
│   ├── input.js            输入解析与合法性检查（不含求解）
│   ├── data.js             内置数据集注册表
│   ├── wasm-worker.js      后台线程入口：运行求解器本体
│   └── wasm/               求解器编译产物 solver_wasm.{js,wasm}
├── tools/
│   ├── check_solution.py   纯 Python 独立校验器
│   └── shot.js             用 CDP 截图（开发用）
├── wasm/
│   ├── README.md           怎么编译、改了什么、怎么调用
│   └── changes.patch       对 Solution.cpp 的全部改动（63 行）
├── reference/
│   ├── README.md           C++ 怎么编译、怎么跑、参考结果
│   └── cpp_out_default.txt C++ 在默认算例上的输出
└── data/default.in         默认算例原文
```

调试时控制台可用 `__nest.goTo(50)` 跳帧、`__nest.state` 查看当前状态。
