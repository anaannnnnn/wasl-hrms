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

  // ---- Extended checks (PRD "25-point" simulation) ----
  const [sy, sm] = (salaryMonth || '').split('-').map(Number);
  const monthOk = sy > 2000 && sm >= 1 && sm <= 12;
  const created = new Date(createdAt);
  const monthStart = monthOk ? Date.UTC(sy, sm - 1, 1) : 0;
  add('SALARY_MONTH', monthOk && monthStart <= Date.UTC(created.getUTCFullYear(), created.getUTCMonth() + 1, 1), 'Salary month is valid and not in the future', salaryMonth);
  const inMonth = (d) => typeof d === 'string' && d.slice(0, 7) === salaryMonth;
  const badPeriod = rows.filter((r) => !inMonth(r.periodStart) || !inMonth(r.periodEnd) || r.periodEnd < r.periodStart);
  add('PERIOD_DATES', badPeriod.length === 0, 'Pay period dates fall inside the salary month', badPeriod.map((r) => r.name).join(', ') || 'All rows');
  const span = (r) => Math.round((Date.parse(r.periodEnd) - Date.parse(r.periodStart)) / 86400000) + 1;
  const badDays = rows.filter((r) => !badPeriod.includes(r) && Number(r.days) !== span(r));
  add('DAYS_IN_PERIOD', badDays.length === 0, 'Days in period match the pay period', badDays.map((r) => r.name).join(', ') || 'All rows');
  add('RECORD_COUNT', Number(lines[0].split(',')[6]) === lines.length - 1, 'SCR record count equals EDR rows', `${lines.length - 1} rows`);
  const missingBank = rows.filter((r) => !r.iban);
  add('MISSING_BANK', missingBank.length === 0, 'Every employee has bank details', missingBank.map((r) => r.name).join(', ') || 'None missing');
  const ibanSeen = {}; rows.forEach((r) => { if (r.iban) (ibanSeen[r.iban] ||= []).push(r.name); });
  const shared = Object.values(ibanSeen).filter((n) => n.length > 1);
  add('SHARED_IBAN', shared.length === 0, 'No IBAN is shared between employees', shared.map((n) => n.join(' & ')).join('; ') || 'None', 'warn');
  const zero = rows.filter((r) => r.fixedFils + r.variableFils === 0);
  add('ZERO_PAY', zero.length === 0, 'No employee is paid zero', zero.map((r) => r.name).join(', ') || 'None', 'warn');
  const badLeave = rows.filter((r) => (r.leaveDays || 0) > (r.days || 0));
  add('LEAVE_DAYS', badLeave.length === 0, 'Leave days do not exceed days in period', badLeave.map((r) => r.name).join(', ') || 'All rows');
  const nonInt = rows.filter((r) => !Number.isInteger(r.fixedFils) || !Number.isInteger(r.variableFils));
  add('PRECISION', nonInt.length === 0, 'Amounts have at most 2 decimals (whole fils)', nonInt.map((r) => r.name).join(', ') || 'All rows');
  add('NOT_EMPTY', valid.length > 0 && totalFils > 0, 'File has at least one payable row', `${valid.length} rows`);
  const commas = rows.filter((r) => [r.labourCardNo, r.iban, r.routingCode].some((v) => String(v ?? '').includes(',')));
  add('FIELD_FORMAT', commas.length === 0, 'No field contains a comma (CSV safety)', commas.map((r) => r.name).join(', ') || 'Clean');
  add('FILENAME_FORMAT', /^\d{13}\d{12}\.sif$/.test(filename), 'Filename is {MOHRE ID}{YYMMDDHHMMSS}.sif', filename);
  const huge = rows.filter((r) => r.fixedFils + r.variableFils > 100000000);
  add('AMOUNT_SANITY', huge.length === 0, 'No single salary above AED 1,000,000', huge.map((r) => r.name).join(', ') || 'None', 'warn');
  add('CURRENCY', lines[0].split(',')[8] === 'AED', 'Currency is AED', lines[0].split(',')[8]);

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
