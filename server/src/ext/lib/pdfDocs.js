// Real PDF versions of payslips, official letters and offer letters (English, Arabic or dual-column),
// each with a drawn company seal, signatory line and a QR/verification code tied to a SealedDocument record.
import { PdfDoc } from './pdf.js';
import { filsToDisplay } from '../../lib/money.js';

const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const fmtAr = (d) => (d ? new Date(d).toLocaleDateString('ar-AE-u-nu-latn', { day: '2-digit', month: 'long', year: 'numeric' }) : '');
const AED = (f) => `AED ${filsToDisplay(f || 0)}`;
const ACCENT = '#1f6f5c'; const MUTED = '#5b6b66';
const totalComp = (e) => { const c = e.compensation || {}; return (c.basicFils || 0) + (c.housingFils || 0) + (c.transportFils || 0) + (c.allowances || []).reduce((a, x) => a + (x.amountFils || 0), 0); };

function header(d, est, titleEn, titleAr) {
  d.rect(0, 0, d.W, 6, { fill: ACCENT });
  d.text(40, 46, est.name || '', { size: 15, bold: true });
  d.text(d.W - 40, 46, est.nameAr || est.name || '', { size: 15, bold: true, align: 'right' });
  const sub = [est.jurisdiction === 'FREEZONE' ? `Free Zone · ${est.freeZone || ''}` : 'UAE Mainland', est.mohreId ? `MOHRE ${est.mohreId}` : '', est.tradeLicenceNo ? `Licence ${est.tradeLicenceNo}` : ''].filter(Boolean).join(' · ');
  d.text(40, 62, sub, { size: 8, color: MUTED });
  d.line(40, 74, d.W - 40, 74, { color: '#cfd8d5' });
  d.text(40, 104, titleEn, { size: 18, bold: true });
  if (titleAr) d.text(d.W - 40, 104, titleAr, { size: 18, bold: true, align: 'right' });
}

function footer(d, { code, verifyUrl, est, issuedBy, issuedAt }) {
  const y = d.H - 170;
  d.line(40, y + 40, 220, y + 40, { color: '#14211d', width: 0.8 });
  d.text(40, y + 54, issuedBy || 'HR Department', { size: 9 });
  d.text(40, y + 66, 'إدارة الموارد البشرية', { size: 9, color: MUTED });
  d.seal(d.W / 2 + 40, y + 40, (est.name || '').toUpperCase(), `${fmt(issuedAt)} · ${est.nameAr || 'DIGITAL SEAL'}`);
  if (code) { d.qr(d.W - 40 - 64, y + 6, verifyUrl || code, 64); d.text(d.W - 40, y + 82, `Verify: ${code}`, { size: 7.5, color: MUTED, align: 'right' }); }
  d.line(40, d.H - 52, d.W - 40, d.H - 52, { color: '#e3e8e6' });
  d.text(40, d.H - 38, 'Issued electronically from Wasl HRMS. Scan the code or enter the verification code to confirm authenticity.', { size: 7, color: MUTED, maxWidth: d.W - 80 });
  d.text(d.W - 40, d.H - 26, 'صادر إلكترونياً. امسح الرمز للتحقق من صحة المستند.', { size: 7, color: MUTED, align: 'right' });
}

function table(d, x, y, w, title, rows, totalLabel, totalFils) {
  d.rect(x, y, w, 20, { fill: '#eef3f1' }); d.text(x + 8, y + 14, title, { size: 9, bold: true }); d.text(x + w - 8, y + 14, 'AED', { size: 9, bold: true, align: 'right' });
  y += 20;
  for (const [en, ar, v] of rows) {
    d.text(x + 8, y + 14, en, { size: 9, maxWidth: w - 100 }); if (ar) d.text(x + 8, y + 25, ar, { size: 7.5, color: MUTED });
    d.text(x + w - 8, y + 14, filsToDisplay(v), { size: 9, align: 'right' }); y += ar ? 32 : 22; d.line(x, y, x + w, y, { color: '#edf0ef' });
  }
  if (!rows.length) { d.text(x + 8, y + 14, 'None', { size: 9, color: MUTED }); y += 22; }
  d.text(x + 8, y + 15, totalLabel, { size: 9.5, bold: true }); d.text(x + w - 8, y + 15, filsToDisplay(totalFils), { size: 9.5, bold: true, align: 'right' });
  return y + 24;
}

export function payslipPdf({ employee: e, establishment: est, run, line, ytd, seal }) {
  const d = new PdfDoc({ title: `Payslip ${e.employeeNo} ${run.period}` });
  const [y, m] = run.period.split('-').map(Number); const month = new Date(Date.UTC(y, m - 1, 1));
  header(d, est, `Payslip · ${month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`, `قسيمة راتب · ${month.toLocaleDateString('ar-AE-u-nu-latn', { month: 'long', year: 'numeric' })}`);
  const meta = [['Employee', e.fullName], ['Employee no.', e.employeeNo], ['Job title', e.jobTitle || ''], ['Department', e.department || '']];
  const meta2 = [['Pay period', `${run.period}${run.type && run.type !== 'regular' ? ` (${run.type})` : ''}`], ['Joined', fmt(e.joinDate)], ['Bank', `${e.bank?.bankName || ''} ${e.bank?.ibanLast4 ? `•••• ${e.bank.ibanLast4}` : ''}`], ['Paid via', `WPS · ${est.wps?.agentName || ''}`]];
  meta.forEach(([k, v], i) => { d.text(40, 136 + i * 15, k, { size: 8.5, color: MUTED }); d.text(115, 136 + i * 15, v, { size: 9, maxWidth: 170 }); });
  meta2.forEach(([k, v], i) => { d.text(310, 136 + i * 15, k, { size: 8.5, color: MUTED }); d.text(385, 136 + i * 15, v, { size: 9, maxWidth: 170 }); });
  if (e.fullNameAr) d.text(d.W - 40, 200, e.fullNameAr, { size: 10, align: 'right' });
  const c = e.compensation || {}; const allow = (c.allowances || []).map((a) => [a.label || a.code, 'بدل', a.amountFils]);
  const fullFixed = (c.basicFils || 0) + (c.housingFils || 0) + (c.transportFils || 0) + allow.reduce((a, x) => a + x[2], 0);
  const earnings = run.type === 'regular' || !run.type
    ? [['Basic salary', 'الراتب الأساسي', c.basicFils || 0], ['Housing allowance', 'بدل السكن', c.housingFils || 0], ['Transport allowance', 'بدل المواصلات', c.transportFils || 0], ...allow]
    : [[run.title || run.type, '', line.fixedFils || 0]].filter((r) => r[2]);
  if (line.variableFils) earnings.push(['Overtime, commission & reimbursements', 'العمل الإضافي والعمولات والمبالغ المستردة', line.variableFils]);
  const unpaid = run.type === 'regular' || !run.type ? Math.max(0, fullFixed - (line.fixedFils || 0)) : 0;
  const deductions = []; if (unpaid) deductions.push([`Unpaid leave (${line.unpaidLeaveDays || 0} days)`, 'إجازة غير مدفوعة', unpaid]);
  const other = (line.deductionsFils || 0) - unpaid; if (other > 0) deductions.push(['Loans, advances & fines', 'القروض والسلف والغرامات', other]);
  const gross = earnings.reduce((a, r) => a + r[2], 0); const ded = deductions.reduce((a, r) => a + r[2], 0);
  const yy = Math.max(table(d, 40, 220, 250, 'Earnings · المستحقات', earnings, 'Gross', gross), table(d, 305, 220, 250, 'Deductions · الاستقطاعات', deductions, 'Total deductions', ded));
  d.rect(40, yy + 6, d.W - 80, 38, { fill: '#fff4ee' });
  d.text(52, yy + 30, 'Net pay · صافي الراتب', { size: 12, bold: true });
  d.text(d.W - 52, yy + 31, AED(line.netFils), { size: 16, bold: true, color: '#d9541e', align: 'right' });
  if (ytd) d.text(40, yy + 64, `Year to date: gross ${AED(ytd.grossFils)} · net ${AED(ytd.netFils)}`, { size: 8.5, color: MUTED });
  d.text(40, yy + 78, `Computed with rule pack ${run.rulePack || ''}. Questions: use the employee request centre.`, { size: 8, color: MUTED });
  footer(d, { ...seal, est, issuedBy: 'Payroll', issuedAt: run.approvedAt || new Date() });
  return d.toBuffer();
}

const LETTER_TEXT = {
  salary_certificate: {
    title: 'Salary Certificate', titleAr: 'شهادة راتب',
    en: (e, est, to) => [`This is to certify that ${e.fullName}, holder of ${e.nationality || ''} nationality, has been employed with ${est.name} since ${fmt(e.joinDate)} and currently holds the position of ${e.jobTitle || ''}.`, `The employee's gross monthly salary is ${AED(totalComp(e))}, comprising basic salary of ${AED(e.compensation.basicFils)}, housing allowance of ${AED(e.compensation.housingFils)} and transport allowance of ${AED(e.compensation.transportFils)}.`, `This certificate is issued at the employee's request for submission to ${to}, without any liability on the part of the company.`],
    ar: (e, est, to) => [`نشهد بأن السيد/ة ${e.fullNameAr || e.fullName}، ${e.nationality || ''} الجنسية، يعمل لدى ${est.nameAr || est.name} منذ ${fmtAr(e.joinDate)} ويشغل حالياً وظيفة ${e.jobTitle || ''}.`, `يبلغ إجمالي الراتب الشهري ${AED(totalComp(e))}، ويشمل الراتب الأساسي ${AED(e.compensation.basicFils)} وبدل السكن ${AED(e.compensation.housingFils)} وبدل المواصلات ${AED(e.compensation.transportFils)}.`, `صدرت هذه الشهادة بناءً على طلب الموظف لتقديمها إلى ${to} دون أدنى مسؤولية على الشركة.`],
  },
  bank_transfer: {
    title: 'Salary Transfer Letter', titleAr: 'خطاب تحويل راتب',
    en: (e, est, to) => [`We confirm that ${e.fullName} (employee no. ${e.employeeNo}) is employed with ${est.name} as ${e.jobTitle || ''} with a gross monthly salary of ${AED(totalComp(e))}.`, `We undertake to transfer the employee's monthly salary and, on separation, the end-of-service benefits to their account with ${to}, until we receive a clearance letter from the bank.`],
    ar: (e, est, to) => [`نؤكد أن ${e.fullNameAr || e.fullName} (الرقم الوظيفي ${e.employeeNo}) يعمل لدى ${est.nameAr || est.name} بوظيفة ${e.jobTitle || ''} براتب شهري إجمالي قدره ${AED(totalComp(e))}.`, `ونتعهد بتحويل الراتب الشهري ومستحقات نهاية الخدمة عند انتهاء العلاقة إلى حسابه لدى ${to} إلى حين استلام خطاب براءة ذمة من البنك.`],
  },
  noc: {
    title: 'No Objection Certificate', titleAr: 'شهادة عدم ممانعة',
    en: (e, est, to, purpose) => [`${est.name} has no objection to ${e.fullName}, employed with us as ${e.jobTitle || ''} since ${fmt(e.joinDate)}, ${purpose || 'travelling abroad'}.`, `This certificate is issued at the employee's request and addressed to ${to}.`],
    ar: (e, est, to, purpose) => [`لا مانع لدى ${est.nameAr || est.name} من قيام ${e.fullNameAr || e.fullName}، الذي يعمل لدينا بوظيفة ${e.jobTitle || ''} منذ ${fmtAr(e.joinDate)}، بـ${purpose || 'السفر إلى الخارج'}.`, `صدرت هذه الشهادة بناءً على طلب الموظف وهي موجهة إلى ${to}.`],
  },
  experience: {
    title: 'Experience Certificate', titleAr: 'شهادة خبرة',
    en: (e, est) => [`This is to certify that ${e.fullName} worked with ${est.name} as ${e.jobTitle || ''} from ${fmt(e.joinDate)} ${e.exitDate ? `to ${fmt(e.exitDate)}` : 'to date'}.`, 'During this period the employee carried out their duties diligently. We wish them every success.'],
    ar: (e, est) => [`نشهد بأن ${e.fullNameAr || e.fullName} عمل لدى ${est.nameAr || est.name} بوظيفة ${e.jobTitle || ''} اعتباراً من ${fmtAr(e.joinDate)} ${e.exitDate ? `حتى ${fmtAr(e.exitDate)}` : 'وحتى تاريخه'}.`, 'وقد أدى مهامه بكل جد وإخلاص خلال هذه الفترة، ونتمنى له دوام التوفيق.'],
  },
};
export const PDF_LETTER_TYPES = Object.keys(LETTER_TEXT);

export function letterPdf({ type, employee: e, establishment: est, addressee = 'To whom it may concern', purpose, lang = 'dual', reference, issuedBy, issuedAt = new Date(), seal }) {
  const L = LETTER_TEXT[type]; if (!L) throw new Error(`Unknown letter type ${type}`);
  const d = new PdfDoc({ title: `${L.title} ${e.employeeNo}` });
  header(d, est, lang === 'ar' ? '' : L.title, lang === 'en' ? '' : L.titleAr);
  const dual = lang === 'dual'; const colW = dual ? 245 : d.W - 80;
  if (lang !== 'ar') { let y = 136; d.text(40, y, `Date: ${fmt(issuedAt)} · Ref: ${reference || ''}`, { size: 8.5, color: MUTED }); y += 22; d.text(40, y, `To: ${addressee}`, { size: 10, bold: true, maxWidth: colW }); y += 22; for (const p of L.en(e, est, addressee, purpose)) y = d.paragraph(40, y, p, { size: 10, maxWidth: colW, lineGap: 5 }) + 8; }
  if (lang !== 'en') { const x = dual ? d.W - 40 - colW : 40; let y = 136; d.text(x + colW, y, `التاريخ: ${fmtAr(issuedAt)} · المرجع: ${reference || ''}`, { size: 8.5, color: MUTED, align: 'right' }); y += 22; d.text(x + colW, y, `إلى: ${addressee}`, { size: 10, bold: true, align: 'right', maxWidth: colW }); y += 22; for (const p of L.ar(e, est, addressee, purpose)) y = d.paragraph(x, y, p, { size: 10.5, maxWidth: colW, lineGap: 6, align: 'right' }) + 8; }
  if (dual) d.line(d.W / 2, 128, d.W / 2, 520, { color: '#e3e8e6' });
  footer(d, { ...seal, est, issuedBy, issuedAt });
  return d.toBuffer();
}

export function offerPdf({ offer: o, establishment: est, seal, signature }) {
  const d = new PdfDoc({ title: `Offer ${o.candidateName}` });
  header(d, est, 'Offer of Employment', 'عرض عمل');
  let y = 136;
  d.text(40, y, `Date: ${fmt(o.createdAt || new Date())}`, { size: 8.5, color: MUTED }); y += 22;
  y = d.paragraph(40, y, `Dear ${o.candidateName}, we are pleased to offer you the position of ${o.jobTitle}${o.grade ? ` (grade ${o.grade})` : ''} with ${est.name}, starting ${fmt(o.startDate)}, subject to a satisfactory visa, medical fitness and background process.`, { size: 10, maxWidth: 245, lineGap: 5 }) + 6;
  const ar = `يسرنا أن نعرض عليك وظيفة ${o.jobTitle} لدى ${est.nameAr || est.name} اعتباراً من ${fmtAr(o.startDate)}، وذلك رهناً باستكمال إجراءات التأشيرة والفحص الطبي.`;
  d.paragraph(d.W - 40 - 245, 158, ar, { size: 10.5, maxWidth: 245, lineGap: 6, align: 'right' });
  y = Math.max(y, 240);
  const rows = [['Basic salary', 'الراتب الأساسي', o.basicFils], ['Housing allowance', 'بدل السكن', o.housingFils], ['Transport allowance', 'بدل المواصلات', o.transportFils], ['Other allowances', 'بدلات أخرى', o.otherFils]].filter((r) => r[2]);
  y = table(d, 40, y, d.W - 80, 'Monthly package · الحزمة الشهرية', rows, 'Total monthly', rows.reduce((a, r) => a + r[2], 0)) + 6;
  for (const t of [`Probation: ${o.probationMonths} months. Notice period: ${o.noticeDays} days after probation.`, `Visa: ${o.visaType || 'Employment residence visa sponsored by the company'}. Annual leave, gratuity and benefits as per UAE law and company policy.`, 'This offer is valid for 7 days and is conditional on the MOHRE/free-zone contract matching these terms.']) y = d.paragraph(40, y, t, { size: 9.5, maxWidth: d.W - 80, lineGap: 4 }) + 4;
  if (signature?.at) {
    d.rect(40, y + 8, 260, 58, { stroke: '#cfd8d5' });
    d.text(50, y + 26, `Accepted by ${signature.name}`, { size: 10, bold: true });
    d.text(50, y + 42, `${new Date(signature.at).toISOString().replace('T', ' ').slice(0, 19)} UTC · IP ${signature.ip || ''}`, { size: 8, color: MUTED });
    d.text(50, y + 56, `Document hash ${String(signature.docHash || '').slice(0, 32)}…`, { size: 7, color: MUTED });
  }
  footer(d, { ...seal, est, issuedBy: 'Talent Acquisition', issuedAt: o.createdAt || new Date() });
  return d.toBuffer();
}
