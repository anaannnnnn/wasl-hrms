// WPS Salary Information File (.SIF) builder + pre-flight validator.
// Field order follows the PRD blueprint. Confirm against your agent bank's
// current specification before go-live: banks differ in column order details.
import { isValidUaeIban } from './iban.js';
import { filsToPlain, sumFils } from './money.js';

const pad2 = (n) => String(n).padStart(2, '0');

export function sifFilename(employerId, createdAt) {
  const d = new Date(createdAt);
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${employerId}${yy}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}.sif`;
}

/**
 * @param {object} p
 * @param {object} p.establishment {mohreId, agentRoutingCode}
 * @param {string} p.salaryMonth 'YYYY-MM'
 * @param {Date}   p.createdAt
 * @param {Array}  p.rows [{labourCardNo, routingCode, iban, periodStart, periodEnd, days, fixedFils, variableFils, leaveDays, name}]
 */
export function preflight({ establishment, salaryMonth, createdAt, rows }) {
  const checks = [];
  const add = (id, ok, label, detail, severity = 'block') =>
    checks.push({ id, status: ok ? 'pass' : severity === 'block' ? 'fail' : 'warn', label, detail });

  add('EMPLOYER_ID', /^\d{13}$/.test(establishment.mohreId || ''), 'Employer MOHRE ID is 13 digits', establishment.mohreId);
  add('AGENT_ROUTING', /^\d{9}$/.test(establishment.agentRoutingCode || ''), 'Agent bank routing code is 9 digits', establishment.agentRoutingCode);

  const badCards = rows.filter((r) => !/^\d{14}$/.test(r.labourCardNo || ''));
  add('LABOUR_CARD', badCards.length === 0, 'Labour card numbers are 14 digits', badCards.map((r) => r.name).join(', ') || `${rows.length}/${rows.length}`);

  const badRouting = rows.filter((r) => !/^\d{9}$/.test(r.routingCode || ''));
  add('EMP_ROUTING', badRouting.length === 0, 'Employee bank routing codes are 9 digits', badRouting.map((r) => r.name).join(', ') || 'All valid');

  const badIban = rows.filter((r) => !isValidUaeIban(r.iban));
  add('IBAN', badIban.length === 0, 'IBAN format and mod-97 checksum', badIban.map((r) => `${r.name}: ${r.iban}`).join('; ') || 'All valid');

  const dupes = rows.filter((r, i) => rows.findIndex((x) => x.labourCardNo === r.labourCardNo) !== i);
  add('DUPLICATE', dupes.length === 0, 'No duplicate employees in batch', dupes.map((r) => r.name).join(', ') || 'None');

  const negative = rows.filter((r) => r.fixedFils < 0 || r.variableFils < 0);
  add('NEGATIVE', negative.length === 0, 'No negative salary amounts', negative.map((r) => r.name).join(', ') || 'None');

  const valid = rows.filter((r) => !badIban.includes(r) && !badCards.includes(r));
  const totalFils = sumFils(valid.map((r) => r.fixedFils + r.variableFils));
  const lines = buildLines({ establishment, salaryMonth, createdAt, rows: valid, totalFils });
  // re-parse the generated EDR amounts to prove SCR == sum(EDR) to the fils
  const edrSum = sumFils(lines.slice(1).map((l) => { const c = l.split(','); return Math.round(Number(c[7]) * 100) + Math.round(Number(c[8]) * 100); }));
  add('TOTALS', edrSum === totalFils, 'SCR total equals sum of EDR rows (to the fils)', `${filsToPlain(totalFils)} vs ${filsToPlain(edrSum)}`);

  const filename = sifFilename(establishment.mohreId, createdAt);
  add('FILENAME', filename.slice(13, 19) === lines[0].split(',')[3].replace(/-/g, '').slice(2), 'Filename date matches SCR creation date', filename);

  const blocking = checks.filter((c) => c.status === 'fail').length;
  return { checks, blocking, filename, content: lines.join('\r\n') + '\r\n', recordCount: valid.length, totalFils, heldRows: rows.length - valid.length };
}

function buildLines({ establishment, salaryMonth, createdAt, rows, totalFils }) {
  const d = new Date(createdAt);
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const time = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
  const [y, m] = salaryMonth.split('-');
  const scr = ['SCR', establishment.mohreId, establishment.agentRoutingCode, date, time, `${m}${y}`, rows.length, filsToPlain(totalFils), 'AED', ''].join(',');
  const edr = rows.map((r) => ['EDR', r.labourCardNo, r.routingCode, r.iban, r.periodStart, r.periodEnd, r.days, filsToPlain(r.fixedFils), filsToPlain(r.variableFils), r.leaveDays || 0, ''].join(','));
  return [scr, ...edr];
}
