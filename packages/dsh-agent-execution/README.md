# dsh-agent-execution

肥鱼综合 Canary 的本地执行适配器。它只向主会话暴露
execution_submit_plan，消费思考层发布的 fish-execution-plan-v1，
生成不可变 Ticket、结果包和权威证据引用，再调用思考核心进行三态复核。

- 默认 dispatchMode=mock；只有计划显式声明 real 且 realWorkerEnabled=true 时，连接精确绑定 DSH 0.2.1-rc.2 的单 Worker Runtime Driver。
- parallelWorkersEnabled 是独立开关。关闭时完全绕过 ParallelCoordinator；开启时 maximumWorkers=2 仅允许恰好两个无依赖、独立工作区和不相交写目标的 Worker。
- ParallelCoordinator 只负责 ready 屏障、并发投递、单调时间线、冲突复核和 integration manifest 候选，不拥有计划、Ticket、预算、证据或最终裁定。
- 历史真实 Worker 试验使用 `<DSH Home>/workspaces/workers/<ticketId>`，只提供受限文件工具与固定 node --test；公开根包的现行组合使用原生 standard Worker，不启用此旧执行器。
- 完整 Superagent、子代理、commit Ticket 和两个以上 Worker 保持不可用。
- 不修改真实项目目标。
- 状态位置由 `stateDir` 配置，根包统一指向 `<脑数据根>/鱼的大脑/脑区运行状态/执行`，不保存原始消息、完整会话或脑区内容。
- executionEnabled=false 时不注册工具，也不创建状态。
