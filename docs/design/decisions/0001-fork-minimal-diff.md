# 0001 — fork 官方 tool-subagent 而非从零实现

## 状态

accepted

## 背景

需要一个"可指定模型的 subagent 工具"。实现路径有两条：

1. **fork** 官方 `@deepseek-ai/dsh-tool-subagent`（467 行，完整测试覆盖），只把 `agentOptions` 提升为调用参数。
2. **从零写**一个只做"指定模型委派"的精简工具（约 200 行，先在 cordis 创造模式里动态验证过）。

## 备选

| 方案 | 优点 | 缺点 |
|---|---|---|
| fork + 最小 diff | 沿用上游全部测试语义；`toolFilter`/`persona`/`maxDepth`/后台策略免费获得；上游修 bug 时可对 diff 移植 | 上游重构时需要人工跟进；代码量大于精简版 |
| 从零精简版 | 代码量小，无上游包袱 | 语义等价性要自己重新踩坑（结算、dispose、continuable、provider 生命周期）；功能面窄 |

## 决策

fork + 最小 diff。改动处全部用 `// fork:` 注释标记，保持与上游逐段对应；核心新增只有三处——参数声明、`execute()` 里约十行的路由合并、一个约三十行的 `assertCallRouteResolvable` 校验函数。

## 后果

- 行为与内置 `subagent` 工具严格对齐（同 provider 生命周期、同后台策略语义），用户心智模型不分裂。
- 上游版本升级时需 `diff` 官方源码人工对齐；`// fork:` 标记把对齐范围压缩到注释附近。
- 从零版并非废弃：动态插件阶段验证了整条链路（`agentOptions` 请求级覆盖、llm 校验目录），其测试结论直接沉淀进了 fork 版。
