// Attendance engine: geofence distance, local work date, lateness, hours and overtime.
// Pure functions only, so they can be unit-tested without a database.

const R = 6371000; // Earth radius in metres
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres between two lat/lng points. */
export function distanceMeters(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** Local calendar parts for a timezone (UAE has no DST, but use Intl so other zones work). */
export function localParts(date, timeZone = 'Asia/Dubai') {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: p.weekday };
}

const hm = (s) => { const [h, m] = String(s || '00:00').split(':').map(Number); return h * 60 + (m || 0); };

/**
 * Evaluate a clock-in against the site geofence and shift.
 * GPS problems never block a clock-in (frontline phones often have poor signal); they are flagged for HR instead.
 */
export function evaluateClockIn({ at = new Date(), gps, site, shift, timeZone = 'Asia/Dubai', ramadan = false }) {
  const flags = [];
  const local = localParts(at, timeZone);
  let distanceM = null, insideGeofence = null;
  if (gps && Number.isFinite(gps.lat) && Number.isFinite(gps.lng)) {
    if (site && Number.isFinite(site.lat) && Number.isFinite(site.lng)) {
      distanceM = distanceMeters(gps, site);
      // allow for the phone's own accuracy radius (capped); a very poor fix gets no allowance at all
      const acc = gps.accuracyM || 0;
      const slack = acc <= 250 ? Math.min(acc, 150) : 0;
      insideGeofence = distanceM <= (site.radiusM || 300) + slack;
      if (!insideGeofence) flags.push({ code: 'OUTSIDE_GEOFENCE', msg: `Clocked in ${distanceM >= 1000 ? `${(distanceM / 1000).toFixed(1)} km` : `${distanceM} m`} from ${site.label || 'the work site'}` });
    }
    if (gps.accuracyM > 200) flags.push({ code: 'LOW_GPS_ACCURACY', msg: `Location accuracy was ±${Math.round(gps.accuracyM)} m` });
  } else {
    flags.push({ code: 'NO_GPS', msg: gps?.error ? `Location unavailable: ${gps.error}` : 'Location was not shared' });
  }
  const start = hm(shift?.start || '08:00');
  const grace = shift?.graceMin ?? 15;
  const lateMinutes = Math.max(0, local.minutes - start - grace);
  if (lateMinutes > 0) flags.push({ code: 'LATE', msg: `${lateMinutes} min after the grace period` });
  return { date: local.date, localMinutes: local.minutes, distanceM, insideGeofence, lateMinutes, status: lateMinutes > 0 ? 'late' : 'present', flags, ramadan };
}

/**
 * Hours worked and overtime for a completed day.
 * Ramadan mode shortens the standard day by 2 hours (PRD §4.3). Overtime is time beyond the standard day;
 * its pay rate (125% / 150%) is applied by payroll, not here.
 */
export function evaluateDay({ clockInAt, clockOutAt, shift, ramadan = false, breakMin = 60 }) {
  if (!clockInAt || !clockOutAt) return { minutesWorked: null, overtimeMinutes: 0 };
  const raw = Math.max(0, Math.round((new Date(clockOutAt) - new Date(clockInAt)) / 60000));
  const standard = Math.max(0, hm(shift?.end || '17:00') - hm(shift?.start || '08:00') - breakMin - (ramadan ? 120 : 0));
  const worked = Math.max(0, raw - (raw > 6 * 60 ? breakMin : 0));
  return { minutesWorked: worked, standardMinutes: standard, overtimeMinutes: Math.max(0, worked - standard) };
}

/** Monthly summary for an employee's attendance records. */
export function summarize(records) {
  const done = records.filter((r) => r.minutesWorked != null);
  return {
    daysPresent: new Set(records.filter((r) => r.clockIn?.at).map((r, i) => r.date ?? `#${i}`)).size, // a day with several sessions counts once
    lateDays: records.filter((r) => r.lateMinutes > 0).length,
    outsideGeofence: records.filter((r) => r.clockIn?.insideGeofence === false).length,
    hoursWorked: Math.round(done.reduce((a, r) => a + r.minutesWorked, 0) / 6) / 10,
    overtimeHours: Math.round(done.reduce((a, r) => a + (r.overtimeMinutes || 0), 0) / 6) / 10,
  };
}

/** UAE public holidays (fixed-date ones exact; Islamic holidays are moon-sighting dependent and marked estimated). */
export const UAE_HOLIDAYS = [
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-03-20', name: 'Eid Al Fitr', estimated: true },
  { date: '2026-05-26', name: 'Arafat Day', estimated: true },
  { date: '2026-05-27', name: 'Eid Al Adha', estimated: true },
  { date: '2026-06-16', name: 'Islamic New Year', estimated: true },
  { date: '2026-08-25', name: "Prophet Muhammad's Birthday", estimated: true },
  { date: '2026-12-01', name: 'Commemoration Day' },
  { date: '2026-12-02', name: 'National Day' },
  { date: '2026-12-03', name: 'National Day holiday' },
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-03-10', name: 'Eid Al Fitr', estimated: true },
];
export const upcomingHolidays = (fromDate, n = 3) => UAE_HOLIDAYS.filter((h) => h.date >= fromDate).slice(0, n);
