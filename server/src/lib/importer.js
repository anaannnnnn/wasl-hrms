// CSV employee import with validation, duplicate detection and a dry-run preview. Pure functions.
import { isValidUaeIban } from './iban.js';
import { toFils } from './money.js';

export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

export const TEMPLATE_COLUMNS = ['employee_no', 'full_name', 'full_name_ar', 'email', 'phone', 'nationality', 'uae_national', 'job_title', 'department', 'mohre_skill_level', 'join_date', 'contract_type', 'basic', 'housing', 'transport', 'iban', 'bank_routing_code', 'labour_card_no', 'pension_registered'];
export const templateCsv = () => `${TEMPLATE_COLUMNS.join(',')}\nANT-201,Sara Example,سارة مثال,sara@example.com,+971501234567,India,no,Accountant,Finance,2,2024-03-01,full-time,8000,3000,1000,AE070331234567890123456,302620122,94821370009999,no\n`;

const yes = (v) => /^(y|yes|true|1)$/i.test(String(v).trim());
const alias = { emp_no: 'employee_no', name: 'full_name', 'full name': 'full_name', 'joining date': 'join_date', 'basic salary': 'basic', 'labour card': 'labour_card_no', 'routing code': 'bank_routing_code' };

/**
 * @returns { valid: [{row, data}], errors: [{row, field, msg}], duplicates: [] , columns }
 */
export function validateImport(text, { existingEmployeeNos = [], existingLabourCards = [] } = {}) {
  const rows = parseCsv(text);
  if (!rows.length) return { valid: [], errors: [{ row: 0, field: 'file', msg: 'The file is empty.' }], columns: [] };
  const head = rows[0].map((h) => { const k = h.trim().toLowerCase(); return alias[k] || k.replace(/\s+/g, '_'); });
  const missing = ['employee_no', 'full_name', 'join_date', 'basic'].filter((c) => !head.includes(c));
  if (missing.length) return { valid: [], errors: [{ row: 1, field: missing.join(', '), msg: `Missing required column(s): ${missing.join(', ')}` }], columns: head };
  const errors = [], valid = [], seenNo = new Set(existingEmployeeNos), seenCard = new Set(existingLabourCards.filter(Boolean));
  rows.slice(1).forEach((r, i) => {
    const line = i + 2; const v = Object.fromEntries(head.map((h, j) => [h, (r[j] ?? '').trim()]));
    const err = (field, msg) => errors.push({ row: line, field, msg });
    if (!v.employee_no) err('employee_no', 'Required'); else if (seenNo.has(v.employee_no)) err('employee_no', `Duplicate employee number ${v.employee_no}`);
    if (!v.full_name) err('full_name', 'Required');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.join_date) || Number.isNaN(Date.parse(v.join_date))) err('join_date', 'Use YYYY-MM-DD');
    const money = {};
    for (const k of ['basic', 'housing', 'transport']) { try { money[k] = v[k] ? toFils(v[k]) : 0; } catch { err(k, 'Not a valid AED amount'); } }
    if (v.iban && !isValidUaeIban(v.iban.replace(/\s/g, ''))) err('iban', 'IBAN fails the UAE checksum');
    if (v.bank_routing_code && !/^\d{9}$/.test(v.bank_routing_code)) err('bank_routing_code', 'Must be 9 digits');
    if (v.labour_card_no) { if (!/^\d{14}$/.test(v.labour_card_no)) err('labour_card_no', 'Must be 14 digits'); else if (seenCard.has(v.labour_card_no)) err('labour_card_no', 'Duplicate labour card'); }
    if (v.mohre_skill_level && !/^[1-9]$/.test(v.mohre_skill_level)) err('mohre_skill_level', '1 to 9');
    if (v.contract_type && !['full-time', 'part-time', 'temporary', 'flexible'].includes(v.contract_type)) err('contract_type', 'full-time, part-time, temporary or flexible');
    if (errors.some((e) => e.row === line)) return;
    seenNo.add(v.employee_no); if (v.labour_card_no) seenCard.add(v.labour_card_no);
    valid.push({
      row: line,
      data: {
        employeeNo: v.employee_no, fullName: v.full_name, fullNameAr: v.full_name_ar || undefined, email: v.email || undefined, phone: v.phone || undefined,
        nationality: v.nationality || undefined, isUaeNational: yes(v.uae_national), jobTitle: v.job_title || undefined, department: v.department || undefined,
        mohreSkillLevel: v.mohre_skill_level ? Number(v.mohre_skill_level) : undefined, joinDate: new Date(v.join_date), contractType: v.contract_type || 'full-time',
        pensionRegistered: yes(v.pension_registered), status: 'active',
        compensation: { basicFils: money.basic, housingFils: money.housing, transportFils: money.transport, effectiveFrom: new Date(v.join_date) },
        bank: { iban: v.iban ? v.iban.replace(/\s/g, '') : undefined, routingCode: v.bank_routing_code || undefined },
        labourCardNo: v.labour_card_no || undefined,
      },
    });
  });
  return { valid, errors, columns: head };
}
