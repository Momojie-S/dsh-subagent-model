# 0006 — 省略路由参数时继承父会话实时路由（不再沿用 options 戳记）

## 状态

accepted（0.4.0）

## 背景

上游官方 `tool-subagent` 的继承链是 `resolveChildAgentOptions`：孩子缺省取 `parent.options.provider/model/maxTokens`。`options` 是 agent **创建/恢复时**写入的种子值——Web 会话创建时从当时的默认模型硬戳（api-proxy `agentOptions()`），之后 UI 切换模型（`session.selectModel`）只改会话级选型引用，**从不回写 `agent.options.model`**。

结果是一个两条取数路径不一致的真实缺陷：父会话每轮组装请求读的是实时选型（显示并实际运行新模型），而子代理委派继承的是创建时的旧戳。实证：本机一个创建于默认 glm-5.2 时期的会话切到 glm-5.3-flash 后，省略参数委派的子代理仍起在 glm-5.2（探针读执行上下文对拍确认）。用户视角就是"切换模型后发起子代理还是旧模型"。

另一条候选捕获路线也实测过并排除：全局监听 `system-prompt/assemble` 组装瀑布、从 variables 里取注入的 provider/model。失败原因是**瀑布监听位置不可控**——宿主层插件注册的监听读到的是 installModelSelection 注入之前的变量（实测捕获值 = 旧戳），拿不到 UI 切换后的选型。

## 备选

| 方案 | 优点 | 缺点 |
|---|---|---|
| 委派时读 `parent.session.requestHeader().config` 作为继承基底（**选定**） | 实测可行；语义正确——请求头存的是最近一次真实请求的路由，委派发生在回合中，上一步请求必然已用上切换后的模型；零事件监听、一行读取、随用随读不缓存 | 空白会话（一次请求都没跑过）无头可读，需退化到旧行为 |
| 监听组装/请求瀑布事件建捕获表 | 与选中方案同值域 | 监听位置决定读到的值，位置不可控（实测拿到旧戳）；还引入跨会话状态表 |
| 等上游修（让 selectModel 回写 options 或让 resolveChildAgentOptions 读实时选型） | 根治所有工具 | 时点不可控；本插件的立身之本就是自己掌握委派路由 |

## 决策

1. `execute` 里构造 `callOptions` 时，基底从（空）改为 `liveParentRoute(parent)`：读 `parent.session.requestHeader()?.config` 的 provider/model，包 try/catch，头不存在或字段缺失时返回 undefined → 完整退化为上游行为。
2. 合并优先级变为：**调用参数 > config.agentOptions > 实时路由 > （兜底）parent.options**。前两级未覆盖时，实时路由的 provider+model 显式进入孩子的 agentOptions，压过官方继承链里的旧戳。
3. 裸 `model` 参数的有效路由解释同步修正：校验用的 inherited provider 取合并后 `callOptions.provider`（可能来自实时路由），不再是 `parent.options.provider`。
4. 三处模型可见文案（工具描述尾段、provider/model 参数描述）改为"继承当前对话现行路由（最近一次请求所用）"。

## 后果

- 修复实证缺陷：UI 切换模型后的下一次委派即在新模型上跑，无需重启或显式传参。
- 依赖 `session.requestHeader()` 这一公开于官方 api-proxy 用法的接口；若上游改签名，try/catch 保证优雅退化（回到旧戳行为），不会炸委派。
- reasoning_effort 不在继承范围内（它走 `agent/request` 调整通道，不在 requestHeader.config 里强制落地）；档位本就是逐请求的事，维持不继承。
- 上游若根治此缺口（options 或继承源改实时），本决策的最优基底与之等值，可在下个版本移除 `liveParentRoute` 直接跟随上游。
