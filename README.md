# dsh-subagent-model

一个 DeepSeek Harness (DSH) 插件：注册 **`subagent_model`** 工具——在[内置 subagent 工具](https://github.com/deepseek-ai/deepseek-harness)基础上，把子代理的模型路由（provider / model / max_tokens）暴露为**每次调用可选的参数**，模型可以在委派任务时自行选择子代理跑在哪个模型上。

fork 自官方 `@deepseek-ai/dsh-tool-subagent`，除模型选择外行为与原版一致（后台策略、continuable 子会话、工具过滤、persona、深度限制全部保留）。

## 环境要求

- DeepSeek Harness `>= 0.1.0-rc.6`（已验证至 `0.1.1-rc.2`，Windows）
- Host 组合已加载 `subagents` 服务及传输 provider（内置 `spawn` / `fork` 均可）

## 用法

挂载后模型多出一个 `subagent_model` 工具，参数在内置 `subagent`（`description` / `prompt` / `run_in_background`）之上增加：

| 参数 | 类型 | 说明 |
|---|---|---|
| `provider` | string? | provider 路由 id（Models 页配置的路由）。省略则继承父会话——此时 `model` 必须是该继承路由下的模型 |
| `model` | string? | 模型 id，由**有效路由**（显式 `provider`，否则继承的父路由）解释；跨路由的 id 不会被自动转发，模型属于别的路由时务必同时传 `provider`。省略则继承父会话 |
| `max_tokens` | number? | 子代理每次模型请求的输出 token 上限（正整数） |

组合方式（最终路由优先级）：**调用参数 > 插件 config 的 `agentOptions` > 父会话路由**。

未知 provider/model 在启动子代理**之前**快速失败，错误信息列出可用的 provider / 模型目录。

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
        provider: spawn
        backgroundMode: continuable
```

重启 DSH 生效。组合包安装形态：`dsh plugin --profile web add github:Momojie-S/dsh-subagent-model`。

## 配置

patch `config` 字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` | （必填） | `ctx.subagents` 传输 provider 名，如 `spawn`、`fork` |
| `toolName` | `subagent_model` | 模型可见的工具名；与内置 `subagent` 工具共存，勿重名 |
| `enableRunInBackground` | `true` | 是否暴露 `run_in_background` |
| `backgroundMode` | `one-shot` | `one-shot` / `continuable`，语义同内置工具 |
| `agentOptions` | 无 | 所有子代理的默认路由（provider/model/maxTokens），被调用参数覆盖 |
| `validateModel` | `true` | 调用级路由是否经 `llm` 注册表校验（未知 id 快速失败） |
| `persona` | 无 | 子代理 persona，同内置工具 |
| `toolFilter` | 无 | 子代理工具过滤（allow/deny），同内置工具 |
| `maxDepth` | `3` | 子代理递委派深度上限，同内置工具 |

## 验证

重启后让模型调用（或检查 verbose 日志确认工具注册）：

```
> 用 subagent_model 委派一个任务，指定 model 为 glm-4.7，让它报告自己运行在什么模型上
```

子代理回复 `glm-4.7`（父会话为其他模型时）即按次路由生效；再传一个不属于所选路由的模型名（如只传 `model` 不传 `provider`、且该 id 不在继承路由目录里），应在子代理启动**之前**收到列出该路由可用模型的错误——而不是子代理无声死掉。

---

设计取舍与实现细节见 [docs/design/overview.md](docs/design/overview.md)。
