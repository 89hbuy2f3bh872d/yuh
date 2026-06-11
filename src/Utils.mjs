export function parseBet(raw, balance) {
  if (!raw) return null;
  const s = String(raw).toLowerCase().trim();
  if (s === "all" || s === "allin") return balance;
  if (s === "half") return Math.floor(balance / 2);
  const mults = { k: 1000, m: 1000000, b: 1000000000 };
  for (const [sfx, mult] of Object.entries(mults)) {
    if (s.endsWith(sfx)) {
      const n = parseFloat(s.slice(0, -1));
      return isNaN(n) ? null : Math.floor(n * mult);
    }
  }
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}
