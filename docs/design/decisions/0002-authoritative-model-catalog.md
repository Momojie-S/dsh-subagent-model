# 0002 — model 校验从 advisory 改为目录权威（authoritative）

## 状态

accepted

## 背景

实测反馈（2026-08，rc.6）：调用方只传 `model: 'glm-5.2'` 不传 `provider` 时，子代理继承 deepseek 路由，启动后**无声死掉**（无报错、无 closing message）——失败发生在子代理首个模型请求，父会话只能靠猜。

原校验逻辑（v0.1.0）：model 分支先调 `resolveModelInfo(provider, model)`，**目录检查嵌在它的 catch 里**。而 DSH 源码明确 `resolveModelInfo` 只验证元数据形状（"catalog membership remains advisory"），对目录外的 id 宽松接受——于是目录检查永远不执行，校验形同虚设。工具描述承诺的 "Unknown ids fail fast with the available directory" 只对 provider 分支兑现（精确注册表匹配），对 model 分支是空头支票。

## 备选

| 方案 | 优点 | 缺点 |
|---|---|---|
| 保持 advisory（resolve 先行，catch 才查目录） | 目录外的自定义 id（用户手配的别名模型）仍可放行 | 实测为静默失败的直接根因；承诺与行为不符 |
| **目录权威**（`listModels` 有目录就全权判断；无目录退 resolve 形状校验） | 有目录的路由上 typo 与跨路由 id 一律启动前报错并附目录；描述承诺兑现 | 目录里没有但端点其实认识的 id 会被拒（可显式 `validateModel: false` 逃生） |
| 删掉校验，全交给端点 | 实现最简 | 静默失败原样保留 |

## 决策

目录权威。目录存在（`listModels` 返回非空）时：id 在目录中 → 放行；不在 → 报错，错误信息附该路由目录，并显式提示"model 由有效路由解释，跨路由要同时传 provider"。目录列不出来（adapter 不支持 list）→ 退回 `resolveModelInfo` 形状校验，其余交端点。

配套：`provider`/`model` 参数描述补组合陷阱（model 由有效路由解释、跨路由须同传 provider），错误信息本身也带教学性。

## 后果

- 有目录路由上的跨路由模型 id 从"子代理静默死"变为"启动前报错 + 目录 + 教学提示"。
- 依赖目录外自定义 id 的部署需显式 `validateModel: false`（错误信息可引导）。
- 上游 `tool-subagent` 若将来吸收同类校验，对齐时以本 ADR 记录的语义为准。
