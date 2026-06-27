// src/core/week.ts
// ISO 8601 week number. Pure date arithmetic, no deps.
export function isoWeekKey(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`isoWeekKey: invalid date format "${date}" (expected YYYY-MM-DD)`);
  }
  const d = new Date(date + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) {
    throw new Error(`isoWeekKey: invalid date "${date}"`);
  }
  // Reject impossible days that JS Date rolls over (e.g. 2026-02-31 -> Mar 3).
  if (d.toISOString().slice(0, 10) !== date) {
    throw new Error(`isoWeekKey: impossible date "${date}"`);
  }
  // Shift to Thursday of this week — ISO weeks are defined by their Thursday.
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - day + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}
