/* ============================================================
 * fish-brain-ui · 客户端半区（前端工作块 8D 正式接入）
 *
 * 定向确认过的 DSH 0.2.1-rc.2 真实视图切换机制（不是模拟点击）：
 *  1) conversation.view 组件 ownerProps.openView(view, focus)
 *     —— 契约表 ConvViewOwnerProps：「Select a View and address one opaque focus identity to it」
 *  2) conversation.session.header 的 inject.selectView(view)
 *     = uiConversation.binding(sessionId).activate(view)
 *       + conversationStore.actions.setView(view)
 *     宿主 tab 的 onClick 就是调用它。
 *  3) settings.section 的 ownerProps.close()：契约文档明确由宿主关闭设置面板，
 *     用于「离开设置 altogether」的流程；不通过 DOM 点击或文本遍历实现。
 *
 * 本实现：
 *  - 常驻桥接组件声明与 conversation.session 相同的 store handle，让 renderer
 *    注入同一个 conversationStore.actions；点击时在宿主注册项上取回它自己的
 *    inject(sessionId, actions).selectView / openView，因此「打开星图」就是
 *    宿主 tab onClick 的同一套状态机，而不是坐标点击或中文文本遍历。
 *  - conversation.view 里只有唯一一个 FishBrainWorkspace：槽位内是 0 高度测量锚点，
 *    唯一的 iframe 挂在 document.body 下的固定定位 Portal，覆盖标签栏以下整个会话界面。
 *  - settings.section 只有轻量入口页：无 canvas、无 iframe、只有一个「打开星图」按钮。
 *  - 「返回对话」由 iframe postMessage → 父组件调用 openView('chat')。
 * ============================================================ */
window.__ModuleLoader__.load({
  id: 'fish-brain-ui',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const inject = ['slots']

    const WORKSPACE_URL = '/api/fish-brain/ui'
    const VIEW_ID = 'fish-brain'
    const OPEN_EVENT = 'fish-brain:open-view'

    /* 模块级单例：常驻桥接组件注册宿主 store 的视图切换动作；
       conversation.view 组件注册自己的 openView（用于返回对话）。 */
    const seat = { open: null, close: null, openView: null }
    const diag = { lastRoute: '', sessionEntries: 0, hasActions: false }
    let ctxRef = null
    let bridgeRef = { actions: null, sessionId: null }

    /* 宿主把视图切换放在 conversation.session / conversation.session.header
       注册项的 inject(sessionId, actions) 里：
         conversation.session        → openView(view, focus)
         conversation.session.header → selectView(view)（tab 的 onClick 正是它）
       子槽位不会自动继承这两个 owner props，所以在点击时按宿主注册项
       取回同一套 inject face，走宿主自己的状态机；不做坐标点击或文本遍历。 */
    /* 宿主注册项上的 store 是 {spec, create} 句柄，实例由 renderer 按 session key
       缓存。把它原样声明在自己的 register options 里，renderer 会注入同一个
       conversationStore.actions —— 不自行 create 出第二个实例。 */
    function findStoreHandle() {
      const ctx = ctxRef
      if (!ctx || !ctx.slots || !ctx.slots.entriesOfSlot) return null
      for (const slot of ['conversation.session', 'conversation.session.header']) {
        let entries = []
        try { entries = ctx.slots.entriesOfSlot(slot) || [] } catch (_) { continue }
        for (const entry of entries) {
          const h = entry && (entry.store || (entry.options && entry.options.store))
          if (h) return h
        }
      }
      return null
    }

    function hostViewSwitch(view, sid) {
      const ctx = ctxRef
      if (!ctx || !ctx.slots || !ctx.slots.entriesOfSlot || !sid) return false
      /* 优先用宿主注入给本桥接组件的真实 actions */
      const actions = bridgeRef.actions
      for (const slot of ['conversation.session', 'conversation.session.header']) {
        let entries = []
        try { entries = ctx.slots.entriesOfSlot(slot) || [] } catch (_) { continue }
        diag.sessionEntries = entries.length
        for (const entry of entries) {
          const injectFn = entry && entry.inject
          if (typeof injectFn !== 'function' || !actions) continue
          let face
          try { face = injectFn(sid, actions) } catch (_) { continue }
          const fn = face && (face.selectView || face.openView)
          if (typeof fn === 'function') {
            try { fn(view, undefined); return true } catch (_) {}
          }
        }
      }
      return false
    }

    /* ---------- 唯一的星图工作区（conversation.view） ----------
     * 8D-1：conversation.view 的宿主槽位只覆盖「原会话内容」区域，消息输入框、
     * 模型选择栏与 Token 状态栏在槽位之外的兄弟容器里，所以 100% 高度并不等于
     * 覆盖整个会话界面。这里改为固定定位 Portal：
     *   - 槽位里只留一个 0 高度的测量锚点；
     *   - iframe 挂到 document.body 下的固定层，top/left 全部来自锚点的
     *     getBoundingClientRect() 运行时测量（不做 98px 之类的硬编码）；
     *   - right/bottom 固定为 0，因此底边始终等于窗口底边；
     *   - z-index 低于 DSH 设置 Dialog 的全局模态层，高于会话输入框与状态栏。
     * 组件卸载时删除 Portal 节点、ResizeObserver、事件监听器与 iframe。 */
    const LAYER_Z = 600   /* 宿主设置 Dialog 的模态层实测为 1000，必须低于它 */

    function FishBrainWorkspace(props) {
      const anchorRef = React.useRef(null)
      const openView = props && props.openView

      React.useEffect(() => {
        if (typeof openView === 'function') seat.openView = openView
        const onMessage = (event) => {
          if (!event.data || event.data.type !== 'fish-brain:navigate') return
          const target = event.data.view || 'chat'
          /* DSH 注入的 ownerProp：宿主自己的视图切换入口 */
          if (typeof openView === 'function') openView(target, undefined)
          else if (target === 'chat' && typeof seat.close === 'function') seat.close()
          else if (typeof seat.open === 'function') seat.open(target)
        }
        window.addEventListener('message', onMessage)

        const anchor = anchorRef.current
        let layer = null
        let frame = null
        let ro = null
        let raf = 0
        let last = ''
        let timers = []

        const apply = () => {
          raf = 0
          if (!layer || !anchor || typeof anchor.getBoundingClientRect !== 'function') return
          const box = anchor.getBoundingClientRect()
          const top = Math.max(0, Math.round(box.top))
          const left = Math.max(0, Math.round(box.left))
          const key = top + ':' + left
          if (key === last) return
          last = key
          layer.style.top = top + 'px'
          layer.style.left = left + 'px'
        }
        const schedule = () => {
          if (raf) return
          raf = window.requestAnimationFrame ? window.requestAnimationFrame(apply) : window.setTimeout(apply, 16)
        }

        const doc = anchor && anchor.ownerDocument
        if (doc && doc.body) {
          layer = doc.createElement('div')
          layer.setAttribute('data-fish-brain-layer', 'true')
          layer.style.position = 'fixed'
          layer.style.top = '0px'
          layer.style.left = '0px'
          layer.style.right = '0px'
          layer.style.bottom = '0px'
          layer.style.zIndex = String(LAYER_Z)
          layer.style.display = 'block'
          layer.style.overflow = 'hidden'
          layer.style.background = '#0A0C0E'
          layer.style.margin = '0'
          layer.style.padding = '0'
          layer.style.border = '0'

          frame = doc.createElement('iframe')
          frame.setAttribute('title', '鱼的脑 · 全脑事件星图')
          frame.setAttribute('data-fish-brain-workspace', 'true')
          frame.setAttribute('src', WORKSPACE_URL)
          frame.style.display = 'block'
          frame.style.width = '100%'
          frame.style.height = '100%'
          frame.style.border = '0'
          frame.style.background = '#0A0C0E'
          frame.style.colorScheme = 'dark'

          layer.appendChild(frame)
          doc.body.appendChild(layer)

          /* 输入框被整层覆盖后仍可能保持焦点，键盘输入会落到看不见的草稿里。
             只对 textarea / contenteditable 失焦，不清空任何内容。 */
          try {
            const active = doc.activeElement
            const tag = active && active.tagName ? active.tagName.toLowerCase() : ''
            if (active && (tag === 'textarea' || active.getAttribute('contenteditable') === 'true') &&
              typeof active.blur === 'function') active.blur()
          } catch (_) {}

          schedule()
          /* 首帧布局稳定前多测几次；之后由 ResizeObserver 与 resize 事件维持 */
          timers = [60, 240, 600].map((ms) => window.setTimeout(schedule, ms))
          if (window.ResizeObserver) {
            ro = new window.ResizeObserver(schedule)
            try {
              ro.observe(anchor)
              if (anchor.parentElement) ro.observe(anchor.parentElement)
              ro.observe(doc.body)
            } catch (_) {}
          }
          window.addEventListener('resize', schedule)
          window.addEventListener('scroll', schedule, true)
        }

        return () => {
          window.removeEventListener('message', onMessage)
          window.removeEventListener('resize', schedule)
          window.removeEventListener('scroll', schedule, true)
          timers.forEach((id) => window.clearTimeout(id))
          if (raf) {
            if (window.cancelAnimationFrame) window.cancelAnimationFrame(raf)
            else window.clearTimeout(raf)
            raf = 0
          }
          if (ro) { ro.disconnect(); ro = null }
          if (frame) frame.src = 'about:blank'   /* 离开视图：显式释放 iframe 文档 */
          if (layer && layer.parentNode) layer.parentNode.removeChild(layer)
          layer = null
          frame = null
          if (seat.openView === openView) seat.openView = null
        }
      }, [openView])

      /* 槽位里只保留测量锚点：它给出视图标签栏下沿的真实 y 与内容区左边界 */
      return React.createElement('div', {
        ref: anchorRef,
        'data-fish-brain-anchor': 'true',
        'aria-hidden': 'true',
        style: { display: 'block', width: '100%', height: '0px', overflow: 'hidden', pointerEvents: 'none' }
      })
    }

    /* 通用开关状态：读/写宿主 gate 端点；保存失败如实回滚并报错，不留虚假成功。 */
    function useGateState(path) {
      const [state, setState] = React.useState({ enabled: false, loaded: false, saving: false, error: '' })
      const ref = React.useRef(state)
      ref.current = state
      React.useEffect(() => {
        let alive = true
        fetch(path, { credentials: 'same-origin', cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then((d) => { if (alive) setState({ enabled: d && d.enabled === true, loaded: true, saving: false, error: '' }) })
          .catch(() => { if (alive) setState({ enabled: false, loaded: true, saving: false, error: '开关状态读取失败，后端按「关闭」处理。' }) })
        return () => { alive = false }
      }, [path])
      const toggle = React.useCallback(() => {
        const snapshot = ref.current
        if (snapshot.saving || !snapshot.loaded) return
        const next = !snapshot.enabled
        setState({ enabled: snapshot.enabled, loaded: true, saving: true, error: '' })
        fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next })
        })
          .then(async (r) => {
            const d = await r.json().catch(() => ({}))
            if (!r.ok || !d || d.ok !== true) throw new Error((d && d.error) || ('HTTP ' + r.status))
            return d
          })
          .then((d) => setState({ enabled: d.enabled === true, loaded: true, saving: false, error: '' }))
          .catch((e) => setState({
            enabled: snapshot.enabled, loaded: true, saving: false,
            error: '保存失败：' + ((e && e.message) || String(e))
          }))
      }, [path])
      return [state, toggle]
    }

    /* ---------- 轻量设置入口页：无 Canvas、无 iframe、单按钮 ---------- */
    function BrainEntryPage(props) {
      const [hint, setHint] = React.useState('')

      /* 「多 Agent 协作」开关：读的是宿主 fish-agent-collab-gate 的真实准入状态。
         关闭时由该插件的 tools.guard 拒绝 subagent / subagent_fork 的执行，
         因此这里展示的只是事实回显，不是一个纯装饰的开关。 */
      /* 两个开关共用同一套读写与回滚逻辑：工程工具在上，子 Agent 在下。 */
      const [eng, onToggleEng] = useGateState('/api/fish-eng-tools/state')
      const [collab, onToggleCollab] = useGateState('/api/fish-collab-gate/state')

      /* 主题：设置面板本体是浅色硬编码，深色主题下 token 不一定可取到，
         因此这些开关显式跟随 body[data-ds-dark-theme]，不依赖变量回退。 */
      const [dark, setDark] = React.useState(
        () => !!(typeof document !== 'undefined' && document.body && document.body.hasAttribute('data-ds-dark-theme'))
      )
      React.useEffect(() => {
        if (typeof MutationObserver === 'undefined' || !document.body) return undefined
        const body = document.body
        const observer = new MutationObserver(() => setDark(body.hasAttribute('data-ds-dark-theme')))
        observer.observe(body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        return () => observer.disconnect()
      }, [])

      const onOpen = React.useCallback(() => {
        /* settings.section 的 ownerProps.close()：契约文档明确「Close the settings
           panel (the shell owns the open state). For flows that leave settings
           altogether」。由宿主自己关面板，不做 DOM 点击或文本遍历。 */
        const close = props && typeof props.close === 'function' ? props.close : null
        if (close) { try { close() } catch (_) {} }
        else { try { ctxRef && ctxRef.layout && ctxRef.layout.selectPanel(null) } catch (_) {} }
        if (typeof seat.open === 'function') {
          seat.open(VIEW_ID)
        } else {
          /* 降级：通知常驻桥接组件，仍走宿主 store 机制 */
          window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { view: VIEW_ID } }))
          setHint('正在切换到「鱼的脑」视图…若未切换，请点击会话顶栏的「鱼的脑」。')
        }
      }, [])

      const box = (style, children) => React.createElement('div', { style }, children)
      /* 设置面板是浅色（白底）；入口页必须用深色文字，不能沿用深色工作区的浅色字。 */
      const row = (label, value) => React.createElement('div', {
        style: { display: 'flex', gap: '12px', padding: '7px 0', borderBottom: dark ? '1px solid rgba(255,255,255,.12)' : '1px solid rgba(30,42,50,.12)' }
      }, [
        React.createElement('span', { key: 'k', style: { flex: '0 0 92px', color: dark ? '#AEB5BB' : '#5A6670', fontSize: '12px' } }, label),
        React.createElement('span', { key: 'v', style: { flex: '1', color: dark ? '#E8EBEE' : '#20272C', fontSize: '12.5px' } }, value)
      ])

      /* 一行开关：文字左、开关右；沿用页面既有字号/圆角/明暗配色 */
      const settingCard = ({ id, title, desc, note, state, onToggle, legacy }) => React.createElement('div', {
        key: id,
        'data-fish-gate': id,
        ...(legacy ? { 'data-fish-collab': 'true' } : {}),
        style: {
          display: 'flex', alignItems: 'flex-start', gap: '12px',
          padding: '10px 12px', borderRadius: '8px', boxSizing: 'border-box',
          border: dark ? '1px solid rgba(255,255,255,.16)' : '1px solid rgba(30,42,50,.14)',
          background: dark ? 'rgba(255,255,255,.04)' : 'rgba(30,42,50,.02)'
        }
      }, [
        React.createElement('div', { key: 'text', style: { flex: '1 1 auto', minWidth: 0 } }, [
          React.createElement('div', { key: 't', style: { fontSize: '13px', color: dark ? '#E8EBEE' : '#20272C' } }, title),
          React.createElement('div', { key: 'd1', style: { marginTop: '3px', fontSize: '11.5px', lineHeight: '1.7', color: dark ? '#AEB5BB' : '#5A6670' } }, desc),
          React.createElement('div', { key: 'd2', style: { marginTop: '2px', fontSize: '11.5px', lineHeight: '1.7', color: dark ? '#AEB5BB' : '#5A6670' } }, note),
          state.saving ? React.createElement('div', { key: 's', style: { marginTop: '6px', fontSize: '11.5px', color: dark ? '#AEB5BB' : '#5A6670' } }, '保存中…') : null,
          state.error ? React.createElement('div', { key: 'e', role: 'alert', 'data-fish-gate-error': id, style: { marginTop: '6px', fontSize: '11.5px', color: dark ? '#F08A7E' : '#C0392B' } }, state.error) : null
        ]),
        React.createElement('button', {
          key: 'sw',
          type: 'button',
          role: 'switch',
          'aria-checked': state.enabled ? 'true' : 'false',
          'aria-label': title,
          'data-fish-gate-switch': id,
          ...(legacy ? { 'data-fish-collab-switch': 'true' } : {}),
          disabled: state.saving || !state.loaded,
          onClick: onToggle,
          title: state.enabled ? '当前：开启' : '当前：关闭',
          style: {
            flex: '0 0 auto', width: '38px', height: '22px', padding: 0, marginTop: '2px',
            position: 'relative', borderRadius: '11px', border: '1px solid transparent',
            background: state.enabled ? '#1D4B46' : 'rgba(90,102,112,.35)',
            cursor: (state.saving || !state.loaded) ? 'default' : 'pointer',
            opacity: (state.saving || !state.loaded) ? '.6' : '1',
            transition: 'background-color .15s ease'
          }
        }, React.createElement('span', {
          key: 'knob',
          style: {
            position: 'absolute', top: '2px', left: state.enabled ? '18px' : '2px',
            width: '16px', height: '16px', borderRadius: '50%', background: '#FFF',
            transition: 'left .15s ease', boxShadow: '0 1px 2px rgba(0,0,0,.25)'
          }
        }))
      ])

      return React.createElement('div', {
        'data-fish-brain-entry': 'true',
        style: {
          maxWidth: '620px', padding: '24px 4px', color: dark ? '#E8EBEE' : '#20272C',
          fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif'
        }
      }, [
        React.createElement('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' } }, [
          React.createElement('h2', { key: 't', style: { margin: 0, fontSize: '16px', fontWeight: 500 } }, '鱼的脑'),
          React.createElement('span', { key: 'v', style: { fontSize: '11px', color: dark ? '#AEB5BB' : '#5A6670', fontFamily: 'monospace' } }, 'v1.0.0')
        ]),
        React.createElement('p', { key: 'sub', style: { margin: '0 0 18px', fontSize: '12px', color: dark ? '#AEB5BB' : '#5A6670' } },
          '统一全脑事件星图 · 只读投影'),
        box({ key: 'meta', marginBottom: '18px' }, [
          row('状态', '已启用'),
          row('当前绑定', 'fish-main · 55299'),
          row('数据来源', '正式只读事件投影（运行时从权威文件动态构建）'),
          row('安全边界', '只读；不写入、删除或遗忘记忆；不启用 Auto Capture / Embedding / 鱼的手')
        ]),
        React.createElement('p', {
          key: 'note',
          style: { margin: '0 0 18px', fontSize: '12px', lineHeight: '1.8', color: dark ? '#C2C9CF' : '#4C5761' }
        }, '星图展示人格、记忆、心情、思考、执行与证据中的具体中文内容或事件。缺摘要、缺时间、缺权威关系时明确显示「不可用」，不生成、不猜测。'),
        /* 「打开星图」在左；右侧两个开关上下排列（工程工具在上、子 Agent 在下）；窄屏整列下移 */
        React.createElement('div', {
          key: 'actions',
          style: { display: 'flex', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }
        }, [
          React.createElement('button', {
            key: 'open',
            type: 'button',
            'data-fish-brain-open': 'true',
            onClick: onOpen,
            style: {
              flex: '0 0 auto',
              padding: '9px 20px', borderRadius: '7px', border: '1px solid #3B6E68',
              background: '#1D4B46', color: '#E4F0ED', fontSize: '13px', cursor: 'pointer'
            }
          }, '打开星图'),
          React.createElement('div', {
            key: 'switches',
            style: { flex: '1 1 320px', minWidth: '320px', display: 'flex', flexDirection: 'column', gap: '10px' }
          }, [
            settingCard({
              id: 'eng',
              title: '开启思考与执行',
              desc: '仅控制 fish 的原生工程工具。关闭后 fish 仍可对话，但不能使用这些工具。',
              note: '不影响 standard 和其他 Agent；鱼脑工具及独立插件保持原有配置。',
              state: eng, onToggle: onToggleEng
            }),
            settingCard({
              id: 'collab', legacy: true,
              title: '允许创建子 Agent',
              desc: '允许 Agent 委派任务，可能增加 Token 消耗。',
              note: '对当前工作区所有 Agent 生效，包含鱼的固定 standard Worker。',
              state: collab, onToggle: onToggleCollab
            })
          ])
        ]),
        hint ? React.createElement('p', { key: 'hint', style: { marginTop: '10px', fontSize: '11.5px', color: dark ? '#D6B25E' : '#8A6D1F' } }, hint) : null
      ])
    }

    /* ---------- 常驻桥接：复用宿主 conversationStore handle ---------- */
    /* 该组件渲染 null，只负责把宿主 store 的 setView/openView 暴露给设置入口页。
       它注册在 conversation.session.header.actions（scope: session，常驻挂载），
       并声明与宿主 conversation.session.header 相同的 store handle，
       因此 standardKit 会把同一个 conversationStore.actions 注入进来。 */
    function ViewBridge(props) {
      /* 挂载一次即可：actions / sessionId 在事件发生时再取最新值。
         视图来回切换时宿主可能重渲染本组件；若把注册放进带依赖的 effect，
         依赖变化会先执行 cleanup 把 seat.open 清空，遇到 sessionId 暂缺的
         一次渲染就再也不会恢复，设置页按钮会失效。 */
      const latest = React.useRef(null)
      if (!latest.current) latest.current = bridgeRef
      latest.current.actions = props && props.actions
      latest.current.sessionId = props && props.sessionId

      React.useEffect(() => {
        const activate = (view) => {
          try {
            const ctx = ctxRef
            const sid = latest.current.sessionId
            const uiConversation = ctx && ctx.get && ctx.get('uiConversation')
            if (uiConversation && sid && typeof uiConversation.binding === 'function') {
              const binding = uiConversation.binding(sid)
              if (binding && typeof binding.activate === 'function') binding.activate(view)
            }
          } catch (_) {}
        }
        const open = (view) => {
          const sid = latest.current.sessionId
          diag.hasActions = !!(latest.current.actions && latest.current.actions.setView)
          /* 首选：宿主注册项自己的 selectView / openView */
          if (hostViewSwitch(view, sid)) { diag.lastRoute = 'host.inject'; return }
          /* 次选：uiConversation 服务 + conversationStore actions（同一套状态机的两步） */
          activate(view)
          const a = latest.current.actions
          if (a && typeof a.setView === 'function') {
            a.setView(view)
            diag.lastRoute = 'service+store'
          } else if (a && typeof a.openView === 'function') {
            a.openView(view, undefined)
            diag.lastRoute = 'service+store.openView'
          } else {
            diag.lastRoute = 'unavailable'
          }
        }
        const close = () => open('chat')
        seat.open = open
        seat.close = close
        const onRequest = (event) => {
          open((event.detail && event.detail.view) || VIEW_ID)
        }
        window.addEventListener(OPEN_EVENT, onRequest)
        return () => {
          window.removeEventListener(OPEN_EVENT, onRequest)
          if (seat.open === open) seat.open = null
          if (seat.close === close) seat.close = null
        }
      }, [])
      return null
    }

    function apply(ctx) {
      ctxRef = ctx
      /* 只读验收探针：只暴露路由状态，不提供任何写入或视图切换能力 */
      try {
        window.__fishBrainBridge = {
          get diag() {
            return {
              lastRoute: diag.lastRoute,
              sessionEntries: diag.sessionEntries,
              hasActions: diag.hasActions,
              sessionId: !!bridgeRef.sessionId
            }
          }
        }
      } catch (_) {}

      /* 1) 会话顶栏入口：与「对话 / 轨迹」同级的原生视图 */
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: VIEW_ID,
        order: 40,
        label: () => '鱼的脑'
      }, FishBrainWorkspace))

      /* 2) 设置侧边栏入口：轻量入口页，不含 Canvas */
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'fish-brain',
        order: 18,
        label: () => '鱼的脑'
      }, BrainEntryPage))

      /* 3) 常驻桥接：复用宿主 conversationStore handle，让 renderer 注入真实 actions。
         apply() 阶段宿主注册项可能还没挂载，因此把句柄解析做成 register 时的惰性函数：
         SlotRegistry._register 会在注册那一刻调用它，那时 conversation.session
         已经声明好 store。这是宿主自己的 store 实例，不会 create 出第二份。 */
      const storeHandle = findStoreHandle()
      try {
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'fish-brain-view-bridge',
          order: 90,
          store: storeHandle || findStoreHandle
        }, ViewBridge))
      } catch (_) {
        /* 桥接不可用时：设置页按钮退化为提示文案，两个正式入口不受影响 */
      }

      /* 4) 插件卸载：清掉模块级引用，避免残留监听器 */
      ctx.effect(() => () => {
        seat.open = null
        seat.close = null
        seat.openView = null
        ctxRef = null
      })
    }

    module.exports = { inject, apply }
    return module.exports
  }
})
