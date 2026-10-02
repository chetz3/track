// Purely visual effects: count-up numbers, a one-shot tick pop and confetti.
// Nothing here reads or writes app state; every function is a no-op under
// prefers-reduced-motion and swallows its own errors.

const reduced = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return true; }
};

const lastCount = new Map(); // data-count key -> last numeric text shown
const lastDone = new Map();  // data-fx-key -> last '0' / '1'

// Elements `<span data-count="key">12.5</span>`: when the same key was shown
// before with a different number, tick from the old value to the new one.
export function runFx(root) {
  try {
    const skip = reduced();
    root.querySelectorAll('[data-count]').forEach((el) => {
      const key = el.dataset.count;
      const text = el.textContent.trim();
      const to = parseFloat(text);
      const prevText = lastCount.get(key);
      lastCount.set(key, text);
      if (skip || prevText == null || !Number.isFinite(to)) return;
      const from = parseFloat(prevText);
      if (!Number.isFinite(from) || from === to) return;
      const dec = (text.split('.')[1] || '').length;
      const t0 = performance.now();
      const step = (now) => {
        if (!el.isConnected) return;
        const p = Math.min(1, (now - t0) / 500);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = p < 1 ? (from + (to - from) * eased).toFixed(dec) : text;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    root.querySelectorAll('[data-fx-key]').forEach((el) => {
      const key = el.dataset.fxKey;
      const now = el.dataset.fxDone;
      const prev = lastDone.get(key);
      lastDone.set(key, now);
      if (!skip && prev === '0' && now === '1') el.classList.add('fx-pop');
    });
  } catch (_) { /* visual only */ }
}

// ~24 CSS confetti pieces from `anchor`, at most once per `flagKey` (localStorage).
export function confettiOnce(anchor, flagKey) {
  try {
    if (!anchor || reduced()) return;
    try {
      if (localStorage.getItem(flagKey)) return;
      localStorage.setItem(flagKey, '1');
    } catch (_) { /* storage blocked: still fine to show it this once */ }
    const box = document.createElement('div');
    box.className = 'confetti';
    box.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 24; i++) {
      const piece = document.createElement('i');
      const angle = (Math.PI * 2 * i) / 24 + Math.random() * 0.4;
      const dist = 90 + Math.random() * 90;
      piece.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
      piece.style.setProperty('--dy', `${Math.sin(angle) * dist - 30}px`);
      piece.style.setProperty('--rot', `${Math.round(Math.random() * 720 - 360)}deg`);
      piece.style.animationDelay = `${Math.random() * 0.15}s`;
      box.appendChild(piece);
    }
    anchor.appendChild(box);
    setTimeout(() => box.remove(), 1600);
  } catch (_) { /* visual only */ }
}
