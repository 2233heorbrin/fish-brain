# fish-brain-suite

DSH 原生父插件。原生 bundle 选择是唯一启停依据；不提供第二个启停 API。

- enabled：Group 拥有 UI 和两个自研 gate，生命周期桥通过原生 Preset Registry 装载 `fish-plugins.json` 中原有的 SELF、只读记忆、心情、思考、固定 standard Worker 与 compaction。
- disabled：先取消精确归属的 fish Agent 及其原生子树，等待退出，调用 AgentLoop 的已有句柄 teardown，退休原生 fish 预设版本，再卸载 UI/gates。保留 fish 卡片，名称为「fish · 鱼脑已关闭」，原生新会话采用当前 standard 定义中的能力和独立插件。
- uninstalled：本工作块不执行。

不提供五脑区单独开关。页面内也不提供启停或写入入口。

Suite 声明与 Group 运行选项深度分离。共享 EntryTree 上的同 ID 后继只在旧 Suite 完成释放后创建；活跃占用明确失败。清理按确切 Group/Entry/Fiber 归属，不删除其他代的条目。失败释放保留在该 EntryTree 的内存所有权中并传播给后继，不把它当作空闲资源；它不写额外状态文件。原生必需子项被配置为停用时仍明确失败，不强制启用。

生命周期回归使用 `FISH_DSH_TEST_ANCHOR` 指向隔离 rc.5 的安装锚点；设置 `FISH_TEST_INSTALL_ROOT` 时加载其 `node_modules/fish-brain` 内的实际产物。运行 `node --test packages/fish-brain-suite/test/suite-reload.test.mjs`，不访问日常 Profile 或调用模型。

`fish-brain-suite/control` 常驻的只有状态投影、原生预设注册和会话边界，始终不装载鱼脑提示词、记忆或 Worker。`GET/HEAD /api/fish-brain-lifecycle/state` 显示实际状态；只有取消、释放、预设退休及 Group 子组件释放都成功，`fullyDisabled` 才为 true。释放失败为 fault，不以原生开关颜色代替结果。

启停前后原生会话日志保持；跨 epoch 的 fish 历史只供查看，继续输入会明确要求原生新会话。epoch 文件只记录已观察的原生套件状态和会话代际，不接受启停命令。不删除日志、文件、状态或记忆，不复制旧消息/压缩摘要到新会话。

会话准入在 `agent/pre-step` 安全时点完成；创建和 `agent-preset/selected` 仅观察归属，不在发布事件期间追加日志。原生 standard → 选择 fish → 首句路径正常使用；仅有轮次、权限设置、预设选择或待处理输入不视为历史。无模型/工具步骤、无已准入消息且无摘要的首轮失败可重试。

缺少绑定但有历史时，通过 DSH 原生 `userQuestions.ask` 提示「旧上下文可能残留」，选择「新建对话」或「明确沿用历史」。沿用记录为 `history-confirmed`，只在该会话当前 epoch 有效，可随原生日志恢复，不逐步重复询问，也不把它称为干净新会话。没有确认界面或未明确选择时不自动沿用；已确认跨代际的绑定仍要求新对话。单会话准入错误不改变套件 mode 或进入全局 fault。

当前 Profile 未配置执行适配器或双 Worker，因此保持其未加载状态；未来若加入，只能列在套件拥有的 fish composition 内。按父 Agent 精确 drain 会覆盖该父树下所有原生 Worker，不按工具前缀猜测归属。

`tools/agent-loop-release.mjs` 维护一处必要的宿主小扩展：暴露 AgentLoop 已有的 exact AgentHandle disposer；不会替换 Loader 或 AgentFactory。升级 DSH 后须重新核对并应用该补丁，缺失时桥接层明确失败。该扩展与两份源码/安装副本一同回退。
