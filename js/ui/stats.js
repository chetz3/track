// Stats screen (#/stats): a D3 progress ring plus one zoomable trend chart
// per number-typed step. D3 is loaded as a classic (non-module) script from
// vendor/d3.v7.min.js (see index.html), so it's read off `window.d3` at
// render time rather than imported — this also lets us degrade gracefully
// if the vendor file failed to load (e.g. first launch offline).
//
// Render contract (see app.js): renderStats receives a container already
// attached inside #app. It may only write inside it. The router swaps in a
// brand-new container on every re-render (including on every store change),
// so the chart width (el.clientWidth) can change between renders; a
// debounced `resize` listener re-renders the charts to match. That listener
// is registered once at module load (not per-render) so it never leaks, and
// it only acts while the current route is actually #/stats and the
// container it would redraw into is still attached. It also skips redrawing
// when the container's width hasn't actually changed — mobile browsers fire
// `resize` when the address bar collapses/expands (a height-only change),
// which would otherwise replay the ring/line-draw animations and reset zoom
// on every scroll.

import * as store from '../store.js';
import { esc, hydratePhotos } from './dom.js';
import { collectNumberSeries, trendDomain, ringStats } from '../chartMath.js';
import { buildPhotoProgress } from '../summaryModel.js';

// ---------- resize handling (module-level, registered once) ----------

let currentRoot = null;
let lastRenderedWidth = null;
let resizeTimer = null;

// ---------- photo progress selections (module-level so re-renders, e.g. on
// every store change, keep whatever the person picked; reset to defaults in
// photoProgressHtml if the stored id no longer exists on this challenge) ----------

let selectedPhotoStepId = null;
let selectedNumberStepId = null; // step id, or 'none'

function scheduleResizeRerender() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    const top = location.hash.replace(/^#\/?/, '').split('/')[0];
    if (top !== 'stats') return;
    if (!currentRoot || !currentRoot.isConnected) return;
    if (currentRoot.clientWidth === lastRenderedWidth) return; // height-only resize (e.g. mobile address bar)
    renderStats(currentRoot);
  }, 150);
}

window.addEventListener('resize', scheduleResizeRerender);

// ---------- photo progress (gallery) ----------

// Rounds away float noise (e.g. 80 - 78.4) before display.
function roundClean(n) {
  return Math.round(n * 100) / 100;
}

function fmtValue(value, unit) {
  return unit ? `${value} ${unit}` : `${value}`;
}

function fmtDiff(diff, unit) {
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
  return fmtValue(`${sign}${Math.abs(roundClean(diff))}`, unit);
}

function photoTileHtml(tile) {
  const caption = typeof tile.value === 'number'
    ? `Day ${tile.dayNumber} · ${esc(fmtValue(tile.value, tile.unit))}`
    : `Day ${tile.dayNumber}`;
  return `<button type="button" class="photo-progress-tile" data-role="photo-tile" data-date="${esc(tile.date)}">
    <img data-photo-id="${esc(tile.photoId)}" alt="Day ${esc(tile.dayNumber)}" />
    <span class="photo-progress-caption">${caption}</span>
  </button>`;
}

// Returns '' (section omitted entirely) when the challenge has no
// photo-enabled step.
function photoProgressHtml(challenge, attempt, daysMap) {
  const photoSteps = challenge.steps.filter((s) => s.photo && s.photo !== 'none');
  if (!photoSteps.length) return '';

  if (!photoSteps.some((s) => s.id === selectedPhotoStepId)) selectedPhotoStepId = photoSteps[0].id;

  const numberSteps = challenge.steps.filter((s) => s.number);
  if (numberSteps.length) {
    if (selectedNumberStepId !== 'none' && !numberSteps.some((s) => s.id === selectedNumberStepId)) {
      selectedNumberStepId = numberSteps[0].id;
    }
  } else {
    selectedNumberStepId = 'none';
  }

  const numberStepId = selectedNumberStepId === 'none' ? null : selectedNumberStepId;
  const { tiles, change } = buildPhotoProgress(challenge, daysMap, attempt, selectedPhotoStepId, numberStepId);

  const photoOptionsHtml = photoSteps
    .map((s) => `<option value="${esc(s.id)}"${s.id === selectedPhotoStepId ? ' selected' : ''}>${esc(s.name)}</option>`)
    .join('');
  const numberOptionsHtml = `<option value="none"${selectedNumberStepId === 'none' ? ' selected' : ''}>None</option>` +
    numberSteps.map((s) => `<option value="${esc(s.id)}"${s.id === selectedNumberStepId ? ' selected' : ''}>${esc(s.name)}</option>`).join('');

  const changeHtml = change
    ? `<p class="section-footer photo-progress-change">First ${esc(fmtValue(change.first, change.unit))} → Latest ${esc(fmtValue(change.latest, change.unit))} (${esc(fmtDiff(change.diff, change.unit))})</p>`
    : '';

  const gridHtml = tiles.length
    ? `<div class="photo-progress-grid">${tiles.map(photoTileHtml).join('')}</div>`
    : `<p class="section-footer">No photos yet.</p>`;

  return `
    <div class="section">
      <div class="photo-progress-head">
        <p class="section-header">Photo progress</p>
        <div class="photo-progress-selects">
          <label class="photo-progress-select-label">Photo
            <select class="photo-progress-select" data-role="photo-step-select">${photoOptionsHtml}</select>
          </label>
          <label class="photo-progress-select-label">Show
            <select class="photo-progress-select" data-role="number-step-select">${numberOptionsHtml}</select>
          </label>
        </div>
      </div>
      ${changeHtml}
      ${gridHtml}
    </div>
  `;
}

function wirePhotoProgress(root) {
  const photoSelect = root.querySelector('[data-role="photo-step-select"]');
  if (photoSelect) {
    photoSelect.addEventListener('change', (e) => {
      selectedPhotoStepId = e.target.value;
      renderStats(root);
    });
  }
  const numberSelect = root.querySelector('[data-role="number-step-select"]');
  if (numberSelect) {
    numberSelect.addEventListener('change', (e) => {
      selectedNumberStepId = e.target.value;
      renderStats(root);
    });
  }
  root.querySelectorAll('[data-role="photo-tile"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      location.hash = '#/summary/' + btn.dataset.date;
    });
  });
}

// ---------- main screen ----------

export async function renderStats(root) {
  currentRoot = root;
  lastRenderedWidth = root.clientWidth;

  const challenge = store.selected();
  if (!challenge) {
    root.innerHTML = '';
    return;
  }

  if (!window.d3) {
    root.innerHTML = `
      <h1 class="large-title">Stats</h1>
      <p class="subtitle">${esc(challenge.name)}</p>
      <p class="section-footer">Charts unavailable offline — reload once online.</p>
    `;
    return;
  }

  const attempt = store.displayAttempt(challenge.id);
  const evaluation = store.state.evaluations[challenge.id];

  if (!attempt || !evaluation) {
    root.innerHTML = `
      <h1 class="large-title">Stats</h1>
      <p class="subtitle">${esc(challenge.name)}</p>
      <p class="section-footer">No active attempt yet.</p>
    `;
    return;
  }

  const stats = ringStats(challenge, evaluation, attempt, store.today());
  const daysMap = store.state.days[challenge.id] || {};
  const series = collectNumberSeries(challenge, daysMap);
  const photoProgress = photoProgressHtml(challenge, attempt, daysMap);

  const seriesHtml = series.length
    ? series.map((s, i) => {
      const unitSuffix = s.step.number.unit ? ` (${esc(s.step.number.unit)})` : '';
      return `
      <div class="section">
        <p class="section-header">${esc(s.step.name)} — ${esc(s.step.number.label)}${unitSuffix}</p>
        <div class="group trend-group" data-trend-index="${i}"></div>
      </div>
    `;
    }).join('')
    : `<p class="section-footer">Add a number field to a step to see trends here.</p>`;

  root.innerHTML = `
    <h1 class="large-title">Stats</h1>
    <p class="subtitle">${esc(challenge.name)}</p>
    <div class="section">
      <p class="section-header">Progress</p>
      <div class="group ring-group">
        <div class="ring-mount"></div>
        <div class="ring-legend">
          <div class="ring-legend-col">
            <div class="ring-legend-value accent">${esc(stats.day)}/${esc(stats.totalDays)}</div>
            <div class="ring-legend-label">Day</div>
          </div>
          <div class="ring-legend-col">
            <div class="ring-legend-value green">${esc(stats.weeksPassed)}/${esc(stats.totalWeeks)}</div>
            <div class="ring-legend-label">Weeks passed</div>
          </div>
          <div class="ring-legend-col">
            <div class="ring-legend-value">${stats.streakDays}</div>
            <div class="ring-legend-label">Streak</div>
          </div>
        </div>
      </div>
    </div>
    ${photoProgress}
    ${seriesHtml}
  `;

  const ringMount = root.querySelector('.ring-mount');
  if (ringMount) renderProgressRing(ringMount, stats);

  for (const [i, s] of series.entries()) {
    const mount = root.querySelector(`[data-trend-index="${i}"]`);
    if (mount) renderTrendChart(mount, { title: s.step.name, unit: s.step.number.unit, points: s.points });
  }

  wirePhotoProgress(root);
  await hydratePhotos(root);
}

// ---------- progress ring ----------

export function renderProgressRing(el, s) {
  const d3 = window.d3;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const size = 240, stroke = 18, gap = 8;
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${size} ${size}`).attr('class', 'ring')
    .attr('role', 'img').attr('aria-label', `Day ${s.day} of ${s.totalDays}, ${s.weeksPassed} of ${s.totalWeeks} weeks passed, ${s.streakDays} day streak`);
  const g = svg.append('g').attr('transform', `translate(${size / 2},${size / 2})`);
  const tip = d3.select(el).append('div').attr('class', 'chart-tip').style('opacity', 0).style('margin', '8px auto 0');
  const rings = [
    { label: `Day ${s.day} of ${s.totalDays}`, frac: s.totalDays ? s.day / s.totalDays : 0, r: size / 2 - stroke / 2, color: 'var(--accent)' },
    { label: `${s.weeksPassed} of ${s.totalWeeks} weeks passed`, frac: s.totalWeeks ? s.weeksPassed / s.totalWeeks : 0, r: size / 2 - stroke * 1.5 - gap, color: 'var(--green)' },
  ];
  for (const ring of rings) {
    const arc = d3.arc().innerRadius(ring.r - stroke / 2).outerRadius(ring.r + stroke / 2).startAngle(0).cornerRadius(stroke / 2);
    g.append('path').attr('d', arc.endAngle(2 * Math.PI)()).attr('fill', 'var(--track)');
    const end = Math.max(0.001, Math.min(1, ring.frac)) * 2 * Math.PI;
    const fg = g.append('path').attr('fill', ring.color).attr('tabindex', 0).style('cursor', 'pointer');
    if (reduce) fg.attr('d', arc.endAngle(end)());
    else fg.attr('d', arc.endAngle(0.001)()).transition().duration(1000).ease(d3.easeCubicOut)
      .attrTween('d', () => { const i = d3.interpolate(0.001, end); return (t) => arc.endAngle(i(t))(); });
    const show = () => tip.text(ring.label).style('opacity', 1);
    fg.on('pointerenter', show).on('click', show).on('focus', show)
      .on('pointerleave', () => tip.style('opacity', 0)).on('blur', () => tip.style('opacity', 0));
  }
  g.append('text').attr('text-anchor', 'middle').attr('dy', '0.05em').attr('class', 'ring-value').text(s.streakDays);
  g.append('text').attr('text-anchor', 'middle').attr('dy', '1.9em').attr('class', 'ring-caption').text('day streak');
}

// ---------- trend chart ----------

export function renderTrendChart(el, { title, unit, points }) {
  const d3 = window.d3;
  if (points.length === 0) { el.innerHTML = `<p class="section-footer">No ${esc(title)} entries yet.</p>`; return; }
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // `el` is the padded `.trend-group` mount itself, so its clientWidth
  // includes left+right padding; subtract that so the SVG's viewBox (which
  // fills the mount edge-to-edge) matches the available content width
  // instead of running ~32px too wide.
  const cs = getComputedStyle(el);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const width = Math.max(280, el.clientWidth - padX), height = 220, m = { top: 16, right: 12, bottom: 28, left: 40 };
  const parse = d3.timeParse('%Y-%m-%d');
  const data = points.map((p) => ({ date: parse(p.date), value: p.value }));
  const x0 = d3.scaleTime().range([m.left, width - m.right]);
  if (data.length === 1) x0.domain([d3.timeDay.offset(data[0].date, -3), d3.timeDay.offset(data[0].date, 3)]);
  else x0.domain(d3.extent(data, (d) => d.date));
  const y = d3.scaleLinear().domain(trendDomain(data.map((d) => d.value))).nice().range([height - m.bottom, m.top]);
  const uid = Math.random().toString(36).slice(2);
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('class', 'trend').style('touch-action', 'pan-y');
  const defs = svg.append('defs');
  const grad = defs.append('linearGradient').attr('id', `g${uid}`).attr('x1', 0).attr('x2', 0).attr('y1', 0).attr('y2', 1);
  grad.append('stop').attr('offset', '0%').attr('stop-color', '#ff9f0a').attr('stop-opacity', 0.35);
  grad.append('stop').attr('offset', '100%').attr('stop-color', '#ff9f0a').attr('stop-opacity', 0);
  defs.append('clipPath').attr('id', `c${uid}`).append('rect').attr('x', m.left).attr('y', 0).attr('width', width - m.left - m.right).attr('height', height);
  svg.append('g').attr('class', 'axis axis-y').attr('transform', `translate(${m.left},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSize(-(width - m.left - m.right)))
    .call((g) => g.select('.domain').remove());
  const xAxis = svg.append('g').attr('class', 'axis axis-x').attr('transform', `translate(0,${height - m.bottom})`);
  const plot = svg.append('g').attr('clip-path', `url(#c${uid})`);
  const area = plot.append('path').attr('fill', `url(#g${uid})`);
  const line = plot.append('path').attr('fill', 'none').attr('stroke', '#ff9f0a').attr('stroke-width', 2.5).attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round');
  const dots = plot.selectAll('circle.pt').data(data).join('circle').attr('class', 'pt').attr('r', 3.5).attr('fill', '#ff9f0a');
  const focus = svg.append('g').style('opacity', 0).style('pointer-events', 'none');
  focus.append('line').attr('y1', m.top).attr('y2', height - m.bottom).attr('stroke', 'rgba(255,255,255,.25)');
  const focusDot = focus.append('circle').attr('r', 6).attr('fill', '#ff9f0a').attr('stroke', '#000').attr('stroke-width', 2);
  const tip = d3.select(el).append('div').attr('class', 'chart-tip').style('opacity', 0);
  let x = x0;
  const draw = () => {
    xAxis.call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(width / 90))).tickSizeOuter(0));
    area.attr('d', d3.area().x((d) => x(d.date)).y0(height - m.bottom).y1((d) => y(d.value)).curve(d3.curveMonotoneX)(data));
    line.attr('d', d3.line().x((d) => x(d.date)).y((d) => y(d.value)).curve(d3.curveMonotoneX)(data));
    dots.attr('cx', (d) => x(d.date)).attr('cy', (d) => y(d.value));
  };
  draw();
  if (!reduce && data.length > 1) {
    const len = line.node().getTotalLength();
    line.attr('stroke-dasharray', `${len} ${len}`).attr('stroke-dashoffset', len)
      .transition().duration(900).ease(d3.easeCubicOut).attr('stroke-dashoffset', 0)
      .on('end', () => line.attr('stroke-dasharray', null));
  }
  const bisect = d3.bisector((d) => d.date).center;
  const fmt = d3.timeFormat('%a %-d %b');
  svg.on('pointermove pointerdown', (event) => {
    const [px] = d3.pointer(event);
    const d = data[bisect(data, x.invert(px))];
    if (!d) return;
    focus.style('opacity', 1).attr('transform', `translate(${x(d.date)},0)`);
    focusDot.attr('cy', y(d.value));
    tip.style('opacity', 1).text(unit ? `${fmt(d.date)} · ${d.value} ${unit}` : `${fmt(d.date)} · ${d.value}`);
  }).on('pointerleave', () => { focus.style('opacity', 0); tip.style('opacity', 0); });
  if (data.length > 1) {
    const zoom = d3.zoom().scaleExtent([1, 8])
      // d3.zoom's default filter accepts a one-finger touchstart and its
      // touchmove handler calls preventDefault, which blocks vertical page
      // scroll over the chart on phones (`touch-action: pan-y` has no effect
      // against a non-passive handler). Restrict zoom-initiation to pinch
      // (2+ touches), wheel and mouse, so a single-finger swipe still
      // scrolls the page; the crosshair tooltip on pointermove/pointerdown
      // is untouched, so a single tap still shows a value.
      .filter((e) => (!e.ctrlKey || e.type === 'wheel') && !e.button && !(e.type === 'touchstart' && e.touches.length < 2))
      .extent([[m.left, 0], [width - m.right, height]])
      .translateExtent([[m.left, 0], [width - m.right, height]])
      .on('zoom', (event) => { x = event.transform.rescaleX(x0); draw(); });
    svg.call(zoom).on('dblclick.zoom', () => svg.transition().duration(300).call(zoom.transform, d3.zoomIdentity));
  }
}
