# 0004 — 继承模式补齐 continuable 分叉会话（取代 0003 第 3 条）

## 状态

accepted

## 背景

0003 把继承模式钉死在 one-shot，依据是当时的上游事实（2026-08-10 笔记：continuable 子代理的 report 通道排在继承历史之前破坏前缀复用，官方组合全部把 fork 绑 one-shot）。但 rc.7 起**上游 preset 已把内置 `subagent_fork` 改回 `backgroundMode: continuable`**（本机部署实测即此形态）——上游解决了 continuable fork 的落地问题并重新上线。若用 subagent_model 完全取代内置工具（关掉 preset 里的两行 tool-subagent），就缺了"可持续分叉会话"这块能力：一个从当前对话 fork 出来、可 `send_message` 多轮续聊的长驻子代理。

## 备选

| 方案 | 优点 | 缺点 |
|---|---|---|
| 显式 `run_in_background: true` + 继承 → continuable fork（**选定**） | 与内置 subagent_fork 能力对齐，可安全关闭内置工具；默认行为不变（继承仍前台等结果，"取最新"哲学保留） | 分叉子代理视野冻结在创建时刻（continuable 前缀机制使然，与内置行为一致，需文案说清） |
| 保持继承恒 one-shot，接受能力缺口 | 零改动 | 关内置工具后失去可持续分叉会话；"补齐再关"路径走不通 |
| 继承也默认后台 continuable（完全复制内置 subagent_fork 默认值） | 行为逐字对齐 | 违背 0003 的核心诉求：默认路径应"每次调用取最新"，后台默认会把最新语义埋进冻结前缀里 |

## 决策

1. `backgroundMode: continuable` 挂载下：fresh 模式默认后台（不变）；**继承模式默认仍前台**，显式 `run_in_background: true` 时走 `startContinuable` + `inheritProvider`，返回 durable 子代理 id。
2. `backgroundMode: one-shot` 挂载下：显式后台走 one-shot 后台 job（不变）。
3. 文案三处（工具描述尾段、`run_in_background` 参数描述、prompt section）明确写："分叉子代理对父对话的视野冻结在创建时刻，要最新状态发起新调用"。
4. 按次模型路由在 continuable 路径的透传由 continuation 管理器 `resolveChildAgentOptions()` 保证（源码核实 rc.2），无需插件侧额外处理。

## 后果

- subagent_model 成为内置 `subagent` / `subagent_fork` 的完全超集，preset 里的两行内置工具可以安全移除（本机实测 `subagent_fork` 零真实调用）。
- 继承模式出现两种后台形态（durable 分叉 vs one-shot job），由 `backgroundMode` 配置决定——文案已按配置分别描述。
- "冻结前缀"是 continuable 机制固有属性，不是缺陷；需要最新视野时模型应发起新的继承调用（工具文案有引导）。
