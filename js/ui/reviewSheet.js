// The "Why isn't it moving?" review (R2 of
// docs/superpowers/plans/2026-10-10-plateau-coach.md §6). Entry point for
// the Stats button and the Today coach card: no AI key -> the add-key flow;
// a review still in effect -> show it; otherwise run a new one.
//
// The sheet body is one #review-root; all clicks are delegated from it (wired
// once), sections open and close by toggling `hidden`/`aria-expanded` (no
// re-render), and only Apply / Undo / Re-run replace its HTML.

import { openSheet } from './sheet.js';
import { openAiKeySheet } from './aiKeySheet.js';
import { esc, loaderHtml } from './dom.js';
import { aiAvailable, reviewPlateau } from '../gemini.js';
import * as store from '../store.js';
import { trendStatus } from '../trend.js';
import { pickWeeklyBodyPhotos, photoTrendReady } from '../photoTrend.js';
import { buildBodyCollage } from './collage.js';
import {
  buildReviewInput, fitReviewInput, reviewContext, newReviewRecord, rerunInfo, shouldShowExisting,
  applyChange, revertChange, foodStepOf, proteinRaiseTarget,
} from '../coach.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const VERDICTS = {
  real_plateau: ['Real plateau', 'pending'],
  water_noise: ['Mostly water noise', 'pending'],
  under_logging: ['Likely under-logging', 'pending'],
  gaining: ['Gaining', 'red'],
  losing_fine: ['Losing fine', 'green'],
  not_enough_data: ['Not enough data', 'future'],
};

const dm = (date) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : '';
};
const kcalText = (n) => `${Number(n).toLocaleString('en-US')} kcal`;
const signed = (n, unit) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n * 100) / 100)} ${unit}`;

// One review run per challenge at a time; reopening the sheet mid-run waits
// for the same request instead of spending the quota twice.
const inflight = new Map();

function liveChallenge(id) {
  return store.state.challenges.find((c) => c.id === id) || null;
}

// ---------- entry ----------

export function openReviewEntry(challenge) {
  if (!aiAvailable()) {
    openAiKeySheet();
    return;
  }
  const id = challenge.id;
  const c = liveChallenge(id) || challenge;
  const showExisting = shouldShowExisting(c, store.state.days[id] || {}, store.today());
  openSheet({
    title: "Why isn't it moving?",
    bodyHtml: `<div id="review-root">${loaderHtml('Reviewing your last 28 days…', 'lg')}</div>`,
    onMount: (sheet, close) => {
      const root = sheet.querySelector('#review-root');
      wire(root, id, close);
      if (showExisting && !inflight.has(id)) render(root, id);
      else run(root, id);
    },
  });
}

// ---------- body photo trend ----------

function photosAllowed(c) {
  const days = store.state.days[c.id] || {};
  return !!(c.profile && c.profile.shareBodyPhoto === true)
    && photoTrendReady(pickWeeklyBodyPhotos(c, days, store.today()));
}

// Stats -> "Analyse body trend (AI)". Photos leave the device only when
// profile.shareBodyPhoto is on AND the person taps Analyse on the preview.
export function openBodyTrend(challenge) {
  if (!aiAvailable()) {
    openAiKeySheet();
    return;
  }
  const id = challenge.id;
  const c = liveChallenge(id) || challenge;

  if (!(c.profile && c.profile.shareBodyPhoto === true)) {
    openSheet({
      title: 'Body photo trend',
      bodyHtml: `<div id="review-root">
        <p>Turn on 'Share body photo' in the challenge profile to include photos.</p>
        <a class="btn btn-secondary" href="#/challenges/${esc(id)}" data-role="rv-profile">Open profile</a>
        <button type="button" class="btn btn-primary" data-role="bt-text">Run review without photos</button>
        <button type="button" class="btn btn-secondary" data-role="rv-close">Cancel</button>
      </div>`,
      onMount: (sheet, close) => {
        const root = sheet.querySelector('#review-root');
        wire(root, id, close);
        root.addEventListener('click', (e) => {
          if (e.target.closest('[data-role="bt-text"]')) run(root, id);
        });
      },
    });
    return;
  }

  const picks = pickWeeklyBodyPhotos(c, store.state.days[id] || {}, store.today());
  if (!photoTrendReady(picks)) return;
  const photoCtx = { picks, blob: null };
  let url = null;
  let closed = false;
  openSheet({
    title: 'Body photo trend',
    bodyHtml: `<div id="review-root">${loaderHtml('Building collage…', 'lg')}</div>`,
    onClose: () => {
      closed = true;
      if (url) { URL.revokeObjectURL(url); url = null; }
    },
    onMount: (sheet, close) => {
      const root = sheet.querySelector('#review-root');
      wire(root, id, close, photoCtx);
      buildBodyCollage(picks).then((blob) => {
        if (closed || !root.isConnected) return;
        photoCtx.blob = blob;
        url = URL.createObjectURL(blob);
        root.innerHTML = `<img class="bt-collage" src="${url}" alt="Your weekly body photos in one image" />
          <p class="section-footer">This 1 image goes to Google Gemini on your own key, with your last 28 days of data. Nothing is stored.</p>
          <div class="btn-pair">
            <button type="button" class="btn btn-primary" data-role="bt-analyse">Analyse</button>
            <button type="button" class="btn btn-secondary" data-role="bt-cancel">Cancel</button>
          </div>`;
      }).catch((err) => { if (root.isConnected) renderError(root, err); });
    },
  });
}

// ---------- run ----------

function run(root, id, photos = null) {
  root.innerHTML = loaderHtml('Reviewing your last 28 days…', 'lg');
  let p = inflight.get(id);
  if (!p) {
    p = runReview(id, photos);
    inflight.set(id, p);
    p.then(() => inflight.delete(id), () => inflight.delete(id));
  }
  p.then(() => { if (root.isConnected) render(root, id); })
    .catch((err) => { if (root.isConnected) renderError(root, err); });
}

// photos: null (text only) or { picks, blob } — the collage built and
// confirmed on the preview sheet. It is sent once and never stored.
async function runReview(id, photos = null) {
  const c = liveChallenge(id);
  if (!c) throw new Error('Challenge not found.');
  const daysMap = store.state.days[id] || {};
  const attempt = store.displayAttempt(id);
  const today = store.today();
  const opts = { startDate: attempt ? attempt.startDate : undefined };
  if (photos && photos.blob && c.profile && c.profile.shareBodyPhoto === true) {
    opts.photoDates = photos.picks.map((p) => p.date);
  } else {
    photos = null;
  }
  const input = fitReviewInput(buildReviewInput(c, daysMap, today, opts));
  const parsed = await reviewPlateau(input, reviewContext(input), photos ? photos.blob : null);
  const trend = trendStatus(c, daysMap, today, { ...opts, windowDays: 14 });
  const prior = (liveChallenge(id) || c).plateauReview;
  const record = newReviewRecord(parsed, today, trend, prior && prior.applied ? prior.applied : null);
  await store.patchChallenge(id, { plateauReview: record });
}

function renderError(root, err) {
  root.innerHTML = `<p class="section-footer error" role="alert">${esc((err && err.message) || 'Something went wrong.')}</p>
    <div class="btn-pair">
      <button type="button" class="btn btn-primary" data-role="rv-retry">Try again</button>
      <button type="button" class="btn btn-secondary" data-role="rv-close">Close</button>
    </div>`;
}

// ---------- render ----------

function listHtml(items) {
  return `<ul class="rv-list">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
}

function refsHtml(item) {
  const parts = [];
  if (item.dates && item.dates.length) parts.push(item.dates.map(dm).join(', '));
  if (item.dishes && item.dishes.length) parts.push(item.dishes.join(', '));
  return parts.length ? `<p class="rv-refs">${esc(parts.join(' · '))}</p>` : '';
}

function trendLine(t) {
  if (!t) return '';
  const bits = [];
  if (Number.isFinite(t.slopeKgPerWeek)) bits.push(`${signed(t.slopeKgPerWeek, 'kg/week')}`);
  if (Number.isFinite(t.rangeKg)) bits.push(`range ${t.rangeKg} kg`);
  if (Number.isFinite(t.adherencePct)) bits.push(`${t.adherencePct} % of days on plan`);
  if (Number.isFinite(t.expectedLossKg) && Number.isFinite(t.actualLossKg)) {
    bits.push(`expected ${signed(-t.expectedLossKg, 'kg')}, actual ${signed(-t.actualLossKg, 'kg')}`);
  }
  return bits.length ? `<p class="rv-trend">${esc(bits.join(' · '))}</p>` : '';
}

function maintenanceHtml(c, r) {
  const m = r.maintenance || { action: 'keep', why: '' };
  const food = foodStepOf(c);
  const current = food && food.goal ? food.goal.target : null;
  const a = r.applied;
  const out = [];
  const why = m.why ? `<p>${esc(m.why)}</p>` : '';

  if (m.action === 'keep') {
    out.push(`<p><strong>Keep your target${Number.isFinite(current) ? ` (${esc(kcalText(current))})` : ''}.</strong></p>${why}`);
  } else if (m.action === 'lower_target') {
    out.push(`<p><strong>Lower your target to ${esc(kcalText(m.new_kcal))}.</strong></p>${why}`);
    if (!a) out.push(`<button type="button" class="btn btn-primary" data-role="rv-apply" data-kind="kcal">Apply ${esc(Number(m.new_kcal).toLocaleString('en-US'))} kcal</button>`);
  } else if (m.action === 'diet_break') {
    out.push(`<p><strong>Take a ${esc(m.duration_days)}-day diet break at ${esc(kcalText(m.new_kcal))}.</strong></p>${why}`);
    if (!a) out.push(`<button type="button" class="btn btn-primary" data-role="rv-apply" data-kind="kcal">Start diet break: ${esc(Number(m.new_kcal).toLocaleString('en-US'))} kcal for ${esc(m.duration_days)} days</button>`);
  } else if (m.action === 'raise_protein') {
    const weight = r.trendAtReview && r.trendAtReview.endKg;
    const cur = food && food.macros && food.macros.protein ? food.macros.protein.target : null;
    const goal = proteinRaiseTarget(weight, cur);
    out.push(`<p><strong>Raise your protein.</strong></p>${why}`);
    if (goal && !a) {
      out.push(`<p class="rv-sub">A common aim is about 1.6 g per kg of body weight, so ${esc(goal)} g a day${Number.isFinite(cur) ? ` (now ${esc(cur)} g)` : ''}.</p>
        <button type="button" class="btn btn-primary" data-role="rv-apply" data-kind="protein" data-to="${esc(goal)}">Raise protein target to ${esc(goal)} g</button>`);
    } else if (!goal) {
      out.push('<p class="rv-sub">Your protein target is already at that level. Hitting it is what counts.</p>');
    }
  } else if (m.action === 'recalc') {
    out.push(`<p><strong>Recalculate your targets.</strong></p>${why}
      <a class="btn btn-secondary" href="#/challenges" data-role="rv-profile">Open your profile</a>`);
  }

  if (a) {
    const what = a.field === 'protein'
      ? `Protein target ${a.from} → ${a.to} g`
      : `${Number(a.from).toLocaleString('en-US')} → ${Number(a.to).toLocaleString('en-US')} kcal`;
    const until = a.action === 'diet_break' && a.untilDate ? `, diet break until ${dm(a.untilDate)}` : '';
    out.push(`<div class="rv-applied" role="status"><span>Applied ${esc(dm(a.date))}: ${esc(what)}${esc(until)}.</span>
      <button type="button" class="btn btn-secondary" data-role="rv-undo">Undo</button></div>`);
  }
  return out.join('');
}

function section(id, title, bodyHtml, open) {
  return `<section class="rv-sec">
    <button type="button" class="rv-head" data-role="rv-toggle" aria-expanded="${open}" aria-controls="rv-${id}">
      <span>${esc(title)}</span><span class="rv-chev" aria-hidden="true">›</span>
    </button>
    <div class="rv-body" id="rv-${id}"${open ? '' : ' hidden'}>${bodyHtml}</div>
  </section>`;
}

const BELLY = {
  smaller: ['Smaller', 'green'],
  same: ['Same', 'pending'],
  larger: ['Larger', 'red'],
  unclear: ['Unclear', 'future'],
};

function photoTrendHtml(r) {
  const pt = r.photo_trend;
  if (!pt) return '';
  const [label, cls] = BELLY[pt.belly] || BELLY.unclear;
  return `<div class="rv-photos">
      <p class="rv-label">What the photos show</p>
      <p><span class="pill ${esc(cls)}">Belly: ${esc(label)}</span></p>
      ${pt.note ? `<p class="rv-sub">${esc(pt.note)}</p>` : ''}
    </div>`;
}

export function reviewHtml(c, r, rerun) {
  const [verdictLabel, verdictClass] = VERDICTS[r.verdict] || VERDICTS.not_enough_data;
  const secs = [];
  if (r.likely_causes.length) {
    secs.push(['causes', 'Likely causes', r.likely_causes.map((x) => `<div class="rv-item">
      <div class="rv-item-head"><strong>${esc(x.cause)}</strong><span class="pill rv-conf conf-${esc(x.confidence)}">${esc(x.confidence)}</span></div>
      ${x.evidence ? `<p class="rv-sub">${esc(x.evidence)}</p>` : ''}${refsHtml(x)}</div>`).join('')]);
  }
  if (r.mistakes.length) {
    secs.push(['mistakes', 'Mistakes to fix', r.mistakes.map((x) => {
      const meta = [x.since ? `since ${dm(x.since)}` : '', x.how_often].filter(Boolean).join(' · ');
      return `<div class="rv-item"><strong>${esc(x.what)}</strong>
        ${meta ? `<p class="rv-sub">${esc(meta)}</p>` : ''}${x.fix ? `<p>Fix: ${esc(x.fix)}</p>` : ''}${refsHtml(x)}</div>`;
    }).join('')]);
  }
  const fc = r.food_changes;
  if (fc.add.length || fc.reduce.length || fc.swap.length) {
    secs.push(['food', 'Food changes', [
      fc.add.length ? `<p class="rv-label">Add</p>${listHtml(fc.add)}` : '',
      fc.reduce.length ? `<p class="rv-label">Reduce</p>${listHtml(fc.reduce)}` : '',
      fc.swap.length ? `<p class="rv-label">Swap</p>${listHtml(fc.swap.map((s) => `${s.from} → ${s.to}`))}` : '',
    ].join('')]);
  }
  if (r.new_local_foods.length) {
    secs.push(['foods', `${r.new_local_foods.length} new local foods`, r.new_local_foods.map((f) => `<div class="rv-item">
      <strong>${esc(f.dish)}</strong>${f.why ? `<p class="rv-sub">${esc(f.why)}</p>` : ''}${f.where ? `<p class="rv-refs">${esc(f.where)}</p>` : ''}</div>`).join('')]);
  }
  secs.push(['maint', 'Maintenance', maintenanceHtml(c, r)]);
  if (r.habits.length) secs.push(['habits', 'Habits', listHtml(r.habits)]);
  if (r.ask_doctor.length) {
    secs.push(['doctor', 'Ask your doctor', `${r.ask_doctor.map((a) => `<div class="rv-item"><strong>${esc(a.test)}</strong>${a.why ? `<p class="rv-sub">${esc(a.why)}</p>` : ''}</div>`).join('')}
      <button type="button" class="btn btn-secondary" data-role="rv-copy">Copy for my doctor</button>`]);
  }
  if (r.watch_next) secs.push(['watch', 'What to watch next', `<p>${esc(r.watch_next)}</p>`]);

  const rerunLabel = rerun.available ? 'Re-run review' : `Available on ${dm(rerun.onDate)}`;
  return `<div class="rv-head-card">
      <span class="pill ${esc(verdictClass)}">${esc(verdictLabel)}</span>
      <p class="rv-summary">${esc(r.summary)}</p>
      ${trendLine(r.trendAtReview)}
      <p class="rv-sub">Reviewed ${esc(dm(r.date))}</p>
    </div>
    ${photoTrendHtml(r)}
    <div class="rv-secs">${secs.map(([id, title, html], i) => section(id, title, html, i < 2)).join('')}</div>
    <div class="group"><div class="row">
      <span class="row-label">Use in meal suggestions</span>
      <input type="checkbox" class="switch" data-role="rv-use" aria-label="Use in meal suggestions" ${r.useInSuggestions !== false ? 'checked' : ''} />
    </div></div>
    <p class="section-footer error" data-role="rv-msg" aria-live="polite" hidden></p>
    <button type="button" class="btn btn-secondary" data-role="rv-rerun" ${rerun.available ? '' : 'disabled'}>${esc(rerunLabel)}</button>
    <p class="section-footer">General guidance, not medical advice. Talk to your doctor before changing medication or if you have a medical condition.</p>
    <button type="button" class="btn btn-primary" data-role="rv-close">Done</button>`;
}

function render(root, id) {
  const c = liveChallenge(id);
  const r = c && c.plateauReview;
  if (!c || !r || !r.verdict) {
    root.innerHTML = '<p class="section-footer">No review yet.</p><button type="button" class="btn btn-secondary" data-role="rv-close">Close</button>';
    return;
  }
  const rerun = rerunInfo(c, store.state.days[id] || {}, store.today());
  root.innerHTML = reviewHtml(c, r, rerun);
}

// ---------- actions ----------

function showMessage(root, text) {
  const el = root.querySelector('[data-role="rv-msg"]');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

function doctorText(r) {
  return `Questions for my doctor:\n${r.ask_doctor.map((a) => `- ${a.test}${a.why ? `: ${a.why}` : ''}`).join('\n')}`;
}

// Clipboard API first; a hidden textarea + execCommand where it's missing or
// refused (older iOS, insecure origins).
export async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to execCommand */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  ta.remove();
  return ok;
}

async function doApply(root, id, btn) {
  const c = liveChallenge(id);
  const r = c && c.plateauReview;
  if (!r) return;
  const kind = btn.dataset.kind === 'protein' ? 'protein' : 'kcal';
  const to = kind === 'protein' ? Number(btn.dataset.to) : r.maintenance.new_kcal;
  const days = kind === 'kcal' && r.maintenance.action === 'diet_break' ? r.maintenance.duration_days : null;
  btn.disabled = true;
  try {
    await store.updateChallenge(applyChange(c, store.today(), { kind, to, durationDays: days }));
    render(root, id);
  } catch (err) {
    btn.disabled = false;
    showMessage(root, (err && err.message) || "Couldn't apply that.");
  }
}

async function doUndo(root, id, btn) {
  const c = liveChallenge(id);
  if (!c) return;
  btn.disabled = true;
  try {
    await store.updateChallenge(revertChange(c));
    render(root, id);
  } catch (err) {
    btn.disabled = false;
    showMessage(root, (err && err.message) || "Couldn't undo that.");
  }
}

function wire(root, id, close, photoCtx = null) {
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-role]');
    if (!btn || !root.contains(btn)) return;
    const role = btn.dataset.role;
    if (role === 'rv-toggle') {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(open));
      const panel = root.querySelector(`#${btn.getAttribute('aria-controls')}`);
      if (panel) panel.hidden = !open;
    } else if (role === 'rv-close') {
      close();
    } else if (role === 'rv-profile') {
      close();
    } else if (role === 'rv-retry') {
      run(root, id);
    } else if (role === 'rv-rerun') {
      if (btn.disabled) return;
      const c = liveChallenge(id);
      // The last run used photos: ask again on the preview (nothing is sent without it).
      if (c && c.plateauReview && c.plateauReview.photo_trend && photosAllowed(c)) openBodyTrend(c);
      else run(root, id);
    } else if (role === 'bt-analyse') {
      if (photoCtx && photoCtx.blob) run(root, id, { picks: photoCtx.picks, blob: photoCtx.blob });
    } else if (role === 'bt-cancel') {
      close();
    } else if (role === 'rv-apply') {
      doApply(root, id, btn);
    } else if (role === 'rv-undo') {
      doUndo(root, id, btn);
    } else if (role === 'rv-copy') {
      const c = liveChallenge(id);
      if (!c || !c.plateauReview) return;
      const ok = await copyText(doctorText(c.plateauReview));
      const before = btn.dataset.label || btn.textContent;
      btn.dataset.label = before;
      btn.textContent = ok ? 'Copied' : "Couldn't copy";
      setTimeout(() => { if (btn.isConnected) btn.textContent = before; }, 1800);
    }
  });
  root.addEventListener('change', async (e) => {
    if (e.target.dataset.role !== 'rv-use') return;
    const input = e.target;
    try {
      await store.patchChallenge(id, { plateauReview: { ...liveChallenge(id).plateauReview, useInSuggestions: input.checked } });
    } catch (err) {
      input.checked = !input.checked;
      showMessage(root, (err && err.message) || "Couldn't save that.");
    }
  });
}
