/**
 * Lightweight password strength evaluator — no external library.
 * Returns { score: 0..4, label, hint, classes: { upper, lower, digit, symbol, length } }
 * Mirrors the backend rule: min 10 chars + ≥3 of {upper, lower, digit, symbol}.
 */
export function evaluatePassword(pwd) {
  const classes = {
    length: (pwd?.length || 0) >= 10,
    lower: /[a-z]/.test(pwd),
    upper: /[A-Z]/.test(pwd),
    digit: /\d/.test(pwd),
    symbol: /[^A-Za-z0-9]/.test(pwd),
  };
  const classCount = ['lower', 'upper', 'digit', 'symbol'].filter((k) => classes[k]).length;
  let score = 0;
  if (classes.length) score += 1;
  if (classCount >= 2) score += 1;
  if (classCount >= 3) score += 1;
  if (pwd && pwd.length >= 14 && classCount >= 3) score += 1;

  const labels = ['Too weak', 'Weak', 'Okay', 'Strong', 'Excellent'];
  const meetsMinimum = classes.length && classCount >= 3;

  let hint = '';
  if (!classes.length) hint = `Use at least 10 characters (you have ${pwd?.length || 0}).`;
  else if (classCount < 3) {
    const need = ['lowercase', 'uppercase', 'digit', 'symbol'].filter((k, i) => {
      const key = ['lower', 'upper', 'digit', 'symbol'][i];
      return !classes[key];
    });
    hint = `Add ${need.slice(0, 3 - classCount).join(' + ')} for a stronger password.`;
  } else if (score < 3) hint = 'Try 14+ characters for extra strength.';
  else hint = 'Looks great.';

  return { score, label: labels[score], hint, classes, meetsMinimum };
}
