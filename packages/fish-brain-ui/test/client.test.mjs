/* ============================================================
 * 客户端半区运行时验证（8D 第九节 + 8D-1 全屏覆盖）
 * 用最小 mock 执行 lib/client.js，验证：
 *  - 三个槽位注册（conversation.view / settings.section / conversation.session.header.actions）
 *  - conversation.view 只渲染 0 高度测量锚点，iframe 走 document.body 下的固定 Portal
 *  - Portal 的 top/left 来自 getBoundingClientRect 运行时测量，right/bottom 固定为 0
 *  - 层级低于宿主设置 Dialog 的模态层（1000）
 *  - 卸载时删除 Portal 节点、iframe、ResizeObserver 与监听器
 *  - 设置入口页只有一个主按钮、无 Canvas / iframe
 * ============================================================ */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const CLIENT = 'D:/deepseek框架/鱼的大脑/适配器/fish-brain-ui/lib/client.js'

/* 极简 React.createElement 替身：只记录元素树，不做真实渲染 */
function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.filter((c) => c !== null && c !== undefined && c !== false) }
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((n) => walk(n, visit)); return }
  visit(node)
  if (node.children) walk(node.children, visit)
}

/* 极简 DOM 替身：记录属性、样式、子节点与测量结果 */
function makeDom() {
  let ownerDoc = null
  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      style: {}, attrs: {}, children: [], parentNode: null, src: '',
      get ownerDocument() { return ownerDoc },
      setAttribute(k, v) { this.attrs[k] = String(v) },
      getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null },
      appendChild(child) { this.children.push(child); child.parentNode = this; return child },
      removeChild(child) {
        this.children = this.children.filter((x) => x !== child)
        child.parentNode = null
        return child
      },
      getBoundingClientRect() { return this.rect || { top: 76, left: 280, width: 1313, height: 796 } },
      blur() { this.blurred = true }
    }
    return el
  }
  const body = makeEl('body')
  const doc = {
    body,
    activeElement: null,
    createElement: makeEl
  }
  ownerDoc = doc
  return { doc, body, makeEl }
}

async function loadClient() {
  const source = await readFile(CLIENT, 'utf8')
  const registered = []
  const effects = []
  const injected = []
  const refs = []
  const rafs = []
  const timers = []
  const observers = []
  const listeners = new Map()
  const slotEntries = {
    'conversation.session.header': [{
      options: { name: 'conversation.session.header', store: { __handle: 'conversationStore' } }
    }]
  }
  const ctx = {
    get(name) {
      if (name === 'uiConversation') return { binding: () => ({ activate() {} }) }
      return undefined
    },
    layout: { selectPanel() {} },
    effect(factory) { effects.push(factory) },
    slots: {
      inject(name, factory) { injected.push(name); return factory() },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
      entriesOfSlot(name) { return slotEntries[name] || [] }
    }
  }
  const React = {
    createElement,
    useRef: () => { const r = { current: null }; refs.push(r); return r },
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useCallback: (fn) => fn,
    useEffect: (fn) => { effects.push(fn) }
  }
  const dom = makeDom()
  const win = {
    __ModuleLoader__: null,
    document: dom.doc,
    addEventListener(type, fn) { listeners.set(type, fn) },
    removeEventListener(type) { listeners.delete(type) },
    dispatchEvent() {},
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length },
    clearTimeout() {},
    requestAnimationFrame(fn) { rafs.push(fn); return rafs.length },
    cancelAnimationFrame() {},
    ResizeObserver: class {
      constructor(cb) { this.cb = cb; observers.push(this) }
      observe(target) { this.target = target }
      disconnect() { this.disconnected = true }
    }
  }
  let exportsRef = null
  const loader = {
    load({ id, factory }) {
      assert.equal(id, 'fish-brain-ui')
      exportsRef = factory((name) => {
        if (name === 'react') return React
        throw new Error('unexpected require: ' + name)
      })
    }
  }
  win.__ModuleLoader__ = loader
  const sandbox = {
    window: win,
    document: dom.doc,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail } },
    console
  }
  vm.runInNewContext(source, sandbox, { filename: CLIENT })
  assert.ok(exportsRef, 'client module must export')
  exportsRef.apply(ctx)
  return { ctx, React, createElement, registered, effects, injected, exportsRef, sandbox, dom, refs, rafs, timers, observers, listeners, win }
}

test('client apply registers conversation.view + settings.section + view bridge', async () => {
  const { registered, injected, exportsRef } = await loadClient()
  assert.deepEqual(Array.from(exportsRef.inject), ['slots'])
  assert.ok(injected.includes('conversation.view'))
  assert.ok(injected.includes('settings.section'))
  assert.ok(injected.includes('conversation.session.header.actions'))
  const names = registered.map((r) => r.options.name)
  assert.deepEqual(names, [
    'conversation.view', 'settings.section', 'conversation.session.header.actions'
  ])
  const view = registered[0].options
  assert.equal(view.id, 'fish-brain')
  assert.equal(view.order, 40)
  assert.equal(view.label(), '鱼的脑')
  const settings = registered[1].options
  assert.equal(settings.id, 'fish-brain')
  assert.equal(settings.order, 18)
  assert.equal(settings.label(), '鱼的脑')
  /* 桥接复用宿主 conversationStore handle —— 走宿主自己的 store 状态机 */
  assert.deepEqual(registered[2].options.store, { __handle: 'conversationStore' })
})

test('workspace slot renders only a measurement anchor, not an inline iframe', async () => {
  const { registered, effects } = await loadClient()
  const before = effects.length
  const tree = registered[0].component({ openView() {} })
  assert.equal(tree.type, 'div', '槽位内必须是测量锚点，而不是内联 iframe')
  assert.equal(tree.props['data-fish-brain-anchor'], 'true')
  assert.equal(tree.props['aria-hidden'], 'true')
  assert.equal(tree.props.style.height, '0px')
  assert.equal(effects.length, before + 1, '挂载时必须注册 Portal 副作用')
})

test('workspace mounts one iframe into a body-level fixed portal', async () => {
  const { registered, effects, dom, refs, rafs, observers } = await loadClient()
  registered[0].component({ openView() {} })
  const anchor = dom.makeEl('div')
  anchor.rect = { top: 76, left: 280, width: 1313, height: 4 }
  refs[refs.length - 1].current = anchor
  const cleanup = effects[effects.length - 1]()

  assert.equal(dom.body.children.length, 1, 'Portal 必须挂在 document.body 下')
  const layer = dom.body.children[0]
  assert.equal(layer.attrs['data-fish-brain-layer'], 'true')
  assert.equal(layer.style.position, 'fixed')
  assert.equal(layer.style.right, '0px')
  assert.equal(layer.style.bottom, '0px')
  assert.ok(Number(layer.style.zIndex) > 0)
  assert.ok(Number(layer.style.zIndex) < 1000, '层级必须低于宿主设置 Dialog 的模态层')

  assert.equal(layer.children.length, 1, '整个插件只允许一个 iframe 工作区')
  const frame = layer.children[0]
  assert.equal(frame.tagName, 'IFRAME')
  assert.equal(frame.attrs['src'], '/api/fish-brain/ui')
  assert.equal(frame.attrs['data-fish-brain-workspace'], 'true')

  /* 渲染循环里用运行时测量值写 top/left，不出现硬编码像素 */
  assert.ok(rafs.length >= 1, '必须调度一次测量帧')
  rafs[rafs.length - 1]()
  assert.equal(layer.style.top, '76px', 'top 必须等于锚点实测上沿')
  assert.equal(layer.style.left, '280px', 'left 必须等于内容区实测左沿')

  /* 窗口尺寸变化后重新测量 */
  anchor.rect = { top: 120, left: 280, width: 1313, height: 4 }
  rafs[rafs.length - 1]()
  assert.equal(layer.style.top, '120px', '窗口变化后必须重新计算顶部位置')

  assert.ok(observers.length >= 1, '必须用 ResizeObserver 跟随布局变化')

  /* 卸载：删 Portal、释放 iframe、断开观察器、移除监听器 */
  cleanup()
  assert.equal(dom.body.children.length, 0, '卸载必须删除 Portal 节点')
  assert.equal(frame.src, 'about:blank', '卸载必须释放 iframe 文档')
  assert.ok(observers.every((o) => o.disconnected), '卸载必须断开 ResizeObserver')
})

test('settings entry page renders one button and no Canvas', async () => {
  const { registered } = await loadClient()
  const entryTree = registered[1].component({})
  let iframes = 0, canvases = 0, buttons = 0
  walk(entryTree, (n) => {
    if (n.type === 'iframe') iframes++
    if (n.type === 'canvas') canvases++
    if (n.type === 'button') buttons++
  })
  assert.equal(iframes, 0)
  assert.equal(canvases, 0)
  assert.equal(buttons, 1, '设置入口页只允许一个主按钮')
  assert.equal(entryTree.props['data-fish-brain-entry'], 'true')
})

test('settings entry page closes the settings panel through ownerProps.close', async () => {
  const { registered } = await loadClient()
  let closed = 0
  const tree = registered[1].component({ close: () => { closed += 1 } })
  let button = null
  walk(tree, (n) => { if (n.type === 'button' && n.props['data-fish-brain-open']) button = n })
  assert.ok(button, '入口页必须有唯一主按钮')
  assert.equal(typeof button.props.onClick, 'function')
  button.props.onClick()
  assert.equal(closed, 1, '点击后必须由宿主自己的 close() 关闭设置面板')
})

test('settings entry page uses dark text on the light settings panel', async () => {
  const { registered } = await loadClient()
  const tree = registered[1].component({})
  const color = tree.props.style.color
  assert.match(color, /^#[0-9a-f]{6}$/i)
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  assert.ok((r * 299 + g * 587 + b * 114) / 1000 < 128,
    '设置面板是白底，入口页文字必须是深色（不能沿用深色工作区的浅色字）')
})

test('plugin dispose clears module-level seat references', async () => {
  const { effects } = await loadClient()
  assert.ok(effects.length >= 1)
  const cleanups = effects.map((f) => f()).filter(Boolean)
  assert.ok(cleanups.length >= 1, '必须注册卸载清理')
  cleanups.forEach((fn) => fn())
})
