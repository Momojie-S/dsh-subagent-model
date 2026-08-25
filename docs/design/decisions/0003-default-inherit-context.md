# 0003 — 省略参数时默认继承当前对话（且取调用时刻最新状态）

## 状态

accepted（第 3 条"继承模式恒 one-shot"已被 [0004](0004-inherit-continuable.md) 取代；其余条款不变）

## 背景

0.1.x 的 `subagent_model` 只暴露模型路由，上下文固定走 `config.provider`（部署普遍配 `spawn`）——子代理永远干净上下文。要"让子代理基于本对话继续干活"只能换用内置 `subagent_fork`，而它没有按次模型路由。需求：**不传参数时默认使用当前对话**，且必须取到当前对话**最新**状态——不是会话打开时的快照（上游 fork provider 的 `start()` 每次从活的会话日志切到最后一个 `turn/end`，天然满足；真正会冻结的是 continuable fork 的 `prepareContinuable`，前缀在创建时捕获一次）。

## 备选

| 方案 | 优点 | 缺点 |
|---|---|---|
| 每次调用按 `fresh_context` 选 provider，默认继承（**选定**） | 一个工具同时覆盖 subagent + subagent_fork + 模型路由；每次继承委派都新起子代理、新切种子，"最新"由每次 `start()` 保证 | 0.2.0 破坏性默认变更；`provider` 配置语义收窄为"fresh 模式专用" |
| 只把挂载 config 的 `provider` 改成 `fork` | 零代码改动 | 丧失干净上下文委派 + 模型路由组合；`backgroundMode: continuable` 与 fork 组合踩上游刻意回避的前缀冻结/复用失效坑 |
| 默认继承 + 继承也走 continuable（`startContinuable` + `prepareContinuable`） | 继承型子代理可 `send_message` 续聊 | 前缀在创建时冻结一次，后续轮次看不到父会话新内容——与"取最新"直接矛盾；report 通道排在继承历史之前，前缀复用全失效（上游 issue #2124 / 2026-08-10 fork-children-stay-one-shot 笔记） |
| 加 `inherit_conversation: true` 参数（默认关） | 完全向后兼容 | 与需求相反：模型省略参数时仍拿不到当前对话 |

## 决策

1. 新增调用参数 `fresh_context`（boolean）：省略回退 `defaultContext`（默认 `inherit`），显式传值双向覆盖。
2. 新增 config：`inheritProvider`（默认 `fork`，继承模式 provider）+ `defaultContext`；`provider` 语义收窄为 fresh 模式专用，配成 fork 类 provider 挂载即报错（描述不许说谎）。
3. 继承模式**恒 one-shot**：默认前台等结果，`run_in_background: true` 走后台 job。fresh 模式后台策略不变（`backgroundMode` 只作用于它）。
4. 继承模式每次调用实时解析 provider：未注册 / `inheritsParentContext: false` 在子会话创建前报错并列出可用 provider。

## 后果

- "最新"的准确边界：最新到**最后一个已完成轮次**；发起委派的当前轮结构性排除（未闭合 turn 不能重放，且它还在写）。当前轮里需要子代理知道的内容写进 `prompt`（即子代理首条 user 消息）。工具描述与 prompt section 都已明说。
- 换模型继承（本插件典型用法）拿不到 provider 侧前缀复用——整段对话在子路由上全额预填充。工具描述明确提示自包含任务传 `fresh_context: true`。
- 0.2.0 起省略 `fresh_context` 的行为变化：旧部署要恢复全干净上下文加 `defaultContext: fresh`。
- 与上游对齐成本低：继承路径就是上游 `subagent_fork`（one-shot fork）+ 请求级 `agentOptions`，无新生命周期语义。
