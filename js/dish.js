// Dish-name normalisation shared by the planner, trend and meal-suggestion
// code — a leaf module (no imports) so any of them can use it without an
// import cycle.

// Lower-cased, punctuation dropped, whitespace collapsed, and a simple plural
// "s" dropped from each word ("Idlis" → "idli"), so "Masala Dosa!" and
// "masala dosas" compare equal. Short words (≤ 3 letters) and "-ss" endings
// keep their s ("dal", "bass").
export function normDish(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}
