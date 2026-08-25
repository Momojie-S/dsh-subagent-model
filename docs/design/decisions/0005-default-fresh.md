# 0005 — 省略参数默认回到干净上下文（继承改为显式 `fresh_context: false`）

## 状态

accepted（取代 [0003](0003-default-inherit-context.md) 的默认值决策）

## 背景

0.2.0 把省略 `fresh_context` 的默认翻成"继承当前对话"（0003）。上线后两条实证指向相反的默认：

1. **使用分布**：本机全部历史会话统计，干净上下文委派（原内置 `subagent`）1095 次真实调用，继承委派（原内置 `subagent_fork`）0 次——"自包含任务委派"是绝对主流，"基于本对话续写"是从未发生过的少数场景。
2. **成本不对称**：默认继承 = 模型忘传参数时整段对话在子代理路由上全额重算（换模型继承拿不到前缀复用，贵且无提示）；默认干净 = 忘传参数只是子代理没上下文（它会明说，父代理补一句话即可补救）。昂贵路径应是显式 opt-in，便宜路径适合做默认。
3. **上游语义**：官方 `subagent`（干净）是主工具、`subagent_fork` 是补充；fork 自官方的工具默认值与上游对齐，使用心智不分裂。

## 备选

| 方案 | 优点 | 缺点 |
|---|---|---|
| 代码默认翻回 fresh，继承显式 `fresh_context: false`（**选定**） | 与上游对齐、成本极性正确、匹配实测分布；省略一切=原版 `subagent` 行为 | 0.3.0 又一次破坏性默认变更（0.2.0 才翻过一次） |
| 保持代码默认 inherit，仅部署 config 配 `defaultContext: fresh` | 零破坏 | 发布出去的插件默认仍是昂贵极性；"官方默认"与作者判断相悖 |
| 两个模式都保持现状（inherit 默认） | 无 | 忘传参数的代价最大，与使用分布相反 |

## 决策

1. `defaultContext` 代码默认 `inherit` → `fresh`（schema 与直接 apply 回退同步改）；`fresh_context: false` 是继承的唯一入口（或部署显式配 `defaultContext: inherit`）。
2. 三处模型可见文案（工具描述尾段、`run_in_background` 参数描述、prompt section）全部翻转为 fresh 默认框架；继承路径的语义文案（最新完成轮次种子 / 当前轮排除 / 分叉视野冻结）原样保留。
3. 后台默认逻辑不变（按模式驱动）：fresh 默认后台 continuable，继承默认前台、显式 `run_in_background: true` 走 durable 分叉（0004）。

## 后果

- 省略全部参数 = 内置 `subagent` 原版行为，模型迁移零成本；继承是文档清晰的 opt-in。
- 版本默认值变更史（README 有提示）：0.1.x fresh → 0.2.0 inherit → 0.3.0 fresh。0.2.x 部署想保 inherit 默认加 `defaultContext: inherit`。
- 0003 的"每次 start 取调用时刻最新完成轮次"语义不受影响，继续由 `fresh_context: false` 路径兑现。
