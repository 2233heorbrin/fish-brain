/* ============================================================
 * 8D-1 · 星图渲染器过滤与动画单元测试
 * 在 Node 里用 vm + 记录型 Canvas 2D 替身执行 assets/js/event-graph.js，
 * 直接检查「实际绘制了什么」，而不是只看计数文字：
 *  - strict/isolate 模式不绘制非匹配节点与枢纽
 *  - 非匹配节点不参与命中检测
 *  - 单脑区 bounds / fit 只包含该脑区
 *  - 全部模式恢复完整节点与跨区流线
 *  - 暂停后逐帧绘制指令完全一致；继续后再次变化
 *  - destroy 清理 RAF / ResizeObserver / 监听器
 * ============================================================ */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

import { buildEventProjection } from '../lib/index.js'

const ROOT = 'D:/deepseek框架/鱼的大脑/适配器/fish-brain-ui'
const config = {
  freezeMatrixPath: 'D:/deepseek框架/鱼的大脑/总说明/全脑V1冻结矩阵.json',
  brainRoot: 'D:/deepseek框架/鱼的大脑'
}

/* ---------- 记录型 Canvas 2D 替身 ---------- */
function makeContext(log) {
  const gradient = { addColorStop() {} }
  const ctx = {
    fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1,
    font: '', textAlign: '', textBaseline: '',
    setTransform() {},
    clearRect() {},
    fillRect() {},
    save() { log.push({ op: 'save' }) },
    restore() { log.push({ op: 'restore' }) },
    translate() {}, scale() {}, setLineDash() {},
    createRadialGradient() { return gradient },
    createLinearGradient() { return gradient },
    beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, quadraticCurveTo() {},
    stroke() { log.push({ op: 'stroke', style: ctx.strokeStyle, alpha: ctx.globalAlpha }) },
    arc(x, y, r) { log.push({ op: 'arc', x, y, r }) },
    fill() { log.push({ op: 'fill', style: ctx.fillStyle, alpha: ctx.globalAlpha }) },
    measureText(t) { return { width: String(t).length * 6 } },
    fillText(t, x, y) { log.push({ op: 'text', text: String(t), x, y, style: ctx.fillStyle }) },
    strokeText() {}
  }
  return ctx
}

function makeSandbox() {
  const log = []
  const listeners = new Map()
  const rafQueue = []
  const cancelled = []
  const ctx = makeContext(log)
  const canvas = {
    width: 0, height: 0, style: {},
    parentNode: { getBoundingClientRect: () => ({ width: 1200, height: 800 }) },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
    addEventListener(type, fn) { listeners.set(type, fn) },
    setPointerCapture() {}
  }
  const observers = []
  const win = {
    devicePixelRatio: 1,
    ResizeObserver: class { constructor(cb) { this.cb = cb; observers.push(this) } observe() {} disconnect() { this.disconnected = true } },
    addEventListener(type, fn) { listeners.set('win:' + type, fn) },
    removeEventListener(type) { listeners.delete('win:' + type) },
    requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length },
    cancelAnimationFrame(id) { cancelled.push(id) }
  }
  const sandbox = {
    window: win, FB: {}, console,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    ResizeObserver: win.ResizeObserver,
    setTimeout: () => 0,
    Math, Date, Array, Object, String, Number, isNaN
  }
  sandbox.window.FB = sandbox.FB
  return { sandbox, canvas, log, listeners, rafQueue, cancelled, observers }
}

async function makeGraph() {
  const source = await readFile(ROOT + '/assets/js/event-graph.js', 'utf8')
  const kit = makeSandbox()
  vm.runInNewContext(source, kit.sandbox, { filename: 'event-graph.js' })
  const Graph = kit.sandbox.FB.EventGraph
  assert.equal(typeof Graph, 'function', 'FB.EventGraph 必须导出')
  const graph = new Graph(kit.canvas, {})
  const projection = await buildEventProjection(config)
  graph.setData(projection)
  graph.resize()
  return { graph, projection, ...kit }
}

/* 每次调用推进 120ms 并记录这一帧的全部绘制指令 */
let clock = 1000
function runFrame(graph, log, ts) {
  log.length = 0
  clock = ts === undefined ? clock + 120 : ts
  graph._loop(clock)
  return log
}
function snapshot(log) {
  return log.map((e) => JSON.stringify(e))
}
function drawnLabels(frame) {
  return frame.filter((e) => e.op === 'text').map((e) => e.text)
}

/* ---------- 测试 ---------- */
test('strict isolate draws only the selected region hubs, nodes and labels', async () => {
  const { graph, projection, log } = await makeGraph()
  const mood = projection.regions.find((r) => r.id === 'mood')
  const ids = {}
  mood.nodes.forEach((n) => { ids[n.id] = true })

  graph.setFilter({ regions: { mood: true }, ids, isolate: true })
  const labels = drawnLabels(runFrame(graph, log))

  /* 枢纽名只有 mood；其他 5 个脑区名一个都不能出现 */
  const hubLabels = projection.regions.map((r) => r.label)
  assert.ok(labels.includes(mood.label), '必须绘制选中脑区枢纽')
  hubLabels.filter((l) => l !== mood.label).forEach((l) => {
    assert.ok(!labels.includes(l), '未选中的枢纽不得绘制：' + l)
  })

  /* 节点标题只允许 mood 的 */
  const moodTitles = new Set(mood.nodes.map((n) => n.titleZh))
  const otherTitles = projection.regions
    .filter((r) => r.id !== 'mood')
    .flatMap((r) => r.nodes.map((n) => n.titleZh))
  labels.forEach((t) => {
    assert.ok(!otherTitles.includes(t), '非选中脑区节点不得绘制：' + t)
  })

  /* 可见节点数就是 mood 节点数，且每个都进入绘制 */
  assert.equal(graph.visibleNodes().length, mood.nodes.length)
  assert.equal(graph.visibleHubs().length, 1)
  assert.equal(graph.visibleHubs()[0].id, 'mood')
  const drawnMood = [...moodTitles].filter((t) => labels.includes(t))
  assert.ok(drawnMood.length > 0, 'mood 节点标题必须可见')
})

test('non-matching nodes are not hit-testable and not selectable', async () => {
  const { graph, projection } = await makeGraph()
  const mood = projection.regions.find((r) => r.id === 'mood')
  const ids = {}
  mood.nodes.forEach((n) => { ids[n.id] = true })
  graph.setFilter({ regions: { mood: true }, ids, isolate: true })

  const thinking = graph.byId[projection.regions.find((r) => r.id === 'thinking').nodes[0].id]
  const toClient = (n) => ({
    clientX: n.x * graph.view.s + graph.view.x,
    clientY: n.y * graph.view.s + graph.view.y
  })
  assert.equal(graph.pick(toClient(thinking)), null, '被过滤掉的节点不得被命中')

  const moodNode = graph.byId[mood.nodes[0].id]
  const hit = graph.pick(toClient(moodNode))
  assert.ok(hit && hit.id === moodNode.id, '可见节点必须可命中')

  const thinkingHub = graph.byId['hub:thinking']
  assert.equal(graph.pick(toClient(thinkingHub)), null, '被过滤掉的枢纽不得被命中')
})

test('hub hit test exposes a hub object whose id is the region id', async () => {
  const { graph, projection } = await makeGraph()
  const mood = projection.regions.find((r) => r.id === 'mood')
  const ids = {}
  mood.nodes.forEach((n) => { ids[n.id] = true })
  graph.setFilter({ regions: { mood: true }, ids, isolate: true })

  const hub = graph.byId['hub:mood']
  const hit = graph.pick({
    clientX: hub.x * graph.view.s + graph.view.x,
    clientY: hub.y * graph.view.s + graph.view.y
  })
  assert.ok(hit, '枢纽必须可命中，否则点枢纽没有任何反应')
  assert.equal(hit.kind, 'hub')
  assert.equal(hit.id, 'mood', '枢纽对象的 id 是脑区名，不是 hub: 前缀')
})

test('bounds and fit only cover the selected region', async () => {
  const { graph, projection } = await makeGraph()
  const mood = projection.regions.find((r) => r.id === 'mood')
  const ids = {}
  mood.nodes.forEach((n) => { ids[n.id] = true })
  graph.setFilter({ regions: { mood: true }, ids, isolate: true })

  const b = graph.bounds()
  const visible = graph.visibleHubs().concat(graph.visibleNodes())
  const expect = visible.reduce((acc, n) => ({
    x0: Math.min(acc.x0, n.x - n.r), y0: Math.min(acc.y0, n.y - n.r),
    x1: Math.max(acc.x1, n.x + n.r), y1: Math.max(acc.y1, n.y + n.r)
  }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })
  assert.equal(b.x0, expect.x0)
  assert.equal(b.y1, expect.y1)

  /* fit 后的视野中心必须落在该脑区中心附近，而不是全图中心 */
  const cx = (b.x0 + b.x1) / 2
  const cy = (b.y0 + b.y1) / 2
  assert.ok(Math.abs(graph.view.x + cx * graph.view.s - graph.w / 2) < 2, '横向应居中到该脑区')
  assert.ok(Math.abs(graph.view.y + cy * graph.view.s - graph.h / 2) < 2, '纵向应居中到该脑区')
})

test('clearing the filter restores the full graph and cross-region flows', async () => {
  const { graph, projection, log } = await makeGraph()
  const mood = projection.regions.find((r) => r.id === 'mood')
  const ids = {}
  mood.nodes.forEach((n) => { ids[n.id] = true })
  graph.setFilter({ regions: { mood: true }, ids, isolate: true })
  runFrame(graph, log)

  graph.setFilter(null)
  const frame = runFrame(graph, log)
  const labels = drawnLabels(frame)
  const total = projection.regions.reduce((n, r) => n + r.nodes.length, 0)

  assert.equal(graph.visibleNodes().length, total)
  assert.equal(graph.visibleHubs().length, projection.regions.length)
  projection.regions.forEach((r) => assert.ok(labels.includes(r.label), '必须恢复枢纽 ' + r.label))
  /* 跨区流线恢复：选中态以外的流线 stroke 数量应大于单脑区时的 0 */
  const strokes = frame.filter((e) => e.op === 'stroke').length
  assert.ok(strokes > 6, '恢复后应有跨区流线与辐射线')
})

test('paused frames are pixel-stable; resuming changes the drawing again', async () => {
  const { graph, log } = await makeGraph()
  const a = snapshot(runFrame(graph, log))
  graph.setPaused(true)
  const b = snapshot(runFrame(graph, log))
  const c = snapshot(runFrame(graph, log))
  assert.deepEqual(b, c, '暂停后两帧绘制指令必须完全一致')

  graph.setPaused(false)
  runFrame(graph, log)                      /* 恢复后的第一帧只重新对时，不补播 */
  const d = snapshot(runFrame(graph, log))
  assert.notDeepEqual(b, d, '继续动画后绘制必须变化')
  assert.ok(a.length > 0)
})

test('animation follows the authoritative flow lines without moving nodes', async () => {
  const { graph, log } = await makeGraph()
  const before = graph.nodes.map((n) => n.x + ':' + n.y)
  /* 跑两帧：节点坐标不得变化（不漂移） */
  runFrame(graph, log)
  runFrame(graph, log)
  const after = graph.nodes.map((n) => n.x + ':' + n.y)
  assert.deepEqual(after, before, '动画不得移动节点坐标')

  /* 流线上必须有粒子：小半径实心点（r≈2.5/s）出现在枢纽之间 */
  const frame = runFrame(graph, log)
  const dots = frame.filter((e) => e.op === 'arc' && e.r < 4 && e.r > 1)
  assert.ok(dots.length >= 4, '可见流线上必须有信号粒子，实测 ' + dots.length)
})

test('destroy cancels animation, disconnects observers and drops data', async () => {
  const { graph, cancelled, observers, listeners } = await makeGraph()
  graph.destroy()
  assert.equal(graph.raf, 0)
  assert.ok(cancelled.length >= 1, '必须取消 requestAnimationFrame')
  assert.ok(observers.every((o) => o.disconnected), '必须断开 ResizeObserver')
  assert.equal(listeners.has('win:resize'), false, '必须移除窗口 resize 监听')
  assert.equal(graph.nodes.length, 0)
  assert.equal(graph.hubs.length, 0)
})
