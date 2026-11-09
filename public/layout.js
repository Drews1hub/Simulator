// Customizable panel layout (desktop/tablet only; phones keep the stacked layout).
//  - Drag the gaps between panels to resize them; double-click a gap to reset it.
//  - "Layout" button: drag a panel onto another to swap them, hide panels, reset.
// The layout is saved per profile (store.layout) and syncs with the account.
// Works in the browser (window.Layout) and in Node (module.exports) for tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Layout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TILES = { w: 'Watchlist', c: 'Chart', t: 'Order Ticket', b: 'Positions & Orders' };
  const TOP = ['w', 'c', 't'];          // tiles that share the top row (any order)
  const HIDEABLE = ['w', 't', 'b'];     // the chart always stays
  const MIN = { w: 200, t: 240, c: 360 }, MAX = { w: 560, t: 480 };
  const MIN_TOP = 320;                  // shortest top row (px)
  const PAD = 10, GAP = 10;             // .layout padding and gap (style.css)

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function normalize(l) {
    const o = l && typeof l === 'object' ? l : {};
    let order = Array.isArray(o.order) ? [...new Set(o.order.filter((k) => TOP.includes(k)))] : [];
    if (order.length !== TOP.length) order = TOP.slice();
    const hidden = Array.isArray(o.hidden) ? [...new Set(o.hidden.filter((k) => HIDEABLE.includes(k)))] : [];
    const widths = {};
    for (const k of ['w', 't']) { const v = Number(o.widths && o.widths[k]); if (v > 0) widths[k] = Math.round(v); }
    const topH = Number(o.topH) > 0 ? Math.round(Number(o.topH)) : null;
    return { order, hidden, widths, topH };
  }
  const isDefault = (l) => l.order.join('') === TOP.join('') && !l.hidden.length && !Object.keys(l.widths).length && !l.topH;
  // Matches the stylesheet's column widths at each screen size.
  const defaultWidths = (vw) => (vw > 1200 ? { w: 300, t: 280 } : vw > 1000 ? { w: 280, t: 250 } : { w: 220, t: 250 });

  // Pure: the CSS grid for a layout at a viewport size, or null to keep the stylesheet default.
  function gridSpec(layout, vw, vh) {
    const l = normalize(layout);
    if (isDefault(l)) return null;
    const def = defaultWidths(vw);
    const top = l.order.filter((k) => !l.hidden.includes(k));
    const sides = top.filter((k) => k !== 'c');
    const widths = {};
    sides.forEach((k) => { widths[k] = clamp(l.widths[k] || def[k], MIN[k], MAX[k]); });
    // Keep the chart at least MIN.c wide: shrink the side panels proportionally if needed.
    const room = vw - 2 * PAD - GAP * (top.length - 1) - MIN.c;
    const used = sides.reduce((s, k) => s + widths[k], 0);
    if (used > room) sides.forEach((k) => { widths[k] = Math.max(120, Math.floor(widths[k] * Math.max(room, 0) / used)); });
    const showB = !l.hidden.includes('b');
    const topH = l.topH ? clamp(l.topH, MIN_TOP, Math.max(MIN_TOP, vh - 120)) : null;
    return {
      top,
      widths,
      columns: top.map((k) => (k === 'c' ? 'minmax(0, 1fr)' : widths[k] + 'px')).join(' '),
      rows: (topH ? topH + 'px' : 'minmax(460px, calc(100vh - 150px))') + (showB ? ' auto' : ''),
      areas: `"${top.join(' ')}"` + (showB ? ` "${top.map(() => 'b').join(' ')}"` : ''),
    };
  }

  // ---------- browser UI ----------
  const SEL = { w: '.watchlist', c: '.chart-panel', t: '.ticket', b: '.bottom' };
  let ctx = null, editing = false, busy = false;
  const rootEl = () => document.querySelector('main.layout');
  const panel = (k) => rootEl().querySelector(SEL[k]);
  const wide = () => window.matchMedia('(min-width: 701px)').matches;
  const current = () => normalize(ctx && ctx.get());

  function apply(override) {
    const root = rootEl();
    if (!root || !ctx) return;
    const l = override || current();
    const on = wide();
    const spec = on ? gridSpec(l, document.documentElement.clientWidth, window.innerHeight) : null;
    root.classList.toggle('custom', !!spec);
    root.style.gridTemplateColumns = spec ? spec.columns : '';
    root.style.gridTemplateRows = spec ? spec.rows : '';
    root.style.gridTemplateAreas = spec ? spec.areas : '';
    Object.keys(SEL).forEach((k) => panel(k).classList.toggle('tile-hidden', on && l.hidden.includes(k)));
    if (!override) { renderBar(l); placeOverlays(); }
  }

  function save(l) { ctx.set(isDefault(l) ? null : l); apply(); }

  // Resize handles in the gaps, plus the drag covers shown in edit mode.
  function placeOverlays() {
    const root = rootEl();
    if (!root || busy) return;
    root.querySelectorAll('.split, .tile-cover').forEach((x) => x.remove());
    if (!wide()) return;
    const l = current();
    const top = l.order.filter((k) => !l.hidden.includes(k));
    const R = root.getBoundingClientRect();
    const box = (k) => panel(k).getBoundingClientRect();
    const ci = top.indexOf('c');
    for (let i = 0; i < top.length - 1; i++) {
      const a = box(top[i]), b = box(top[i + 1]);
      // A panel left of the chart is sized by its right edge, one right of it by its left edge.
      const key = i < ci ? top[i] : top[i + 1];
      addHandle('v', { left: (a.right + b.left) / 2 - R.left - 5, top: a.top - R.top, height: a.height }, key, i < ci ? 'right' : 'left');
    }
    if (!l.hidden.includes('b')) {
      const a = box(top[0]), b = box('b');
      addHandle('h', { top: (a.bottom + b.top) / 2 - R.top - 5, left: b.left - R.left, width: b.width }, 'topH');
    }
    if (!editing) return;
    [...top, ...(l.hidden.includes('b') ? [] : ['b'])].forEach((k) => {
      const r = box(k);
      const c = document.createElement('div');
      c.className = 'tile-cover' + (k === 'b' ? ' fixed' : '');
      c.dataset.tile = k;
      Object.assign(c.style, { left: r.left - R.left + 'px', top: r.top - R.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      c.innerHTML = `<b>${k === 'b' ? '' : '⠿ '}${TILES[k]}</b>` +
        `<small>${k === 'b' ? 'Stays full width along the bottom' : 'Drag onto another panel to swap places'}</small>` +
        (HIDEABLE.includes(k) ? `<button type="button" class="btn small" data-hide="${k}">Hide</button>` : '');
      if (k !== 'b') c.addEventListener('pointerdown', (e) => startMove(e, k));
      root.appendChild(c);
    });
  }

  function addHandle(kind, pos, key, edge) {
    const h = document.createElement('div');
    h.className = 'split split-' + kind;
    h.title = 'Drag to resize · double-click to reset';
    for (const [p, v] of Object.entries(pos)) h.style[p] = v + 'px';
    h.addEventListener('pointerdown', (e) => startResize(e, h, kind, key, edge));
    h.addEventListener('dblclick', () => {
      const l = current();
      if (key === 'topH') l.topH = null; else delete l.widths[key];
      save(l);
    });
    rootEl().appendChild(h);
  }

  function startResize(e, h, kind, key, edge) {
    if (e.button !== 0) return;
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    busy = true;
    h.classList.add('active');
    document.body.classList.add('resizing', 'resizing-' + kind);
    const R = rootEl().getBoundingClientRect();
    let next = null;
    const move = (ev) => {
      const l = current();
      if (key === 'topH') {
        const t = panel(l.order.find((k) => !l.hidden.includes(k))).getBoundingClientRect().top;
        l.topH = Math.round(Math.max(MIN_TOP, ev.clientY - t - GAP / 2));
        h.style.top = ev.clientY - R.top - 5 + 'px';
      } else {
        const r = panel(key).getBoundingClientRect();
        const w = edge === 'right' ? ev.clientX - r.left - GAP / 2 : r.right - ev.clientX - GAP / 2;
        l.widths[key] = Math.round(clamp(w, MIN[key], MAX[key]));
        h.style.left = ev.clientX - R.left - 5 + 'px';
      }
      next = l;
      apply(l);
    };
    const end = () => {
      h.removeEventListener('pointermove', move);
      busy = false;
      document.body.classList.remove('resizing', 'resizing-v', 'resizing-h');
      if (next) save(next); else placeOverlays();
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', end, { once: true });
    h.addEventListener('pointercancel', end, { once: true });
  }

  function startMove(e, k) {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const cover = e.currentTarget;
    cover.setPointerCapture(e.pointerId);
    busy = true;
    cover.classList.add('moving');
    const covers = [...rootEl().querySelectorAll('.tile-cover')];
    let target = null;
    const move = (ev) => {
      const hit = covers.find((c) => {
        if (c === cover || c.classList.contains('fixed')) return false;
        const r = c.getBoundingClientRect();
        return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      });
      const t = hit ? hit.dataset.tile : null;
      if (t === target) return;
      covers.forEach((c) => c.classList.toggle('drop-target', c.dataset.tile === t));
      target = t;
    };
    const end = () => {
      cover.removeEventListener('pointermove', move);
      busy = false;
      const l = current();
      if (target) {
        const i = l.order.indexOf(k), j = l.order.indexOf(target);
        [l.order[i], l.order[j]] = [l.order[j], l.order[i]];
        save(l);
      } else placeOverlays();
    };
    cover.addEventListener('pointermove', move);
    cover.addEventListener('pointerup', end, { once: true });
    cover.addEventListener('pointercancel', end, { once: true });
  }

  function renderBar(l) {
    const bar = document.getElementById('layoutBar');
    const btn = document.getElementById('btnLayout');
    if (btn) btn.classList.toggle('on', editing);
    if (!bar) return;
    bar.classList.toggle('hidden', !editing);
    if (!editing) return;
    const hid = l.hidden.map((k) => `<button type="button" class="btn small" data-show="${k}">＋ ${TILES[k]}</button>`).join(' ');
    bar.innerHTML = '<span><b>Editing layout.</b> Drag a panel onto another to swap them. Drag the gaps between panels to resize (double-click a gap to reset it).</span>' +
      (hid ? `<span class="layout-hidden">Hidden: ${hid}</span>` : '') +
      '<span class="layout-actions"><button type="button" class="btn small" data-act="reset">Reset layout</button>' +
      '<button type="button" class="btn small save" data-act="done">Done</button></span>';
  }

  function setEditing(on) {
    editing = on;
    document.body.classList.toggle('layout-edit', on);
    apply();
  }

  // opts: { get() -> saved layout, set(layout|null) to save it, onResize() to redraw the chart }
  function init(opts) {
    ctx = opts;
    const root = rootEl();
    if (!root) return;
    const btn = document.getElementById('btnLayout');
    if (btn) btn.addEventListener('click', () => setEditing(!editing));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && editing) setEditing(false); });
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-hide]');
      if (!b) return;
      const l = current();
      l.hidden.push(b.dataset.hide);
      save(l);
    });
    const bar = document.getElementById('layoutBar');
    if (bar) bar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const l = current();
      if (b.dataset.show) { l.hidden = l.hidden.filter((k) => k !== b.dataset.show); save(l); }
      else if (b.dataset.act === 'reset') save(normalize(null));
      else if (b.dataset.act === 'done') setEditing(false);
    });
    // Redraw the canvas chart whenever its box changes size (dividers, coach panel, window).
    let raf = 0;
    const chartWrap = root.querySelector('.chart-wrap');
    if (chartWrap && window.ResizeObserver) {
      new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => ctx.onResize && ctx.onResize()); }).observe(chartWrap);
    }
    if (window.ResizeObserver) new ResizeObserver(() => requestAnimationFrame(placeOverlays)).observe(root);
    window.addEventListener('resize', () => { if (editing && !wide()) setEditing(false); else apply(); });
    apply();
  }

  return { TILES, MIN, MAX, MIN_TOP, normalize, isDefault, defaultWidths, gridSpec, init, apply, setEditing };
});
