// Expiry alert thresholds (PRD: 90/60/30/7 days). Pure and unit-tested.
export const ALERT_DAYS = [90, 60, 30, 7];

/** Which threshold (if any) a document has just reached; 0 means expired. */
export function dueThreshold(daysLeft, alreadySent = []) {
  if (daysLeft < 0) return alreadySent.includes(0) ? null : 0;
  const t = ALERT_DAYS.filter((d) => daysLeft <= d).at(-1);
  return t !== undefined && !alreadySent.includes(t) ? t : null;
}
