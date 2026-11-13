# fish-brain（鱼的脑）

> DeepSeek Harness（DSH）上的「全脑组合」：把**人格（SELF）、只读记忆检索、心情、思考策略卡**装进 agent 的上下文，再用两道**门**控制「谁能协作、谁能碰工程工具」。
>
> A "whole brain" bundle for DSH: persona (SELF), read-only memory recall, mood and thinking strategy cards injected into an agent's context, plus two gates controlling collaboration and engineering tools.

本仓库是一个 **monorepo**，包含 11 个包：

| 包 | 作用 | 角色 |
|---|---|---|
| `fish-brain-suite` | 组合层：持有 `fish-plugins.json`（全脑清单）、控制接口 `./control`、生命周期 | 必需 |
| `fish-brain-ui` | 设置页「脑」面板：脑区投影、事件图、记忆摘要、过滤/搜索 | 推荐 |
| `dsh-agent-thinking` | 思考：策略卡 / 能力索引注入（`thinking-core` 为内核） | 推荐 |
| `thinking-core` | 思考内核（策略卡解析、作用域、状态读写） | 内核 |
| `dsh-agent-mood` | 心情：状态机 + 衰减 + 极短注入（`dsh-mood-core` 为内核） | 可选 |
| `dsh-mood-core` | 心情内核 | 内核 |
| `dsh-memory-shipei` | 人格（SELF）：把 `SELF.compat.md` 作为 persona 前缀注入 | 可选 |
| `fish-memory-readonly-tools` | 只读记忆：`fish_memory_search`（依赖第三方 `mnemon`，**不随仓库分发**） | 可选 |
| `dsh-agent-execution` | 执行：受限 Worker 运行时驱动（只在明确需要时启用） | 可选 |
| `fish-agent-collab-gate` | 协作门：关闭时拒绝 `subagent` / `subagent_fork` / `worker` 的执行准入 | 可选 |
| `fish-engineering-tools-gate` | 工程工具门：只对指定 agent 隐藏并拦截原生工程写工具 | 可选 |

## 安装

### 先决条件

- DSH ≥ `0.2.1-rc.2`（本仓库在 `0.2.1-rc.5` 上验证）
- **宿主能力**：`fish-brain-suite/control` 要求 `ctx.agentLoop.releaseExact`（原生 AgentHandle 释放能力）。当前 DSH `0.2.1-rc.5` 已具备；若你的宿主没有该函数，控制器会直接抛 `fish-brain requires native AgentHandle releaseExact support`，此时**不要**装本套件。
- 可选安装「鱼的身体 / 鱼的手」以获得审核安装流程。

### 方式一：市场子目录规格（推荐）

```
github:2233heorbrin/fish-brain/tree/main/packages/fish-brain-suite
github:2233heorbrin/fish-brain/tree/main/packages/fish-brain-ui
github:2233heorbrin/fish-brain/tree/main/packages/dsh-agent-thinking
github:2233heorbrin/fish-brain/tree/main/packages/thinking-core
github:2233heorbrin/fish-brain/tree/main/packages/dsh-agent-mood
github:2233heorbrin/fish-brain/tree/main/packages/dsh-mood-core
github:2233heorbrin/fish-brain/tree/main/packages/dsh-memory-shipei
github:2233heorbrin/fish-brain/tree/main/packages/fish-memory-readonly-tools
github:2233heorbrin/fish-brain/tree/main/packages/dsh-agent-execution
github:2233heorbrin/fish-brain/tree/main/packages/fish-agent-collab-gate
github:2233heorbrin/fish-brain/tree/main/packages/fish-engineering-tools-gate
```

### 方式二：克隆后按本地路径安装

```bash
git clone https://github.com/2233heorbrin/fish-brain.git
cd fish-brain
dsh plugin --profile <profile> add file:<克隆路径>/packages/fish-brain-suite
# 其余按上表按需安装
```

> ⚠️ 带审核流程的「鱼手」安装器目前只接受**仓库根目录有 `package.json`** 的来源；monorepo 子目录会报 `SOURCE_PACKAGE_JSON_MISSING`。请用市场/原生安装，或把单个包拆成独立仓库。

## 装完必须改的本地路径

`fish-brain-suite/cordis.patch.yml` 里用两个占位符（**改配置，不改源代码**）：

| 占位符 | 换成 |
|---|---|
| `<FISH_BRAIN_ROOT>` | 你的「鱼的脑」根目录（放 `总说明/`、`脑区运行状态/` 等） |
| `<PROFILE_DIR>` | 你的 DSH profile 目录（`agent-collab.json`、`engineering-tools.json` 所在处） |

另外三处默认值也在代码里，可用环境变量覆盖：

| 文件 | 配置 |
|---|---|
| `packages/fish-agent-collab-gate/index.js` | `statePath`（未给时用 `DEFAULT_STATE_PATH`） |
| `packages/fish-engineering-tools-gate/index.js` | 同上 |
| `packages/fish-memory-readonly-tools/lib/index.js` | `FISH_MNEMON_ROOT`（mnemon 安装目录）、`FISH_MEMORY_DIR`（只读记忆数据目录） |

## 未随仓库提供的部分（重要）

| 依赖 | 状态 | 说明 |
|---|---|---|
| `mnemon`（第三方只读记忆库） | **不随仓库分发** | `fish-memory-readonly-tools` 默认从 `../../vendor/mnemon` 解析，或用 `FISH_MNEMON_ROOT` 指定；不装则 `fish_memory_search` 不可用，其余脑区不受影响 |
| `SELF.compat.md`（人格正文） | **刻意不提供** | 这是使用者自己的内容；`dsh-memory-shipei` 只负责把它注入，仓库只给结构约定，不放任何人的正文 |
| `思考运行卡.txt` / 能力索引 | **需自行准备** | 同上，`dsh-agent-thinking` 读的是你的策略卡文件 |
| 冻结矩阵 `全脑V1冻结矩阵.json` | **需自行准备** | `fish-brain-ui` 用它做投影过滤，缺省时面板降级 |

## 已知限制

1. **`worker` 也会被协作门拦截**：`fish-agent-collab-gate` 的 `DISPATCH_TOOLS = ['subagent','subagent_fork','worker']`。早期文档写「worker 不受影响」，**与实现不符，已按实现更正**（`worker` 是 fish 预设的委派通道，属于派发入口）。
2. **开启 `fish-agent-collab-gate` 后**，当前 agent 不能创建任何子 Agent（包括单个 Worker）；要恢复请在设置/插件页关掉该门，或把会话切到不带该门的预设。
3. **`dsh-agent-execution` 默认不应常开**：它给 Worker 提供受限文件工具与固定 `node --test`，只在需要「执行型 Worker」时启用。
4. **测试分两类**：`node --test packages/*/test/*.mjs` 默认只跑不需要真实宿主的用例；涉及真实 profile / 本机目录的集成用例需设置 `FISH_BRAIN_INTEGRATION=1`、`FISH_BRAIN_PROFILE=<profile 目录>`、`FISH_BRAIN_ROOT=<脑根目录>` 才会运行。

## 安全边界

- 记忆**只读**：仓库内没有写入记忆的代码路径。
- 注入内容**来自使用者自己的文件**：本仓库不含任何人的 SELF 正文、关系、记忆或会话记录。
- 开关**只能人来按**：两个门与生命周期开关都在设置/插件页，agent 无权自行开启。
- **不碰凭据**：仓库内没有 token / 密钥读取逻辑。

## 开发与测试

```bash
node --test packages/fish-brain-suite/test/*.test.mjs
node --test packages/fish-brain-ui/test/*.test.mjs
node --test packages/dsh-agent-*/test/*.test.mjs
```

## 许可

MIT © 2026 酥软大肥鱼（2233heorbrin）
