/* ============================================================
 * 8D-1 · 过滤契约与搜索语义单元测试
 * 直接执行 assets/js/app.js 暴露的纯过滤函数（不依赖 DOM），
 * 用正式只读投影的真实节点验证：
 *  - 无任何条件时返回 null（不打扰用户视角）
 *  - 有脑区 / 时间 / 搜索时返回 { regions, ids, isolate }
 *  - 搜索同时匹配 titleZh / summaryZh / kind
 *  - 搜索 + 脑区 + 时间取交集
 *  - 结果为空时 ids 与 regions 都为空（Canvas 因此不残留旧节点）
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

async function loadFilterModel() {
  const source = await readFile(ROOT + '/assets/js/app.js', 'utf8')
  const noop = () => {}
  const sandbox = {
    console,
    document: {
      readyState: 'loading',      /* boot 延后执行：本测试只验证纯函数 */
      addEventListener: noop,
      removeEventListener: noop,
      getElementById: () => null
    },
    sessionStorage: { getItem: () => null, setItem: noop },
    setTimeout: () => 0, clearTimeout: noop,
    fetch: () => Promise.reject(new Error('no network in unit test')),
    EventSource: function () { this.close = noop },
    matchMedia: () => ({ matches: false }),
    addEventListener: noop, removeEventListener: noop,
    FB: { views: { h: () => ({ appendChild: noop }) } },
    Math, Date, JSON, Object, Array, String, Number, isNaN
  }
  sandbox.window = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'app.js' })
  assert.ok(sandbox.FB.filterModel, 'app.js 必须暴露 FB.filterModel')
  return { model: sandbox.FB.filterModel, projection: await buildEventProjection(config) }
}

function nodesOf(projection) {
  return projection.regions.reduce((out, r) => out.concat(r.nodes), [])
}

test('no condition means no filter object at all', async () => {
  const { model, projection } = await loadFilterModel()
  const nodes = nodesOf(projection)
  assert.equal(model.build(nodes, 'all', 'all', ''), null)
  assert.equal(model.build(nodes, 'all', 'all', '   '), null)
})

test('region filter returns the strict isolate contract', async () => {
  const { model, projection } = await loadFilterModel()
  const nodes = nodesOf(projection)
  const mood = projection.regions.find((r) => r.id === 'mood')
  const f = model.build(nodes, 'mood', 'all', '')

  assert.ok(f, '选择脑区必须产生过滤对象')
  assert.equal(f.isolate, true)
  assert.deepEqual(Object.keys(f.regions), ['mood'])
  assert.equal(Object.keys(f.ids).length, mood.nodes.length)
  mood.nodes.forEach((n) => assert.equal(f.ids[n.id], true))
  /* 结构必须是 regions + ids，而不是裸 id 集合 */
  assert.ok(f.regions && typeof f.regions === 'object')
})

test('search matches titleZh, summaryZh and kind', async () => {
  const { model } = await loadFilterModel()
  const nodes = [
    { id: 'a', region: 'mood', kind: 'render-audit', titleZh: '平静指数', summaryZh: null, at: null },
    { id: 'b', region: 'thinking', kind: 'task', titleZh: '小任务', summaryZh: '与鲸落无关', at: null },
    { id: 'c', region: 'execution', kind: 'run', titleZh: '一条执行', summaryZh: null, at: null }
  ]
  const byTitle = model.build(nodes, 'all', 'all', '鲸落')
  assert.deepEqual(Object.keys(byTitle.ids), ['b'], 'summaryZh 命中')

  const byKind = model.build(nodes, 'all', 'all', 'render-audit')
  assert.deepEqual(Object.keys(byKind.ids), ['a'], 'kind 命中')

  const byTitle2 = model.build(nodes, 'all', 'all', '平静')
  assert.deepEqual(Object.keys(byTitle2.ids), ['a'], 'titleZh 命中')

  assert.equal(model.matches({ titleZh: '平静指数' }, ''), true, '空查询匹配一切')
})

test('search on the real projection finds 鲸落 in title nodes only', async () => {
  const { model, projection } = await loadFilterModel()
  const nodes = nodesOf(projection)
  const f = model.build(nodes, 'all', 'all', '鲸落')

  const matched = nodes.filter((n) => /鲸落/.test(n.titleZh || '') ||
    /鲸落/.test(n.summaryZh || '') || /鲸落/.test(n.kind || ''))
  assert.ok(matched.length > 0, '正式投影里必须存在匹配节点')
  assert.ok(matched.length < nodes.length, '匹配数必须小于总数')
  assert.equal(Object.keys(f.ids).length, matched.length)
  matched.forEach((n) => assert.equal(f.ids[n.id], true))
  /* 匹配节点所属脑区均可见，其余脑区不可见 */
  const regions = new Set(matched.map((n) => n.region))
  assert.deepEqual(Object.keys(f.regions).sort(), [...regions].sort())
})

test('search, region and time conditions intersect', async () => {
  const { model, projection } = await loadFilterModel()
  const nodes = nodesOf(projection)
  const thinking = projection.regions.find((r) => r.id === 'thinking')
  const hitInThinking = thinking.nodes.some((n) => /鲸落/.test(n.titleZh || ''))

  const f = model.build(nodes, 'thinking', 'all', '鲸落')
  if (hitInThinking) {
    assert.ok(Object.keys(f.ids).length > 0)
  } else {
    assert.equal(Object.keys(f.ids).length, 0, '思考区没有鲸落时交集必须为空')
    assert.equal(Object.keys(f.regions).length, 0)
  }

  /* 时间条件：近 1 小时 + 无可靠时间的节点 → 不可见 */
  const g = model.build(nodes, 'all', 'h1', '')
  nodes.forEach((n) => {
    if (g.ids[n.id]) {
      assert.ok(n.at, '没有可靠时间的节点不得出现在时间筛选结果里')
      assert.ok(Date.now() - Date.parse(n.at) <= 3600e3)
    }
  })
})

test('empty search result yields empty ids so the canvas shows nothing', async () => {
  const { model, projection } = await loadFilterModel()
  const nodes = nodesOf(projection)
  const f = model.build(nodes, 'all', 'all', '这个字符串一定不存在zzz')
  assert.equal(Object.keys(f.ids).length, 0)
  assert.equal(Object.keys(f.regions).length, 0)
  assert.equal(f.shown, 0)
  assert.equal(f.total, nodes.length)
})
