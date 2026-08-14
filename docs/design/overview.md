# dsh-subagent-model 设计总览

## 目标

让模型在委派子代理时**按次选择模型路由**：`subagent_model` 工具接受可选的 `provider` / `model` / `max_tokens` 参数，组合出"调用参数 > 插件 config `agentOptions` > 父会话路由"的优先级。

## 非目标

- 不修改、不包装内置 `subagent` 工具——两者共存，各自独立注册。
- 不引入新的子代理传输或生命周期语义——所有委派仍走 Host 组合的 `ctx.subagents` 服务（spawn/fork 等 provider）。
- 不做模型路由的权限控制——工具只是暴露选择，路由可用性由部署的模型配置（Models 页 / settings.yaml）决定。

## 工作原理

fork 官方 `@deepseek-ai/dsh-tool-subagent`（v0.1.0-rc 线），最小 diff：

1. **底层能力本来就在**：`SubagentStartRequest.agentOptions`（`provider/model/maxTokens`）是请求级字段；DSH 运行时 `resolveChildAgentOptions()`（`dsh-subagent/child-agent.ts`）把请求级字段展开在父路由**之后**，即请求级覆盖父路由。内置工具只是把它做成加载时的静态 config。
2. **fork 的改动**：把这三个字段提升为工具调用参数；`execute()` 里 `{ ...config.agentOptions, ...调用参数 }` 合并后放进 `request.agentOptions`。子代理创建、组合、深度记账、策略继承全由现有运行时处理，插件侧零新逻辑。
3. **调用前校验（`validateModel: true`，默认开）**：显式指定了 `provider`/`model` 时，先查 `ctx.get('llm')` 注册表——provider 精确匹配 `listProviders()`；model 先试 `resolveModelInfo(provider, model)`，解析失败再对照 `listModels()` 目录，目录里也没有才报错（目录是 advisory 的：部分路由目录为空，让端点自己判断）。校验失败发生在任何子会话创建之前，错误信息附可用目录。
4. 其余行为（provider 生命周期镜像、`one-shot`/`continuable` 后台策略、前台结算与 dispose 错误隔离、stopReason 错误映射、prompt section）保持上游原文。

## 边界与限制

- `toolName` 默认 `subagent_model`；与内置工具或其他 fork 实例重名会在 provider 出现时触发工具注册冲突（上游已知行为，见其 TODO 注释）。
- model 单独指定（不给 provider）时，子代理继承父会话的 provider，校验也按该 provider 进行；若父会话没有 provider（理论上不发生于 agent 会话），跳过 model 校验。
- 校验不能发现"模型存在但订阅无权限/配额耗尽"这类运行时问题——那类 429 发生在子代理首个模型请求，按子代理会话的 error 路径结算。
- 上游升级后本 fork 需人工对齐（改动处均有 `// fork:` 注释标记，`diff` 官方源码即可定位）。
