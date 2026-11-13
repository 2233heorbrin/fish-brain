/* 鱼的脑 · 全脑事件星图 Canvas 渲染器（正式插件 / 8D-1）
 *
 * 过滤语义（8D-1 第六节）：
 *   filter = { regions:{id:true}, ids:{nodeId:true}, isolate:true } | null
 *   isolate 为真时，不匹配的枢纽 / 节点 / 标签 / 辐射线 / 跨区流线
 *   一律不绘制、不占标签空间、不参与命中检测与 bounds 计算，
 *   而不是降低透明度后继续显示。
 *
 * 动画（8D-1 第七节）：只改视觉，不动节点坐标。
 *   1) 枢纽缓慢呼吸（半径 + 光环 + 扩散脉冲环）；
 *   2) 权威跨区流线上有移动的信号粒子，周期 4–8 秒，颜色取目标脑区。
 *   paused 时所有动画量停止推进，画面逐像素稳定。
 */
(function (root) {
  'use strict';

  var FB = root.FB = root.FB || {};

  var HUBS = {
    personality: { x: 214, y: 170 },
    memory:      { x: 186, y: 414 },
    mood:        { x: 392, y: 574 },
    thinking:    { x: 640, y: 330 },
    execution:   { x: 856, y: 242 },
    evidence:    { x: 872, y: 468 }
  };
  var HUB_R = 13;
  var RINGS = [
    { r: 86, cap: 6 },
    { r: 152, cap: 10 },
    { r: 208, cap: 14 }
  ];
  var PAD_X = 132, PAD_Y = 46;
  var FLOWS = [
    ['personality', 'thinking'],
    ['memory', 'thinking'],
    ['mood', 'thinking'],
    ['thinking', 'execution'],
    ['execution', 'thinking'],
    ['execution', 'evidence']
  ];
  /* 每条流线的粒子周期（秒）与相位：慢、稳、不闪 */
  var FLOW_PERIOD = [6.4, 5.6, 7.2, 4.8, 6.8, 7.6];
  var FLOW_PHASE = [0, 0.45, 0.2, 0.62, 0.15, 0.5];
  var BREATH_PERIOD = 6.2;

  function truncate(text, maxUnits) {
    var t = String(text || '');
    var used = 0, out = '';
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i);
      var w = /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
      if (used + w > maxUnits - 2) { out += '…'; return out; }
      used += w;
      out += ch;
    }
    return out;
  }

  /* 二次贝塞尔：与 _drawFlows 共用同一条曲线，粒子才落在线上 */
  function flowControl(a, b) {
    var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    var dx = b.x - a.x, dy = b.y - a.y;
    return { x: mx - dy * 0.08, y: my + dx * 0.08 };
  }
  function quadPoint(a, c, b, u) {
    var iu = 1 - u;
    return {
      x: iu * iu * a.x + 2 * iu * u * c.x + u * u * b.x,
      y: iu * iu * a.y + 2 * iu * u * c.y + u * u * b.y
    };
  }

  function EventGraph(el, opts) {
    this.el = el;
    this.ctx = el.getContext('2d');
    this.opts = opts || {};
    this.nodes = [];
    this.hubs = [];
    this.view = { s: 1, x: 0, y: 0 };
    this.sel = null;
    this.hover = null;
    this.paused = false;
    this.t = 0;          /* 动画时间（秒）；paused 时不推进 */
    this.clock = 0;      /* 保留旧字段，供已有调试口读取 */
    this.raf = 0;
    this.filter = null;
    this._filterWasActive = false;
    this._boxes = [];
    this.dpr = Math.min(2, root.devicePixelRatio || 1);
    this._bind();
    this._loop = this._loop.bind(this);
    this.raf = requestAnimationFrame(this._loop);

    var self = this;
    if (root.ResizeObserver) {
      this._ro = new ResizeObserver(function () { self.resize(); });
      this._ro.observe(el.parentNode || el);
    }
    this._onWin = function () { self.resize(); };
    root.addEventListener('resize', this._onWin);
    setTimeout(function () { self.resize(); }, 40);
    setTimeout(function () { self.resize(); }, 200);
  }

  /* ---------- 数据 → 稳定槽位 ----------
     opts.keepView：动态更新（node.added / node.updated）时保持用户当前视角 */
  EventGraph.prototype.setData = function (projection, opts) {
    var nodes = [];
    var hubs = [];

    projection.regions.forEach(function (r) {
      var pos = HUBS[r.id] || { x: 500, y: 350 };

      /* 排序键：有时间按时间升序，没时间按 id；保证同一份数据每次槽位一致 */
      var list = (r.nodes || []).slice().sort(function (a, b) {
        var ta = a.at ? Date.parse(a.at) : Infinity;
        var tb = b.at ? Date.parse(b.at) : Infinity;
        if (ta !== tb) return ta - tb;
        return String(a.id).localeCompare(String(b.id));
      });

      hubs.push({
        id: r.id, kind: 'hub', region: r.id, label: r.label,
        color: r.color, x: pos.x, y: pos.y, r: HUB_R,
        count: list.length, status: r.status, authority: r.authority,
        sha: r.sha, nonRegion: r.id === 'evidence'
      });

      var phase = r.id.charCodeAt(0) * 0.37;   /* 每个脑区不同的起始角，避免整齐划一 */
      var idx = 0;
      RINGS.forEach(function (ring, ri) {
        var take = Math.min(ring.cap, list.length - idx);
        for (var k = 0; k < take; k++, idx++) {
          var n = list[idx];
          var a = phase + (Math.PI * 2 * k) / Math.max(1, take) + ri * 0.22;
          nodes.push({
            id: n.id, kind: 'node', region: r.id, color: r.color,
            x: pos.x + Math.cos(a) * ring.r,
            y: pos.y + Math.sin(a) * ring.r * 0.92,
            r: idx < 2 ? 6 : 4.2,
            angle: a,
            ring: ri,
            rank: idx < 2 ? 0 : 1,
            data: n
          });
        }
      });
    });

    this.nodes = nodes;
    this.hubs = hubs;
    this.byId = {};
    hubs.forEach(function (h) { this.byId['hub:' + h.id] = h; }, this);
    nodes.forEach(function (n) { this.byId[n.id] = n; }, this);

    if (!opts || !opts.keepView) this.fit();
    if (this.opts.onLayout) this.opts.onLayout(projection);
  };

  /* ---------- 尺寸 / 视角 ---------- */
  EventGraph.prototype.resize = function () {
    var box = (this.el.parentNode || this.el).getBoundingClientRect();
    var w = Math.max(1, Math.round(box.width));
    var h = Math.max(1, Math.round(box.height));
    if (this.w === w && this.h === h) return;
    this.w = w; this.h = h;
    this.el.width = Math.round(w * this.dpr);
    this.el.height = Math.round(h * this.dpr);
    this.el.style.width = w + 'px';
    this.el.style.height = h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.fit();
  };

  /* ---------- 过滤：唯一真源 ---------- */
  EventGraph.prototype.setFilter = function (f, opts) {
    this.filter = f || null;
    var active = !!this.filter;
    var refit = !opts || opts.refit !== false;
    /* 进入筛选或从筛选中恢复都要重新取景；无筛选且此前也无筛选时保持用户视角。
       opts.refit === false 用于动态更新：条件没变，不能挪动用户视角。 */
    if (refit && (active || this._filterWasActive)) this.fit();
    this._filterWasActive = active;
  };

  /* 枢纽只按脑区判定；节点按脑区 + id 双条件判定 */
  EventGraph.prototype._on = function (n) {
    var f = this.filter;
    if (!f) return true;
    if (f.regions && !f.regions[n.region]) return false;
    if (n.kind === 'hub') return true;
    if (f.ids && !f.ids[n.id]) return false;
    return true;
  };

  EventGraph.prototype.visibleHubs = function () {
    var self = this;
    return this.hubs.filter(function (h) { return self._on(h); });
  };
  EventGraph.prototype.visibleNodes = function () {
    var self = this;
    return this.nodes.filter(function (n) { return self._on(n); });
  };
  EventGraph.prototype.isVisible = function (id) {
    var n = this.byId[id];
    if (!n) return false;
    return this._on(n);
  };

  EventGraph.prototype.bounds = function () {
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    var hubs = this.visibleHubs();
    var nodes = this.visibleNodes();
    hubs.concat(nodes).forEach(function (n) {
      x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r);
      x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r);
    });
    if (x0 > x1) return { x0: 0, y0: 0, x1: this.w || 1, y1: this.h || 1, empty: true };
    return { x0: x0, y0: y0, x1: x1, y1: y1, empty: false };
  };

  EventGraph.prototype.fit = function () {
    if (!this.w) return;
    var hubs = this.visibleHubs();
    var nodes = this.visibleNodes();
    if (!nodes.length && !hubs.length) {
      if (this.filter) return;   /* 筛选结果为空：保留当前视角，由空状态说明 */
      this.view = { s: 1, x: this.w / 2, y: this.h / 2 };
      return;
    }
    var b = this.bounds();
    var bw = Math.max(1, b.x1 - b.x0);
    var bh = Math.max(1, b.y1 - b.y0);
    var padX = this.w < 760 ? Math.min(80, this.w * 0.12) : PAD_X;
    var padY = this.h < 460 ? 28 : PAD_Y;
    var maxS = this.filter ? 2.6 : 1.7;   /* 隔离查看时放大，让选中内容占据主要画布空间 */
    var s = Math.min((this.w - padX * 2) / bw, (this.h - padY * 2) / bh);
    s = Math.max(0.2, Math.min(maxS, s));
    this.view.s = s;
    this.view.x = this.w / 2 - ((b.x0 + b.x1) / 2) * s;
    this.view.y = this.h / 2 - ((b.y0 + b.y1) / 2) * s;
  };

  EventGraph.prototype.reset = function () { this.fit(); };
  EventGraph.prototype.setPaused = function (p) {
    this.paused = !!p;
    this._lastTs = 0;   /* 恢复时从当前帧重新计时，不补播 */
  };

  EventGraph.prototype.focusOn = function (id) {
    var n = this.byId[id];
    if (!n || !this._on(n)) return;
    var s = Math.max(this.view.s, 1.05);
    this.view.s = s;
    this.view.x = this.w / 2 - n.x * s;
    this.view.y = this.h / 2 - n.y * s;
  };

  /* ---------- 交互 ---------- */
  EventGraph.prototype._bind = function () {
    var self = this;
    var dragging = false, moved = 0, last = null;

    this.el.addEventListener('pointerdown', function (e) {
      dragging = true; moved = 0;
      last = { x: e.clientX, y: e.clientY };
      try { self.el.setPointerCapture(e.pointerId); } catch (err) {}
    });

    this.el.addEventListener('pointermove', function (e) {
      if (dragging) {
        var dx = e.clientX - last.x, dy = e.clientY - last.y;
        moved += Math.abs(dx) + Math.abs(dy);
        self.view.x += dx; self.view.y += dy;
        last = { x: e.clientX, y: e.clientY };
        return;
      }
      var hit = self.pick(e);
      var next = hit ? hit.id : null;
      if (next !== self.hover) {
        self.hover = next;
        self.el.style.cursor = hit ? 'pointer' : 'grab';
      }
    });

    this.el.addEventListener('pointerup', function (e) {
      if (dragging && moved < 5) {
        var hit = self.pick(e);
        /* 高亮键：枢纽用 'hub:' + 脑区，与 app 的选择键保持一致 */
        self.sel = hit ? (hit.kind === 'hub' ? 'hub:' + hit.id : hit.id) : null;
        if (self.opts.onSelect) self.opts.onSelect(hit);
      }
      dragging = false;
    });

    this.el.addEventListener('pointerleave', function () { self.hover = null; });

    this.el.addEventListener('wheel', function (e) {
      e.preventDefault();
      var rect = self.el.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var k = Math.exp(-e.deltaY * 0.0015);
      var s2 = Math.min(3.0, Math.max(0.25, self.view.s * k));
      var ratio = s2 / self.view.s;
      self.view.x = mx - (mx - self.view.x) * ratio;
      self.view.y = my - (my - self.view.y) * ratio;
      self.view.s = s2;
    }, { passive: false });

    this.el.addEventListener('dblclick', function () { self.reset(); });

    this.el.addEventListener('keydown', function (e) {
      var step = 44;
      if (e.key === 'ArrowLeft') { self.view.x += step; e.preventDefault(); }
      else if (e.key === 'ArrowRight') { self.view.x -= step; e.preventDefault(); }
      else if (e.key === 'ArrowUp') { self.view.y += step; e.preventDefault(); }
      else if (e.key === 'ArrowDown') { self.view.y -= step; e.preventDefault(); }
      else if (e.key === '+' || e.key === '=') { self.view.s = Math.min(3, self.view.s * 1.12); e.preventDefault(); }
      else if (e.key === '-' || e.key === '_') { self.view.s = Math.max(0.25, self.view.s / 1.12); e.preventDefault(); }
      else if (e.key === '0') { self.reset(); e.preventDefault(); }
    });
  };

  /* 命中检测只认可见内容：被过滤掉的节点既不可点也不可悬停 */
  EventGraph.prototype.pick = function (e) {
    var rect = this.el.getBoundingClientRect();
    var wx = (e.clientX - rect.left - this.view.x) / this.view.s;
    var wy = (e.clientY - rect.top - this.view.y) / this.view.s;
    var best = null, bd = 1e9;
    var all = this.visibleHubs().concat(this.visibleNodes());
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      var hitR = n.kind === 'hub' ? n.r + 7 : Math.max(12, n.r * 2.6);
      var d = Math.hypot(n.x - wx, n.y - wy);
      if (d <= hitR && d < bd) { best = n; bd = d; }
    }
    return best;
  };

  EventGraph.prototype.select = function (id) { this.sel = id; };

  /* ---------- 绘制 ---------- */
  EventGraph.prototype._loop = function (ts) {
    var now = typeof ts === 'number' ? ts : 0;
    if (!this.paused) {
      if (this._lastTs) {
        var dt = (now - this._lastTs) / 1000;
        /* 掉帧、切后台或窗口最小化后不跳变 */
        if (dt > 0 && dt < 0.25) this.t += dt;
      }
      this._lastTs = now;
      this.clock = now;
    } else {
      this._lastTs = now;
    }
    this._frame();
    this.raf = requestAnimationFrame(this._loop);
  };

  EventGraph.prototype._frame = function () {
    if (!this.w) this.resize();
    if (!this.w) return;
    var ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    this._drawBg(ctx);
    if (!this.hubs.length) return;

    ctx.save();
    ctx.translate(this.view.x, this.view.y);
    ctx.scale(this.view.s, this.view.s);

    this._boxes = [];
    this._reserveHubLabels(ctx);
    this._drawFlows(ctx);
    this._drawSpokes(ctx);
    this._drawParticles(ctx);
    this._drawNodes(ctx);
    this._drawHubs(ctx);

    ctx.restore();
  };

  EventGraph.prototype._drawBg = function (ctx) {
    var w = this.w, h = this.h;
    var g = ctx.createRadialGradient(w * 0.5, h * 0.46, 0, w * 0.5, h * 0.46, Math.max(w, h) * 0.72);
    g.addColorStop(0, 'rgba(18,26,29,.95)');
    g.addColorStop(1, 'rgba(8,10,12,1)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,.02)';
    ctx.lineWidth = 1;
    var step = 84;
    for (var x = this.view.x % step; x < w; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (var y = this.view.y % step; y < h; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
  };

  EventGraph.prototype._hub = function (id) { return this.byId['hub:' + id]; };

  /* 枢纽名先占位，避免条目标签压上去读成一串；只占可见枢纽 */
  EventGraph.prototype._reserveHubLabels = function (ctx) {
    var s = this.view.s;
    ctx.save();
    ctx.font = '500 ' + (11.5 / s) + 'px -apple-system,"PingFang SC",sans-serif';
    this.visibleHubs().forEach(function (h) {
      var w = ctx.measureText(h.label).width;
      var x = h.x - w / 2;
      var y = h.y + h.r + 8 / s;
      this._boxes.push({
        x0: x * s + this.view.x, y0: (y - 3 / s) * s + this.view.y,
        x1: (x + w) * s + this.view.x, y1: (y + 13 / s) * s + this.view.y
      });
    }, this);
    ctx.restore();
  };

  /* 可见流线：两端枢纽都必须可见 */
  EventGraph.prototype._flowsOn = function () {
    var self = this;
    var out = [];
    FLOWS.forEach(function (f, i) {
      var a = self._hub(f[0]), b = self._hub(f[1]);
      if (!a || !b) return;
      if (!self._on(a) || !self._on(b)) return;
      out.push({ a: a, b: b, i: i });
    });
    return out;
  };

  EventGraph.prototype._drawFlows = function (ctx) {
    var self = this;
    this._flowsOn().forEach(function (f) {
      var a = f.a, b = f.b;
      var dim = self.sel && self.sel.indexOf('hub:') !== 0 &&
        self.byId[self.sel] && self.byId[self.sel].region !== a.id && self.byId[self.sel].region !== b.id;
      var c = flowControl(a, b);
      ctx.save();
      ctx.strokeStyle = b.color;
      ctx.globalAlpha = dim ? 0.1 : 0.26;
      ctx.lineWidth = 1.4 / Math.max(0.7, self.view.s * 0.75);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
      ctx.stroke();
      ctx.restore();
    });
  };

  EventGraph.prototype._drawSpokes = function (ctx) {
    var self = this;
    this.visibleNodes().forEach(function (n) {
      var h = self._hub(n.region);
      if (!h || !self._on(h)) return;
      ctx.save();
      ctx.strokeStyle = n.color;
      ctx.globalAlpha = 0.16;
      ctx.lineWidth = 0.8 / Math.max(0.6, self.view.s * 0.8);
      ctx.beginPath();
      ctx.moveTo(h.x, h.y);
      ctx.lineTo(n.x, n.y);
      ctx.stroke();
      ctx.restore();
    });
  };

  /* 权威流线上的信号粒子：每条可见流线 1–2 个，慢速、两端淡入淡出 */
  EventGraph.prototype._drawParticles = function (ctx) {
    var self = this;
    var s = this.view.s;
    /* 粒子位置只由 this.t 决定：paused 时 this.t 不推进，画面逐像素稳定 */
    this._flowsOn().forEach(function (f) {
      var a = f.a, b = f.b;
      var c = flowControl(a, b);
      var period = FLOW_PERIOD[f.i] || 6;
      var base = (self.t / period + FLOW_PHASE[f.i]) % 1;
      var lowAlpha = self.sel && self.sel.indexOf('hub:') !== 0 &&
        self.byId[self.sel] && self.byId[self.sel].region !== a.id && self.byId[self.sel].region !== b.id;
      var total = 2;
      for (var k = 0; k < total; k++) {
        var u = (base + k * 0.5) % 1;
        var p = quadPoint(a, c, b, u);
        var fade = Math.sin(Math.PI * u);            /* 两端收，避免从枢纽里“冒出” */
        var alpha = (lowAlpha ? 0.25 : 0.9) * fade;
        if (alpha <= 0.01) continue;
        var rr = 2.9 / s;

        ctx.save();
        var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 8 / s);
        g.addColorStop(0, hexA(b.color, 0.42 * alpha));
        g.addColorStop(1, hexA(b.color, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, 9.5 / s, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = hexA(b.color, Math.min(1, 0.95 * alpha));
        ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    });
  };

  EventGraph.prototype._drawNodes = function (ctx) {
    var self = this;
    var s = this.view.s;
    var order = this.visibleNodes().sort(function (a, b) {
      var wa = (a.id === self.sel || a.id === self.hover) ? 0 : 1;
      var wb = (b.id === self.sel || b.id === self.hover) ? 0 : 1;
      return wa - wb;
    });

    order.forEach(function (n) {
      var active = self.sel === n.id;
      var hot = active || self.hover === n.id;
      var rc = Math.max(n.r * s, n.rank === 0 ? 3.4 : 2.6) / s;

      ctx.save();

      if (hot) {
        var g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, 26 / s);
        g.addColorStop(0, 'rgba(255,255,255,.2)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(n.x, n.y, 26 / s, 0, Math.PI * 2); ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, active ? rc * 1.7 : rc, 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.restore();

      self._nodeLabel(ctx, n, active || hot);
    });
  };

  EventGraph.prototype._nodeLabel = function (ctx, n, forced) {
    var s = this.view.s;
    /* 低缩放时只标重要节点 */
    if (!forced && s < 0.52) return;

    var d = n.data;
    var txt = truncate(d.titleZh || '', 26);
    var right = Math.cos(n.angle) >= 0;
    var gap = 6 / s;
    var hh = 8.5 / s;

    ctx.save();
    ctx.font = (forced ? '600 ' : '') + (10.5 / s) + 'px -apple-system,"PingFang SC",sans-serif';
    var tw = ctx.measureText(txt).width;
    var tx = n.x + (right ? n.r + gap : -(n.r + gap));

    /* 被选中的标签优先：先按原位试，挡住就上下让一让 */
    var offsets = forced ? [0, -15 / s, 15 / s, -30 / s, 30 / s] : [0];
    var picked = null;
    for (var i = 0; i < offsets.length; i++) {
      var ty = n.y + offsets[i];
      var rect = {
        x0: right ? tx : tx - tw, x1: right ? tx + tw : tx,
        y0: ty - hh, y1: ty + hh
      };
      var sx0 = rect.x0 * s + this.view.x, sx1 = rect.x1 * s + this.view.x;
      var sy0 = rect.y0 * s + this.view.y, sy1 = rect.y1 * s + this.view.y;
      var inb = sx0 >= 2 && sx1 <= this.w - 2 && sy0 >= 2 && sy1 <= this.h - 2;
      if (!inb) continue;
      if (this._room(rect)) { picked = { ty: ty, rect: rect }; break; }
    }
    if (!picked) {
      if (!forced) { ctx.restore(); return; }
      picked = { ty: n.y, rect: null };          /* 实在放不下就叠在原位，靠描边保证可读 */
    }

    ctx.textAlign = right ? 'left' : 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3.2 / s;
    ctx.strokeStyle = 'rgba(8,10,12,.94)';
    ctx.strokeText(txt, tx, picked.ty);
    ctx.fillStyle = forced ? '#EAEEED'
      : (n.rank === 0 ? 'rgba(214,221,220,.9)' : 'rgba(186,195,194,.74)');
    ctx.fillText(txt, tx, picked.ty);
    ctx.restore();
  };

  EventGraph.prototype._drawHubs = function (ctx) {
    var self = this;
    var s = this.view.s;
    var t = this.t;

    this.visibleHubs().forEach(function (h) {
      var active = self.sel === 'hub:' + h.id || (self.sel && self.byId[self.sel] && self.byId[self.sel].region === h.id);

      /* 呼吸：半径、光环与扩散脉冲环三者同相，幅度克制但肉眼可见 */
      var phase = (h.x + h.y) * 0.013;
      var breath = Math.sin((t / BREATH_PERIOD) * Math.PI * 2 + phase);   /* -1..1 */
      var breath01 = 0.5 + 0.5 * breath;                                  /* 0..1 */
      var ringR = h.r * (1 + 0.08 * breath);

      ctx.save();

      var haloR = h.r * (3.1 + 0.7 * breath01);
      var g = ctx.createRadialGradient(h.x, h.y, ringR * 0.6, h.x, h.y, haloR);
      g.addColorStop(0, hexA(h.color, 0.16 + 0.12 * breath01));
      g.addColorStop(1, hexA(h.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(h.x, h.y, haloR, 0, Math.PI * 2); ctx.fill();

      var core = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, ringR);
      core.addColorStop(0, hexA(h.color, 0.34));
      core.addColorStop(1, hexA(h.color, 0.06));
      ctx.fillStyle = core;
      ctx.beginPath(); ctx.arc(h.x, h.y, ringR, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = 'rgba(11,16,18,.96)';
      ctx.strokeStyle = h.color;
      ctx.lineWidth = (active ? 2.2 : 1.5) / Math.max(0.7, s * 0.8);
      ctx.beginPath(); ctx.arc(h.x, h.y, ringR, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();

      /* 扩散脉冲环：周期性向外扩散并淡出，是最容易被看见的“活着”信号 */
      var p = ((t / 7.4) + phase) % 1;
      if (p < 0) p += 1;
      var pr = h.r * (1.15 + 2.5 * p);
      ctx.beginPath();
      ctx.arc(h.x, h.y, pr, 0, Math.PI * 2);
      ctx.strokeStyle = hexA(h.color, 0.4 * (1 - p) * (1 - p));
      ctx.lineWidth = 1.3 / s;
      ctx.stroke();

      if (h.nonRegion) {
        ctx.beginPath();
        ctx.arc(h.x, h.y, ringR + 4 / s, 0, Math.PI * 2);
        ctx.setLineDash([2 / s, 3 / s]);
        ctx.strokeStyle = hexA(h.color, .45);
        ctx.lineWidth = 1 / s;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      /* 脑区名 */
      ctx.fillStyle = active ? '#EEF1F0' : '#C6CDCB';
      ctx.font = (active ? '600 ' : '500 ') + (11.5 / s) + 'px -apple-system,"PingFang SC",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineWidth = 3.4 / s;
      ctx.strokeStyle = 'rgba(8,10,12,.92)';
      ctx.strokeText(h.label, h.x, h.y + h.r + 8 / s);
      ctx.fillText(h.label, h.x, h.y + h.r + 8 / s);

      /* 节点数 */
      ctx.font = (9.5 / s) + 'px -apple-system,"PingFang SC",sans-serif';
      ctx.fillStyle = 'rgba(150,160,165,.62)';
      ctx.fillText(String(h.count), h.x, h.y + h.r + 23 / s);

      ctx.restore();
    });
  };

  EventGraph.prototype._room = function (r) {
    var s = this.view.s;
    var pad = 5;
    var x0 = r.x0 * s + this.view.x - pad, y0 = r.y0 * s + this.view.y;
    var x1 = r.x1 * s + this.view.x + pad, y1 = r.y1 * s + this.view.y;
    for (var i = 0; i < this._boxes.length; i++) {
      var b = this._boxes[i];
      if (x0 < b.x1 && x1 > b.x0 && y0 < b.y1 && y1 > b.y0) return false;
    }
    this._boxes.push({ x0: x0, y0: y0, x1: x1, y1: y1 });
    return true;
  };

  EventGraph.prototype.destroy = function () {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    root.removeEventListener('resize', this._onWin);
    this.nodes = []; this.hubs = []; this.byId = {}; this.filter = null;
  };

  function hexA(hex, a) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  FB.EventGraph = EventGraph;
  FB.truncateTitle = truncate;
})(window);
