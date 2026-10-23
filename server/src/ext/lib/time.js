// Time engines: public-holiday aware working days, roster/shift evaluation (split + overnight shifts),
// break rules, missed-punch detection and Ramadan date windows. Pure functions.
import { UAE_HOLIDAYS } from '../../lib/attendance.js';

const DAY = 86400000;
export const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
export const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat

/** Merge built-in UAE holidays with tenant-defined ones (tenant wins on the same date). */
export function holidaySet(tenantHolidays = [], establishmentId = null) {
  const map = new Map(UAE_HOLIDAYS.map((h) => [h.date, h.name]));
  for (const h of tenantHolidays) if (!h.establishmentId || !establishmentId || String(h.establishmentId) === String(establishmentId)) map.set(h.date, h.name);
  return map;
}

/**
 * Working days in [from, to] excluding weekend days and public holidays.
 * UAE federal weekend is Saturday–Sunday; private employers may differ, so it's configurable.
 */
export function workingDays(from, to, { holidays = new Map(), weekend = [0, 6] } = {}) {
  const out = { working: 0, weekend: 0, holidays: [] };
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (holidays.has(d)) out.holidays.push({ date: d, name: holidays.get(d) });
    else if (weekend.includes(weekday(d))) out.weekend++;
    else out.working++;
  }
  return out;
}

/** Scheduled minutes for a shift template (split shifts sum their segments; overnight segments wrap). */
export function shiftMinutes(shift, { ramadan = false } = {}) {
  const raw = (shift.segments || []).reduce((a, s) => { let e = hm(s.end); const b = hm(s.start); if (e <= b) e += 1440; return a + (e - b); }, 0);
  const unpaidBreak = shift.paidBreak ? 0 : (shift.segments?.length > 1 ? 0 : shift.breakMin || 0); // split shifts: the gap is the break
  return Math.max(0, raw - unpaidBreak - (ramadan ? (shift.ramadanReduceMin ?? 120) : 0));
}

export const isNightShift = (shift) => (shift.segments || []).some((s) => hm(s.end) <= hm(s.start) || hm(s.start) >= 22 * 60 || hm(s.end) <= 4 * 60);

/** Validate a roster week: rest day each 7 days, max hours, overlaps with leave. Returns warnings (never blocks). */
export function rosterWarnings(entries, shifts, { leaveDates = new Set(), maxWeeklyMin = 48 * 60 } = {}) {
  const byId = new Map(shifts.map((s) => [String(s._id), s]));
  const warnings = [];
  const days = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  let worked = 0;
  for (const e of days) {
    if (leaveDates.has(e.date) && !e.restDay) warnings.push({ date: e.date, code: 'ON_LEAVE', msg: 'Employee has approved leave on this day.' });
    if (!e.restDay && e.shiftId) worked += shiftMinutes(byId.get(String(e.shiftId)) || {});
  }
  if (days.length >= 7 && !days.some((e) => e.restDay)) warnings.push({ code: 'NO_REST_DAY', msg: 'No rest day in this 7-day window.' });
  if (worked > maxWeeklyMin) warnings.push({ code: 'OVER_HOURS', msg: `Scheduled ${Math.round(worked / 60)}h exceeds ${maxWeeklyMin / 60}h this week.` });
  return warnings;
}

/**
 * Evaluate worked time vs a rostered shift: lateness, early leaving, overtime and break compliance.
 * Times are local minutes from midnight; clockOut may be < clockIn for overnight.
 */
export function evaluateAgainstShift({ clockInMin, clockOutMin, shift, ramadan = false, breakTakenMin = null, minBreakAfterMin = 5 * 60, minBreakMin = 30 }) {
  const first = shift.segments[0]; const last = shift.segments[shift.segments.length - 1];
  const start = hm(first.start); let end = hm(last.end); if (end <= start) end += 1440;
  let out = clockOutMin; if (out != null && out < clockInMin) out += 1440;
  const lateMinutes = Math.max(0, clockInMin - start - (shift.graceMin || 0));
  const earlyLeaveMinutes = out == null ? 0 : Math.max(0, end - (ramadan ? (shift.ramadanReduceMin ?? 120) : 0) - out);
  const scheduled = shiftMinutes(shift, { ramadan });
  const breakMin = breakTakenMin ?? (shift.paidBreak ? 0 : shift.segments.length > 1 ? 0 : shift.breakMin || 0);
  const worked = out == null ? null : Math.max(0, out - clockInMin - breakMin);
  const flags = [];
  if (lateMinutes) flags.push({ code: 'LATE', msg: `${lateMinutes} min late` });
  if (earlyLeaveMinutes) flags.push({ code: 'EARLY_OUT', msg: `Left ${earlyLeaveMinutes} min early` });
  if (worked != null && worked > minBreakAfterMin && breakMin < minBreakMin) flags.push({ code: 'BREAK_SHORT', msg: `Break under ${minBreakMin} min after ${minBreakAfterMin / 60}h` });
  if (out == null) flags.push({ code: 'MISSED_PUNCH', msg: 'No clock-out recorded' });
  return { scheduledMinutes: scheduled, minutesWorked: worked, lateMinutes, earlyLeaveMinutes, overtimeMinutes: worked == null ? 0 : Math.max(0, worked - scheduled), flags };
}

/** Attendance records that need a missed-punch follow-up: clocked in, never out, and the shift day is over. */
export const missedPunches = (records, todayLocal) => records.filter((r) => r.clockIn?.at && !r.clockOut?.at && r.date < todayLocal);

/** Is a local date inside any configured Ramadan window? */
export const ramadanOn = (date, periods = []) => periods.find((p) => p.start <= date && date <= p.end) || null;

/** Leave days that are actually working days (for holiday-adjusted balances shown in the team calendar). */
export function leaveWorkingDays(startDate, endDate, opts) {
  return workingDays(new Date(startDate).toISOString().slice(0, 10), new Date(endDate).toISOString().slice(0, 10), opts);
}
