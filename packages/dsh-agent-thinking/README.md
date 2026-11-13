# dsh-agent-thinking

fish-main 候选工作区思考层适配器，引用已经离线验证的 thinking-core 1.1.0-fish.1，不复制核心逻辑。

- 只处理主会话的人类用户消息。
- 每条消息最多进行一次本地确定性分类，不调用额外模型。
- 每轮常驻内容只有不超过500字符的思考运行卡和当前任务的紧凑路由摘要。
- medium 生成内部版本化计划摘要；large 生成需要向用户展示的可审查计划摘要。
- 只保存任务哈希、计划版本、分类、状态和证据引用，不保存用户原文。
- 不注册 Worker、不接 Superagent、不写 Mnemon、人格、心情或关系账本。
- thinkingEnabled=false 时不注册监听器、不注入提示、不创建状态。
- 只有显式 JSON 对象中的 parallelCandidate 可发布双 Worker 计划；普通自然语言不会自动拆分。
- parallelWorkersEnabled=false 时结构化候选返回 replan-required，不发布可提交计划。
