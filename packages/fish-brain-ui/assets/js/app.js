/* ============================================================
 * 鱼的脑 · 工作区应用层（正式插件 / 8D）
 *
 * 数据：GET /api/fish-brain/events-projection（正式只读投影，动态权威文件）
 * 更新：GET /api/fish-brain/events（SSE，命名事件 event-graph.snapshot /
 *       node.added / node.updated；按 id 幂等合并）
 * 生命周期：SSE 重连后重新请求完整快照对账；页面离开/隐藏时停止动画与 SSE。
 * 本文件只发起读取请求，不发起任何写请求，也不打开新窗口。
 * ============================================================ */
(function (root) {
  'use strict';
  var FB = root.FB;
  var V = FB.views;
  var h = V.h;

  var ENDPOINT = '/api/fish-brain/events-projection';
  var STREAM = '/api/fish-brain/events';
  var STORE_KEY = 'fish-brain-workspace-state-v1';

  var TIME_RANGES = {
    all: { label: '全部时间', ms: 0 },
    h1: { label: '近 1 小时', ms: 3600e3 },
    d1: { label: '近 24 小时', ms: 86400e3 },
    d7: { label: '近 7 天', ms: 7 * 86400e3 }
  };

  var S = {
    projection: null,
    region: 'all',
    time: 'all',
    query: '',
    sel: null,
    paused: false,
    visible: true,
    destroyed: false,
    streamState: 'connecting',
    nodeCount: 0
  };

  var el = {};
  var graph = null;
  var stream = null;
  var pop = null;
  var retryTimer = null;
  var reconcileInFlight = false;

  function prefersReducedMotion() {
    try {
      return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  /* ---------- 状态持久化：再次进入保持视角与筛选 ---------- */
  function loadState() {
    try {
      var raw = root.sessionStorage.getItem(STORE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        if (saved.region) S.region = saved.region;
        if (saved.time) S.time = saved.time;
        if (typeof saved.query === 'string') S.query = saved.query;
        if (typeof saved.paused === 'boolean') { S.paused = saved.paused; S.pausedStored = true; }
        S.savedView = saved.view || null;
        S.savedSel = saved.sel || null;
      }
    } catch (e) {}
  }

  function saveState() {
    if (S.destroyed) return;
    try {
      root.sessionStorage.setItem(STORE_KEY, JSON.stringify({
        region: S.region, time: S.time, query: S.query,
        paused: S.paused, sel: S.sel,
        view: graph ? { s: graph.view.s, x: graph.view.x, y: graph.view.y } : null
      }));
    } catch (e) {}
  }

  /* ---------- 投影工具 ---------- */
  function allNodes() {
    if (!S.projection) return [];
    return S.projection.regions.reduce(function (out, r) { return out.concat(r.nodes || []); }, []);
  }
  function regionOf(id) {
    if (!S.projection) return null;
    return S.projection.regions.filter(function (r) { return r.id === id; })[0] || null;
  }
  function nodeById(id) {
    var list = allNodes();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* 搜索匹配 titleZh / summaryZh / kind 三项（8D-1 第四节） */
  function matchesQuery(node, q) {
    if (!q) return true;
    return String(node.titleZh || '').toLowerCase().indexOf(q) >= 0 ||
      String(node.summaryZh || '').toLowerCase().indexOf(q) >= 0 ||
      String(node.kind || '').toLowerCase().indexOf(q) >= 0;
  }

  /* 过滤契约：返回结构化对象，供 EventGraph.setFilter 严格隔离使用
     { regions:{id:true}, ids:{nodeId:true}, isolate:true }
     无任何条件时返回 null（表示不过滤）。 */
  function buildFilterFrom(nodes, region, time, query) {
    var q = String(query || '').trim().toLowerCase();
    var maxAge = TIME_RANGES[time] ? TIME_RANGES[time].ms : 0;
    var active = region !== 'all' || !!maxAge || !!q;
    if (!active) return null;
    var now = Date.now();
    var ids = {}, regions = {}, shown = 0;
    (nodes || []).forEach(function (n) {
      if (region !== 'all' && n.region !== region) return;
      if (!matchesQuery(n, q)) return;
      if (maxAge && (!n.at || now - Date.parse(n.at) > maxAge)) return;
      ids[n.id] = true;
      regions[n.region] = true;
      shown += 1;
    });
    return {
      regions: regions, ids: ids, isolate: true,
      shown: shown, total: (nodes || []).length, query: q, region: region, time: time
    };
  }

  function buildFilter() {
    return buildFilterFrom(allNodes(), S.region, S.time, S.query);
  }

  /* 按 id 幂等合并：重复事件不创建副本；新节点只追加到所属脑区末尾 */
  function mergeNode(incoming) {
    if (!S.projection || !incoming || !incoming.id) return false;
    var r = regionOf(incoming.region);
    if (!r) return false;
    var list = r.nodes || (r.nodes = []);
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === incoming.id) { idx = i; break; }
    if (idx >= 0) {
      if (JSON.stringify(list[idx]) === JSON.stringify(incoming)) return false;
      list[idx] = incoming;
    } else {
      list.push(incoming);
    }
    r.nodeCount = list.length;
    S.projection.counts.nodes = allNodes().length;
    return true;
  }

  /* 可见节点 id 集：与传给 Canvas 的过滤对象同源，避免计数与绘制不一致 */
  function visibleSet(filter) {
    var f = filter || buildFilter();
    if (!f) {
      var all = {};
      allNodes().forEach(function (n) { all[n.id] = true; });
      return all;
    }
    return f.ids;
  }

  /* ---------- 状态条：加载 / 失败 / 旧数据 ---------- */
  function setStatus(kind, text) {
    if (!el.status) return;
    V.clear(el.status);
    if (!text) { el.status.hidden = true; return; }
    el.status.hidden = false;
    el.status.className = 'ws-status' + (kind ? ' is-' + kind : '');
    el.status.appendChild(h('span', { text: text }));
  }

  /* ---------- 渲染 ---------- */
  /* opts.refit === false：动态更新（SSE / node.updated）时保持用户当前视角 */
  function applyFilter(opts) {
    if (!graph) return;
    var f = buildFilter();
    var refit = !opts || opts.refit !== false;
    graph.setFilter(f, { refit: refit });   /* 结构化契约，Canvas 严格隔离 */
    renderCount(f);
    renderNavState();
    syncSrList(f);
    /* 详情节点被过滤掉时关闭详情面板，避免读到已不可见的内容 */
    if (S.sel && !graph.isVisible(S.sel)) {
      S.sel = null;
      graph.select(null);
      renderPanel();
    }
    renderEmptyState(f);
  }

  /* 空状态：投影为空 / 读取失败 / 当前条件无交集，三种原因分别说明 */
  function renderEmptyState(f) {
    var total = allNodes().length;
    if (!total) return;
    var shown = f ? f.shown : total;
    if (shown === 0) {
      showEmpty('没有匹配的内容节点',
        '当前搜索、脑区与时间条件没有交集。清空搜索或切换回「全部」可恢复完整星图。');
    } else {
      hideEmpty();
    }
  }

  function renderCount(f) {
    if (!el.count) return;
    var filter = f || buildFilter();
    var shown = filter ? filter.shown : allNodes().length;
    var total = allNodes().length;
    el.count.textContent = shown + ' / ' + total + ' 节点';
  }

  function renderNavState() {
    Array.prototype.forEach.call(el.nav.querySelectorAll('.ws-tab'), function (t) {
      var on = t.dataset.region === S.region;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function syncSrList(f) {
    if (!el.sr) return;
    var set = visibleSet(f);
    V.clear(el.sr);
    allNodes().forEach(function (n) {
      if (!set[n.id]) return;
      el.sr.appendChild(h('button', {
        type: 'button', text: n.titleZh,
        onclick: function () { selectNode(n.id, true); }
      }));
    });
  }

  function showEmpty(title, desc) {
    el.empty.hidden = false;
    V.showEmpty(el.empty, title, desc);
  }
  function hideEmpty() { el.empty.hidden = true; }

  function renderPanel() {
    if (!S.sel) {
      el.main.dataset.panel = 'off';
      V.clear(el.panel);
      return;
    }
    el.main.dataset.panel = 'on';
    var ctx = {
      regions: S.projection ? S.projection.regions : [],
      regionOf: regionOf, nodeById: nodeById,
      onSelect: selectNode, onClose: clearSel
    };
    if (S.sel.indexOf('hub:') === 0) V.renderHubPanel(el.panel, S.sel.slice(4), ctx);
    else {
      var n = nodeById(S.sel);
      if (!n) { el.main.dataset.panel = 'off'; V.clear(el.panel); return; }
      V.renderNodePanel(el.panel, n, ctx);
    }
  }

  function selectNode(id, focus) {
    if (id && id.indexOf('hub:') !== 0 && !nodeById(id)) return;
    S.sel = id;
    if (graph) {
      graph.select(id);
      if (focus) graph.focusOn(id);
    }
    renderPanel();
    closePop();
    saveState();
  }

  function clearSel() {
    S.sel = null;
    if (graph) graph.select(null);
    renderPanel();
    saveState();
  }

  /* ---------- 筛选浮层 ---------- */
  function closePop() {
    if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
    pop = null;
    if (el.regionBtn) el.regionBtn.setAttribute('aria-expanded', 'false');
    if (el.timeBtn) el.timeBtn.setAttribute('aria-expanded', 'false');
  }

  function openPop(kind, anchor) {
    closePop();
    var items, current, onPick, title, note;
    if (kind === 'region') {
      title = '脑区筛选';
      current = S.region;
      items = [{ id: 'all', label: '全部脑区', count: allNodes().length }];
      (S.projection ? S.projection.regions : []).forEach(function (r) {
        items.push({ id: r.id, label: r.label, count: (r.nodes || []).length, color: r.color });
      });
      onPick = function (id) { S.region = id; applyFilter(); closePop(); renderPopLabels(); saveState(); };
      note = '筛选只影响显示，不修改任何权威数据。';
    } else {
      title = '时间筛选';
      current = S.time;
      items = Object.keys(TIME_RANGES).map(function (k) {
        return { id: k, label: TIME_RANGES[k].label };
      });
      onPick = function (id) { S.time = id; applyFilter(); closePop(); renderPopLabels(); saveState(); };
      note = '没有可靠时间的节点在限定时间范围内不可见，详情里显示「时间不可用」。';
    }
    pop = h('div', { class: 'ws-pop', role: 'dialog', 'aria-label': title });
    V.renderPop(pop, title, items, current, onPick, note);
    el.stage.appendChild(pop);
    var box = anchor.getBoundingClientRect();
    var stageBox = el.stage.getBoundingClientRect();
    pop.style.right = Math.max(8, stageBox.right - box.right) + 'px';
    pop.style.top = (box.bottom - stageBox.top + 6) + 'px';
    anchor.setAttribute('aria-expanded', 'true');
  }

  function renderPopLabels() {
    if (el.regionBtn) {
      var r = S.region === 'all' ? null : regionOf(S.region);
      el.regionBtn.textContent = r ? r.label : '全部脑区';
    }
    if (el.timeBtn) el.timeBtn.textContent = TIME_RANGES[S.time] ? TIME_RANGES[S.time].label : '全部时间';
  }

  /* ---------- 数据加载与 SSE ---------- */
  function applyProjection(next, reason) {
    S.projection = next;
    S.nodeCount = next.counts ? next.counts.nodes : allNodes().length;
    if (!graph) {
      graph = new FB.EventGraph(el.canvas, {
        /* 枢纽对象的 id 是脑区名，详情选择键是 'hub:' + 脑区；
           这里统一转换，否则点枢纽会被当成"未知节点"直接忽略。 */
        onSelect: function (node) {
          if (!node) { selectNode(null, false); return; }
          selectNode(node.kind === 'hub' ? 'hub:' + node.id : node.id, false);
        }
      });
      if (S.paused) graph.setPaused(true);
    }
    graph.setData(next);
    /* 恢复上次的视角（仅在首次进入时） */
    if (S.savedView && !S.viewRestored) {
      S.viewRestored = true;
      graph.view.s = S.savedView.s;
      graph.view.x = S.savedView.x;
      graph.view.y = S.savedView.y;
    }
    graph.resize();
    if (el.bind && next.binding) {
      el.bind.textContent = next.binding.profile + ' · ' + next.binding.port;
    }
    if (S.nodeCount === 0) {
      showEmpty('没有可展示的正式事件', '权威投影当前没有返回节点。本页不会用演示数据填充。');
    } else {
      hideEmpty();
    }
    applyFilter();
    if (S.savedSel && !S.selRestored) {
      S.selRestored = true;
      if (nodeById(S.savedSel) || S.savedSel.indexOf('hub:') === 0) selectNode(S.savedSel, false);
    }
    if (reason === 'reconcile') setStatus(null, '');
  }

  function reconcile(reason) {
    if (S.destroyed || reconcileInFlight) return;
    reconcileInFlight = true;
    fetch(ENDPOINT, { method: 'GET', credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (S.destroyed) return;
        if (!data || data.schema !== 'fish-brain-events-projection-v1') {
          throw new Error('投影 schema 不匹配');
        }
        applyProjection(data, reason);
        setStatus(null, '');
      })
      .catch(function (err) {
        if (S.destroyed) return;
        if (!S.projection) {
          setStatus('error', '投影读取失败：' + err.message + '。未使用任何演示数据填充。');
          showEmpty('投影读取失败', '无法读取正式只读投影。本页不会生成节点，也不会用演示数据填充。');
        } else {
          setStatus('stale', '投影刷新失败，当前显示上一次成功快照（' + err.message + '）');
        }
      })
      .then(function () { reconcileInFlight = false; });
  }

  function connectStream() {
    if (S.destroyed || !root.EventSource) return;
    closeStream();
    try {
      stream = new EventSource(STREAM, { withCredentials: true });
    } catch (e) {
      scheduleReconnect();
      return;
    }
    stream.onopen = function () {
      if (S.destroyed) return;
      S.streamState = 'open';
      /* SSE 重连后重新对账完整快照，避免遗漏断线期间的变化 */
      reconcile('reconcile');
    };
    stream.addEventListener('event-graph.snapshot', function (e) {
      if (S.destroyed) return;
      try {
        var data = JSON.parse(e.data);
        if (data && data.schema === 'fish-brain-events-projection-v1') applyProjection(data, 'snapshot');
      } catch (err) {}
    });
    stream.addEventListener('node.added', onNodeEvent);
    stream.addEventListener('node.updated', onNodeEvent);
    stream.addEventListener('projection-error', function (e) {
      if (S.destroyed) return;
      setStatus('stale', '投影更新失败，当前显示上一次成功快照');
    });
    stream.onerror = function () {
      if (S.destroyed) return;
      S.streamState = 'reconnecting';
      /* EventSource 自带重连；这里只标记，不做无意义轮询 */
    };
  }

  /* SSE 的 node.added / node.updated 与验收探针走同一条路径：
     原位更新投影与卡片，不关闭详情、不重置筛选、不改变用户视角。 */
  function applyNodePayload(payload) {
    if (S.destroyed || !payload || !payload.node) return false;
    if (!mergeNode(payload.node)) return false;
    S.nodeCount = allNodes().length;
    if (graph) graph.setData(S.projection, { keepView: true });
    applyFilter({ refit: false });
    /* 当前详情是这条节点，或当前打开的是它所属脑区的枢纽 → 原位重绘 */
    if (S.sel && (S.sel === payload.node.id || S.sel === 'hub:' + payload.node.region)) renderPanel();
    return true;
  }

  function onNodeEvent(e) {
    if (S.destroyed) return;
    try {
      applyNodePayload(JSON.parse(e.data));
    } catch (err) {}
  }

  function closeStream() {
    if (stream) {
      try { stream.close(); } catch (e) {}
      stream = null;
    }
  }

  function scheduleReconnect() {
    if (S.destroyed || retryTimer) return;
    retryTimer = root.setTimeout(function () {
      retryTimer = null;
      if (!S.destroyed && S.visible) connectStream();
    }, 3000);
  }

  /* ---------- 生命周期：离开视图后停止动画 / SSE / 计时器 ---------- */
  function suspend() {
    S.visible = false;
    if (graph) graph.setPaused(true);
    closeStream();
    if (retryTimer) { root.clearTimeout(retryTimer); retryTimer = null; }
  }

  function resume() {
    if (S.destroyed || S.visible) return;
    S.visible = true;
    if (graph) graph.setPaused(S.paused);
    reconcile('resume');
    connectStream();
  }

  function destroy() {
    if (S.destroyed) return;
    S.destroyed = true;
    saveState();
    closeStream();
    closePop();
    if (retryTimer) { root.clearTimeout(retryTimer); retryTimer = null; }
    if (graph) { graph.destroy(); graph = null; }
    root.removeEventListener('pagehide', destroy);
    root.removeEventListener('message', onHostMessage);
    root.document.removeEventListener('visibilitychange', onVisibility);
    root.removeEventListener('resize', onResize);
  }

  function onVisibility() {
    if (root.document.hidden) suspend(); else resume();
  }

  function onHostMessage(event) {
    if (!event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'fish-brain:suspend') suspend();
    else if (event.data.type === 'fish-brain:resume') resume();
    else if (event.data.type === 'fish-brain:destroy') destroy();
  }

  var resizeTimer = null;
  function onResize() {
    if (resizeTimer) root.clearTimeout(resizeTimer);
    resizeTimer = root.setTimeout(function () {
      resizeTimer = null;
      if (graph && !S.destroyed) graph.resize();
    }, 80);
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    el.regionBtn.addEventListener('click', function () { openPop('region', el.regionBtn); });
    el.timeBtn.addEventListener('click', function () { openPop('time', el.timeBtn); });
    el.search.addEventListener('input', function () {
      S.query = el.search.value;
      applyFilter();
      saveState();
    });
    el.nav.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('.ws-tab') : null;
      if (!t) return;
      S.region = t.dataset.region;
      applyFilter();
      closePop();
      saveState();
    });
    el.reset.addEventListener('click', function () {
      if (graph) graph.reset();
      saveState();
    });
    el.pause.addEventListener('click', function () {
      S.paused = !S.paused;
      if (graph) graph.setPaused(S.paused);
      el.pause.textContent = S.paused ? '继续动画' : '暂停动画';
      el.pause.classList.toggle('is-on', S.paused);
      saveState();
    });
    /* 返回对话：通过 postMessage 交给宿主 conversation.view 的 openView('chat') */
    el.back.addEventListener('click', function () {
      if (root.parent && root.parent !== root) {
        root.parent.postMessage({ type: 'fish-brain:navigate', view: 'chat' }, '*');
      }
    });
    root.document.addEventListener('click', function (e) {
      if (!pop) return;
      if (pop.contains(e.target) || el.regionBtn.contains(e.target) || el.timeBtn.contains(e.target)) return;
      closePop();
    });
    root.document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (pop) { closePop(); return; }
        if (S.sel) clearSel();
      }
    });
    root.addEventListener('pagehide', destroy);
    root.addEventListener('message', onHostMessage);
    root.document.addEventListener('visibilitychange', onVisibility);
    root.addEventListener('resize', onResize);
  }

  function boot() {
    el = {
      canvas: document.getElementById('wsCanvas'),
      stage: document.getElementById('wsStage'),
      main: document.getElementById('wsMain'),
      panel: document.getElementById('wsPanel'),
      empty: document.getElementById('wsEmpty'),
      status: document.getElementById('wsStatus'),
      nav: document.getElementById('wsNav'),
      count: document.getElementById('wsCount'),
      bind: document.getElementById('wsBind'),
      search: document.getElementById('wsSearch'),
      regionBtn: document.getElementById('wsRegionBtn'),
      timeBtn: document.getElementById('wsTimeBtn'),
      reset: document.getElementById('wsReset'),
      pause: document.getElementById('wsPause'),
      back: document.getElementById('wsBack')
    };
    el.sr = h('div', { class: 'sr-only', 'aria-label': '节点列表（键盘可达）' });
    document.body.appendChild(el.sr);

    loadState();
    /* 系统减少动效时默认静止；用户点「继续动画」仍必须能播放（8D-1 第七节） */
    if (!S.pausedStored && prefersReducedMotion()) S.paused = true;
    el.search.value = S.query;
    if (S.paused) {
      el.pause.textContent = '继续动画';
      el.pause.classList.add('is-on');
    }
    renderPopLabels();
    renderNavState();
    bind();

    setStatus(null, '正在读取正式只读投影…');
    reconcile('initial');
    connectStream();

    /* 便于自动化验收：只读状态与计数器，不暴露写入能力 */
    root.__fishBrain = {
      get state() { return S; },
      get nodeCount() { return allNodes().length; },
      get regions() { return S.projection ? S.projection.regions : []; },
      get graph() { return graph; },
      get filter() { return buildFilter(); },
      select: selectNode,
      reset: function () { if (graph) graph.reset(); },
      /* 验收探针：把一条 node.added / node.updated 交给与 SSE 相同的处理路径。
         只合并进内存投影，不写任何权威文件。 */
      ingestNodeEvent: function (payload) { return applyNodePayload(payload); },
      counts: { reconcile: 0 }
    };
  }

  /* 纯过滤函数（不依赖 DOM）：供单元测试直接验证搜索与隔离语义 */
  FB.filterModel = { matches: matchesQuery, build: buildFilterFrom };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})(window);
