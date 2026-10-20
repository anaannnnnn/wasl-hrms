// Bilingual (English / Arabic) printable documents: payslips and official letters.
// Rendered as self-contained HTML with print CSS; users save as PDF from the browser.
// (A server-side PDF renderer such as pdfkit or headless Chromium can wrap these later.)
import { filsToDisplay } from './money.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const fmtDateAr = (d) => (d ? new Date(d).toLocaleDateString('ar-AE-u-nu-latn', { day: '2-digit', month: 'long', year: 'numeric' }) : '');
const AED = (f) => `AED ${filsToDisplay(f || 0)}`;

const shell = (title, body, { lang = 'dual' } = {}) => `<!doctype html><html lang="${lang === 'ar' ? 'ar' : 'en'}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;600&family=Barlow+Condensed:wght@700;800&family=IBM+Plex+Sans+Arabic:wght@400;600&display=swap">
<style>
@page{size:A4;margin:16mm}
*{box-sizing:border-box}body{margin:0;background:#eef2f3;font-family:Barlow,'IBM Plex Sans Arabic',system-ui,sans-serif;color:#14211d;font-size:13px}
.page{max-width:820px;margin:24px auto;background:#fff;padding:36px 40px;border-top:6px solid #ff6a2b}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;border-bottom:1px solid #d9e2e5;padding-bottom:16px;margin-bottom:18px}
.org b{display:block;font-family:'Barlow Condensed',sans-serif;font-size:24px;text-transform:uppercase}
.org small{color:#5b6b66}
.ar{font-family:'IBM Plex Sans Arabic',sans-serif;direction:rtl;text-align:right}
h1{font-family:'Barlow Condensed',sans-serif;font-size:26px;text-transform:uppercase;margin:0}
table{width:100%;border-collapse:collapse;margin:10px 0}th,td{padding:7px 8px;border-bottom:1px solid #e3eaec;text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#5b6b66}
td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
.tot td{font-weight:700;border-top:2px solid #14211d}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:28px}
.meta td{border:0;padding:3px 0}.meta td:first-child{color:#5b6b66;width:42%}
.sign{margin-top:36px;display:flex;justify-content:space-between;gap:20px;align-items:flex-end}
.stamp{width:120px;height:120px;border:3px double #ff6a2b;border-radius:50%;display:grid;place-items:center;text-align:center;color:#ff6a2b;font-size:10px;font-weight:600;transform:rotate(-8deg);padding:10px}
.foot{margin-top:24px;font-size:10.5px;color:#5b6b66;border-top:1px solid #e3eaec;padding-top:10px}
.bar{max-width:820px;margin:16px auto 0;display:flex;justify-content:flex-end}
.bar button{font:inherit;font-weight:600;background:#ff6a2b;color:#0b2530;border:0;padding:9px 16px;cursor:pointer}
@media print{body{background:#fff}.page{margin:0;max-width:none;padding:0;border-top:0}.bar{display:none}}
</style></head><body><div class="bar"><button onclick="window.print()">Print / Save as PDF</button></div><div class="page">${body}</div></body></html>`;

const orgHead = (est, refLabel) => `<div class="head"><div class="org"><b>${esc(est.name)}</b><small>${esc(est.emirate || '')}${est.freeZone ? ` · ${esc(est.freeZone)}` : ' · Mainland'} · MOHRE ${esc(est.mohreId || '—')}</small></div>
<div class="org ar"><b>${esc(est.nameAr || est.name)}</b><small>${esc(refLabel || '')}</small></div></div>`;

export function renderPayslip({ employee, establishment, run, line, ytd }) {
  const c = employee.compensation;
  const allow = (c.allowances || []).map((a) => [a.label || a.code, a.amountFils]);
  const unpaidDed = Math.max(0, (c.basicFils + c.housingFils + c.transportFils + allow.reduce((s, a) => s + a[1], 0)) - line.fixedFils);
  const earnings = [['Basic salary', 'الراتب الأساسي', c.basicFils], ['Housing allowance', 'بدل السكن', c.housingFils], ['Transport allowance', 'بدل المواصلات', c.transportFils], ...allow.map(([l, v]) => [l, 'بدل', v])];
  if (line.variableFils) earnings.push(['Overtime, commission & reimbursements', 'العمل الإضافي والعمولات', line.variableFils]);
  const deductions = [];
  if (unpaidDed) deductions.push([`Unpaid leave (${line.unpaidLeaveDays || 0} days)`, 'إجازة غير مدفوعة', unpaidDed]);
  const other = (line.deductionsFils || 0) - unpaidDed;
  if (other > 0) deductions.push(['Loans, advances & fines', 'القروض والسلف', other]);
  const gross = earnings.reduce((a, e) => a + e[2], 0), ded = deductions.reduce((a, d) => a + d[2], 0);
  const [y, m] = run.period.split('-').map(Number);
  const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const monthAr = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('ar-AE-u-nu-latn', { month: 'long', year: 'numeric' });
  const rows = (list) => list.map(([en, ar, v]) => `<tr><td>${esc(en)}<div class="ar" style="font-size:11px;color:#5b6b66">${esc(ar)}</div></td><td class="r">${filsToDisplay(v)}</td></tr>`).join('');
  return shell(`Payslip ${employee.fullName} ${run.period}`, `${orgHead(establishment, `قسيمة راتب · ${monthAr}`)}
  <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px"><h1>Payslip · ${esc(monthName)}</h1><div class="ar" style="font-size:18px;font-weight:600">قسيمة الراتب</div></div>
  <div class="grid2" style="margin-top:12px"><table class="meta">
    <tr><td>Employee</td><td><b>${esc(employee.fullName)}</b>${employee.fullNameAr ? `<div class="ar">${esc(employee.fullNameAr)}</div>` : ''}</td></tr>
    <tr><td>Employee no.</td><td>${esc(employee.employeeNo)}</td></tr><tr><td>Job title</td><td>${esc(employee.jobTitle || '')}</td></tr>
    <tr><td>Department</td><td>${esc(employee.department || '')}</td></tr></table>
    <table class="meta"><tr><td>Pay period</td><td>${esc(run.period)}${run.type && run.type !== 'regular' ? ` (${esc(run.type)})` : ''}</td></tr>
    <tr><td>Joined</td><td>${fmtDate(employee.joinDate)}</td></tr><tr><td>Bank</td><td>${esc(employee.bank?.bankName || '')} ${employee.bank?.ibanLast4 ? `•••• ${esc(employee.bank.ibanLast4)}` : ''}</td></tr>
    <tr><td>Paid via</td><td>WPS · ${esc(establishment.wps?.agentName || '')}</td></tr></table></div>
  <div class="grid2"><div><table><thead><tr><th>Earnings · المستحقات</th><th class="r">AED</th></tr></thead><tbody>${rows(earnings)}<tr class="tot"><td>Gross</td><td class="r">${filsToDisplay(gross)}</td></tr></tbody></table></div>
  <div><table><thead><tr><th>Deductions · الاستقطاعات</th><th class="r">AED</th></tr></thead><tbody>${rows(deductions) || '<tr><td colspan="2" style="color:#5b6b66">None</td></tr>'}<tr class="tot"><td>Total deductions</td><td class="r">${filsToDisplay(ded)}</td></tr></tbody></table></div></div>
  <table style="margin-top:16px"><tr class="tot"><td style="font-size:16px">Net pay · صافي الراتب</td><td class="r" style="font-size:20px;color:#ff6a2b">${AED(line.netFils)}</td></tr></table>
  ${ytd ? `<p style="color:#5b6b66">Year to date: gross ${AED(ytd.grossFils)} · net ${AED(ytd.netFils)}</p>` : ''}
  <div class="foot">Computed with rule pack ${esc(run.rulePack || '')}. This payslip is system generated. Questions: contact HR through the employee request centre.<div class="ar">هذه القسيمة صادرة إلكترونياً. للاستفسار يرجى التواصل مع الموارد البشرية.</div></div>`);
}

const LETTERS = {
  salary_certificate: {
    title: 'Salary Certificate', titleAr: 'شهادة راتب',
    en: (e, est, to) => `<p>This is to certify that <b>${esc(e.fullName)}</b>, holder of ${esc(e.nationality || '')} nationality, has been employed with <b>${esc(est.name)}</b> since ${fmtDate(e.joinDate)} and currently holds the position of <b>${esc(e.jobTitle || '')}</b>.</p>
      <p>The employee's gross monthly salary is <b>${AED(total(e))}</b>, comprising basic salary of ${AED(e.compensation.basicFils)}, housing allowance of ${AED(e.compensation.housingFils)} and transport allowance of ${AED(e.compensation.transportFils)}.</p>
      <p>This certificate is issued at the employee's request for submission to <b>${esc(to)}</b>, without any liability on the part of the company.</p>`,
    ar: (e, est, to) => `<p>نشهد بأن السيد/ة <b>${esc(e.fullNameAr || e.fullName)}</b>، ${esc(e.nationality || '')} الجنسية، يعمل لدى <b>${esc(est.nameAr || est.name)}</b> منذ ${fmtDateAr(e.joinDate)} ويشغل حالياً وظيفة <b>${esc(e.jobTitle || '')}</b>.</p>
      <p>يبلغ إجمالي الراتب الشهري <b>${AED(total(e))}</b>، ويشمل الراتب الأساسي ${AED(e.compensation.basicFils)} وبدل السكن ${AED(e.compensation.housingFils)} وبدل المواصلات ${AED(e.compensation.transportFils)}.</p>
      <p>صدرت هذه الشهادة بناءً على طلب الموظف لتقديمها إلى <b>${esc(to)}</b> دون أدنى مسؤولية على الشركة.</p>`,
  },
  bank_transfer: {
    title: 'Salary Transfer Letter', titleAr: 'خطاب تحويل راتب',
    en: (e, est, to) => `<p>We confirm that <b>${esc(e.fullName)}</b> (employee no. ${esc(e.employeeNo)}) is employed with <b>${esc(est.name)}</b> as <b>${esc(e.jobTitle || '')}</b> with a gross monthly salary of <b>${AED(total(e))}</b>.</p>
      <p>We undertake to transfer the employee's monthly salary and, on separation, the end-of-service benefits to their account with <b>${esc(to)}</b>, until we receive a clearance letter from the bank.</p>`,
    ar: (e, est, to) => `<p>نؤكد أن <b>${esc(e.fullNameAr || e.fullName)}</b> (الرقم الوظيفي ${esc(e.employeeNo)}) يعمل لدى <b>${esc(est.nameAr || est.name)}</b> بوظيفة <b>${esc(e.jobTitle || '')}</b> براتب شهري إجمالي قدره <b>${AED(total(e))}</b>.</p>
      <p>ونتعهد بتحويل الراتب الشهري ومستحقات نهاية الخدمة عند انتهاء العلاقة إلى حسابه لدى <b>${esc(to)}</b> إلى حين استلام خطاب براءة ذمة من البنك.</p>`,
  },
  noc: {
    title: 'No Objection Certificate', titleAr: 'شهادة عدم ممانعة',
    en: (e, est, to, purpose) => `<p><b>${esc(est.name)}</b> has no objection to <b>${esc(e.fullName)}</b>, employed with us as <b>${esc(e.jobTitle || '')}</b> since ${fmtDate(e.joinDate)}, ${esc(purpose || 'travelling abroad')}.</p>
      <p>This certificate is issued at the employee's request and addressed to <b>${esc(to)}</b>.</p>`,
    ar: (e, est, to, purpose) => `<p>لا مانع لدى <b>${esc(est.nameAr || est.name)}</b> من قيام <b>${esc(e.fullNameAr || e.fullName)}</b>، الذي يعمل لدينا بوظيفة <b>${esc(e.jobTitle || '')}</b> منذ ${fmtDateAr(e.joinDate)}، بـ${esc(purpose ? purpose : 'السفر إلى الخارج')}.</p>
      <p>صدرت هذه الشهادة بناءً على طلب الموظف وهي موجهة إلى <b>${esc(to)}</b>.</p>`,
  },
  experience: {
    title: 'Experience Certificate', titleAr: 'شهادة خبرة',
    en: (e, est) => `<p>This is to certify that <b>${esc(e.fullName)}</b> worked with <b>${esc(est.name)}</b> as <b>${esc(e.jobTitle || '')}</b> from ${fmtDate(e.joinDate)} ${e.exitDate ? `to ${fmtDate(e.exitDate)}` : 'to date'}.</p>
      <p>During this period the employee carried out their duties diligently. We wish them every success.</p>`,
    ar: (e, est) => `<p>نشهد بأن <b>${esc(e.fullNameAr || e.fullName)}</b> عمل لدى <b>${esc(est.nameAr || est.name)}</b> بوظيفة <b>${esc(e.jobTitle || '')}</b> اعتباراً من ${fmtDateAr(e.joinDate)} ${e.exitDate ? `حتى ${fmtDateAr(e.exitDate)}` : 'وحتى تاريخه'}.</p>
      <p>وقد أدى مهامه بكل جد وإخلاص خلال هذه الفترة، ونتمنى له دوام التوفيق.</p>`,
  },
};
export const LETTER_TYPES = Object.keys(LETTERS);
function total(e) { const c = e.compensation; return c.basicFils + c.housingFils + c.transportFils + (c.allowances || []).reduce((a, x) => a + x.amountFils, 0); }

/** lang: 'en' | 'ar' | 'dual' (two columns) */
export function renderLetter({ type, employee, establishment, addressee = 'To whom it may concern', purpose, lang = 'dual', reference, issuedBy, issuedAt = new Date() }) {
  const L = LETTERS[type];
  if (!L) throw new Error(`Unknown letter type ${type}`);
  const enBlock = `<div><h1 style="font-size:22px">${L.title}</h1><p style="color:#5b6b66">Date: ${fmtDate(issuedAt)} · Ref: ${esc(reference || '')}</p><p>To: <b>${esc(addressee)}</b></p>${L.en(employee, establishment, addressee, purpose)}</div>`;
  const arBlock = `<div class="ar"><h1 style="font-size:22px;font-family:'IBM Plex Sans Arabic'">${L.titleAr}</h1><p style="color:#5b6b66">التاريخ: ${fmtDateAr(issuedAt)} · المرجع: ${esc(reference || '')}</p><p>إلى: <b>${esc(addressee)}</b></p>${L.ar(employee, establishment, addressee, purpose)}</div>`;
  const body = lang === 'en' ? enBlock : lang === 'ar' ? arBlock : `<div class="grid2">${enBlock}${arBlock}</div>`;
  return shell(`${L.title} ${employee.fullName}`, `${orgHead(establishment, L.titleAr)}${body}
  <div class="sign"><div><div style="border-top:1px solid #14211d;width:220px;padding-top:6px">${esc(issuedBy || 'HR Department')}<div class="ar">إدارة الموارد البشرية</div></div></div>
  <div class="stamp">${esc(establishment.name)}<br>DIGITAL STAMP<br>${fmtDate(issuedAt)}</div></div>
  <div class="foot">Verify this letter with HR quoting reference ${esc(reference || '')}. Issued electronically from Wasl HRMS.</div>`, { lang });
}
