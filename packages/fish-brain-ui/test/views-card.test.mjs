/* ============================================================
 * 8E-F · 中文事件卡片单元测试
 * 用最小 DOM 替身执行 assets/js/views.js，直接检查渲染出的元素树：
 *  - 有摘要节点：中文摘要作为视觉主体（不再是"中文摘要"字段行）
 *  - 无摘要节点：只显示简短降级文案，不拼接标题当摘要
 *  - 技术信息默认收起、可展开、只显示截断哈希与脱敏来源
 *  - 枢纽列表：标题 / 摘要预览 / 时间 / 类型 / 状态，保持投影顺序
 *  - 关闭、节点跳转、相关节点跳转
 *  - 动态更新与只读边界的源码断言
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

/* ---------- 最小 DOM 替身 ---------- */
function makeDom() {
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase()
      this.children = []
      this.attrs = {}
      this.listeners = {}
      this.className = ''
      this.style = {}
      this.parentNode = null
      this._text = null
    }
    setAttribute(k, v) { this.attrs[k] = String(v) }
    getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null }
    appendChild(child) { this.children.push(child); child.parentNode = this; return child }
    removeChild(child) {
      const i = this.children.indexOf(child)
      if (i >= 0) this.children.splice(i, 1)
      child.parentNode = null
      return child
    }
    get firstChild() { return this.children[0] || null }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
    click() { (this.listeners.click || []).forEach((fn) => fn({})) }
    set textContent(v) { this.children = []; this._text = String(v) }
    get textContent() {
      if (this.children.length === 0) return this._text === null ? '' : this._text
      return this.children.map((c) => c.textContent).join('')
    }
  }
  const document = {
    createElement: (tag) => new El(tag),
    createTextNode: (text) => { const n = new El('#text'); n.textContent = text; return n }
  }
  return { document, El }
}

async function loadViews() {
  const source = await readFile(ROOT + '/assets/js/views.js', 'utf8')
  const dom = makeDom()
  const sandbox = { console, document: dom.document, window: null, Date, isNaN, String, Object, Array }
  sandbox.window = sandbox
  sandbox.FB = {}
  sandbox.window.FB = sandbox.FB
  vm.runInNewContext(source, sandbox, { filename: 'views.js' })
  assert.ok(sandbox.FB.views, 'views.js 必须导出 FB.views')
  return { views: sandbox.FB.views, dom }
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  ;(node.children || []).forEach((c) => walk(c, visit))
}

function hasClass(node, cls) {
  return String(node.className || '').split(/\s+/).includes(cls)
}

function findAll(root, cls) {
  const out = []
  walk(root, (n) => { if (hasClass(n, cls)) out.push(n) })
  return out
}

function ctxFor(projection, calls = {}) {
  return {
    regions: projection.regions,
    regionOf: (id) => projection.regions.find((r) => r.id === id) || null,
    nodeById: (id) => projection.regions.flatMap((r) => r.nodes).find((n) => n.id === id) || null,
    onSelect: (id, focus) => { calls.select = { id, focus } },
    onClose: () => { calls.close = true }
  }
}

function memoryNode(projection) {
  return projection.regions.find((r) => r.id === 'memory').nodes[0]
}

/* ---------- 节点详情 ---------- */
test('node with summary renders the Chinese summary as the visual body', async () => {
  const { views, dom } = await loadViews()
  const projection = await buildEventProjection(config)
  const n = memoryNode(projection)
  assert.ok(n.summaryZh && n.summaryZh.length > 20, '记忆节点必须已有中文摘要')

  const host = dom.document.createElement('aside')
  views.renderNodePanel(host, n, ctxFor(projection))

  const summary = findAll(host, 'p-summary')
  assert.equal(summary.length, 1, '只允许一个摘要主体')
  assert.equal(summary[0].textContent, n.summaryZh, '必须原样展示后端摘要，不在前端改写')
  assert.ok(!hasClass(summary[0], 'is-missing'))

  /* 摘要不再是"中文摘要"小节下的字段行 */
  const headings = [] 
  walk(host, (x) => { if (x.tagName === 'H5') headings.push(x.textContent) })
  assert.ok(!headings.includes('中文摘要'), '摘要不应再藏在字段型小节里')

  /* 标题是最外层主标题，脑区名单独一行 */
  const titles = findAll(host, 'p-head').map((x) => x.textContent)
  assert.ok(titles[0].includes(n.titleZh), '中文标题必须是面板主标题')
  assert.ok(titles[0].includes(projection.regions.find((r) => r.id === 'memory').label), '必须显示脑区名称')
})

test('node without summary shows a short fallback and never fabricates one', async () => {
  const { views, dom } = await loadViews()
  const projection = await buildEventProjection(config)
  const base = memoryNode(projection)
  const bare = { ...base, summaryZh: null }

  const host = dom.document.createElement('aside')
  views.renderNodePanel(host, bare, ctxFor(projection))
  const summary = findAll(host, 'p-summary')
  assert.equal(summary.length, 1)
  assert.ok(hasClass(summary[0], 'is-missing'))
  assert.equal(summary[0].textContent, '该事件暂无可展示摘要')
  assert.ok(summary[0].textContent.length <= 20, '降级文案必须简短，不占主要空间')
  /* 不得把标题拼成伪摘要 */
  assert.notEqual(summary[0].textContent, bare.titleZh)
  assert.ok(!summary[0].textContent.includes(bare.titleZh))
})

test('technical info is collapsed by default and expands on click', async () => {
  const { views, dom } = await loadViews()
  const projection = await buildEventProjection(config)
  const n = memoryNode(projection)

  const host = dom.document.createElement('aside')
  views.renderNodePanel(host, n, ctxFor(projection))

  const tech = findAll(host, 'p-tech')[0]
  const toggle = findAll(host, 'p-tech-toggle')[0]
  const body = findAll(host, 'p-tech-body')[0]
  assert.ok(tech && toggle && body, '必须有技术信息折叠区')
  assert.equal(tech.className, 'p-tech', '默认收起')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')

  /* 折叠区内容：截断哈希、脱敏来源、隐私等级、状态说明 */
  const bodyText = body.textContent
  assert.ok(bodyText.includes(n.sourceSha256.slice(0, 12)), '必须显示截断哈希')
  assert.ok(!bodyText.includes(n.sourceSha256), '不得显示完整哈希')
  assert.ok(bodyText.includes('已脱敏'), '隐私等级要用中文标签')
  assert.ok(!/\b[A-Za-z]:[\\/]/.test(bodyText), '不得出现盘符绝对路径')

  toggle.click()
  assert.equal(tech.className, 'p-tech is-open')
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  toggle.click()
  assert.equal(tech.className, 'p-tech', '可再次收起')
})

test('close, node switch and related-node jump are wired', async () => {
  const { views, dom } = await loadViews()
  const projection = await buildEventProjection(config)
  const calls = {}
  const ctx = ctxFor(projection, calls)
  const n = memoryNode(projection)

  const host = dom.document.createElement('aside')
  views.renderNodePanel(host, n, ctx)
  findAll(host, 'p-close')[0].click()
  assert.equal(calls.close, true, '关闭按钮必须回调 onClose')

  /* 相关节点：找一条带 relationRefs 的节点 */
  const withRel = projection.regions.flatMap((r) => r.nodes).find((x) => x.relationRefs.length)
  if (withRel) {
    const host2 = dom.document.createElement('aside')
    views.renderNodePanel(host2, withRel, ctx)
    const cards = findAll(host2, 'p-rel-card')
    assert.equal(cards.length, withRel.relationRefs.length)
    cards[0].click()
    assert.equal(calls.select.id, withRel.relationRefs[0], '相关节点卡片必须跳到目标节点')
    assert.equal(calls.select.focus, true)
  }
})

/* ---------- 枢纽事件卡片列表 ---------- */
test('hub list renders event cards with title, preview, time, kind and status', async () => {
  const { views, dom } = await loadViews()
  const projection = await buildEventProjection(config)
  const memory = projection.regions.find((r) => r.id === 'memory')
  const calls = {}

  const host = dom.document.createElement('aside')
  views.renderHubPanel(host, 'memory', ctxFor(projection, calls))

  const cards = findAll(host, 'p-card')
  assert.equal(cards.length, memory.nodes.length, '每个记忆条目必须有一张卡片')

  const ids = cards.map((c) => c.getAttribute('data-node-id'))
  assert.deepEqual(ids, memory.nodes.map((n) => n.id), '必须保持投影原顺序')

  cards.forEach((card, i) => {
    const n = memory.nodes[i]
    const title = findAll(card, 'p-card-title')[0]
    const sum = findAll(card, 'p-card-sum')[0]
    const foot = findAll(card, 'p-card-foot')[0]
    assert.equal(title.textContent, n.titleZh)
    assert.equal(sum.textContent, n.summaryZh, '列表必须显示后端中文摘要预览')
    assert.ok(foot.textContent.includes(views.fmtTime(n.at)), '必须显示时间')
    assert.ok(foot.textContent.includes(n.kind), '必须显示类型')
    assert.ok(foot.textContent.includes(views.statusText(n.status)), '必须显示状态')
  })

  cards[1].click()
  assert.equal(calls.select.id, memory.nodes[1].id, '点击卡片进入完整节点详情')
  assert.equal(calls.select.focus, true)
})

test('hub list falls back when a node has no summary and keeps order after append', async () => {
  const { views, dom } = await loadViews()
  const projection = await buildEventProjection(config)
  const memory = projection.regions.find((r) => r.id === 'memory')
  const bare = { ...memory.nodes[0], id: 'mem-bare', titleZh: '无摘要条目', summaryZh: null }
  const region = { ...memory, nodes: [...memory.nodes, bare] }
  const localProjection = { regions: projection.regions.map((r) => (r.id === 'memory' ? region : r)) }

  const host = dom.document.createElement('aside')
  views.renderHubPanel(host, 'memory', ctxFor(localProjection))
  const cards = findAll(host, 'p-card')
  assert.equal(cards.length, memory.nodes.length + 1)
  assert.equal(cards[cards.length - 1].getAttribute('data-node-id'), 'mem-bare', '新节点追加在末尾')

  const sum = findAll(cards[cards.length - 1], 'p-card-sum')[0]
  assert.equal(sum.textContent, '暂无可展示摘要')
  assert.ok(hasClass(sum, 'is-missing'))
})

test('status and privacy identifiers are shown as Chinese labels', async () => {
  const { views } = await loadViews()
  assert.equal(views.statusText('active'), '已激活')
  assert.equal(views.statusText('confirmed-cross-platform-core'), '跨平台核心已确认')
  assert.equal(views.statusText('unknown-state'), 'unknown-state', '未知值原样显示，不猜测')
  assert.equal(views.privacyText('redacted'), '已脱敏')
  assert.equal(views.safeRef('documents-readonly/documents/active/a.md'), 'documents-readonly/documents/active/a.md')
  assert.equal(views.safeRef('D:\\deepseek的记忆\\x\\y.md'), '…/x/y.md', '绝对路径只留末两段')
})

/* ---------- 动态更新与只读边界（源码断言） ---------- */
test('dynamic updates reuse the SSE path and keep view, filter and panel', async () => {
  const app = await readFile(ROOT + '/assets/js/app.js', 'utf8')
  assert.match(app, /function applyNodePayload\(payload\)/, '必须抽出与 SSE 共用的处理函数')
  assert.match(app, /applyNodePayload\(JSON\.parse\(e\.data\)\)/, 'SSE 事件必须走同一路径')
  assert.match(app, /graph\.setData\(S\.projection, \{ keepView: true \}\)/, '动态更新不得重置视角')
  assert.match(app, /applyFilter\(\{ refit: false \}\)/, '动态更新不得重新取景')
  assert.match(app, /S\.sel === 'hub:' \+ payload\.node\.region/, '枢纽列表必须随新节点原位刷新')

  /* 点枢纽必须能打开枢纽卡片列表：枢纽对象 id 是脑区名，选择键要补 'hub:' */
  assert.match(app, /node\.kind === 'hub' \? 'hub:' \+ node\.id : node\.id/, '枢纽点击必须转换成 hub: 选择键')

  const graph = await readFile(ROOT + '/assets/js/event-graph.js', 'utf8')
  assert.match(graph, /opts\.keepView/)
  assert.match(graph, /opts\.refit !== false/)
})

test('cards expose no write affordance and only read-only requests', async () => {
  const files = ['assets/js/views.js', 'assets/js/app.js', 'assets/css/brain.css']
  const source = (await Promise.all(files.map((f) => readFile(ROOT + '/' + f, 'utf8')))).join('\n')
  assert.doesNotMatch(source, /POST|PUT|PATCH|DELETE/)
  assert.doesNotMatch(source, /innerHTML\s*=/)
  assert.doesNotMatch(source, /window\.open/)
  assert.doesNotMatch(source, /删除|遗忘|写入记忆|重新生成摘要/)
  /* 面板里出现的按钮只有：关闭、技术信息折叠、事件卡片、相关节点卡片、筛选项 */
  const views = await readFile(ROOT + '/assets/js/views.js', 'utf8')
  const allowed = ['p-close', 'p-tech-toggle', 'p-card', 'p-rel-card', 'pop-i', 'p-rel']
  const buttonClasses = [...views.matchAll(/h\('button',\s*\{([\s\S]{0,400}?)\}\)/g)]
    .map((m) => (m[1].match(/class: '([a-z0-9 -]+)'/) || [])[1])
    .filter(Boolean)
  assert.ok(buttonClasses.length >= 5, '必须找到面板里的按钮定义')
  buttonClasses.forEach((c) => {
    assert.ok(allowed.some((a) => c.startsWith(a)), '未登记的按钮样式：' + c)
  })
})
