// Runtime rules registry: tenant-approved, effective-dated rule versions layered OVER the code rule packs.
// Draft versions never affect payroll. Approved versions are registered as new effective-dated packs
// (the original packs are untouched), so historical calculations keep the version they were made with.
import { RULE_PACKS, getRulePack } from '../../lib/rules.js';
import { calculateGratuity } from '../../lib/eosb.js';

const deepMerge = (a, b) => {
  if (b === undefined) return a;
  if (Array.isArray(b) || typeof b !== 'object' || b === null) return b;
  const out = { ...(a || {}) }; for (const [k, v] of Object.entries(b)) out[k] = deepMerge(out[k], v); return out;
};

/** Build a full pack object from a base pack + override, without registering it. */
export function composePack(rv) {
  const base = getRulePack(rv.packId, rv.effectiveFrom);
  return { ...deepMerge(base, rv.overrides || {}), id: rv.packId, version: rv.version, effectiveFrom: rv.effectiveFrom, effectiveTo: rv.effectiveTo || null, status: rv.status === 'approved' ? 'approved-by-tenant' : 'draft', source: rv.sourceRef || base.source, sourceUrls: rv.sourceUrls?.length ? rv.sourceUrls : base.sourceUrls, changeLog: [...(base.changeLog || []), { version: rv.version, date: new Date().toISOString().slice(0, 10), note: rv.changeNote || 'Tenant rule version' }] };
}

/** Run a version's test cases (gratuity cases supported; others compared shallowly). */
export function runTestCases(rv) {
  const pack = composePack(rv);
  const results = (rv.testCases || []).map((tc) => {
    try {
      if (tc.input?.kind === 'gratuity') {
        const tmpId = `__test__${rv.packId}`; const tmp = { ...pack, id: tmpId, effectiveFrom: '1900-01-01', effectiveTo: null };
        RULE_PACKS.push(tmp);
        try { const r = calculateGratuity({ ...tc.input, jurisdiction: tmpId }); const pass = tc.expect?.amountFils == null || r.amountFils === tc.expect.amountFils; return { name: tc.name, pass, got: { amountFils: r.amountFils }, expect: tc.expect }; } finally { RULE_PACKS.splice(RULE_PACKS.indexOf(tmp), 1); }
      }
      const path = tc.input?.path; const got = path ? path.split('.').reduce((o, k) => o?.[k], pack) : undefined;
      return { name: tc.name, pass: JSON.stringify(got) === JSON.stringify(tc.expect?.value), got, expect: tc.expect };
    } catch (e) { return { name: tc.name, pass: false, error: e.message }; }
  });
  return { passed: results.length > 0 && results.every((r) => r.pass), results };
}

/**
 * Register a tenant's approved versions as TENANT-SCOPED packs with id "<packId>::<tenantId>", so one tenant's
 * rules can never change another tenant's payroll. An establishment opts in by setting its rulePackId to that id
 * (done through the registry API, audited). Code packs and their windows are never edited; newer versions are
 * inserted ahead so getRulePack() picks the latest one effective on the calculation date.
 */
export const tenantPackId = (packId, tenantId) => `${packId}::${tenantId}`;
const registered = new Map();
export function registerApproved(versions) {
  const sorted = versions.filter((v) => v.status === 'approved').sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  for (const rv of sorted) {
    const id = tenantPackId(rv.packId, rv.tenantId); const key = `${id}@${rv.version}`; if (registered.has(key)) continue;
    // First version for this tenant pack: also register the code pack's own windows under the tenant id (lowest
    // priority), so calculations dated BEFORE the tenant's first effective date still resolve exactly as before.
    if (!registered.has(`${id}@base`)) { for (const base of RULE_PACKS.filter((p) => p.id === rv.packId)) RULE_PACKS.push({ ...base, id }); registered.set(`${id}@base`, true); }
    const pack = { ...composePack(rv), id };
    RULE_PACKS.unshift(pack); registered.set(key, pack);
  }
  return [...registered.keys()];
}
export const registeredVersions = (tenantId) => [...registered.keys()].filter((k) => !k.endsWith('@base') && (!tenantId || k.includes(`::${tenantId}@`)));

/** Preview the effect of a rule version on gratuity for a list of employees (never writes). */
export function recalcPreview(rv, employees, { asOf = new Date() } = {}) {
  const tmpId = `__preview__${rv.packId}`; const tmp = { ...composePack(rv), id: tmpId, effectiveFrom: '1900-01-01', effectiveTo: null };
  RULE_PACKS.push(tmp);
  try {
    return employees.map((e) => {
      const input = { basicMonthlyFils: e.compensation.basicFils, totalMonthlyFils: e.compensation.basicFils + e.compensation.housingFils + e.compensation.transportFils, joinDate: e.joinDate, lastWorkingDate: asOf };
      let cur = null, next = null;
      try { cur = calculateGratuity({ ...input, jurisdiction: rv.packId }).amountFils; } catch { /* no current pack */ }
      try { next = calculateGratuity({ ...input, jurisdiction: tmpId }).amountFils; } catch (err) { next = null; }
      return { employeeId: e._id, employeeName: e.fullName, currentFils: cur, proposedFils: next, deltaFils: cur != null && next != null ? next - cur : null };
    });
  } finally { RULE_PACKS.splice(RULE_PACKS.indexOf(tmp), 1); }
}
