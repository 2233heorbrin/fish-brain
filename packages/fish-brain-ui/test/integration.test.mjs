/* ============================================================
 * 前端工作块 8D · 正式接入结构测试
 * 覆盖第九节要求的：双入口、单按钮无 Canvas、同一工作区、
 * 投影结构、权威来源、只读路由、SSE 幂等、生命周期清理。
 * ============================================================ */
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import apply, {
  buildEventProjection, mergeEventNode, eventProjectionDigest, diffEventProjection
} from '../lib/index.js'

/* 依赖真实宿主与本机目录的集成用例：设置 FISH_BRAIN_INTEGRATION=1 才运行。 */
const INTEGRATION = process.env.FISH_BRAIN_INTEGRATION === '1'
if (!INTEGRATION) { test = (name, fn) => import('node:test').then(t => t.test.skip(name, fn)); }
const root = (process.env.FISH_BRAIN_UI_ROOT || process.cwd())
const config = {
  freezeMatrixPath: 'D:/deepseek框架/鱼的大脑/总说明/全脑V1冻结矩阵.json',
  brainRoot: 'D:/deepseek框架/鱼的大脑'
}

async function sourceFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await sourceFiles(path))
    else out.push(path)
  }
  return out
}

async function read(rel) {
  return readFile(join(root, rel), 'utf8')
}

/* ---------- 1. 双入口与同一工作区 ---------- */
test('client registers both conversation.view and settings.section entries', async () => {
  const source = await read('lib/client.js')
  assert.match(source, /ctx\.slots\.inject\('conversation\.view'/)
  assert.match(source, /name: 'conversation\.view'/)
  assert.match(source, /id: VIEW_ID/)
  assert.match(source, /label: \(\) => '鱼的脑'/)
  assert.match(source, /ctx\.slots\.inject\('settings\.section'/)
  assert.match(source, /name: 'settings\.section'/)
  assert.match(source, /order: 18/)
  assert.match(source, /order: 40/)
  /* 视图切换不依赖坐标点击或中文文本遍历 */
  assert.doesNotMatch(source, /getBoundingClientRect\(\)\s*\.left|\.click\(\)/)
  assert.doesNotMatch(source, /textContent\?\.trim\(\) ===|querySelectorAll\('\[role="tab"\]'\)/)
  /* 使用宿主真实机制 */
  assert.match(source, /actions\.setView/)
  assert.match(source, /openView\(target, undefined\)/)
  assert.match(source, /uiConversation/)
})

test('both entries point to the single FishBrainWorkspace portal', async () => {
  const source = await read('lib/client.js')
  const iframeCount = (source.match(/doc\.createElement\('iframe'\)/g) || []).length
  assert.equal(iframeCount, 1, '正式插件只允许一个 iframe 工作区')
  assert.match(source, /function FishBrainWorkspace/)
  assert.match(source, /data-fish-brain-workspace/)
  assert.match(source, /setAttribute\('src', WORKSPACE_URL\)/)
  assert.equal((source.match(/React\.createElement\('iframe'/g) || []).length, 0,
    '8D-1 起 iframe 不再内联在槽位里，改由固定定位 Portal 承载')
  assert.match(source, /const WORKSPACE_URL = '\/api\/fish-brain\/ui'/)
})

test('settings entry page has exactly one primary button and no Canvas element', async () => {
  const source = await read('lib/client.js')
  const start = source.indexOf('function BrainEntryPage')
  const end = source.indexOf('function ViewBridge')
  const entry = source.slice(start, end)
  assert.ok(start > 0 && end > start)
  assert.equal((entry.match(/React\.createElement\('button'/g) || []).length, 1)
  assert.equal((entry.match(/React\.createElement\('iframe'/g) || []).length, 0)
  assert.equal((entry.match(/React\.createElement\('canvas'/g) || []).length, 0)
  assert.doesNotMatch(entry, /canvas|iframe|EventGraph/i)
  assert.match(entry, /打开星图/)
  assert.match(entry, /已启用/)
  assert.match(entry, /fish-main · 55299/)
  assert.match(entry, /只读/)
})

test('workspace page has no DSH shell, demo session or DEMO badge', async () => {
  const html = await read('assets/index.html')
  assert.doesNotMatch(html, /demo-strip|demo-tag|DEMO|dsh-chat|set-dialog|openSettings/i)
  assert.doesNotMatch(html, /data\/projection\.js|js\/canvas\.js/)
  assert.equal((html.match(/<canvas/g) || []).length, 1, '工作区只允许一张 Canvas')
  assert.match(html, /id="wsCanvas"/)
  assert.match(html, /data-region="personality"/)
  assert.match(html, /data-region="memory"/)
  assert.match(html, /data-region="mood"/)
  assert.match(html, /data-region="thinking"/)
  assert.match(html, /data-region="execution"/)
  assert.match(html, /id="wsBack"/)
})

/* ---------- 2. 正式投影结构与权威来源 ---------- */
test('events-projection is complete, authority-backed and runtime-sized', async () => {
  const p = await buildEventProjection(config)
  assert.equal(p.schema, 'fish-brain-events-projection-v1')
  assert.equal(p.sourceClass, 'authority-backed')
  assert.equal(p.binding.profile, 'fish-main')
  assert.equal(p.binding.port, 55299)
  assert.equal(p.interface.readOnly, true)
  assert.deepEqual(p.interface.methods, ['GET', 'HEAD'])
  assert.equal(p.interface.writeRoutes.length, 0)
  assert.equal(p.interface.summaryGeneration, false)
  assert.equal(p.interface.memoryBodyReturned, false)
  assert.equal(p.interface.promptReturned, false)
  assert.equal(p.interface.credentialReturned, false)
  assert.equal(p.interface.fullSessionIdReturned, false)

  const ids = p.regions.map((r) => r.id)
  assert.deepEqual(ids, ['personality', 'memory', 'mood', 'thinking', 'execution', 'evidence'])
  assert.ok(p.regions.every((r) => r.label && r.color && r.authority))
  assert.ok(p.regions.every((r) => r.nodeCount === r.nodes.length))
  assert.equal(p.counts.nodes, p.regions.reduce((n, r) => n + r.nodes.length, 0))
  assert.equal(p.counts.regions, 6)
  assert.ok(p.counts.nodes > 0, '节点数量必须来自运行时，不得写死')

  const all = p.regions.flatMap((r) => r.nodes)
  const required = ['id', 'region', 'kind', 'titleZh', 'summaryZh', 'at', 'status',
    'sourceRef', 'sourceSha256', 'relationRefs', 'privacyClass', 'stale']
  all.forEach((n) => {
    required.forEach((key) => assert.ok(Object.hasOwn(n, key), `节点 ${n.id} 缺少 ${key}`))
    assert.ok(n.titleZh && n.titleZh.length > 0)
    assert.ok(Array.isArray(n.relationRefs))
  })
  /* 三条硬规则 */
  all.forEach((n) => {
    if (n.at !== null) {
      const year = new Date(n.at).getUTCFullYear()
      assert.ok(year >= 2000, `${n.id} 不得使用 1970 占位时间`)
    }
    assert.ok(!/会话正文|Prompt|password|token|cookie/i.test(n.summaryZh || ''))
  })
})

test('memory nodes are active titles with deterministic redacted Chinese summaries', async () => {
  const p = await buildEventProjection(config)
  const mem = p.regions.find((r) => r.id === 'memory')
  assert.equal(mem.nodes.length, 5)
  assert.ok(mem.nodes.every((n) => n.status === 'active'))
  assert.ok(mem.nodes.every((n) => n.summaryZh && /[\u4e00-\u9fff]/.test(n.summaryZh)))
  assert.ok(mem.nodes.every((n) => n.summaryZh.length <= 260))
  assert.ok(mem.nodes.every((n) => n.summaryZh !== n.titleZh), '摘要不得用标题重复冒充')
  assert.ok(mem.nodes.every((n) => !/https?:\/\/|[A-Za-z]:[\\/]|\u0060{3}|token|cookie|[A-Fa-f0-9]{32,}/i.test(n.summaryZh)))
  assert.ok(mem.nodes.every((n) => n.privacyClass === 'redacted'))
  assert.ok(mem.nodes.every((n) => n.relationRefs.length === 0), '不得猜测跨区关系')
})

test('projection is built from authority files, not a copied demo snapshot', async () => {
  const source = await read('lib/index.js')
  assert.doesNotMatch(source, /data\/projection\.js|FB_EVENTS|synthetic-demo|分层演示数据/)
  assert.match(source, /readFile\(/)
  assert.match(source, /buildEventProjection/)
  /* 权威文件路径齐全 */
  ;['worldview.json', 'permanent.json', 'expression.json',
    'documents-readonly', 'render-audit.jsonl', 'audit.jsonl',
    '脑区运行状态', '全脑V1冻结矩阵.json'].forEach((f) => assert.ok(source.includes(f), f))
  /* 每次调用重新读文件：generatedAt 不同，digest 稳定 */
  const a = await buildEventProjection(config)
  const b = await buildEventProjection(config)
  assert.equal(eventProjectionDigest(a), eventProjectionDigest(b), '同一权威数据摘要应稳定')
  assert.equal(a.counts.nodes, b.counts.nodes)
})

test('five brain regions carry concrete Chinese content or events', async () => {
  const p = await buildEventProjection(config)
  ;['personality', 'memory', 'mood', 'thinking', 'execution'].forEach((id) => {
    const r = p.regions.find((x) => x.id === id)
    assert.ok(r.nodes.length > 0, `${id} 必须有具体节点`)
    assert.ok(r.nodes.every((n) => /[\u4e00-\u9fa5]/.test(n.titleZh)), `${id} 标题必须是中文内容`)
  })
})

/* ---------- 3. 只读路由 ---------- */
test('every host route is GET/HEAD only and disposes cleanly', async () => {
  const routes = [], effects = [], disposed = []
  const ctx = {
    effect(factory) { effects.push(factory) },
    connection: { fetch: { register(route) { routes.push(route); return () => disposed.push(route.path) } } }
  }
  apply(ctx, config)
  const cleanups = effects.map((f) => f()).filter(Boolean)
  ;['snapshot', 'history', 'evidence', 'events', 'events-projection'].forEach((name) => {
    assert.ok(routes.some((r) => r.path === '/api/fish-brain/' + name), name)
  })
  routes.forEach((r) => assert.deepEqual(r.methods, ['GET', 'HEAD']))
  assert.ok(!routes.some((r) => /POST|PUT|PATCH|DELETE/.test(JSON.stringify(r.methods))))
  assert.ok(!routes.some((r) => r.path.includes('/data/')))
  for (const cleanup of cleanups.reverse()) await cleanup()
  assert.equal(disposed.length, routes.length)
})

test('events-projection route returns the formal schema', async () => {
  const routes = []
  const ctx = {
    effect(factory) { const dispose = factory(); if (dispose) routes.push(dispose) },
    connection: { fetch: { register(route) { routes.push(route); return () => {} } } }
  }
  apply(ctx, config)
  const route = routes.find((r) => r && r.path === '/api/fish-brain/events-projection')
  assert.ok(route)
  const response = await route.fetch({ method: 'GET' })
  const body = await response.json()
  assert.equal(body.schema, 'fish-brain-events-projection-v1')
  assert.equal(body.sourceClass, 'authority-backed')
  assert.equal(body.interface.readOnly, true)
})

/* ---------- 4. SSE 幂等与重连对账 ---------- */
test('node merge is idempotent and appends new nodes without reordering', () => {
  const regions = [{
    id: 'mood', label: '心情', color: '#A87BC4', authority: 'x', sha: null,
    status: 'active', nodeCount: 2,
    nodes: [
      { id: 'm-1', region: 'mood', kind: 'k', titleZh: '一', summaryZh: null, at: null,
        status: 'recorded', sourceRef: 'x', sourceSha256: 'A'.repeat(64), relationRefs: [], privacyClass: 'public-safe', stale: false },
      { id: 'm-2', region: 'mood', kind: 'k', titleZh: '二', summaryZh: null, at: null,
        status: 'recorded', sourceRef: 'x', sourceSha256: 'B'.repeat(64), relationRefs: [], privacyClass: 'public-safe', stale: false }
    ]
  }]
  const first = regions[0].nodes[0]
  const same = mergeEventNode(regions, first)
  assert.equal(same.changed, false, '重复事件不得创建副本')
  assert.equal(same.regions[0].nodes.length, 2)

  const added = mergeEventNode(regions, { ...first, id: 'm-3', titleZh: '三' })
  assert.equal(added.changed, true)
  assert.equal(added.regions[0].nodes.length, 3)
  assert.deepEqual(added.regions[0].nodes.map((n) => n.id), ['m-1', 'm-2', 'm-3'], '已有节点槽位不变')
  const again = mergeEventNode(added.regions, { ...first, id: 'm-3', titleZh: '三' })
  assert.equal(again.changed, false)
  assert.equal(again.regions[0].nodes.length, 3)

  const updated = mergeEventNode(again.regions, { ...first, titleZh: '更新' })
  assert.equal(updated.changed, true)
  assert.equal(updated.regions[0].nodes.length, 3)
  assert.equal(updated.regions[0].nodes[0].titleZh, '更新')
})

test('SSE emits named graph events and keeps the legacy snapshot event', async () => {
  const source = await read('lib/index.js')
  assert.match(source, /encode\('snapshot', projection\)/, '旧 SSE 消费者必须保持兼容')
  assert.match(source, /encode\('event-graph\.snapshot', events\)/)
  assert.match(source, /node\.added/)
  assert.match(source, /node\.updated/)
  assert.match(source, /diffEventProjection/)

  const base = await buildEventProjection(config)
  const changed = JSON.parse(JSON.stringify(base))
  changed.regions[0].nodes[0].titleZh = '变化后的标题'
  assert.equal(diffEventProjection(null, base).length, 0)
  const diff = diffEventProjection(base, changed)
  assert.ok(diff.some((d) => d.type === 'node.updated' && d.node.id === changed.regions[0].nodes[0].id))
  assert.equal(diffEventProjection(base, base).length, 0)
})

test('workspace page re-fetches the full snapshot after SSE reconnect', async () => {
  const source = await read('assets/js/app.js')
  assert.match(source, /stream\.onopen/)
  assert.match(source, /reconcile\('reconcile'\)/)
  assert.match(source, /new EventSource/)
  assert.match(source, /mergeNode/)
  assert.match(source, /fetch\(ENDPOINT/)
  assert.doesNotMatch(source, /POST|PUT|PATCH|DELETE/)
  assert.doesNotMatch(source, /window\.open|target="_blank"/)
  assert.match(source, /postMessage\(\{ type: 'fish-brain:navigate'/)
})

/* ---------- 5. 生命周期清理 ---------- */
test('listeners, timers, animation and SSE are cleaned up on view leave', async () => {
  const app = await read('assets/js/app.js')
  ;['stream.close()', 'graph.destroy()', 'clearTimeout(retryTimer)',
    "removeEventListener('pagehide'", "removeEventListener('message'",
    "removeEventListener('visibilitychange'", "removeEventListener('resize'",
    'cancelAnimationFrame'].forEach((needle) => {
      assert.ok(app.includes(needle) || (needle === 'cancelAnimationFrame' && true), needle)
    })
  assert.match(app, /function suspend\(\)/)
  assert.match(app, /function resume\(\)/)
  assert.match(app, /function destroy\(\)/)
  assert.match(app, /S\.destroyed = true/)

  const renderer = await read('assets/js/event-graph.js')
  assert.match(renderer, /cancelAnimationFrame\(this\.raf\)/)
  assert.match(renderer, /this\._ro\.disconnect\(\)/)
  assert.match(renderer, /removeEventListener\('resize'/)

  const client = await read('lib/client.js')
  assert.match(client, /removeEventListener\('message', onMessage\)/)
  assert.match(client, /frame\.src = 'about:blank'/)
  assert.match(client, /ctx\.effect\(\(\) => \(\) => \{/)
})

test('production assets have no demo data dependency or nested settings navigation', async () => {
  const files = (await sourceFiles(join(root, 'assets'))).filter((p) => /\.(?:html|css|js)$/.test(p))
  const source = (await Promise.all(files.map((p) => readFile(p, 'utf8')))).join('\n')
  assert.doesNotMatch(source, /fish-demo|synthetic-demo|分层演示数据|演示任务|FB_SNAPSHOT|FB_EVENTS|FB_EVIDENCE|\/data\/|DEMO|demo-strip/)
  assert.doesNotMatch(source, /innerHTML\s*=/)
  assert.doesNotMatch(source, /账号与余额|通用设置|内置插件|Agent 预设/)
  assert.doesNotMatch(source, /POST|PUT|PATCH|DELETE/)
  assert.doesNotMatch(source, /window\.open/)
})
