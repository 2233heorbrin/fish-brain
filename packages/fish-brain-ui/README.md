# fish-brain-ui

fish-brain-suite 的「鱼的脑」只读前端模块（前端工作块 8D 正式接入）。

## 入口：两个，一个工作区

| 入口 | 槽位 | id | order | 渲染 |
|---|---|---|---|---|
| 会话顶栏 | `conversation.view` | `fish-brain` | 40 | 唯一的 `FishBrainWorkspace`（iframe → `/api/fish-brain/ui`） |
| 设置侧边栏 | `settings.section` | `fish-brain` | 18 | 轻量入口页：状态 + 只读边界 + 唯一「打开星图」按钮（无 Canvas、无 iframe） |

两个入口指向同一个 `FishBrainWorkspace`，不复制第二份 Canvas、不维护两套筛选或状态。
设置页按钮走 DSH 自己的 `conversationStore.actions.setView` +
`uiConversation.binding(sessionId).activate`；返回对话走 `conversation.view` 组件注入的
`openView('chat')`。不使用坐标点击、中文文本遍历、新窗口或第二个 iframe。

## 只读接口

| 路由 | 说明 |
|---|---|
| `GET /api/fish-brain/snapshot` | 既有只读投影 v2（字段语义未变） |
| `GET /api/fish-brain/history` | 既有权威审计历史 |
| `GET /api/fish-brain/evidence` | 既有证据摘要 |
| `GET /api/fish-brain/events` | 既有 SSE；保留 `snapshot` 事件兼容旧消费者 |
| `GET /api/fish-brain/events-projection` | **新增**：`fish-brain-events-projection-v1` 统一事件星图投影 |
| `GET /api/fish-brain/ui` 及 css/js | 正式星图工作区静态资源 |

全部路由仅 `GET` / `HEAD`，无写入路由。

`events-projection` 每次请求都从权威文件动态构建，不缓存、不复制 Demo 静态投影：

- 人格 → `人格/canonical/core/{worldview,permanent,expression}.json`
- 记忆 → `脑区运行状态/记忆/documents-readonly/documents/index.json`（仅 active 标题，摘要 `null`）
- 心情 → `脑区运行状态/心情/{runtime.json,render-audit.jsonl}`
- 思考 → `脑区运行状态/思考/audit.jsonl`
- 执行 → `脑区运行状态/执行/runtime.json`
- 证据 → `总说明/全脑V1冻结矩阵.json`（哈希实时计算，不写死）

三条硬规则：没有摘要返回 `null`（界面显示「摘要不可用」，不调用模型生成）；
没有可靠时间返回 `null`（1970 占位值一律丢弃）；没有权威关系返回 `[]`（不按文本相似度猜关联）。

不返回完整人格文件、完整记忆正文、Prompt、凭据、Cookie、完整会话正文或未脱敏 Session ID。

## SSE 与幂等

- 首次进入先请求完整 `events-projection`；SSE `onopen` 时重新请求完整快照对账。
- 命名事件：`event-graph.snapshot`（完整快照）、`node.added`、`node.updated`；
  既有 `snapshot` 事件保持不变，旧消费者不受影响。
- 节点按 `id` 幂等合并；重复事件不创建副本；新节点只追加到所属脑区末尾，不整体重排。
- 页面离开 / 隐藏 / 宿主通知时关闭 EventSource、停止 rAF、清理定时器与监听器；
  重新进入恢复，并用 `sessionStorage` 保持上次的视角与筛选。

## 界面

深色 DSH 原生风格；顶部显示「鱼的脑」、只读状态与当前绑定；搜索、脑区筛选、时间筛选、
复位视角、暂停动画、返回对话；五脑区枢纽 + 具体中文事件节点 + 右侧详情面板。
缺摘要 / 时间 / 关系时明确显示「不可用」。支持拖动、缩放、节点选择与键盘基本操作。

正式页面不含 DSH 外壳、Demo 会话内容或 DEMO 标识，只保留星图工作区本身。

## 测试

```bash
cd <你的工作区>\fish-brain\packages\fish-brain-ui
npm test
```

`test/projection.test.mjs` 覆盖既有只读契约；
`test/integration.test.mjs` 覆盖 8D 第九节的双入口、单按钮无 Canvas、同一工作区、
投影结构、权威来源、只读路由、SSE 幂等、生命周期清理。

## 边界

当前只读：不启用记忆写入、删除、遗忘、Auto Capture、Embedding 或鱼的手。
不提供套件或脑区启停按钮；启停由 DSH 原生插件管理入口负责。
不改变五脑区冻结契约与安全开关。
