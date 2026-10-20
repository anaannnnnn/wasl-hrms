import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceMeters, localParts, evaluateClockIn, evaluateDay, summarize, upcomingHolidays } from '../src/lib/attendance.js';

const site = { lat: 25.1385, lng: 55.2296, radiusM: 300, label: 'Al Quoz warehouse' };
const shift = { start: '08:00', end: '17:00', graceMin: 15 };

test('distance: same point is 0, ~1.1 km for 0.01° latitude', () => {
  assert.equal(distanceMeters(site, site), 0);
  const d = distanceMeters(site, { lat: site.lat + 0.01, lng: site.lng });
  assert.ok(d > 1100 && d < 1125, String(d));
});

test('localParts uses Dubai time (UTC+4)', () => {
  const p = localParts('2026-10-20T03:30:00Z', 'Asia/Dubai');
  assert.equal(p.date, '2026-10-20');
  assert.equal(p.minutes, 7 * 60 + 30);
  assert.equal(localParts('2026-10-20T21:00:00Z').date, '2026-10-21'); // 01:00 next day in Dubai
});

test('clock-in on site and on time', () => {
  const ev = evaluateClockIn({ at: '2026-10-20T04:05:00Z', gps: { lat: 25.1386, lng: 55.2297, accuracyM: 12 }, site, shift });
  assert.equal(ev.insideGeofence, true);
  assert.equal(ev.lateMinutes, 0);
  assert.equal(ev.status, 'present');
  assert.deepEqual(ev.flags, []);
});

test('clock-in late and outside the geofence is flagged, not blocked', () => {
  const ev = evaluateClockIn({ at: '2026-10-20T04:40:00Z', gps: { lat: 25.2048, lng: 55.2708, accuracyM: 20 }, site, shift });
  assert.equal(ev.insideGeofence, false);
  assert.equal(ev.lateMinutes, 25); // 08:40 vs 08:00 + 15 min grace
  assert.equal(ev.status, 'late');
  assert.ok(ev.flags.some((f) => f.code === 'OUTSIDE_GEOFENCE'));
  assert.ok(ev.flags.some((f) => f.code === 'LATE'));
});

test('GPS accuracy gives limited slack', () => {
  const near = { lat: site.lat + 0.0036, lng: site.lng }; // ~400 m away
  assert.equal(evaluateClockIn({ at: '2026-10-20T04:00:00Z', gps: { ...near, accuracyM: 120 }, site, shift }).insideGeofence, true);
  assert.equal(evaluateClockIn({ at: '2026-10-20T04:00:00Z', gps: { ...near, accuracyM: 5000 }, site, shift }).insideGeofence, false);
});

test('missing GPS is flagged', () => {
  const ev = evaluateClockIn({ at: '2026-10-20T04:00:00Z', gps: { error: 'Permission denied' }, site, shift });
  assert.equal(ev.insideGeofence, null);
  assert.ok(ev.flags.some((f) => f.code === 'NO_GPS' && f.msg.includes('Permission denied')));
});

test('day: 8h standard (9h shift - 1h break); overtime beyond it', () => {
  const d = evaluateDay({ clockInAt: '2026-10-20T04:00:00Z', clockOutAt: '2026-10-20T15:00:00Z', shift });
  assert.equal(d.standardMinutes, 480);
  assert.equal(d.minutesWorked, 600); // 11h minus 1h break
  assert.equal(d.overtimeMinutes, 120);
});

test('day: Ramadan shortens the standard day by 2 hours', () => {
  const d = evaluateDay({ clockInAt: '2026-10-20T04:00:00Z', clockOutAt: '2026-10-20T11:00:00Z', shift, ramadan: true });
  assert.equal(d.standardMinutes, 360);
  assert.equal(d.overtimeMinutes, 0);
});

test('summary counts', () => {
  const s = summarize([
    { clockIn: { at: 1, insideGeofence: true }, minutesWorked: 480, overtimeMinutes: 0, lateMinutes: 0 },
    { clockIn: { at: 1, insideGeofence: false }, minutesWorked: 540, overtimeMinutes: 60, lateMinutes: 10 },
    { clockIn: { at: 1 }, minutesWorked: null, lateMinutes: 0 },
  ]);
  assert.deepEqual(s, { daysPresent: 3, lateDays: 1, outsideGeofence: 1, hoursWorked: 17, overtimeHours: 1 });
});

test('upcoming holidays from a date', () => {
  assert.equal(upcomingHolidays('2026-10-20')[0].name, 'Commemoration Day');
});
