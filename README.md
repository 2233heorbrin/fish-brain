# fish-brain（鱼的脑）

> DeepSeek Harness（DSH）上的「全脑组合」：把**人格（SELF）、只读记忆检索、心情、思考策略卡**装进 agent 的上下文，再用两道**门**控制「谁能协作、谁能碰工程工具」。
>
> A "whole brain" bundle for DSH: persona (SELF), read-only memory recall, mood and thinking strategy cards injected into an agent's context, plus two gates controlling collaboration and engineering tools.

本仓库是一个 **monorepo**，包含四个可独立安装的 DSH 插件包：

| 包 | 作用 | 形态 |
|---|---|---|
| `fish-brain-suite` | 组合层：持有 `fish-plugins.json`（全脑清单）、控制接口 `./control`、生命周期与原生宿主适配 | bundle 补丁 + 宿主控制器 |
| `fish-brain-ui` | 设置页「脑」面板：脑区投影、事件图、记忆摘要、过滤/搜索 | 宿主接口 + 客户端 UI |
| `fish-agent-collab-gate` | 多 Agent 协作开关：关闭时用 `tools.guard` 拒绝 `subagent` / `subagent_fork` 的准入，worker 与普通工具不受影响 | 宿主工具门 |
| `fish-engineering-tools-gate` | 工程工具门：只对指定 agent 隐藏并拦截原生工程工具（bash/文件写入等），开启时恢复 | 宿主工具门 |

## 它解决什么问题

普通 agent 只有「系统提示 + 工具 + 会话历史」。`fish-brain` 补上四层**受控的长期状态**，并保证每条都**只读或可关**：

1. **人格（SELF）**：把 `SELF.compat.md` 注入为 persona 前缀——角色、关系、语气来自文件，不写死在提示里。
2. **只读记忆**：`fish-memory-readonly-tools` 提供 `fish_memory_search`，只读检索，禁止写入。
3. **心情**：`dsh-agent-mood` 记录心情状态并做衰减，注入为极短的上下文。
4. **思考**：`dsh-agent-thinking` 把「思考运行卡 / 能力索引」作为策略提示注入，`scopeOnly` 限定作用域。

再加两道门：

- **协作门**：批量并行 subagent 很容易失控；协作门默认关闭，需要时由用户打开。
- **工程工具门**：让「思考型 agent」在没有授权时看不到工程写工具，从工具层面保证它只能想、不能改。

> 设计原则：**事实与结论分离**。注入的永远是「事实卡/策略卡」，结论必须由 agent 自己给出；记忆**严格只读**；任何开关都不能被 agent 自行打开。

## 安装

### 先决条件

- DSH ≥ `0.2.1-rc.2`（本仓库在 `0.2.1-rc.5` 上验证）
- 推荐同时安装「鱼的身体 / 鱼的手」以启用审核安装流程（可选）

### 逐个安装（推荐：由市场安装）

本仓库是 monorepo，DSH 的插件市场支持**子目录规格**（`…/tree/<branch>/<subdir>`）：

```
github:2233heorbrin/fish-brain/tree/main/packages/fish-brain-suite
github:2233heorbrin/fish-brain/tree/main/packages/fish-brain-ui
github:2233heorbrin/fish-brain/tree/main/packages/fish-agent-collab-gate
github:2233heorbrin/fish-brain/tree/main/packages/fish-engineering-tools-gate
```

在市场里粘贴上面的规格即可安装；四个包顺序不影响（`fish-brain-ui` 与两个 gate 需要 profile 里有入口行）。

### 或者：克隆后按本地路径安装

```bash
git clone https://github.com/2233heorbrin/fish-brain.git
dsh plugin --profile <profile> add file:<克隆路径>/packages/fish-brain-suite
dsh plugin --profile <profile> add file:<克隆路径>/packages/fish-brain-ui
dsh plugin --profile <profile> add file:<克隆路径>/packages/fish-agent-collab-gate
dsh plugin --profile <profile> add file:<克隆路径>/packages/fish-engineering-tools-gate
```

> ⚠️ 如果你用的是带审核流程的「鱼手」安装器：它目前**只接受仓库根目录有 `package.json`** 的来源（monorepo 子目录会报 `SOURCE_PACKAGE_JSON_MISSING`）。此时请用市场/原生安装，或把单个包拆成独立仓库。

### 装完必须改的本地路径

本仓库默认路径指向作者自己的工作区，请按你的目录改这 4 处（否则 UI/门会读不到状态）：

| 文件 | 位置 | 改成 |
|---|---|---|
| `packages/fish-brain-suite/cordis.patch.yml` | `freezeMatrixPath` / `brainRoot` / 两个 `statePath` | 你的「鱼的大脑」目录与 profile 目录 |
| `packages/fish-brain-suite/fish-plugins.json` | `file:///…/dsh-memory-shipei`、`selfPath`、`fish-memory-readonly-tools` 等 | 你的适配器绝对路径 |
| `packages/fish-agent-collab-gate/index.js` | `DEFAULT_STATE_PATH` | 你的 `agent-collab.json` |
| `packages/fish-engineering-tools-gate/index.js` | `DEFAULT_STATE_PATH` | 你的 `engineering-tools.json` |

配色/文案在 `packages/fish-brain-ui/assets/`，可自由改。

## 配置（`fish-plugins.json`）

`fish-brain-suite` 的「全脑清单」是一串 Cordis 插件项，可增删：

```jsonc
[
  { "id": "persona", "name": "@deepseek-ai/dsh-persona",
    "config": { "prefix": "……" } },                    // 人格前缀
  { "id": "dsh-memory-shipei", "name": "file:///…/dsh-memory-shipei/lib/index.js",
    "config": { "selfPath": "…/SELF.compat.md", "includeSelf": true } },
  { "id": "fish-memory-readonly-tools", "name": "file:///…" },  // 只读记忆
  { "id": "dsh-agent-mood", "name": "file:///…" },              // 心情
  { "id": "dsh-agent-thinking", "name": "file:///…", "config": { "runtimeCardPath": "…/思考运行卡.txt" } },
  { "id": "tool-worker", "name": "@deepseek-ai/dsh-tool-subagent", "config": { "toolName": "worker" } }
]
```

## 开发与测试

```bash
# 组合层
node --test packages/fish-brain-suite/test/*.test.mjs

# UI
node --test packages/fish-brain-ui/test/*.test.mjs
```

测试使用本地 fixture，不联网、不写你的真实状态目录。

## 安全边界

- 记忆**只读**：任何写记忆的动作不在本仓库范围内。
- 开关**只能人来按**：两个门与脑区开关都由用户在插件/设置页操作，agent 无权自行开启。
- 注入内容**可审计**：所有注入都来自显式文件（`SELF.compat.md`、`思考运行卡.txt`、心情/记忆状态文件），可在仓库里核对模板。
- 不碰凭据：本仓库不读、不存 token/密钥。

## 许可

MIT © 2026 酥软大肥鱼（2233heorbrin）
