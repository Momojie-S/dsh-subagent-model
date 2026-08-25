# dsh-subagent-model 设计总览

## 目标

让模型在委派子代理时**按次选择**两件事：

1. **模型路由**：`provider` / `model` / `max_tokens` 参数，组合出"调用参数 > 插件 config `agentOptions` > 父会话路由"的优先级。
2. **上下文继承**：`fresh_context` 参数。**省略时默认干净上下文**（同内置 `subagent`，ADR-0005）；传 `false` 则 fork 当前对话——子代理以调用那一刻父会话的**最新完成轮次**为种子。

## 非目标

- 不修改、不包装内置 `subagent` / `subagent_fork` 工具——共存，各自独立注册。
- 不引入新的子代理传输或生命周期语义——所有委派仍走 Host 组合的 `ctx.subagents` 服务（spawn/fork provider），继承模式的"最新快照"语义由 fork provider 原生保证。
- 不做模型路由的权限控制——工具只是暴露选择，路由可用性由部署的模型配置（Models 页 / settings.yaml）决定。

## 工作原理

fork 官方 `@deepseek-ai/dsh-tool-subagent`（v0.1.0-rc 线），最小 diff：

1. **模型路由（底层能力本来就在）**：`SubagentStartRequest.agentOptions`（`provider/model/maxTokens`）是请求级字段；DSH 运行时 `resolveChildAgentOptions()`（`dsh-subagent/child-agent.ts`）在**每次 start 时**读父代理的实时路由再展开请求级覆盖，即请求级覆盖父路由、省略继承最新路由。内置工具只是把它做成加载时的静态 config。
2. **上下文继承（同样零新传输）**：`ctx.subagents` 是按名字选 provider 的注册表，`start(name, request)` 本来就接受每次调用指定 provider。插件在 `execute()` 里按 `fresh_context`（缺省回退 `defaultContext`，默认 `fresh`）选 provider 名：继承 → `inheritProvider`（默认 `fork`），fresh → `provider`（如 `spawn`）。
3. **"最新快照"从哪来**：fork provider 的 `start()` 每次都调 `completedTurnPrefix(request.parent)`，从**活的会话事件日志**切到最后一个 `turn/end`——即调用时刻的全部已完成轮次。不存在会话打开时的冻结快照；每次继承委派都是新子代理、新种子。进行中的那一轮（发起委派的轮）结构性排除在外：未闭合的 turn 无法作为合法种子重放。
4. **继承模式的后台路径（ADR-0004，0.2.1 起）**：`backgroundMode: continuable` 挂载下，继承模式默认仍前台等待（ADR-0003 的"每次调用取最新"哲学不变）；显式 `run_in_background: true` 走 `startContinuable` + fork provider，得到**可持续分叉会话**（durable 子代理，`send_message` 续聊）——与 rc.7+ 内置 `subagent_fork` 的 continuable 形态对齐。continuable 路径的 `agentOptions` 透传由 continuation 管理器的 `resolveChildAgentOptions()` 保证（按次模型路由在分叉子代理上同样生效）。分叉子代理对父对话的视野**冻结在创建时刻**（continuable 前缀创建时捕获一次）；要最新状态就发起新调用。
5. **调用前校验（`validateModel: true`，默认开）**：显式指定了 `provider`/`model` 时，先查 `ctx.get('llm')` 注册表——provider 精确匹配 `listProviders()`；model 检查以 `listModels(provider)` 目录为**权威**：目录存在且不含该 id 即报错（并提示 model 由有效路由解释、跨路由要同时传 provider）。目录列不出来的路由退回 `resolveModelInfo` 形状校验，其余交给端点判断。校验失败发生在任何子会话创建之前，错误信息附可用目录。
6. 其余行为（provider 生命周期镜像、前台结算与 dispose 错误隔离、stopReason 错误映射、prompt section）保持上游原文。挂载时新增两条 fail-loud 检查：`config.provider` 必须是干净上下文类（`inheritsParentContext: false`，否则描述说谎）；继承 provider 若已注册且配了数字 `maxDepth`，同样要求 `depthLimit` 能力（晚注册的由服务层每次 start 兜底校验）。

## 边界与限制

- **继承的"最新"边界**：最新到「最后一个已完成轮次」；发起委派的当前轮不含在种子里，需要子代理知道的当前轮信息必须写进 `prompt` 参数（它就是子代理的首条 user 消息）。
- **成本提示**（写进了工具描述）：继承模式下整段对话会在子代理的路由上重新计费/预填充；换模型继承（本插件的典型用法）拿不到 provider 侧前缀复用。自包含任务是默认（干净上下文）的正场；继承（`fresh_context: false`）适合"基于本对话续写"的少数场景。
- `toolName` 默认 `subagent_model`；与内置工具或其他 fork 实例重名会在 provider 出现时触发工具注册冲突（上游已知行为）。
- model 单独指定（不给 provider）时，子代理继承父会话的 provider，校验也按该 provider 的目录进行；若父会话没有 provider（理论上不发生于 agent 会话），跳过 model 校验。跨路由的模型 id 在目录权威校验下会**启动前**报错并附该路由目录（ADR-0002）。
- 校验不能发现"模型存在但订阅无权限/配额耗尽"这类运行时问题——那类 429 发生在子代理首个模型请求，按子代理会话的 error 路径结算。
- 上游升级后本 fork 需人工对齐（改动处均有 `// fork:` 注释标记，`diff` 官方源码即可定位）。
