/**
 * Lockstep Chrome Version Comparison Helper
 * Compares 1–4 dot-separated integer Chrome version tuples.
 * Returns:
 *   1 if a > b
 *  -1 if a < b
 *   0 if equal, invalid, or missing
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 1, -1, or 0
 */
export function compareVersions(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a.trim() || !b.trim()) {
    return 0;
  }

  const parse = (v) => {
    const parts = v.trim().split('.');
    if (parts.length === 0 || parts.length > 4) return null;
    const nums = [];
    for (const part of parts) {
      if (!/^\d+$/.test(part)) return null;
      const n = Number(part);
      if (!Number.isSafeInteger(n) || n < 0) return null;
      nums.push(n);
    }
    while (nums.length < 4) {
      nums.push(0);
    }
    return nums;
  };

  const parsedA = parse(a);
  const parsedB = parse(b);
  if (!parsedA || !parsedB) return 0;

  for (let i = 0; i < 4; i++) {
    if (parsedA[i] > parsedB[i]) return 1;
    if (parsedA[i] < parsedB[i]) return -1;
  }
  return 0;
}
