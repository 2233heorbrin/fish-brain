# fish-brain（鱼的脑）

> 当前任务分支实现运行与数据绑定解耦，尚未发布或部署。整个鱼脑仍为一个插件；双方不要求另一方存在、开启或先完成初始化。同宿主退出仍影响双方，不提供进程隔离。胃分析及显式原包选择机制属于后续工作块，本分支不宣称已经实现。

本轮开发版将人格、只读记忆、心情、思考、执行内核和控制模块打进一个 DSH bundle，不再要求手动安装十几个内部包。

**官方原版仍受宿主接口阻塞，配套扩展为隔离验证原型。** 根入口检测实际 `agentLoop.releaseExact(agent)` 能力：官方 rc.5 显示 `FISH_EXACT_AGENT_RELEASE_UNAVAILABLE`；具备本轮明确标记的宿主扩展时，挂载现有生命周期、fish Preset、脑区与可逆控制门。插件不会自动修改宿主。

## 安装入口与运行要求

需要 DSH 和 Node `>=22.14`。目前仅对官方 DSH `0.2.1-rc.5` 的下述能力做过隔离验证，不声称支持其他版本或完整启停。

当前版本为 `0.0.2`。可使用 GitHub 根仓库入口；开发者也可在仓库根目录执行 `npm pack --ignore-scripts` 得到 `fish-brain-0.0.2.tgz`，通过 DSH 原生插件管理提交 `file:<绝对 tgz 路径>`。启停仍由原生插件选择控制。已验证的完整功能需要下文说明的配套宿主扩展，普通官方 rc.5 安装不会自动获得该扩展。

无需设置作者路径或 vendor 环境变量，也无需单独安装 `packages/` 下的内核。

## 首次初始化与数据

每个 DSH Profile 分别保存 `fish-brain-data.json` 和 `fish-body-data.json`。本包只维护 `<Profile>/fish-brain-data.json`，结构沿用：

```json
{"schema":"fish-profile-data/v1","root":"<绝对数据根目录>","components":["brain"],"origin":"conversation-workspace"}
```

- 有效独立绑定优先。独立文件存在但无效或根失效时明确报错，不回退到共享文件或另一方位置；可以在本包数据设置中明确重新选择。
- 首次升级才读取旧 `fish-data.json` 和本包明确旧配置；所有来源指向同一根时登记原位置，只补本组件缺失结构，不覆盖正文、迁移或删除数据。来源冲突显示具体来源，等待用户选择，不猜测。身体还核对旧后端投影 `fish-body-state.json:frameworkRoot`，停机事务按宿主原生组合读取旧 fishRoot。
- 独立绑定建立后忽略旧共享文件及旧配置的后续修改；不改写另一方绑定或删除共享文件。另一方继续使用旧版不会带动本包切根。
- 真正新装时只使用明确寻址的对话工作区；不用 cwd、最近会话或安装目录推断位置。无工作区时显示待选择入口。
- 双方可明确选择相同或不同根。切换一方不改变另一方绑定或位置，不自动搬迁旧数据。保存新路径不表示运行实例已经换根；已挂载实例提示需要原生重载，身体旧事务拒绝继续向旧根工作。
- 降级到旧版不会自动读取独立绑定的新根。旧版仍可能使用旧共享文件或旧配置；降级前需核对位置，不能承诺自动反向同步。
- 数据页保留初始化、目录打开、手动切换、失败详情及重试；目录初始化与程序准备分别显示，host-blocked 不表示完整功能就绪。

## 人格与记忆

初始化创建 `<根>/鱼的大脑/{人格,记忆,心情,思考,执行,脑区运行状态}` 及实际消费者需要的结构。

- 人格正文：`人格/generated/SELF.compat.md`，首次为空，由你填写。说明放在独立 README，不注入作者事实。
- 空白记忆：`脑区运行状态/记忆/documents-readonly/documents/index.json` 及 active/archived 目录，使用实际 Documents 只读适配器，空检索返回零结果。
- 思考运行卡、能力索引首次为空；不预填角色、关系或私人经历。
- 已有正文使用不覆盖创建方式保留。数据不会作为程序依赖下载。

## 依赖和 Agent 作用域

正常包安装声明并固定 `dsh-mnemon-source-documents@0.5.11`、`dsh-mnemon@0.5.32`、`@deepseek-ai/schemastery@3.18.5`、`@deepseek-ai/cordis@4.0.5`。同时显式提供 mnemon 所需的 `@deepseek-ai/dsh-typert-protocol@0.2.1-rc.5`、`react@18.3.1` 和 `react-dom@18.3.1`，不依赖用户手动补齐，也不修改宿主 React。心情、思考和执行适配内核随发行物分发，见 THIRD-PARTY-NOTICES。依赖不在每轮对话重新安装。

原生 Preset 挂载测试中，人格、记忆、心情、思考、执行工具和协作门均以原生 `fish` 身份判断作用域，standard/默认 Agent 和其他 Agent 不接收这些内容。Worker 固定原生进程内 `spawn`、`standard`、`maxDepth=1`、`modelSelectionSettings=false`；合成人格与记忆不进入 Worker。不会自动修改当前或默认 Agent。

根入口现已接通现有生命周期；关闭保留原生 fish 入口、释放原生 handle 和 Preset lease，历史保留并按代际准入。不能用取消轮次代替完整释放。隔离扩展版与官方原版的验收结果分别记录，不互相替代。

## 官方宿主阻塞

官方 `dsh-agent-loop@0.2.1-rc.5` 的 create/resume 返回带 dispose 的 handle，但会话控制器创建 Agent 后没有公开该 handle 的精确释放入口。现有 Agent.cancel/idle、subagents.drainDescendants 无法代替完整释放。

本轮隔离扩展 `releaseExact(agent)` 复用创建时保存的原生 handle，核对确切对象后等待原生 dispose；不改写 AgentFactory、AgentLoop 轮次实现或会话存储。这不是官方原有 API，未应用到生产。完整补丁、官方/扩展对照与运行证据见隔离验收报告。

## 开发验证

测试要求先将 tgz 独立安装到临时目录，`FISH_TEST_INSTALL_ROOT` 指向该目录。`FISH_DSH_TEST_ANCHOR` 指向临时安装的官方 DSH 依赖环境 package.json。

```sh
node --test test/distribution.test.mjs test/official-native.test.mjs
```

另运行 `node --test test/independent-binding.test.mjs test/root-compatibility.test.mjs`，覆盖独立绑定优先级、旧版混用、冲突来源及真实根入口的旧配置兼容。覆盖初始化、两种安装顺序、持久化、切根不迁移、旧数据保留、空记忆、失败重试、实际组件导入、原生 standard→fish 选择及 Worker 隔离。测试不调用真实模型。桌面选择器与真实聊天的验收状态见隔离验收报告；上下文测试不调用真实模型。

MIT，第三方来源与许可见 THIRD-PARTY-NOTICES.md。

## 脑运行依赖归属

心情、思考和旧执行内核已随本包分发，包含各自资源和许可证；运行不读取胃工作目录。旧执行模块的可导入性不等于被挂载：当前 fish 组合仅使用固定 standard Worker，保留工程门和协作门的身份边界。身体停用不会移除脑区或 fish preset；脑停用不修改身体选择。
