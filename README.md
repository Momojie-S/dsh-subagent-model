# dsh-subagent-model

一个 DeepSeek Harness (DSH) 插件：注册 **`subagent_model`** 工具——在[内置 subagent 工具](https://github.com/deepseek-ai/deepseek-harness)基础上，把子代理的**模型路由**（provider / model / max_tokens）和**上下文继承**（fresh_context）都暴露为**每次调用可选的参数**。

fork 自官方 `@deepseek-ai/dsh-tool-subagent`，除这两组参数外行为与原版一致（后台策略、continuable 子会话、工具过滤、persona、深度限制全部保留）。

## 环境要求

- DeepSeek Harness `>= 0.1.0-rc.6`（已验证至 `0.1.1-rc.2`，Windows）
- Host 组合已加载 `subagents` 服务；fresh 模式需要 `spawn` 类 provider，默认继承模式需要 `fork` 类 provider（官方 base bundle 两者都带）

## 用法

挂载后模型多出一个 `subagent_model` 工具。**不传任何可选参数时，子代理默认干净上下文**（与内置 `subagent` 语义一致）；要基于当前对话续写，传 `fresh_context: false`——子代理以调用那一刻父会话**最新完成轮次**为种子（不是会话打开时的快照；正在进行的这一轮不含在内）。参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `description` / `prompt` / `run_in_background` | - | 同内置 `subagent`；`run_in_background` 默认值随上下文模式不同（见下） |
| `fresh_context` | boolean? | **默认省略 = 干净上下文**（prompt 必须完全自包含）。传 `false` = fork 当前对话（按调用时刻的最新完成轮次做种子）；显式传 `true` 强制干净 |
| `provider` | string? | provider 路由 id（Models 页配置的路由）。省略则继承父会话——此时 `model` 必须是该继承路由下的模型 |
| `model` | string? | 模型 id，由**有效路由**（显式 `provider`，否则继承的父路由）解释；跨路由的 id 不会被自动转发，模型属于别的路由时务必同时传 `provider`。省略则继承父会话 |
| `max_tokens` | number? | 子代理每次模型请求的输出 token 上限（正整数） |

上下文模式与后台默认（`backgroundMode: continuable` 挂载时）：

| 模式 | 后台语义 |
|---|---|
| fresh（默认，省略 `fresh_context`） | 默认后台 continuable，返回可持续会话的子代理 id（`send_message` 续聊），与内置 `subagent` 原版行为一致 |
| 继承（`fresh_context: false`） | 默认**前台等待**直接拿结果（种子 = 调用时刻最新完成轮次）；传 `run_in_background: true` 得到**可持续分叉会话**（durable 子代理 id，`send_message` 续聊；其对父对话的视野冻结在创建时刻）——与 rc.7+ 内置 `subagent_fork` 对齐 |

`backgroundMode: one-shot` 挂载时两种模式都默认前台；`run_in_background: true` 走后台 job（`job_output` 收取）。

组合方式（最终路由优先级）：**调用参数 > 插件 config 的 `agentOptions` > 父会话路由**。未知 provider/model 在启动子代理**之前**快速失败，错误信息列出可用的 provider / 模型目录。

> ⚠️ **版本间默认值变更史**：0.1.x 省略参数 = 干净上下文；**0.2.0 改为默认继承**（破坏性）；**0.3.0 改回默认干净**（破坏性，依据使用分布与成本不对称，见 ADR-0005）——继承用 `fresh_context: false` 或部署配置 `defaultContext: inherit`。另：`provider` 配置必须是 fresh 类 provider（如 `spawn`）——配成 `fork` 会在挂载时报错，继承通道用 `inheritProvider`。

## 安装

```powershell
git clone https://github.com/Momojie-S/dsh-subagent-model.git
cd dsh-subagent-model
npm install          # prepare 脚本自动构建 lib/
```

profile 的 `cordis.patch.yml` 加一行（源码直连开发机形态）：

```yaml
- insert:
    - id: subagent-model
      name: 'file:///D:/code/workspace/deepseek-harness-101/plugins/dsh-subagent-model/lib/index.js'
      config:
        provider: spawn              # fresh 模式的传输 provider（必须是干净上下文类，如 spawn）
        backgroundMode: continuable  # 后台策略（fresh 默认后台；继承默认前台）
        # inheritProvider: fork      # 继承模式的传输 provider，默认 fork
        # defaultContext: fresh      # 省略 fresh_context 时的模式，默认 fresh（同内置 subagent）
```

重启 DSH 生效。组合包安装形态：`dsh plugin --profile web add github:Momojie-S/dsh-subagent-model`。

## 配置

patch `config` 字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` | （必填） | **fresh 模式**的 `ctx.subagents` 传输 provider（如 `spawn`）；不能是继承父对话的 provider，否则挂载报错 |
| `inheritProvider` | `fork` | **继承模式**的传输 provider；调用时实时解析，缺失或不是 fork 类（`inheritsParentContext: false`）会在子会话创建前报错 |
| `defaultContext` | `fresh` | 调用省略 `fresh_context` 时的模式；`inherit` 把省略默认改为继承当前对话（0.2.x 的行为） |
| `toolName` | `subagent_model` | 模型可见的工具名；与内置 `subagent` 工具共存，勿重名 |
| `enableRunInBackground` | `true` | 是否暴露 `run_in_background` |
| `backgroundMode` | `one-shot` | `one-shot` / `continuable`，作用于两种模式的后台路径（继承模式默认仍前台，见上表；ADR-0004） |
| `agentOptions` | 无 | 所有子代理的默认路由（provider/model/maxTokens），被调用参数覆盖 |
| `validateModel` | `true` | 调用级路由是否经 `llm` 注册表校验（未知 id 快速失败） |
| `persona` | 无 | 子代理 persona，同内置工具 |
| `toolFilter` | 无 | 子代理工具过滤（allow/deny），同内置工具 |
| `maxDepth` | `3` | 子代理递委派深度上限，同内置工具 |

## 验证

重启后让模型做对照委派（或检查 verbose 日志确认工具注册）：

```
> 先在本对话约定一个暗号。然后：1) 用 subagent_model 不传 fresh_context 委派"本对话前面的暗号是什么"；2) 传 fresh_context: false 再委派一次同样的问题
```

默认（省略）的子代理应**不知道**暗号（干净上下文）；`fresh_context: false` 的子代理能答出暗号，且换一轮新对话内容后再 fork，子代理能看到**新增**内容——证明种子取的是调用时刻最新状态，不是会话打开时的。

---

设计取舍与实现细节见 [docs/design/overview.md](docs/design/overview.md)。
