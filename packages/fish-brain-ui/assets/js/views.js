/* ============================================================
 * 鱼的脑 · 中文事件卡片（8E-F）
 *
 * 节点详情的信息顺序：脑区颜色与名称 → 中文标题 → 类型 / 时间 / 状态
 * → 中文摘要（视觉主体）→ 相关节点卡片 → 「来源与技术信息」折叠区（默认收起）。
 * 脑区枢纽改成事件卡片列表：标题、摘要预览（最多两行）、时间、类型、状态，
 * 保持投影原顺序，不在前端猜测重要性。
 *
 * 只读取投影已有字段：不改写摘要、不拼接伪摘要、不调用模型、不提供任何写入入口。
 * 技术信息只显示脱敏来源引用、截断哈希、隐私等级与 stale 说明，
 * 不显示完整哈希、绝对路径、记忆正文、Prompt、凭据或会话原文。
 * ============================================================ */
(function (root) {
  'use strict';
  var FB = root.FB = root.FB || {};

  /* 投影里的状态是稳定标识符；卡片上换成中文短标签，未知值原样显示，不猜测含义 */
  var STATUS_LABELS = {
    'active': '已激活',
    'recorded': '已记录',
    'simulated': '模拟执行',
    'complete': '已完成',
    'set': '已设定',
    'frozen': '已冻结',
    'confirmed-stable-identity': '稳定身份',
    'confirmed-minimum-core': '最小核心已确认',
    'confirmed-cross-platform-core': '跨平台核心已确认',
    'read-only': '只读',
    'safe-default': '安全默认值',
    'non-region': '非脑区'
  };
  var PRIVACY_LABELS = {
    'public-safe': '公开安全',
    'redacted': '已脱敏'
  };

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    });
    append(el, kids);
    return el;
  }

  function append(el, kids) {
    if (kids === null || kids === undefined || kids === false) return;
    if (Array.isArray(kids)) { kids.forEach(function (c) { append(el, c); }); return; }
    el.appendChild(typeof kids === 'string' || typeof kids === 'number'
      ? document.createTextNode(String(kids)) : kids);
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function fmtTime(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function statusText(s) {
    if (!s) return '状态不可用';
    return STATUS_LABELS[s] || String(s);
  }
  function privacyText(p) {
    if (!p) return '未标注';
    return PRIVACY_LABELS[p] || String(p);
  }
  /* 来源哈希只显示前 12 位 */
  function shortHash(sha) {
    if (!sha) return '不可用';
    var s = String(sha);
    return s.length > 12 ? s.slice(0, 12) + '…' : s;
  }
  /* 来源引用若带盘符或绝对路径，只保留末两段，避免暴露本机目录结构 */
  function safeRef(ref) {
    if (!ref) return '不可用';
    var s = String(ref);
    if (/^[A-Za-z]:[\\/]/.test(s) || s.charAt(0) === '/' || s.indexOf('file://') === 0) {
      var parts = s.replace(/\\/g, '/').split('/').filter(Boolean);
      return '…/' + parts.slice(-2).join('/');
    }
    return s;
  }

  function kv(host, key, value, mono) {
    host.appendChild(h('div', { class: 'p-kv' }, [
      h('span', { class: 'k', text: key }),
      h('span', { class: 'v' + (mono ? ' mono' : ''), text: value, title: value })
    ]));
  }

  function panelHead(host, color, regionLabel, title, onClose) {
    host.appendChild(h('div', { class: 'p-head' }, [
      h('div', { class: 'ttl' }, [
        h('div', { class: 'region', style: 'color:' + color }, [
          h('i', {}), h('span', { text: regionLabel })
        ]),
        h('h3', { text: title })
      ]),
      h('button', {
        class: 'p-close', type: 'button', 'aria-label': '关闭详情', text: '×',
        onclick: onClose
      })
    ]));
  }

  /* 类型 / 时间 / 状态：三个紧凑标签，不做成彩色徽章墙 */
  function metaTags(n) {
    return h('div', { class: 'p-tags' }, [
      h('span', { class: 'p-tag is-kind', text: n.kind || '类型不可用' }),
      h('span', { class: 'p-tag' + (n.at ? '' : ' is-muted'), text: fmtTime(n.at) || '时间不可用' }),
      h('span', { class: 'p-tag is-status', text: statusText(n.status) })
    ]);
  }

  /* 中文摘要主体；没有摘要时只给一句降级文案，不拼接标题充当摘要 */
  function summaryBlock(n) {
    return n.summaryZh
      ? h('p', { class: 'p-summary', text: n.summaryZh })
      : h('p', { class: 'p-summary is-missing', text: '该事件暂无可展示摘要' });
  }

  /* 「来源与技术信息」折叠区：默认收起，点击展开 */
  function techBlock(rows) {
    var wrap = h('div', { class: 'p-tech' });
    var body = h('div', { class: 'p-tech-body' });
    rows.forEach(function (row) { kv(body, row[0], row[1], row[2]); });
    var open = false;
    var btn = h('button', {
      class: 'p-tech-toggle', type: 'button', 'aria-expanded': 'false',
      onclick: function () {
        open = !open;
        wrap.className = 'p-tech' + (open ? ' is-open' : '');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        chev.textContent = open ? '▾' : '▸';
      }
    }, [
      h('span', { text: '来源与技术信息' })
    ]);
    var chev = h('i', { class: 'p-tech-chev', text: '▸' });
    btn.appendChild(chev);
    wrap.appendChild(btn);
    wrap.appendChild(body);
    return wrap;
  }

  /* 相关节点：有权威关系时用可点击卡片，没有就整段不出现 */
  function relatedCards(n, ctx) {
    if (!n.relationRefs || !n.relationRefs.length) return null;
    var sec = h('div', { class: 'p-sec p-related' }, [h('h5', { text: '相关节点' })]);
    n.relationRefs.forEach(function (id) {
      var t = ctx.nodeById(id);
      var rr = t ? ctx.regionOf(t.region) : null;
      sec.appendChild(h('button', {
        class: 'p-rel-card', type: 'button', 'data-rel-id': id,
        onclick: function () { ctx.onSelect(id, true); }
      }, [
        h('span', { class: 'p-rel-title', text: t ? t.titleZh : '相关节点不可用' }),
        h('span', {
          class: 'p-rel-meta',
          text: t ? ((rr ? rr.label : t.region) + ' · ' + (fmtTime(t.at) || '时间不可用')) : id
        })
      ]));
    });
    return sec;
  }

  /** 渲染节点详情；ctx = { regions, regionOf, nodeById, onSelect, onClose } */
  function renderNodePanel(host, n, ctx) {
    var r = ctx.regionOf(n.region) || { label: n.region, color: '#7A848F' };
    clear(host);
    panelHead(host, r.color, r.label, n.titleZh, ctx.onClose);

    var body = h('div', { class: 'p-body scroll' });
    body.appendChild(metaTags(n));

    if (n.stale) {
      body.appendChild(h('p', { class: 'p-stale', text: '来源已经变化，摘要可能尚未刷新。' }));
    }

    body.appendChild(summaryBlock(n));

    var rel = relatedCards(n, ctx);
    if (rel) body.appendChild(rel);

    body.appendChild(techBlock([
      ['来源引用', safeRef(n.sourceRef), true],
      ['来源哈希', shortHash(n.sourceSha256), true],
      ['隐私等级', privacyText(n.privacyClass), false],
      ['数据状态', n.stale ? '来源已变化，等待刷新' : '与权威文件一致', false],
      ['展示范围', '仅脱敏摘要与来源标识，不含记忆正文、Prompt、凭据或会话原文', false]
    ]));

    host.appendChild(body);
  }

  /* 枢纽里的一张事件卡片 */
  function hubCard(n, ctx) {
    return h('button', {
      class: 'p-card', type: 'button', 'data-node-id': n.id,
      onclick: function () { ctx.onSelect(n.id, true); }
    }, [
      h('span', { class: 'p-card-title', text: n.titleZh }),
      h('span', {
        class: 'p-card-sum' + (n.summaryZh ? '' : ' is-missing'),
        text: n.summaryZh || '暂无可展示摘要'
      }),
      h('span', { class: 'p-card-foot' }, [
        h('span', { class: 'p-card-time', text: fmtTime(n.at) || '时间不可用' }),
        h('span', { class: 'p-card-sep', text: '·' }),
        h('span', { class: 'p-card-kind', text: n.kind || '类型不可用' }),
        h('span', { class: 'p-card-sep', text: '·' }),
        h('span', { class: 'p-card-status', text: statusText(n.status) })
      ])
    ]);
  }

  /** 渲染脑区枢纽详情：事件卡片列表，保持投影顺序 */
  function renderHubPanel(host, regionId, ctx) {
    var r = ctx.regionOf(regionId);
    if (!r) return;
    var nodes = r.nodes || [];
    clear(host);
    panelHead(host, r.color, '脑区', r.label + ' · ' + nodes.length + ' 个事件', ctx.onClose);

    var body = h('div', { class: 'p-body scroll' });
    body.appendChild(h('div', { class: 'p-tags' }, [
      h('span', { class: 'p-tag is-status', text: statusText(r.status) }),
      h('span', { class: 'p-tag', text: '按投影顺序' })
    ]));

    if (nodes.length) {
      var list = h('div', { class: 'p-cards' });
      nodes.forEach(function (n) { list.appendChild(hubCard(n, ctx)); });
      body.appendChild(list);
    } else {
      body.appendChild(h('p', { class: 'p-summary is-missing', text: '该脑区当前没有可展示的事件' }));
    }

    body.appendChild(techBlock([
      ['权威文件', safeRef(r.authority), true],
      ['文件哈希', shortHash(r.sha), true],
      ['脑区状态', statusText(r.status), false],
      ['展示范围', '按权威投影原顺序列出，不在前端猜测重要性', false]
    ]));

    host.appendChild(body);
  }

  /** 筛选浮层；items = [{ id, label, count, color }] */
  function renderPop(host, title, items, current, onPick, note) {
    clear(host);
    host.appendChild(h('h6', { text: title }));
    items.forEach(function (it) {
      host.appendChild(h('button', {
        class: 'pop-i' + (it.id === current ? ' is-on' : ''),
        type: 'button',
        onclick: function () { onPick(it.id); }
      }, [
        it.color ? h('i', { style: 'color:' + it.color }) : null,
        h('span', { text: it.label }),
        h('em', { text: it.count === null || it.count === undefined ? '' : String(it.count) })
      ]));
    });
    if (note) host.appendChild(h('div', { class: 'pop-note', text: note }));
  }

  function showEmpty(host, title, desc) {
    clear(host);
    host.appendChild(h('h3', { text: title }));
    host.appendChild(h('p', { text: desc }));
  }

  FB.views = {
    h: h, clear: clear, fmtTime: fmtTime,
    statusText: statusText, privacyText: privacyText, safeRef: safeRef, shortHash: shortHash,
    renderNodePanel: renderNodePanel, renderHubPanel: renderHubPanel,
    renderPop: renderPop, showEmpty: showEmpty
  };
})(window);
