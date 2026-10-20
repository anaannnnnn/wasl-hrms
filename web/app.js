// Wasl HRMS web client. Plain ES modules, no build step.
const API = '/api';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AED = (f) => ((f || 0) / 100).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const AED0 = (f) => Math.round((f || 0) / 100).toLocaleString('en-AE');
const ini = (n) => String(n).split(' ').map((x) => x[0]).slice(0, 2).join('');
const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

let token = localStorage.getItem('wasl_token');
let me = JSON.parse(localStorage.getItem('wasl_user') || 'null');
let L = localStorage.getItem('wasl_lang') || 'en';
let cur = location.hash.slice(1) || 'dash';

const T = {
  en: { dash: 'Command Center', emp: 'Employees', pay: 'Payroll & WPS', emi: 'Emiratisation', docs: 'Document Radar', eosb: 'Gratuity (EOSB)', leave: 'Leave', audit: 'Audit log', run: 'Run', lang: 'العربية', signout: 'Sign out',
    ph: 'Ask or instruct… e.g. Hire Omar Al-Maktoum as Senior Engineer, AED 22,000, start Nov 1' },
  ar: { dash: 'مركز القيادة', emp: 'الموظفون', pay: 'الرواتب ونظام حماية الأجور', emi: 'التوطين', docs: 'رادار الوثائق', eosb: 'مكافأة نهاية الخدمة', leave: 'الإجازات', audit: 'سجل التدقيق', run: 'تنفيذ', lang: 'English', signout: 'تسجيل الخروج',
    ph: 'اطلب أو وجّه… مثال: تعيين عمر المكتوم مهندساً أول براتب 22,000 درهم' },
};
const t = (k) => T[L][k] || T.en[k];

async function api(path, opts = {}) {
  const res = await fetch(API + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') { signOut(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let tt;
function toast(m) { const el = $('#toast'); el.textContent = m; el.hidden = false; clearTimeout(tt); tt = setTimeout(() => (el.hidden = true), 3200); }
const fail = (e) => toast(e.message);
const has = (...r) => me?.roles?.some((x) => r.includes(x) || x === 'owner');

// ---------------- Login ----------------
function loginView() {
  $('#root').innerHTML = `<div class="login"><form class="panel" id="lf">
    <div style="font-family:var(--f-display);font-size:28px;font-weight:700">Wasl</div>
    <p class="sub" style="margin:0">UAE HR, payroll and compliance</p>
    <div class="field"><label class="lbl" for="em">Email</label><input id="em" type="email" value="admin@alnoor.demo" required></div>
    <div class="field"><label class="lbl" for="pw">Password</label><input id="pw" type="password" value="Demo@2026" required></div>
    <div class="err" id="le"></div>
    <button class="btn pri" type="submit">Sign in</button>
    <p class="note">Demo accounts: admin@alnoor.demo (HR + payroll maker), checker@alnoor.demo (payroll checker). Password Demo@2026.</p>
  </form></div>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email: $('#em').value, password: $('#pw').value } });
      token = r.token; me = r.user;
      localStorage.setItem('wasl_token', token); localStorage.setItem('wasl_user', JSON.stringify(me));
      shell();
    } catch (err) { $('#le').textContent = err.message; }
  };
}
function signOut() { token = null; me = null; localStorage.removeItem('wasl_token'); localStorage.removeItem('wasl_user'); loginView(); }

// ---------------- Shell ----------------
const MODS = ['dash', 'emp', 'pay', 'emi', 'docs', 'eosb', 'leave', 'audit'];
function shell() {
  document.documentElement.dir = L === 'ar' ? 'rtl' : 'ltr'; document.documentElement.lang = L;
  $('#root').innerHTML = `<div class="app"><nav class="rail">
    <div class="brand">Wasl<small>HRMS · UAE</small></div>
    ${MODS.filter((m) => m !== 'audit' || has('hr_admin')).map((m) => `<button class="nav ${m === cur ? 'on' : ''}" data-m="${m}"><span class="dot"></span>${t(m)}</button>`).join('')}
    <div class="entity"><span class="lbl">Signed in</span><b>${esc(me.name)}</b>${esc(me.roles.join(', '))}<br><button class="btn sm" id="so" style="margin-top:8px">${t('signout')}</button></div>
  </nav><main>
    <div class="top"><form class="cmd" id="cf"><span class="k">AI ⌘</span><input id="cmd" autocomplete="off" placeholder="${esc(t('ph'))}"><button class="btn pri sm" type="submit">${t('run')}</button></form>
    <button class="btn" id="lb">${t('lang')}</button></div>
    <div class="chips" id="chips" style="margin-bottom:18px"></div>
    <div id="agent"></div><section id="view"><div class="loading">Loading…</div></section>
  </main></div>`;
  document.querySelectorAll('.nav').forEach((b) => (b.onclick = () => go(b.dataset.m)));
  $('#so').onclick = signOut;
  $('#lb').onclick = () => { L = L === 'en' ? 'ar' : 'en'; localStorage.setItem('wasl_lang', L); shell(); };
  $('#cf').onsubmit = (e) => { e.preventDefault(); const q = $('#cmd').value.trim(); if (q) agent(q); };
  ['Hire Omar Al-Maktoum as Senior Frontend Engineer, AED 22,000, start Nov 1', 'Ahmed Khan wants 3 days annual leave from 26 Oct', 'Salary certificate for Priya Menon addressed to Emirates NBD'].forEach((c) => {
    const b = document.createElement('button'); b.className = 'chip'; b.type = 'button'; b.textContent = c; b.onclick = () => { $('#cmd').value = c; agent(c); }; $('#chips').appendChild(b);
  });
  views[cur]().catch(fail);
}
function go(m) { cur = m; location.hash = m; shell(); }
const V = (html) => ($('#view').innerHTML = html);
const sevVar = (s) => ({ bad: 'bad', warn: 'warn', info: 'accent' }[s] || 'accent');
const pill = (cls, txt) => `<span class="pill ${cls}">${esc(txt)}</span>`;

// ---------------- Views ----------------
const views = {
  async dash() {
    const d = await api('/dashboard');
    V(`<h1>${t('dash')}</h1><p class="sub">Everything due this month across your establishments, ranked by risk.</p>
    <div class="grid g4">
      <div class="panel stat"><div class="lbl">Headcount</div><div class="v">${d.headcount}</div><div class="d">${d.nationals} UAE nationals</div></div>
      <div class="panel stat"><div class="lbl">Latest payroll (net)</div><div class="v num">${d.lastRun ? AED0(d.lastRun.totals?.netFils) : '—'}</div><div class="d">${d.lastRun ? `${d.lastRun.period} · ${d.lastRun.status.replace('_', ' ')}` : 'No run yet'}</div></div>
      <div class="panel stat"><div class="lbl">Docs expiring ≤30d</div><div class="v">${d.expiringCount}</div><div class="d">Visas, EIDs, licences</div></div>
      <div class="panel stat"><div class="lbl">Penalty exposure</div><div class="v num" style="color:var(--bad)">${AED0(d.exposureFils)}</div><div class="d">AED / month</div></div>
    </div>
    <div class="panel" style="margin-top:16px"><h2>Needs attention</h2><div class="list">
      ${d.actions.length ? d.actions.map((a) => `<div class="row"><span class="sev" style="background:var(--${sevVar(a.severity)})"></span><div class="grow">${esc(a.text)}</div><button class="btn sm" data-go="${a.go}">Open</button></div>`).join('') : '<div class="empty">Nothing needs attention right now.</div>'}
    </div></div>`);
    document.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => go(b.dataset.go)));
  },

  async emp() {
    const list = await api('/employees');
    V(`<h1>${t('emp')}</h1><p class="sub">${list.length} employees. Bank details are masked; full IBANs are never sent to the browser.</p>
    <div class="panel tw"><table><thead><tr><th>Employee</th><th>Role</th><th>Nationality</th><th>Joined</th><th>Status</th><th>IBAN</th><th class="r">Basic (AED)</th></tr></thead><tbody>
    ${list.map((e) => `<tr><td><div style="display:flex;gap:10px;align-items:center"><span class="av">${esc(ini(e.fullName))}</span><div><b style="font-weight:500">${esc(L === 'ar' && e.fullNameAr ? e.fullNameAr : e.fullName)}</b><div class="mono" style="font-size:11px;color:var(--muted)">${esc(e.employeeNo)}</div></div></div></td>
      <td>${esc(e.jobTitle)}</td><td>${e.isUaeNational ? pill('p-g', 'UAE National') : esc(e.nationality)}</td><td class="mono">${fmtDate(e.joinDate)}</td>
      <td>${pill(e.status === 'active' ? 'p-ok' : 'p-n', e.status)}</td>
      <td>${e.ibanValid ? `<span class="mono">${esc(e.bank.ibanMasked)}</span>` : `${pill('p-bad', 'Invalid')} ${has('hr_admin') ? `<button class="btn sm" data-fix="${e._id}">Update</button>` : ''}`}</td>
      <td class="r num">${AED(e.compensation.basicFils)}</td></tr>`).join('')}
    </tbody></table></div>`);
    document.querySelectorAll('[data-fix]').forEach((b) => (b.onclick = () => ibanForm(b.dataset.fix, b.closest('td'))));
  },

  async pay() {
    const [ests, runs] = await Promise.all([api('/establishments'), api('/payroll/runs')]);
    const est = ests[0];
    const now = new Date(); const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let run = runs.find((r) => r.period === period && String(r.establishmentId) === String(est._id));
    if (!run) { V(`<h1>${t('pay')}</h1><div class="panel"><p>No payroll computed for ${period} yet.</p><button class="btn pri" id="comp">Compute ${period} payroll</button></div>`); $('#comp').onclick = () => compute(est._id, period); return; }
    run = await api(`/payroll/runs/${run._id}`);
    const pf = await api(`/payroll/runs/${run._id}/preflight`);
    const stepsAll = ['draft', 'pending_approval', 'approved', 'exported'];
    const at = run.status === 'preflight_failed' ? 0 : stepsAll.indexOf(run.status);
    V(`<h1>${t('pay')} · ${run.period}</h1><p class="sub">${esc(est.name)} · rule pack ${esc(run.rulePack)}. Export stays locked until pre-flight passes and a different person approves.</p>
    <div class="steps">${['Compute', 'Pre-flight & submit', 'Checker approval', 'SIF export'].map((s, i) => `<span class="${i < at + 1 ? 'done' : i === at + 1 ? 'on' : ''}">${s}</span>`).join('')}</div>
    <div class="grid g2">
      <div class="panel"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="margin:0">WPS pre-flight</h2>${pf.blocking ? pill('p-bad', `${pf.blocking} blocking`) : pill('p-ok', 'No blocking errors')}</div>
        <div style="margin-top:10px">${pf.checks.map((c) => `<div class="check"><span class="ic ${c.status === 'pass' ? 'ok' : c.status === 'fail' ? 'bad' : 'warn'}">${c.status === 'pass' ? '✓' : c.status === 'fail' ? '!' : '~'}</span><div style="min-width:0"><div>${esc(c.label)}</div><div class="mono" style="font-size:11.5px;color:var(--muted);overflow-wrap:anywhere">${esc(c.detail)}</div></div></div>`).join('')}</div>
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap" id="acts"></div>
      </div>
      <div class="panel"><h2>Net pay register</h2><div class="tw"><table><thead><tr><th>Employee</th><th class="r">Fixed</th><th class="r">Variable</th><th class="r">Net</th></tr></thead><tbody>
        ${run.lines.map((l) => `<tr><td>${esc(l.employeeName)} ${l.held ? pill('p-bad', 'held') : l.flags.some((f) => f.severity === 'warn') ? pill('p-warn', 'review') : ''}</td><td class="r num">${AED(l.fixedFils)}</td><td class="r num">${AED(l.variableFils)}</td><td class="r num">${AED(l.netFils)}</td></tr>`).join('')}
        <tr><td><b>Total (excl. held)</b></td><td></td><td></td><td class="r num"><b>${AED(run.totals.netFils - run.totals.heldFils)}</b></td></tr>
      </tbody></table></div></div>
    </div><div id="sifOut"></div>`);
    const acts = $('#acts');
    const btn = (label, fn, pri) => { const b = document.createElement('button'); b.className = `btn ${pri ? 'pri' : ''}`; b.textContent = label; b.onclick = () => fn().catch(fail); acts.appendChild(b); };
    if (!run.locked && has('payroll_maker', 'hr_admin')) btn('Recompute', () => compute(est._id, period));
    if (['draft', 'preflight_failed'].includes(run.status) && has('payroll_maker', 'hr_admin')) btn('Submit for approval', async () => { const r = await api(`/payroll/runs/${run._id}/submit`, { method: 'POST' }); toast(r.blocking ? `Blocked: ${r.blocking} error(s) to fix first` : 'Sent to checker'); shell(); }, true);
    if (run.status === 'pending_approval' && has('payroll_checker')) btn('Approve payroll', async () => { await api(`/payroll/runs/${run._id}/approve`, { method: 'POST' }); toast('Approved and locked'); shell(); }, true);
    if (run.status === 'pending_approval' && !has('payroll_checker')) acts.insertAdjacentHTML('beforeend', `<span class="note" style="margin:0">Waiting for a payroll checker. Sign in as checker@alnoor.demo to approve.</span>`);
    if (['approved', 'exported'].includes(run.status)) btn('Export .SIF', async () => {
      const r = await api(`/payroll/runs/${run._id}/sif`, { method: 'POST' });
      const url = URL.createObjectURL(new Blob([r.content], { type: 'text/plain' }));
      $('#sifOut').innerHTML = `<div class="panel" style="margin-top:16px"><h2>${esc(r.filename)}</h2><pre class="sif">${esc(r.content)}</pre><a class="btn pri" style="display:inline-block;margin-top:10px;text-decoration:none" href="${url}" download="${esc(r.filename)}">Download file</a></div>`;
    }, true);
  },

  async emi() {
    const [list, nafis] = await Promise.all([api('/compliance/emiratisation'), api('/compliance/nafis?wage=6500')]);
    V(`<h1>${t('emi')} Shield</h1><p class="sub">Quota status per establishment, from the versioned rule pack. Figures need legal validation before relying on them.</p>
    ${list.map((a) => !a.applicable ? `<div class="panel"><h2>${esc(a.establishment.name)}</h2><p>${esc(a.reason || 'Below quota thresholds.')}</p></div>` : `
    <div class="grid g2"><div class="panel"><div class="lbl">${esc(a.establishment.name)} · Tier ${a.tier} · ${a.headcount} staff</div>
      <div class="big">${a.qualifyingCount} <span style="color:var(--muted);font-size:22px">/ ${a.required}</span></div>
      <div class="meter" style="margin:12px 0"><i style="width:${Math.min(100, (a.qualifyingCount / a.required) * 100)}%"></i></div>
      <div class="list">${a.qualifying.map((q) => `<div class="row"><span class="av">${esc(ini(q.name))}</span><div class="grow">${esc(q.name)}<div style="font-size:12px;color:var(--muted)">AED ${AED0(q.wageFils)} / month</div></div>${pill('p-ok', 'Counts')}</div>`).join('')}
      ${a.notQualifying.map((q) => `<div class="row"><span class="av">${esc(ini(q.name))}</span><div class="grow">${esc(q.name)}<div style="font-size:12px;color:var(--bad)">${esc(q.reasons.join(' · '))}</div></div>${pill('p-bad', 'Not counted')}</div>`).join('')}</div>
    </div>
    <div class="panel"><h2>Hire vs. pay the fine</h2><div class="trace">Unfilled slots <b>${a.gap}</b><br>Monthly exposure <b class="num">AED ${AED0(a.monthlyExposureFils)}</b><br>Annual exposure <b class="num">AED ${AED0(a.annualExposureFils)}</b>
      <hr style="border:0;border-top:1px dashed var(--line);margin:10px 0">Hire at <b class="num">AED ${AED0(nafis.grossWageFils)}</b><br>Modelled NAFIS support <b class="num">− AED ${AED0(nafis.modelledSubsidyFils)}</b><br>Net monthly cost <b class="num">AED ${AED0(nafis.netMonthlyCostFils)}</b></div>
      <div class="big num" style="color:var(--ok);margin-top:12px">AED ${AED0(nafis.annualSavingVsFineFils * a.gap)}</div><div style="font-size:12.5px;color:var(--muted)">modelled yearly saving by hiring instead of paying</div>
      <p class="note">${esc(nafis.note)}</p></div></div>`).join('')}`);
  },

  async docs() {
    const docs = await api('/documents/expiring?days=90');
    const dp = (d) => pill(d <= 14 ? 'p-bad' : d <= 30 ? 'p-warn' : 'p-n', `${d} days`);
    V(`<h1>${t('docs')}</h1><p class="sub">Alerts at 90, 60, 30 and 7 days. Opening a case creates the renewal steps with an owner.</p>
    <div class="panel tw"><table><thead><tr><th>Holder</th><th>Document</th><th>Expiry</th><th>Expires in</th><th>Renewal</th></tr></thead><tbody>
    ${docs.map((d) => `<tr><td>${esc(d.holder)}</td><td>${esc(d.docType.replace(/_/g, ' '))}</td><td class="mono">${fmtDate(d.expiryDate)}</td><td>${dp(d.daysLeft)}</td>
      <td>${d.renewalCase?.status && d.renewalCase.status !== 'none' ? pill('p-ok', `Case ${d.renewalCase.status}`) : has('hr_admin') ? `<button class="btn sm" data-case="${d._id}">Open case</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="5" class="empty">No documents expiring in 90 days.</td></tr>`}
    </tbody></table></div>`);
    document.querySelectorAll('[data-case]').forEach((b) => (b.onclick = async () => { try { const c = await api(`/documents/${b.dataset.case}/renewal`, { method: 'POST' }); toast(`Case opened: ${c.steps.map((s) => s.name).join(' → ')}`); views.docs(); } catch (e) { fail(e); } }));
  },

  async eosb() {
    const list = await api('/employees?status=active');
    V(`<h1>${t('eosb')}</h1><p class="sub">Calculated on the server from the versioned rule pack, with every step shown.</p>
    <div class="grid g2"><div class="panel"><div class="form">
      <div class="field" style="grid-column:1/-1"><label class="lbl" for="eE">Employee</label><select id="eE">${list.map((e) => `<option value="${e._id}">${esc(e.fullName)} · joined ${fmtDate(e.joinDate)}</option>`).join('')}</select></div>
      <div class="field"><label class="lbl" for="eD">Last working day</label><input id="eD" type="date" value="${new Date(Date.now() + 12 * 864e5).toISOString().slice(0, 10)}"></div>
      <div class="field"><label class="lbl" for="eU">Unpaid leave days</label><input id="eU" type="number" min="0" value="0"></div>
      <div class="field"><label class="lbl" for="eS">Scheme</label><select id="eS"><option value="">Mainland (Art. 51)</option><option value="DEWS">DEWS / savings scheme</option></select></div>
    </div></div><div class="panel" id="eO"><div class="loading">Calculating…</div></div></div>`);
    const calc = async () => {
      try {
        const r = await api('/compliance/gratuity', { method: 'POST', body: { employeeId: $('#eE').value, lastWorkingDate: $('#eD').value, unpaidLeaveDays: Number($('#eU').value) || 0, scheme: $('#eS').value || undefined } });
        $('#eO').innerHTML = `<div class="lbl">Gratuity payable</div><div class="big num">AED ${AED(r.amountFils)}</div><div class="trace" style="margin-top:12px">${r.trace.map(esc).join('<br>')}</div>`;
      } catch (e) { $('#eO').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    };
    const anil = list.find((e) => e.fullName === 'Anil Kumar'); if (anil) $('#eE').value = anil._id;
    ['#eE', '#eD', '#eU', '#eS'].forEach((s) => $(s).addEventListener('change', calc));
    calc();
  },

  async leave() {
    const list = await api('/leave');
    V(`<h1>${t('leave')}</h1><p class="sub">Requests from the web, app, WhatsApp or the AI agent, with team overlap checks.</p>
    <div class="panel"><div class="list">
      ${list.map((l) => `<div class="row"><span class="av">${esc(ini(l.employeeId?.fullName || '?'))}</span><div class="grow"><b style="font-weight:500">${esc(l.employeeId?.fullName)}</b> · ${esc(l.type)} · <span class="mono">${fmtDate(l.startDate)} → ${fmtDate(l.endDate)}</span> (${l.days}d)
        <div style="font-size:12px;color:var(--${l.overlaps?.length ? 'warn' : 'muted'})">${l.overlaps?.length ? `Overlaps ${esc(l.overlaps.join(', '))} in ${esc(l.employeeId?.department)}` : `Source: ${esc(l.source)}`}</div></div>
        ${l.status === 'pending' && has('hr_admin', 'manager') ? `<button class="btn sm" data-d="${l._id}" data-v="rejected">Reject</button><button class="btn sm pri" data-d="${l._id}" data-v="approved">Approve</button>` : pill(l.status === 'approved' ? 'p-ok' : l.status === 'rejected' ? 'p-bad' : 'p-n', l.status)}</div>`).join('') || '<div class="empty">No leave requests.</div>'}
    </div></div>`);
    document.querySelectorAll('[data-d]').forEach((b) => (b.onclick = async () => { try { await api(`/leave/${b.dataset.d}/decision`, { method: 'POST', body: { decision: b.dataset.v } }); toast(`Leave ${b.dataset.v}`); views.leave(); } catch (e) { fail(e); } }));
  },

  async audit() {
    const list = await api('/audit');
    V(`<h1>${t('audit')}</h1><p class="sub">Append-only record of every change, approval, export and AI action.</p>
    <div class="panel tw"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Correlation</th></tr></thead><tbody>
    ${list.map((a) => `<tr><td class="mono">${new Date(a.createdAt).toLocaleString('en-AE')}</td><td>${pill(a.actorType === 'agent' ? 'p-g' : 'p-n', a.actorType)}</td><td class="mono">${esc(a.action)}</td><td>${esc(a.entity)}</td><td class="mono" style="font-size:11px">${esc((a.correlationId || '').slice(0, 8))}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No events yet.</td></tr>'}
    </tbody></table></div>`);
  },
};

async function compute(establishmentId, period) {
  try { await api('/payroll/runs', { method: 'POST', body: { establishmentId, period } }); toast('Payroll computed'); views.pay(); } catch (e) { fail(e); }
}

function ibanForm(id, td) {
  td.innerHTML = `<form style="display:flex;gap:6px"><input class="mono" style="min-width:0;width:210px;font:inherit;padding:4px 6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)" placeholder="AE.. 23 characters" required><button class="btn sm pri">Save</button></form>`;
  td.querySelector('form').onsubmit = async (e) => { e.preventDefault(); try { await api(`/employees/${id}/bank`, { method: 'PATCH', body: { iban: td.querySelector('input').value.replace(/\s/g, '') } }); toast('IBAN updated. Recompute payroll to clear the hold.'); views.emp(); } catch (err) { fail(err); } };
}

// ---------------- AI agent ----------------
async function agent(q) {
  const slot = $('#agent');
  slot.innerHTML = `<div class="agent"><div class="loading" style="padding:0">Reading your instruction…</div></div>`;
  try {
    const p = await api('/agent/propose', { method: 'POST', body: { command: q } });
    slot.innerHTML = `<div class="agent"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><h2 style="margin:0">${esc(p.title)}</h2>${p.valid ? pill('p-g', 'Needs your approval') : pill('p-warn', 'More detail needed')}</div>
      ${p.steps ? `<div class="steps">${p.steps.map((s, i) => `<span class="${i === 0 ? 'done' : ''}">${esc(s)}</span>`).join('')}</div>` : ''}
      <div class="trace">${(p.checks || []).map(esc).join('<br>')}</div>
      <div style="display:flex;gap:8px;margin-top:14px">${p.valid ? '<button class="btn pri" id="aOk">Approve & run</button>' : ''}<button class="btn" id="aNo">Discard</button></div></div>`;
    $('#aNo').onclick = async () => { slot.innerHTML = ''; api(`/agent/${p.id}/discard`, { method: 'POST' }).catch(() => {}); };
    if (p.valid) $('#aOk').onclick = async () => {
      try { const r = await api(`/agent/${p.id}/execute`, { method: 'POST' }); slot.querySelectorAll('.steps span').forEach((s) => (s.className = 'done')); toast(r.message); setTimeout(() => { slot.innerHTML = ''; views[cur]().catch(fail); }, 1200); } catch (e) { fail(e); }
    };
  } catch (e) { slot.innerHTML = ''; fail(e); }
}

window.addEventListener('hashchange', () => { const m = location.hash.slice(1); if (token && MODS.includes(m) && m !== cur) { cur = m; shell(); } });
if (!MODS.includes(cur)) cur = 'dash';
token ? shell() : loginView();
