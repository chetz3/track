import test from 'node:test';
import assert from 'node:assert/strict';
import { pickWeeklyBodyPhotos, photoTrendReady } from '../js/photoTrend.js';
import { buildReviewInput, reviewPrompt, fitReviewInput, reviewContext, parseReview, REVIEW_BUDGET_CHARS } from '../js/coach.js';
import { fitnessMockData } from '../js/dev/mock.js';
import { mockReview } from '../js/dev/mockReview.js';
import { addDays } from '../js/rules.js';

const TODAY = '2026-10-10';
const ch = { steps: [{ id: 'b', type: 'body' }, { id: 'f', type: 'food' }] };
const day = (photoId, value, stepId = 'b') => ({ steps: { [stepId]: { photoId, value } } });

test('pickWeeklyBodyPhotos: latest per 7-day bucket, oldest first, skips empty weeks', () => {
  const days = {
    [addDays(TODAY, -1)]: day('p1', 80),
    [addDays(TODAY, -5)]: day('p2', 81),   // same bucket as -1: -1 wins
    [addDays(TODAY, -8)]: day('p3', 82),
    [addDays(TODAY, -22)]: day('p4'),      // bucket 3; bucket 2 empty
    [addDays(TODAY, -40)]: day('old'),     // outside window
  };
  const picks = pickWeeklyBodyPhotos(ch, days, TODAY);
  assert.deepEqual(picks.map((p) => p.photoId), ['p4', 'p3', 'p1']);
  assert.equal(picks[0].kg, null);
  assert.equal(picks[2].kg, 80);
  assert.ok(photoTrendReady(picks));
  assert.equal(photoTrendReady(picks.slice(0, 1)), false);
});

test('pickWeeklyBodyPhotos: cap of 4, ignores non-body photos and future dates', () => {
  const days = {};
  for (let w = 0; w < 6; w++) days[addDays(TODAY, -w * 7)] = day(`p${w}`, 80);
  days[addDays(TODAY, -2)] = day('meal', 1, 'f');
  days[addDays(TODAY, 1)] = day('future', 80);
  const picks = pickWeeklyBodyPhotos(ch, days, TODAY);
  assert.equal(picks.length, 4);
  assert.deepEqual(picks.map((p) => p.photoId), ['p3', 'p2', 'p1', 'p0']);
  assert.deepEqual(pickWeeklyBodyPhotos({ steps: [] }, days, TODAY), []);
});

function fixture() {
  const m = fitnessMockData(TODAY);
  const days = {};
  for (const e of m.entries) if (e.store === 'days') days[e.value.date] = e.value;
  return { challenge: m.challenge, days, start: m.startDate };
}

test('review input/prompt: photos and rule 10 only with photoDates; budget holds', () => {
  const { challenge, days, start } = fixture();
  const plain = buildReviewInput(challenge, days, TODAY, { startDate: start });
  assert.equal('photos' in plain, false);
  assert.equal(/Image = body photos/.test(reviewPrompt(plain)), false);
  const withP = fitReviewInput(buildReviewInput(challenge, days, TODAY, { startDate: start, photoDates: ['2026-09-20', '2026-10-01'] }));
  assert.deepEqual(withP.photos.dates, ['2026-09-20', '2026-10-01']);
  assert.match(reviewPrompt(withP), /10\. Image = body photos/);
  assert.ok(reviewPrompt(withP).length <= REVIEW_BUDGET_CHARS);
  console.log('extra prompt chars with photos:', reviewPrompt(withP).length - reviewPrompt(plain).length);
});

test('parseReview: photo_trend kept only when photosSent; bad enum -> unclear; you have dropped', async () => {
  const { challenge, days, start } = fixture();
  const input = buildReviewInput(challenge, days, TODAY, { startDate: start, photoDates: ['2026-10-01', '2026-10-08'] });
  const raw = await mockReview(input);
  assert.equal(raw.photo_trend.belly, 'same');
  const ctx = reviewContext(input);
  assert.equal(ctx.photosSent, true);
  assert.equal(parseReview(raw, ctx).photo_trend.belly, 'same');
  assert.equal('photo_trend' in parseReview(raw, { ...ctx, photosSent: false }), false);
  const bad = parseReview({ ...raw, photo_trend: { belly: 'huge', note: 'x'.repeat(300) } }, ctx).photo_trend;
  assert.equal(bad.belly, 'unclear');
  assert.ok(bad.note.length <= 160);
  assert.equal(parseReview({ ...raw, photo_trend: { belly: 'same', note: 'You have fatty liver' } }, ctx).photo_trend.note, '');
  const noPhotoInput = buildReviewInput(challenge, days, TODAY, { startDate: start });
  assert.equal('photo_trend' in await mockReview(noPhotoInput), false);
});
