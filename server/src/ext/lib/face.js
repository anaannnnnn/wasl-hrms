// Face attendance engine (pure functions, unit-tested). The browser turns a camera frame into a 128-number face
// descriptor (face-api / FaceNet-style embedding); the server only ever stores and compares those numbers.
// Same-person descriptors are typically < 0.45 apart (Euclidean); different people are usually > 0.6.

export const DIM = 128;
export const ANGLES = ['front', 'left', 'right', 'up', 'down'];
export const DEFAULT_THRESHOLD = 0.5;

export const isDescriptor = (d) => Array.isArray(d) && d.length === DIM && d.every((x) => Number.isFinite(x) && Math.abs(x) < 10);

export function distance(a, b) {
  let s = 0;
  for (let i = 0; i < DIM; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

/** Closest stored sample to the probe, plus the mean of the two closest (steadier than a single sample). */
export function matchScore(probe, samples) {
  const ds = samples.map((s) => distance(probe, s.descriptor || s)).sort((x, y) => x - y);
  if (!ds.length) return { best: Infinity, score: Infinity };
  const score = ds.length > 1 ? (ds[0] + ds[1]) / 2 : ds[0];
  return { best: ds[0], score };
}

/** 0–100 confidence shown to people; 100 at distance 0, ~50 at the threshold, 0 at 2× threshold. */
export const confidence = (score, threshold = DEFAULT_THRESHOLD) => Math.max(0, Math.min(100, Math.round(100 - (score / threshold) * 50)));

/**
 * Check an enrollment scan before storing it: every required angle present, and every angle consistent with the
 * front view (catches a second person stepping in half-way, or a photo held up for one angle).
 */
export function validateEnrollment(samples, threshold = DEFAULT_THRESHOLD) {
  const errors = [];
  for (const s of samples) if (!isDescriptor(s.descriptor)) errors.push(`The ${s.angle || 'unknown'} sample is not a valid face scan.`);
  if (errors.length) return { ok: false, errors };
  const have = new Set(samples.map((s) => s.angle));
  const missing = ANGLES.filter((a) => !have.has(a));
  if (missing.length) errors.push(`Missing angles: ${missing.join(', ')}.`);
  const fronts = samples.filter((s) => s.angle === 'front');
  if (fronts.length) {
    const limit = threshold * 1.3; // turned heads drift further from the front view than a re-scan does
    for (const s of samples) {
      if (s.angle === 'front') continue;
      const d = Math.min(...fronts.map((f) => distance(f.descriptor, s.descriptor)));
      if (d > limit) errors.push(`The ${s.angle} view does not look like the same person as the front view. Rescan in good light.`);
    }
  }
  return { ok: !errors.length, errors };
}

/**
 * Decide a verification. `others` are other employees' profiles: if the face is a closer match to someone else,
 * it fails (buddy punching), even when it is also within the threshold of the signed-in employee.
 */
export function decide({ probe, own, others = [], threshold = DEFAULT_THRESHOLD, live = true }) {
  const mine = matchScore(probe, own);
  let closestOther = null;
  for (const o of others) {
    const m = matchScore(probe, o.samples);
    if (m.score < threshold && (!closestOther || m.score < closestOther.score)) closestOther = { employeeId: o.employeeId, score: m.score };
  }
  const reasons = [];
  if (!live) reasons.push('Liveness check not completed (blink or head movement missing).');
  if (!(mine.score <= threshold)) reasons.push('Face does not match your enrolled scan.');
  if (closestOther && closestOther.score < mine.score) reasons.push('Face is a closer match to another employee.');
  return { passed: !reasons.length, score: Math.round(mine.score * 1000) / 1000, confidence: confidence(mine.score, threshold), otherEmployeeId: closestOther && closestOther.score < mine.score ? closestOther.employeeId : null, reasons };
}
