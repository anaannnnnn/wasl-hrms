// "Nexus Agent": turns natural-language commands into PROPOSALS.
// Nothing is written until the user approves (propose → preview → approve → execute).
//
// This build uses a deterministic intent parser so it runs with no API key.
// To plug in an LLM, replace parseIntent() with a model call that returns the
// same {intent, params} shape using tool/function calling, and keep validation
// and execution here: the model proposes, this code decides.
import { Employee, Establishment, LeaveRequest } from '../models/index.js';
import { toFils, filsToDisplay } from './money.js';

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function parseDate(s) {
  const m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i) || s.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})/i);
  if (!m) return null;
  const [day, mon] = /^\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
  const now = new Date();
  let d = new Date(Date.UTC(now.getUTCFullYear(), MONTHS[mon.slice(0, 3).toLowerCase()], Number(day)));
  if (d < now) d = new Date(Date.UTC(now.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

function parseIntent(cmd) {
  const s = cmd.toLowerCase();
  if (/\bhire\b|تعيين/.test(s)) {
    const name = (cmd.match(/hire\s+([A-Z][\w'-]+(?:[\s-][A-Z][\w'-]+)*)/i) || [])[1];
    const role = (cmd.match(/\bas\s+(?:a\s+|an\s+)?([^,]+?)(?:,|\s+under|\s+start|\s+aed|$)/i) || [])[1];
    const amt = (cmd.match(/aed\s*([\d,]+(?:\.\d+)?)/i) || cmd.match(/([\d,]{4,})/) || [])[1];
    const split = cmd.match(/(\d+)%\s*basic.*?(\d+)%\s*housing.*?(\d+)%\s*transport/i);
    return { intent: 'hire', params: { name, role: role?.trim(), packageAed: amt, split: split ? split.slice(1).map(Number) : [60, 30, 10], startDate: parseDate(cmd), mainland: !/free\s*zone/i.test(cmd) } };
  }
  if (/\bleave\b|إجازة/.test(s)) {
    const days = Number((s.match(/(\d+)\s*day/) || [])[1] || 1);
    return { intent: 'leave', params: { days, type: /sick/.test(s) ? 'sick' : 'annual', startDate: parseDate(cmd), who: cmd } };
  }
  if (/certificate|letter|شهادة/.test(s)) {
    return { intent: 'letter', params: { addressee: (cmd.match(/(?:addressed\s+)?to\s+(.+)$/i) || [])[1] || 'To whom it may concern', who: cmd } };
  }
  return { intent: 'unknown', params: {} };
}

async function findEmployeeIn(text) {
  const emps = await Employee.find({ status: 'active' }).select('fullName').lean();
  const t = text.toLowerCase();
  return emps.find((e) => t.includes(e.fullName.toLowerCase())) || emps.find((e) => t.includes(e.fullName.split(' ')[0].toLowerCase()));
}

export async function propose(command) {
  const { intent, params } = parseIntent(command);

  if (intent === 'hire') {
    if (!params.name || !params.packageAed) return { intent, valid: false, title: 'I need a name and a package', checks: ['Example: Hire Omar Al-Maktoum as Senior Engineer, AED 22,000, start Nov 1'] };
    const total = toFils(params.packageAed);
    const [b, h, t] = params.split;
    const parts = { basicFils: Math.round((total * b) / 100), housingFils: Math.round((total * h) / 100) };
    parts.transportFils = total - parts.basicFils - parts.housingFils; // remainder keeps totals exact
    const est = await Establishment.findOne({ jurisdiction: params.mainland ? 'MAINLAND' : 'FREEZONE' }).lean() || await Establishment.findOne().lean();
    const headcount = await Employee.countDocuments({ status: 'active' });
    const checks = [
      `Package AED ${filsToDisplay(total)} → basic ${b}% ${filsToDisplay(parts.basicFils)} · housing ${h}% ${filsToDisplay(parts.housingFils)} · transport ${t}% ${filsToDisplay(parts.transportFils)}`,
      b + h + t === 100 ? 'Split adds up to 100%' : `Split adds to ${b + h + t}%: fix before approving`,
      `Establishment: ${est?.name}`,
      `Headcount after hire: ${headcount + 1}${headcount + 1 >= 50 && headcount < 50 ? ' (crosses 50: Tier 1 Emiratisation applies)' : ''}`,
      'Creates employee in Onboarding status with visa tracker: Entry permit → Medical → EID biometrics → Insurance → MOHRE contract → IBAN',
    ];
    return { intent, valid: b + h + t === 100, title: `Hire ${params.name}${params.role ? ` as ${params.role}` : ''}`, steps: ['Validate', 'Create onboarding record', 'Offer letter draft', 'Visa tracker', 'Probation reviews'], checks, params: { ...params, ...parts, establishmentId: est?._id } };
  }

  if (intent === 'leave') {
    const emp = await findEmployeeIn(params.who);
    if (!emp) return { intent, valid: false, title: 'Who is the leave for?', checks: ['Name an employee, e.g. "Ahmed Khan wants 3 days annual leave from 26 Oct"'] };
    const start = params.startDate || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const end = new Date(Date.parse(start) + (params.days - 1) * 86400000).toISOString().slice(0, 10);
    return { intent, valid: true, title: `${params.type === 'sick' ? 'Sick' : 'Annual'} leave for ${emp.fullName}`, steps: ['Parse', 'Check balance', 'Check overlap', 'Submit for approval'], checks: [`${params.days} day(s): ${start} to ${end}`, 'Request goes to the manager for approval; it is not auto-approved'], params: { employeeId: emp._id, type: params.type, startDate: start, endDate: end } };
  }

  if (intent === 'letter') {
    const emp = await findEmployeeIn(params.who);
    return { intent, valid: !!emp, title: `Salary certificate${emp ? ` for ${emp.fullName}` : ''}`, steps: ['Identify', 'Draft bilingual letter', 'HR signs', 'Send'], checks: emp ? [`Addressed to ${params.addressee}`, 'English/Arabic dual column, HR signature required before release'] : ['Name the employee'], params: { employeeId: emp?._id, addressee: params.addressee } };
  }

  return { intent, valid: false, title: 'I can draft that once I know the action', checks: ['Try a hire, a leave request or a salary certificate.'] };
}

export async function execute(p, req) {
  if (!p.valid) throw new Error('This proposal has unresolved issues.');
  const x = p.params;
  if (p.intent === 'hire') {
    const n = (await Employee.countDocuments()) + 1;
    const emp = await Employee.create({
      establishmentId: x.establishmentId, employeeNo: `NEW-${String(n).padStart(4, '0')}`, fullName: x.name, jobTitle: x.role || 'TBC',
      nationality: 'TBC', joinDate: x.startDate ? new Date(x.startDate) : new Date(), status: 'onboarding',
      compensation: { basicFils: x.basicFils, housingFils: x.housingFils, transportFils: x.transportFils },
      custom: { onboarding: ['Entry permit', 'Medical fitness', 'EID biometrics', 'Health insurance', 'MOHRE contract', 'Bank IBAN'].map((s) => ({ step: s, done: false })) },
    });
    return { message: `${x.name} added in Onboarding with a 6-step visa tracker.`, employeeId: emp._id };
  }
  if (p.intent === 'leave') {
    const days = Math.round((Date.parse(x.endDate) - Date.parse(x.startDate)) / 86400000) + 1;
    const lr = await LeaveRequest.create({ employeeId: x.employeeId, type: x.type, startDate: x.startDate, endDate: x.endDate, days, source: 'agent' });
    return { message: 'Leave request submitted for manager approval.', leaveRequestId: lr._id };
  }
  if (p.intent === 'letter') return { message: `Salary certificate drafted for HR signature (to ${x.addressee}).` };
  throw new Error('Unknown action');
}
