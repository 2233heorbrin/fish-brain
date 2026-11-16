# dsh-agent-mood

心情适配器。公开根包随发行物提供纯核心，不再从身体或胃的工作目录读取内核；许可与来源见根目录第三方声明。

- 只处理 source.kind=user 的主会话用户消息。
- 全部会话共享一份 fish-global 状态，不建立人物状态。
- 状态写入配置的 `stateDir/runtime.json`；根包使用 `<脑数据根>/鱼的大脑/脑区运行状态/心情/runtime.json`，不进入 Mnemon。
- agent/pre-step 在当轮提示装配前处理消息，session/event 只做持久化补偿。
- 使用稳定 message id 去重，同一消息只判定一次。
- 只向 system prompt 注入紧凑表达提示和独立风险标记。
- 无网络、无子进程、无第三方依赖。
- moodEnabled=false 时不注册监听器、不注入提示、不创建或更新状态。
