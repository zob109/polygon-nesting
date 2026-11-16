# 参考解（来自原始 C++ 求解器）

`cpp_out_default.txt` 是把 `Solution.cpp` **原样编译**后，在 `data/default.in` 上跑出来的结果。

## 怎么复现

用 MSVC 2022 编译（源码里用了 `<filesystem>`，需要 C++17）：

```
cl /nologo /std:c++17 /EHsc /O2 Solution.cpp /Fe:solver.exe
solver.exe < input.in > output.txt
```

## 一个要注意的地方

`data/default.in` 末尾**没有 `OK`**，而 `main()` 里有：

```cpp
string ok; cin >> ok; if (ok != "OK") return 1;
```

所以直接喂原始文件会立刻以退出码 1 结束。跑之前要在末尾补一行 `OK`。

## 参考结果

| 项 | 值 |
|---|---|
| Σ\|trans\| | **625.715892** |
| 运行时间 | 54.85 s（代码里限死 57 s） |
| 边界越界 | 0 |
| 重叠 | 0 |

用 `tools/check_solution.py` 校验：

```
python tools/check_solution.py data/default.in reference/cpp_out_default.txt
```

## 对比用

可视化站点里的 JS 版在同一算例上的结果是：

| 档位 | Σ\|trans\| | 相对参考解 |
|---|---|---|
| 快速 | 637.970 | +2.0% |
| 标准 | 633.617 | +1.3% |
| 彻底 | 633.771 | +1.3% |
