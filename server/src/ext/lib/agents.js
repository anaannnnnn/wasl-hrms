// AI layer v2: an LLM-backed Nexus agent that PLANS multi-step workflows with tool calling, and a
// multilingual employee copilot (text / voice / WhatsApp / Slack). The model only proposes; deterministic code
// validates, previews and — after a human approves — executes. Every function has a no-API-key fallback.
import { aiEnabled, callClaude } from '../../lib/ai.js';
import { toFils } from '../../lib/money.js';

// ---------------------------------------------------------------- Nexus: hire workflow planning
const HIRE_TOOL = {
  name: 'plan_hire',
  description: 'Extract a structured hiring instruction from an HR command. Only use values stated in the command.',
  input_schema: {
    type: 'object',
    properties: {
      candidateName: { type: 'string' }, jobTitle: { type: 'string' }, department: { type: ['string', 'null'] },
      establishmentRef: { type: ['string', 'null'], description: 'Establishment card number/name as written, e.g. "#2" or "Al Noor Free Zone"' },
      startDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' }, totalPackageAed: { type: ['number', 'null'] },
      split: { type: 'object', properties: { basicPct: { type: 'number' }, housingPct: { type: 'number' }, transportPct: { type: 'number' } } },
      visa: { type: ['string', 'null'], enum: ['mainland', 'freezone', 'golden', 'uae_national', null] },
      grade: { type: ['string', 'null'] }, candidateEmail: { type: ['string', 'null'] },
    },
    required: ['candidateName', 'jobTitle'],
  },
};

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
export function parseLooseDate(s, now = new Date()) {
  const m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+(\d{4}))?/i) || s.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i);
  if (!m) { const iso = s.match(/\b(\d{4}-\d{2}-\d{2})\b/); return iso ? iso[1] : null; }
  const [day, mon] = /^\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
  const year = m[3] ? Number(m[3]) : now.getUTCFullYear();
  let d = new Date(Date.UTC(year, MONTHS[mon.slice(0, 3).toLowerCase()], Number(day)));
  if (!m[3] && d < now) d = new Date(Date.UTC(year + 1, d.getUTCMonth(), d.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

/** Deterministic fallback parser for the hire command (same output shape as the LLM tool). */
export function parseHireFallback(cmd) {
  const name = (cmd.match(/\bhire\s+(.+?)\s+as\s/i) || cmd.match(/\bhire\s+([^,]+?)(?:,|$)/i) || [])[1];
  const role = (cmd.match(/\bas\s+(?:a\s+|an\s+)?([^,]+?)(?:,|\s+under|\s+start|\s+aed|\s+in\s|$)/i) || [])[1];
  const amt = (cmd.match(/aed\s*([\d,]+(?:\.\d+)?)/i) || [])[1];
  const split = cmd.match(/(\d+)%\s*basic.*?(\d+)%\s*housing.*?(\d+)%\s*transport/i);
  const est = (cmd.match(/establishment\s*(?:card)?\s*(#?\s*\d+|[A-Z][\w &-]+?)(?:,|\s+start|$)/i) || [])[1];
  const email = (cmd.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [])[0];
  const grade = (cmd.match(/\bgrade\s+([A-Z0-9-]+)/i) || [])[1];
  return {
    candidateName: name?.trim(), jobTitle: role?.trim(), department: null, establishmentRef: est?.trim() || null,
    startDate: parseLooseDate(cmd), totalPackageAed: amt ? Number(amt.replace(/,/g, '')) : null,
    split: split ? { basicPct: +split[1], housingPct: +split[2], transportPct: +split[3] } : { basicPct: 60, housingPct: 30, transportPct: 10 },
    visa: /golden/i.test(cmd) ? 'golden' : /free\s*zone/i.test(cmd) ? 'freezone' : /uae national|emirati/i.test(cmd) ? 'uae_national' : 'mainland',
    grade: grade || null, candidateEmail: email || null,
  };
}

export async function extractHire(command) {
  if (!aiEnabled()) return { params: parseHireFallback(command), engine: 'rules' };
  try {
    const out = await callClaude({
      system: `You turn UAE HR commands into structured hiring instructions. Today is ${new Date().toISOString().slice(0, 10)}. Never invent salary, dates or names that are not in the command; use null instead.`,
      messages: [{ role: 'user', content: command }], tools: [HIRE_TOOL], toolChoice: { type: 'tool', name: 'plan_hire' }, maxTokens: 500,
    });
    const t = out.content?.find((c) => c.type === 'tool_use');
    if (!t?.input) throw new Error('no tool output');
    const p = t.input; p.split ||= { basicPct: 60, housingPct: 30, transportPct: 10 };
    return { params: p, engine: 'claude' };
  } catch (e) { return { params: parseHireFallback(command), engine: 'rules', aiError: e.message }; }
}

/** Deterministic validation of the extracted hire against grade bands and UAE rules. */
export function validateHire(p, { gradeBands = [], establishment, minEmiratiWageFils = 600000 }) {
  const issues = []; const warnings = [];
  if (!p.candidateName) issues.push('Candidate name is missing.');
  if (!p.jobTitle) issues.push('Job title is missing.');
  if (!p.startDate) issues.push('Start date is missing.');
  else if (p.startDate < new Date().toISOString().slice(0, 10)) warnings.push('Start date is in the past.');
  if (!p.totalPackageAed) issues.push('Total package (AED) is missing.');
  const s = p.split || {}; const pct = (s.basicPct || 0) + (s.housingPct || 0) + (s.transportPct || 0);
  if (Math.round(pct) !== 100) issues.push(`Salary split adds up to ${pct}%, not 100%.`);
  if ((s.basicPct || 0) < 50) warnings.push('Basic is under 50% of package; gratuity is calculated on basic, so confirm this is intended.');
  let comp = null;
  if (p.totalPackageAed && Math.round(pct) === 100) {
    const total = toFils(p.totalPackageAed);
    const basic = Math.round((total * s.basicPct) / 100), housing = Math.round((total * s.housingPct) / 100);
    comp = { basicFils: basic, housingFils: housing, transportFils: total - basic - housing, totalFils: total };
    const band = p.grade ? gradeBands.find((g) => g.grade === p.grade) : gradeBands.find((g) => total >= g.minFils && total <= g.maxFils);
    if (p.grade && !band) warnings.push(`Grade ${p.grade} has no band configured.`);
    if (band && (total < band.minFils || total > band.maxFils)) issues.push(`Package is outside grade ${band.grade} band (AED ${band.minFils / 100}–${band.maxFils / 100}).`);
    if (band) comp.grade = band.grade;
    if (p.visa === 'uae_national' && total < minEmiratiWageFils) warnings.push('UAE National below AED 6,000 will not count toward the Emiratisation quota.');
  }
  if (!establishment) issues.push('Establishment not found; pick the establishment card.');
  else if (p.visa === 'freezone' && establishment.jurisdiction !== 'FREEZONE') warnings.push('Free-zone visa requested but the establishment is on the Mainland.');
  return { ok: issues.length === 0, issues, warnings, comp };
}

/** The visa & onboarding tracker steps (offsets are days from the start date; negative = before start). */
export function onboardingSteps({ startDate, jurisdiction = 'MAINLAND', visa = 'mainland' }) {
  const at = (n) => new Date(Date.parse(`${startDate}T00:00:00Z`) + n * 86400000);
  if (visa === 'uae_national') return [
    { key: 'contract', name: 'MOHRE contract & pension (GPSSA) registration', owner: 'hr', dueDate: at(-3), dependsOn: [] },
    { key: 'insurance', name: 'Health insurance enrolment', owner: 'insurer', dueDate: at(0), dependsOn: [] },
    { key: 'iban', name: 'Collect bank IBAN for WPS', owner: 'employee', dueDate: at(0), dependsOn: [] },
  ];
  const fz = jurisdiction === 'FREEZONE';
  return [
    { key: 'offer_signed', name: 'Offer letter signed', owner: 'employee', dueDate: at(-30), dependsOn: [] },
    { key: 'entry_permit', name: fz ? 'Free-zone entry permit' : 'MOHRE work permit + entry permit', owner: 'pro', dueDate: at(-21), dependsOn: ['offer_signed'] },
    { key: 'status_change', name: 'Entry / status change inside UAE', owner: 'employee', dueDate: at(-14), dependsOn: ['entry_permit'] },
    { key: 'medical', name: 'Medical fitness test', owner: 'employee', dueDate: at(-10), dependsOn: ['status_change'] },
    { key: 'eid_biometrics', name: 'Emirates ID biometrics', owner: 'employee', dueDate: at(-7), dependsOn: ['status_change'] },
    { key: 'insurance', name: 'Health insurance enrolment', owner: 'insurer', dueDate: at(-7), dependsOn: ['offer_signed'] },
    { key: 'contract', name: fz ? 'Free-zone employment contract' : 'Tawjeeh + MOHRE contract stamping', owner: 'typing_centre', dueDate: at(-3), dependsOn: ['medical'] },
    { key: 'residence_visa', name: 'Residence visa stamping / e-visa', owner: 'pro', dueDate: at(10), dependsOn: ['medical', 'eid_biometrics', 'insurance'] },
    { key: 'iban', name: 'Collect bank IBAN for WPS', owner: 'employee', dueDate: at(14), dependsOn: [] },
  ];
}

/** Full plan preview shown to the human before anything is written. */
export function buildHirePlan(p, v, { establishment }) {
  const steps = [
    { id: 'validate', label: 'Validate package against grade bands & UAE rules', status: v.ok ? 'ok' : 'blocked', detail: [...v.issues, ...v.warnings].join(' ') || 'All checks passed' },
    { id: 'offer', label: 'Create bilingual offer letter (PDF) + MOHRE contract draft', status: 'pending' },
    { id: 'esign', label: `Send e-signature & document-upload link${p.candidateEmail ? ` to ${p.candidateEmail}` : ''}`, status: 'pending' },
    { id: 'visa', label: 'Open visa & onboarding tracker', status: 'pending', detail: onboardingSteps({ startDate: p.startDate || new Date().toISOString().slice(0, 10), jurisdiction: establishment?.jurisdiction, visa: p.visa }).map((s) => s.name).join(' → ') },
    { id: 'assets', label: 'Request IT assets (laptop, email, access card)', status: 'pending' },
    { id: 'probation', label: 'Schedule 30 / 60 / 90-day probation check-ins', status: 'pending' },
  ];
  return { steps, requiresApproval: true };
}

// ---------------------------------------------------------------- Copilot: multilingual employee intents
const LANG_HINTS = [['ar', /[؀-ۿ]/], ['hi', /[ऀ-ॿ]/], ['ml', /[ഀ-ൿ]/], ['ur', /[؀-ۿ].*(ہ|ے|ی|ں|ٹ|ڈ|ڑ)/], ['tl', /\b(po|gusto|ko|ng|sa|araw|bakasyon|sahod)\b/i]];
export const detectLang = (t) => { let l = 'en'; for (const [k, re] of LANG_HINTS) if (re.test(t)) l = k; return l; };

const KW = {
  leave: /\bleave\b|vacation|holiday|off\b|إجازة|اجازة|छुट्टी|अवकाश|അവധി|لیو|چھٹی|bakasyon|leave\s*po/i,
  sick: /\bsick|مريض|مرضية|बीमार|അസുഖ|بیمار|may sakit/i,
  certificate: /certificate|letter|شهادة|خطاب|प्रमाण|सर्टिफिकेट|സർട്ടിഫിക്കറ്റ്|سرٹیفکیٹ|sertipiko/i,
  balance: /balance|how many (days|leave)|رصيد|बाकी|ബാക്കി|بیلنس|ilan pa/i,
  payslip: /payslip|salary slip|pay slip|قسيمة|सैलरी स्लिप|ശമ്പള|تنخواہ|sahod|payslip po/i,
  noc: /\bnoc\b|no objection|عدم ممانعة/i,
};
const NUMWORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, 'ثلاثة': 3, 'يومين': 2, 'يوم': 1, 'तीन': 3, 'दो': 2, 'मून्ന്': 3 };

export function parseCopilotFallback(text, now = new Date()) {
  const t = text.toLowerCase();
  const daysM = t.match(/(\d+)\s*(?:days?|يوم|أيام|दिन|ദിവസ|دن|araw)/i) || t.match(/(one|two|three|four|five|six|seven|ten|ثلاثة|يومين|तीन|दो)\s*(?:days?|أيام|दिन)?/i);
  const days = daysM ? Number(daysM[1]) || NUMWORDS[daysM[1]] || 1 : 1;
  let startDate = parseLooseDate(text, now);
  if (!startDate && /next week|الأسبوع القادم|अगले हफ्ते|अगले सप्ताह|susunod na linggo/i.test(text)) { const d = new Date(now); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7)); startDate = d.toISOString().slice(0, 10); }
  if (!startDate && /tomorrow|غدا|غداً|कल|bukas/i.test(text)) { const d = new Date(now); d.setUTCDate(d.getUTCDate() + 1); startDate = d.toISOString().slice(0, 10); }
  const to = (text.match(/(?:addressed\s+to|for|to)\s+([A-Z][\w&.\- ]{2,40})/) || [])[1]?.trim();
  if (KW.certificate.test(text) || KW.noc.test(text)) return { intent: 'letter', params: { letterType: KW.noc.test(text) ? 'noc' : /bank|transfer/i.test(text) ? 'bank_transfer' : /experience/i.test(text) ? 'experience' : 'salary_certificate', addressee: to || 'To whom it may concern' } };
  if (KW.balance.test(text)) return { intent: 'leave_balance', params: {} };
  if (KW.payslip.test(text)) return { intent: 'payslip', params: {} };
  if (KW.leave.test(text) || KW.sick.test(text)) return { intent: 'leave', params: { type: KW.sick.test(text) ? 'sick' : 'annual', days, startDate } };
  return { intent: 'unknown', params: {} };
}

const COPILOT_TOOL = {
  name: 'route_request', description: 'Classify an employee HR request and extract parameters.',
  input_schema: { type: 'object', properties: {
    intent: { type: 'string', enum: ['leave', 'leave_balance', 'letter', 'payslip', 'policy_question', 'unknown'] },
    language: { type: 'string', description: 'ISO 639-1 code of the message language (en, ar, hi, ml, ur, tl…)' },
    leaveType: { type: ['string', 'null'], enum: ['annual', 'sick', 'parental', 'hajj', 'unpaid', null] },
    startDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' }, days: { type: ['number', 'null'] },
    letterType: { type: ['string', 'null'], enum: ['salary_certificate', 'bank_transfer', 'noc', 'experience', null] }, addressee: { type: ['string', 'null'] },
  }, required: ['intent', 'language'] },
};

export async function routeCopilot(text, now = new Date()) {
  if (!aiEnabled()) { const r = parseCopilotFallback(text, now); return { ...r, lang: detectLang(text), engine: 'rules' }; }
  try {
    const out = await callClaude({ system: `Route UAE employee HR requests. Today is ${now.toISOString().slice(0, 10)}. Messages may be in English, Gulf Arabic, Hindi, Malayalam, Urdu or Tagalog. "Next week" means the coming Monday.`, messages: [{ role: 'user', content: text }], tools: [COPILOT_TOOL], toolChoice: { type: 'tool', name: 'route_request' }, maxTokens: 300 });
    const x = out.content?.find((c) => c.type === 'tool_use')?.input; if (!x) throw new Error('no route');
    const params = x.intent === 'leave' ? { type: x.leaveType || 'annual', days: x.days || 1, startDate: x.startDate } : x.intent === 'letter' ? { letterType: x.letterType || 'salary_certificate', addressee: x.addressee || 'To whom it may concern' } : {};
    return { intent: x.intent, params, lang: x.language || detectLang(text), engine: 'claude' };
  } catch (e) { const r = parseCopilotFallback(text, now); return { ...r, lang: detectLang(text), engine: 'rules', aiError: e.message }; }
}

// Reply templates in the employee's language (short, factual). Unknown languages fall back to English.
const R = {
  en: { leave_ok: (d, s) => `Your ${d}-day leave request from ${s} has been submitted for approval.`, leave_need: 'Please tell me the start date, e.g. "3 days annual leave from 12 Nov".', letter_ok: (n) => `Your ${n} is ready. Download it from My requests.`, balance: (a, s) => `You have ${a} annual leave days and ${s} full-pay sick days left.`, payslip: (p, n) => `Your latest payslip (${p}) shows net pay AED ${n}. Open My payslips to download it.`, unknown: "Sorry, I can help with leave, leave balance, payslips and letters. Please rephrase.", blocked: (m) => `I couldn't submit that: ${m}` },
  ar: { leave_ok: (d, s) => `تم تقديم طلب إجازتك لمدة ${d} أيام اعتباراً من ${s} للموافقة.`, leave_need: 'يرجى ذكر تاريخ البدء، مثال: إجازة سنوية 3 أيام من 12 نوفمبر.', letter_ok: () => 'شهادتك جاهزة. يمكنك تنزيلها من قسم طلباتي.', balance: (a, s) => `رصيدك ${a} يوم إجازة سنوية و${s} يوم إجازة مرضية بأجر كامل.`, payslip: (p, n) => `آخر قسيمة راتب (${p}) صافيها ${n} درهم. افتح قسائمي لتنزيلها.`, unknown: 'عذراً، أستطيع المساعدة في الإجازات والرصيد وقسائم الرواتب والشهادات.', blocked: (m) => `تعذر تقديم الطلب: ${m}` },
  hi: { leave_ok: (d, s) => `${s} से ${d} दिन की छुट्टी का आपका अनुरोध मंज़ूरी के लिए भेज दिया गया है।`, leave_need: 'कृपया शुरू होने की तारीख बताएं, जैसे "12 Nov से 3 दिन की छुट्टी"।', letter_ok: () => 'आपका प्रमाणपत्र तैयार है। My requests से डाउनलोड करें।', balance: (a, s) => `आपके पास ${a} दिन की वार्षिक छुट्टी और ${s} दिन की पूरे वेतन वाली बीमारी छुट्टी बची है।`, payslip: (p, n) => `आपकी नवीनतम सैलरी स्लिप (${p}) में नेट वेतन AED ${n} है।`, unknown: 'माफ़ कीजिए, मैं छुट्टी, बैलेंस, सैलरी स्लिप और पत्रों में मदद कर सकता हूँ।', blocked: (m) => `अनुरोध जमा नहीं हो सका: ${m}` },
  ml: { leave_ok: (d, s) => `${s} മുതൽ ${d} ദിവസത്തെ അവധി അപേക്ഷ അംഗീകാരത്തിനായി സമർപ്പിച്ചു.`, leave_need: 'ആരംഭ തീയതി പറയൂ, ഉദാ: "12 Nov മുതൽ 3 ദിവസം അവധി".', letter_ok: () => 'നിങ്ങളുടെ സർട്ടിഫിക്കറ്റ് തയ്യാറാണ്. My requests-ൽ നിന്ന് ഡൗൺലോഡ് ചെയ്യുക.', balance: (a, s) => `നിങ്ങൾക്ക് ${a} ദിവസം വാർഷിക അവധിയും ${s} ദിവസം ശമ്പളത്തോടെയുള്ള അസുഖ അവധിയും ബാക്കിയുണ്ട്.`, payslip: (p, n) => `ഏറ്റവും പുതിയ ശമ്പള സ്ലിപ്പ് (${p}) – നെറ്റ് AED ${n}.`, unknown: 'ക്ഷമിക്കണം, അവധി, ബാലൻസ്, ശമ്പള സ്ലിപ്പ്, സർട്ടിഫിക്കറ്റ് എന്നിവയിൽ സഹായിക്കാം.', blocked: (m) => `അപേക്ഷ സമർപ്പിക്കാനായില്ല: ${m}` },
  ur: { leave_ok: (d, s) => `${s} سے ${d} دن کی چھٹی کی درخواست منظوری کے لیے بھیج دی گئی ہے۔`, leave_need: 'براہ کرم شروع کی تاریخ بتائیں، مثلاً "12 Nov سے 3 دن کی چھٹی"۔', letter_ok: () => 'آپ کا سرٹیفکیٹ تیار ہے۔ My requests سے ڈاؤن لوڈ کریں۔', balance: (a, s) => `آپ کے پاس ${a} دن سالانہ چھٹی اور ${s} دن مکمل تنخواہ والی بیماری کی چھٹی باقی ہے۔`, payslip: (p, n) => `آپ کی تازہ تنخواہ سلپ (${p}) میں خالص تنخواہ AED ${n} ہے۔`, unknown: 'معذرت، میں چھٹی، بیلنس، تنخواہ سلپ اور خطوط میں مدد کر سکتا ہوں۔', blocked: (m) => `درخواست جمع نہیں ہو سکی: ${m}` },
  tl: { leave_ok: (d, s) => `Naipasa na ang iyong ${d}-araw na leave simula ${s} para sa approval.`, leave_need: 'Pakisabi ang petsa ng simula, hal. "3 araw na leave simula 12 Nov".', letter_ok: () => 'Handa na ang iyong sertipiko. I-download sa My requests.', balance: (a, s) => `May natitira kang ${a} araw na annual leave at ${s} araw na full-pay sick leave.`, payslip: (p, n) => `Ang pinakabagong payslip (${p}) ay may net pay na AED ${n}.`, unknown: 'Pasensya na, makakatulong ako sa leave, balance, payslip at mga sulat.', blocked: (m) => `Hindi naipasa: ${m}` },
};
export const reply = (lang, key, ...args) => { const t = (R[lang] || R.en)[key] || R.en[key]; return typeof t === 'function' ? t(...args) : t; };

// ---------------------------------------------------------------- Speech to text (optional provider)
// Uses an OpenAI-compatible /audio/transcriptions endpoint when STT_API_KEY is set (Whisper handles Gulf Arabic,
// Hindi, Malayalam, Urdu and Tagalog). Without a provider, voice notes are rejected with a clear message.
export const sttEnabled = () => !!process.env.STT_API_KEY;
export async function transcribe(buffer, mime = 'audio/ogg', langHint) {
  if (!sttEnabled()) throw Object.assign(new Error('Voice notes need a speech-to-text provider (set STT_API_KEY). Type your request instead.'), { status: 501 });
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), `voice.${mime.split('/')[1]?.split(';')[0] || 'ogg'}`);
  form.append('model', process.env.STT_MODEL || 'whisper-1');
  if (langHint) form.append('language', langHint);
  const res = await fetch(process.env.STT_URL || 'https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${process.env.STT_API_KEY}` }, body: form, signal: AbortSignal.timeout(60000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${j?.error?.message || ''}`);
  return { text: j.text || '', language: j.language };
}

// ---------------------------------------------------------------- CV parsing (semantic, with rule fallback)
const CV_TOOL = { name: 'cv', description: 'Structured CV summary', input_schema: { type: 'object', properties: { name: { type: ['string', 'null'] }, email: { type: ['string', 'null'] }, phone: { type: ['string', 'null'] }, totalYears: { type: ['number', 'null'] }, currentTitle: { type: ['string', 'null'] }, skills: { type: 'array', items: { type: 'string' } }, languages: { type: 'array', items: { type: 'string' } }, education: { type: ['string', 'null'] }, inUae: { type: ['boolean', 'null'] }, visaStatus: { type: ['string', 'null'] } }, required: ['skills'] } };
export async function parseCv({ buffer, contentType, text }) {
  if (aiEnabled() && (buffer || text)) {
    try {
      const content = buffer ? [{ type: contentType === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: contentType, data: buffer.toString('base64') } }, { type: 'text', text: 'Summarise this CV.' }] : [{ type: 'text', text: `Summarise this CV:\n${text.slice(0, 20000)}` }];
      const out = await callClaude({ system: 'Extract only facts present in the CV. Do not infer age, religion, marital status, gender or nationality.', messages: [{ role: 'user', content }], tools: [CV_TOOL], toolChoice: { type: 'tool', name: 'cv' }, maxTokens: 700 });
      const x = out.content?.find((c) => c.type === 'tool_use')?.input; if (x) return { ...x, engine: 'claude' };
    } catch { /* fall through */ }
  }
  const t = text || '';
  return { email: (t.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [])[0] || null, phone: (t.match(/\+?\d[\d\s-]{8,}\d/) || [])[0] || null, totalYears: Number((t.match(/(\d+)\+?\s*years?/i) || [])[1]) || null, skills: [...new Set((t.match(/\b[A-Z][A-Za-z+#.]{1,20}\b/g) || []).slice(0, 25))], languages: [], engine: 'rules' };
}

/** Explainable match score between a parsed CV and a requisition. */
export function matchScore(cv, req) {
  const want = (req.requirements || []).map((r) => r.toLowerCase()); const have = (cv.skills || []).map((s) => s.toLowerCase());
  const hits = want.filter((w) => have.some((h) => h.includes(w) || w.includes(h)));
  const reasons = hits.map((h) => `Has ${h}`); let score = want.length ? Math.round((hits.length / want.length) * 70) : 35;
  if (cv.totalYears != null) { score += Math.min(20, cv.totalYears * 3); reasons.push(`${cv.totalYears} years' experience`); }
  if (cv.inUae) { score += 10; reasons.push('Already in the UAE'); }
  return { score: Math.min(100, score), reasons, missing: want.filter((w) => !hits.includes(w)) };
}
