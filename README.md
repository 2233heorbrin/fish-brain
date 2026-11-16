# fish-brain（鱼的脑）

> 0.0.3 提供独立数据绑定及 Suite 生命周期修复。整个鱼脑仍为一个插件；脑与身体不要求另一方存在、开启或先完成初始化。同宿主退出仍影响双方，不提供进程隔离。胃分析与安装决定由独立的 fish-body 管理，不属于鱼脑功能。

本包将人格、只读记忆、心情、思考、执行内核和控制模块打进一个 DSH bundle，不再要求手动安装十几个内部包。

**完整运行要求独立维护的宿主扩展。** 根入口检测实际 `agentLoop.releaseExact(agent)` 能力：官方 rc.5 显示 `FISH_EXACT_AGENT_RELEASE_UNAVAILABLE`；具备指定扩展时，挂载生命周期、fish Preset、脑区与可逆控制门。插件不会自动修改宿主。

## 安装入口与运行要求

需要 Node `>=22.14`。已验证 Windows、DSH `0.2.1-rc.5` 及指定扩展环境；官方原版的阻塞行为单独验证，其他宿主版本、macOS 和 Linux 未验证。

当前版本为 `0.0.3`，通过 [2233heorbrin/fish-brain](https://github.com/2233heorbrin/fish-brain) 的 main 与 annotated tag `v0.0.3` 交付。固定安装来源：

```text
github:2233heorbrin/fish-brain#v0.0.3
```

将此来源交给 DSH 原生插件管理。开发者也可执行 `npm pack --ignore-scripts` 得到 `fish-brain-0.0.3.tgz`，提交 `file:<绝对 tgz 路径>`。启停仍由原生插件选择控制。安装前必须确认下述扩展要求；这不是官方原版 rc.5 的全功能即装即用版本。未创建 GitHub Release，未发布 registry。

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

指定扩展 `releaseExact(agent)` 复用创建时保存的原生 handle，核对确切对象后等待原生 dispose；不改写 AgentFactory、AgentLoop 轮次实现或会话存储。这不是官方原有 API。

### 扩展交付限制

本仓库及安装包不分发或自动应用宿主补丁；目前没有公开、可直接下载的配套补丁发行物。因此完整运行仅支持已经由环境维护者部署并核验这些能力的指定 rc.5 环境，不能只安装本包就获得完整运行。其他用户应先向其环境维护者取得与实际宿主基线匹配、包含来源、许可证、应用和恢复说明的独立扩展；没有这些材料时应停在接口缺失状态，不绕过检查。这里不提供虚构下载地址或把本机路径作为公共安装步骤。

鱼脑要求 `agentLoop.releaseExact`；fish-body 的两阶段安装决定另要求 manager v2。若市场把 `dsh.client` 的资源占位误当服务端加载，还需市场 client-only 唯一挂载兼容修复。这三项分别维护，不互相替代，也不会随插件包静默安装。

### 验证范围

公开根包已在合成数据的隔离扩展环境验证 GitHub 首次安装、旧版更新、真实 Loader、原生重载、独立绑定及启停；最终布局适配也有实际产物回归。日常使用的是保留私有 composition 和 desktop SELF 布局的 Suite 适配器：用户确认了它与身体分支的独立开关、页面及目录按钮。这份日常试用不代表公开根包已替换日常私有鱼脑。实际用户数据不会随源码或包交付；未调用真实模型验证质量。

## 开发验证

测试要求先将 tgz 独立安装到临时目录，`FISH_TEST_INSTALL_ROOT` 指向该目录。`FISH_DSH_TEST_ANCHOR` 指向临时安装的官方 DSH 依赖环境 package.json。

```sh
node --test test/distribution.test.mjs test/official-native.test.mjs
```

另运行 `node --test test/independent-binding.test.mjs test/root-compatibility.test.mjs`，覆盖独立绑定优先级、旧版混用、冲突来源及真实根入口的旧配置兼容。覆盖初始化、两种安装顺序、持久化、切根不迁移、旧数据保留、空记忆、失败重试、实际组件导入、原生 standard→fish 选择及 Worker 隔离。测试不调用真实模型。桌面选择器与真实聊天的验收状态见隔离验收报告；上下文测试不调用真实模型。

MIT，第三方来源与许可见 THIRD-PARTY-NOTICES.md。

## 脑运行依赖归属

心情、思考和旧执行内核已随本包分发，包含各自资源和许可证；运行不读取胃工作目录。旧执行模块的可导入性不等于被挂载：当前 fish 组合仅使用固定 standard Worker，保留工程门和协作门的身份边界。身体停用不会移除脑区或 fish preset；脑停用不修改身体选择。
