// Entry point for "Why isn't it moving?" (Stats) and the Today coach card.
// R1: with no AI key it opens the add-key flow, otherwise a small
// "coming soon" sheet. R2 replaces the body of openReviewEntry with the real
// review sheet; keep the name and signature.

import { openSheet } from './sheet.js';
import { openAiKeySheet } from './aiKeySheet.js';
import { getGeminiKey } from '../gemini.js';

export function openReviewEntry(challenge) { // eslint-disable-line no-unused-vars
  if (!getGeminiKey()) {
    openAiKeySheet();
    return;
  }
  openSheet({
    title: 'Why isn\'t it moving?',
    bodyHtml: `<div id="review-root">
      <p>AI review is coming in the next update.</p>
      <button type="button" class="btn btn-secondary" data-role="review-close">Close</button>
    </div>`,
    onMount: (sheet, close) => {
      sheet.querySelector('[data-role="review-close"]').addEventListener('click', close);
    },
  });
}
