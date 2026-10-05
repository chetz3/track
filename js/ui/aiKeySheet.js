// Launch / "Turn on AI (free)" sheet with two in-sheet steps: a compact
// welcome, then the bring-your-own Gemini key setup. Shown once per launch
// when no key is saved (see app.js, welcome mode) and from the top banner
// (setup step only). Steps swap on button clicks only; never re-render on
// input (that would close the phone keyboard); validation errors are written
// into an existing element.

import { openSheet } from './sheet.js';
import { setGeminiKey, GEMINI_KEY_RE } from '../gemini.js';

export const AI_PROMPT_DISMISSED_KEY = 'tracker:aiPromptDismissed';

const WELCOME_TITLE = 'Welcome to FueLoop';
const SETUP_TITLE = 'Turn on AI (free)';

function welcomeHtml() {
  return `<img class="ai-welcome-logo" src="./icons/logo.svg" width="56" height="56" alt="" />
    <p class="ai-welcome-sub">Food, workouts and habits — one loop, every day.</p>
    <div class="ai-welcome-card">
      <p class="ai-welcome-head"><svg class="icon" aria-hidden="true"><use href="#i-sparkles"/></svg> Optional: turn on AI (free, ~2 min)</p>
      <p>Snap a meal and get calories &amp; macros automatically, plus meal ideas. It uses your own free Google key, which stays on this phone.</p>
    </div>
    <button type="button" class="btn btn-primary" data-role="ai-key-setup">Set up AI</button>
    <button type="button" class="btn btn-secondary" data-role="ai-key-skip">Continue without AI</button>`;
}

function setupHtml(welcome) {
  return `<p><strong>This key is yours.</strong> It stays on this phone and uses your own free Gemini quota. We never see it.</p>
    <ol class="section-footer gemini-steps">
      <li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and sign in with Google.</li>
      <li>Tap <strong>Create API key</strong>. When asked for a project:<ul><li>Pick <strong>Default Gemini Project</strong> (Google creates it for most accounts), or any project you already have.</li><li>No project in the list? Tap <strong>Create project</strong>, name it anything (e.g. FueLoop), then create the key in it.</li></ul></li>
      <li>Copy the key (starts with <code>AIza</code> or <code>AQ.</code>), paste it below, and tap <strong>Save key</strong>.</li>
    </ol>
    <div class="group">
      <div class="row">
        <input type="password" data-role="ai-key-input" placeholder="Paste API key" autocomplete="off" autocapitalize="off" spellcheck="false" style="text-align:left" />
      </div>
    </div>
    <div class="section-footer error" data-role="ai-key-error" role="alert" hidden></div>
    <button type="button" class="btn btn-primary" data-role="ai-key-save">Save key</button>
    <button type="button" class="btn btn-secondary" data-role="${welcome ? 'ai-key-back' : 'ai-key-close'}">${welcome ? 'Back' : 'Not now'}</button>`;
}

export function openAiKeySheet({ welcome = false } = {}) {
  openSheet({
    title: welcome ? WELCOME_TITLE : SETUP_TITLE,
    bodyHtml: `<div id="ai-key-root">${welcome ? welcomeHtml() : setupHtml(false)}</div>`,
    onMount: (sheet, close) => {
      const root = sheet.querySelector('#ai-key-root');
      const titleEl = sheet.querySelector('.sheet-title');

      const showStep = (step) => {
        titleEl.textContent = step === 'welcome' ? WELCOME_TITLE : SETUP_TITLE;
        root.innerHTML = step === 'welcome' ? welcomeHtml() : setupHtml(welcome);
        // Re-attach the input listener after the swap.
        const input = root.querySelector('[data-role="ai-key-input"]');
        const errEl = root.querySelector('[data-role="ai-key-error"]');
        if (input) {
          // Clear a stale error as soon as the user edits; no re-render.
          input.addEventListener('input', () => { if (!errEl.hidden) errEl.hidden = true; });
        }
      };

      const save = () => {
        const input = root.querySelector('[data-role="ai-key-input"]');
        const errEl = root.querySelector('[data-role="ai-key-error"]');
        const value = input.value.trim();
        if (!GEMINI_KEY_RE.test(value)) {
          errEl.textContent = 'That doesn\'t look like a valid Gemini API key. Copy the whole key from Google AI Studio and try again.';
          errEl.hidden = false;
          return;
        }
        setGeminiKey(value);
        close();
      };

      root.addEventListener('click', (e) => {
        if (e.target.closest('[data-role="ai-key-save"]')) {
          save();
        } else if (e.target.closest('[data-role="ai-key-setup"]')) {
          showStep('setup');
        } else if (e.target.closest('[data-role="ai-key-back"]')) {
          showStep('welcome');
        } else if (e.target.closest('[data-role="ai-key-close"]')) {
          close();
        } else if (e.target.closest('[data-role="ai-key-skip"]')) {
          try { localStorage.setItem(AI_PROMPT_DISMISSED_KEY, '1'); } catch (_) { /* storage blocked */ }
          close();
        }
      });

      if (!welcome) showStep('setup');
    },
  });
}
