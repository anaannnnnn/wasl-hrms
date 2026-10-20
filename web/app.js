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
    <div class="brand" style="padding:0"><span class="mark">W</span><div><b>Wasl</b><small>HRMS · UAE</small></div></div>
    <h1 style="font-size:38px;margin:4px 0 0">Run <em>payroll</em> with confidence</h1>
    <p class="sub" style="margin:0">UAE HR, payroll and compliance</p>
    <div class="field"><label class="lbl" for="em">Email</label><input id="em" type="email" value="admin@alnoor.demo" required></div>
    <div class="field"><label class="lbl" for="pw">Password</label><input id="pw" type="password" value="Demo@2026" required></div>
    <div class="err" id="le"></div>
    <button class="btn pri" type="submit">Sign in</button>
    <p class="note">Demo accounts: admin@alnoor.demo (HR + payroll maker), checker@alnoor.demo (payroll checker). Password Demo@2026.</p>
    <div class="powered" style="padding:12px 0 0"><span>POWERED BY</span><img src="devx-logo-light.png" alt="DevX Technologies"></div>
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

// ---------------- Pulse grid background ----------------
const bg = { mx: -999, my: -999, raf: 0 };
function startBackground() {
  const c = document.getElementById('bgfx'); if (!c) return;
  const ctx = c.getContext('2d');
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const t0 = performance.now(); const G = 48;
  const draw = () => {
    const w = innerWidth, h = innerHeight;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const t = (performance.now() - t0) / 1000;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 0; x <= w; x += G) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
    for (let y = 0; y <= h; y += G) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
    ctx.stroke();
    for (let x = 0; x < w; x += G) for (let y = 0; y < h; y += G) {
      const d = Math.hypot(x + G / 2 - bg.mx, y + G / 2 - bg.my);
      const wave = reduce ? 0 : Math.max(0, Math.sin(x * 0.013 + y * 0.021 - t * 1.4)) ** 8 * 0.3;
      const a = Math.max(wave, d < 200 ? (1 - d / 200) * 0.45 : 0);
      if (a > 0.02) { ctx.fillStyle = `rgba(255,106,43,${a})`; ctx.fillRect(x + 4, y + 4, G - 8, G - 8); }
    }
    if (!reduce) bg.raf = requestAnimationFrame(draw);
  };
  addEventListener('pointermove', (e) => { bg.mx = e.clientX; bg.my = e.clientY; if (reduce) draw(); });
  addEventListener('resize', () => reduce && draw());
  draw();
}

// ---------------- Shell ----------------
const MODS = ['dash', 'emp', 'pay', 'emi', 'docs', 'eosb', 'leave', 'audit'];
const ICONS = {
  dash: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  emp: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8',
  pay: 'M3 7h15a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7zM3 7l2-3h11M16 13.5h2',
  emi: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3zM9 12l2 2 4-4',
  docs: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5zM14 3v5h5M9 13h6M9 17h4',
  eosb: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  leave: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  audit: 'M9 5h11M9 12h11M9 19h11M4 5h.01M4 12h.01M4 19h.01',
};
const icon = (d, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"></path></svg>`;
let collapsed = localStorage.getItem('wasl_rail') === '1';
function shell() {
  document.documentElement.dir = L === 'ar' ? 'rtl' : 'ltr'; document.documentElement.lang = L;
  $('#root').innerHTML = `<div class="app ${collapsed ? 'collapsed' : ''}"><nav class="rail" aria-label="Main">
    <div class="brand"><span class="mark">W</span><div class="fade"><b>Wasl</b><small>HRMS · UAE</small></div></div>
    <div class="sect fade">WORKSPACE</div>
    ${MODS.filter((m) => m !== 'audit' || has('hr_admin')).map((m) => `<button class="nav ${m === cur ? 'on' : ''}" data-m="${m}" aria-label="${esc(t(m))}" title="${esc(t(m))}">${icon(ICONS[m])}<span class="fade">${t(m)}</span></button>`).join('')}
    <div class="rail-foot">
      <div class="who"><span class="av">${esc(ini(me.name))}</span><div class="fade" style="min-width:0"><b>${esc(me.name)}</b><span>${esc(me.roles.join(', '))}</span></div></div>
      <button class="btn sm fade" id="so">${t('signout')}</button>
      <div class="powered fade"><span>POWERED BY</span><img src="devx-logo-light.png" alt="DevX Technologies"></div>
      <button class="collapse" id="col" aria-label="${collapsed ? 'Expand sidebar' : 'Collapse sidebar'}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"></path></svg><span class="fade">Collapse</span></button>
    </div>
  </nav><main>
    <div class="top"><form class="cmd" id="cf"><span class="k">AI ⌘</span><input id="cmd" autocomplete="off" placeholder="${esc(t('ph'))}"><button class="btn pri sm" type="submit">${t('run')}</button></form>
    <button class="btn" id="lb">${t('lang')}</button></div>
    <div class="chips" id="chips" style="margin-bottom:18px"></div>
    <div id="agent"></div><section id="view"><div class="loading">Loading…</div></section>
  </main></div>`;
  document.querySelectorAll('.nav').forEach((b) => (b.onclick = () => go(b.dataset.m)));
  $('#so').onclick = signOut;
  $('#col').onclick = () => {
    collapsed = !collapsed; localStorage.setItem('wasl_rail', collapsed ? '1' : '0');
    $('.app').classList.toggle('collapsed', collapsed);
    $('#col').setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  };
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
    const [d, runs, emps] = await Promise.all([api('/dashboard'), api('/payroll/runs'), api('/employees?status=active')]);
    const k = (f) => (f >= 100000000 ? `${Math.round(f / 100000)}k` : AED0(f));
    const first = (me.name || '').split(' ')[0];
    const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase();
    V(`<div class="eyebrow">${esc(today)}</div>
    <h1>Good day, <em>${esc(first)}</em></h1><p class="sub">Everything due across your establishments this month, ranked by risk.</p>
    <div class="grid g4">
      <div class="panel stat"><div class="v">${d.headcount}</div><span class="lbl">Active employees</span><div class="d">${d.nationals} UAE nationals</div></div>
      <div class="panel stat"><div class="v num">${d.lastRun ? k(d.lastRun.totals?.netFils || 0) : '—'}</div><span class="lbl">Latest net payroll · AED</span><div class="d">${d.lastRun ? `${d.lastRun.period} · ${esc(d.lastRun.status.replace('_', ' '))}` : 'No run yet'}</div></div>
      <div class="panel stat"><div class="v ${d.expiringCount ? 'warn' : ''}">${d.expiringCount}</div><span class="lbl">Docs expiring ≤ 30 days</span><div class="d">Visas, Emirates IDs, licences</div></div>
      <div class="panel stat"><div class="v num ${d.exposureFils ? 'bad' : ''}">${k(d.exposureFils)}</div><span class="lbl">Penalty risk · AED / month</span><div class="d">${d.exposureFils ? 'Emiratisation slot unfilled' : 'No quota gap'}</div></div>
    </div>
    <div class="grid g3" style="margin-top:16px">
      <div class="panel span2"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div><h2 style="margin:0">Net payroll</h2><div style="color:var(--muted);font-size:13px">AED thousands · hover for each month</div></div>
        <div class="seg" role="group" aria-label="Range"><button data-r="6">6M</button><button data-r="12" class="on">12M</button></div></div>
        <div class="chart" id="chart"></div></div>
      <div class="panel"><h2>Headcount by team</h2><div id="deptCap" style="font-size:13px;color:var(--muted);min-height:20px;margin-bottom:6px"></div><div id="depts" style="display:flex;flex-direction:column;gap:6px"></div></div>
    </div>
    <div class="panel" style="margin-top:16px"><h2>Needs attention</h2><div class="list">
      ${d.actions.length ? d.actions.map((a) => `<div class="row"><span class="sev" style="background:var(--${sevVar(a.severity)})"></span><div class="grow">${esc(a.text)}</div><button class="btn sm" data-go="${a.go}">Open</button></div>`).join('') : '<div class="empty">Nothing needs attention right now.</div>'}
    </div></div>`);
    document.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => go(b.dataset.go)));

    // Interactive payroll trend
    const series = runs.filter((r) => r.totals?.netFils).sort((a, b) => a.period.localeCompare(b.period)).map((r) => ({ p: r.period, v: r.totals.netFils / 100000 }));
    const drawChart = (n) => {
      const data = series.slice(-n);
      const el = $('#chart');
      if (data.length < 2) { el.innerHTML = '<div class="empty">The trend appears after two payroll runs.</div>'; return; }
      const vs = data.map((x) => x.v), lo = Math.floor(Math.min(...vs) * 0.97), hi = Math.ceil(Math.max(...vs) * 1.02);
      const X0 = 48, X1 = 664, Y0 = 200, Y1 = 16;
      const px = (i) => X0 + (i * (X1 - X0)) / (data.length - 1), py = (v) => Y0 - ((v - lo) / (hi - lo || 1)) * (Y0 - Y1);
      const pts = data.map((x, i) => [px(i), py(x.v)]);
      const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
      const ticks = [0, 1, 2, 3].map((i) => lo + ((hi - lo) * i) / 3);
      const mon = (p) => new Date(p + '-01').toLocaleDateString('en-GB', { month: 'short' });
      el.innerHTML = `<svg viewBox="0 0 680 230" role="img" aria-label="Net payroll trend">
        <defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff6a2b" stop-opacity=".3"/><stop offset="1" stop-color="#ff6a2b" stop-opacity="0"/></linearGradient></defs>
        ${ticks.map((v) => `<line x1="40" x2="672" y1="${py(v)}" y2="${py(v)}" stroke="#1f4b59"/><text x="0" y="${py(v) + 4}" fill="#a9c0c8" font-size="11">${Math.round(v)}</text>`).join('')}
        <path d="${line} L${X1} ${Y0} L${X0} ${Y0} Z" fill="url(#ga)"/>
        <path d="${line}" fill="none" stroke="#ff7a3d" stroke-width="2.5" stroke-linejoin="round"/>
        ${data.map((x, i) => `<text x="${px(i)}" y="226" fill="#a9c0c8" font-size="11" text-anchor="middle">${mon(x.p)}</text>`).join('')}
        <circle cx="${pts.at(-1)[0]}" cy="${pts.at(-1)[1]}" r="4.5" fill="#ff7a3d"/>
        <g id="hov" visibility="hidden"><line id="hl" y1="12" y2="200" stroke="#ff7a3d" stroke-opacity=".4" stroke-dasharray="3 4"/><circle id="hc" r="6" fill="#0f2e39" stroke="#ff7a3d" stroke-width="2.5"/></g>
      </svg><div class="tip" id="tip" hidden></div>`;
      const svg = el.querySelector('svg'), tip = $('#tip');
      svg.onmousemove = (e) => {
        const r = svg.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * 680;
        const i = Math.max(0, Math.min(data.length - 1, Math.round(((x - X0) / (X1 - X0)) * (data.length - 1))));
        $('#hov').setAttribute('visibility', 'visible');
        $('#hl').setAttribute('x1', pts[i][0]); $('#hl').setAttribute('x2', pts[i][0]);
        $('#hc').setAttribute('cx', pts[i][0]); $('#hc').setAttribute('cy', pts[i][1]);
        tip.hidden = false; tip.style.left = `${(pts[i][0] / 680) * 100}%`;
        tip.innerHTML = `<small>${esc(data[i].p)}</small><span class="num">AED ${data[i].v.toFixed(1)}k</span>`;
      };
      svg.onmouseleave = () => { $('#hov').setAttribute('visibility', 'hidden'); tip.hidden = true; };
    };
    document.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => { document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b)); drawChart(+b.dataset.r); }));
    drawChart(12);

    // Team bars
    const byDept = {}; emps.forEach((e) => { const k2 = e.department || 'Other'; (byDept[k2] ||= []).push(e); });
    const teams = Object.entries(byDept).sort((a, b) => b[1].length - a[1].length);
    const max = teams[0]?.[1].length || 1;
    const showDept = (name) => {
      const list = byDept[name] || [];
      const nat = list.filter((e) => e.isUaeNational).length;
      $('#deptCap').textContent = `${name} · ${list.length} people${nat ? ` · ${nat} UAE national${nat > 1 ? 's' : ''}` : ''}`;
      document.querySelectorAll('#depts .bar').forEach((b) => b.classList.toggle('on', b.dataset.d === name));
    };
    $('#depts').innerHTML = teams.map(([name, list]) => `<button class="bar" data-d="${esc(name)}"><div style="display:flex;justify-content:space-between;font-size:13px"><span>${esc(name)}</span><span class="num" style="color:var(--muted)">${list.length}</span></div><div class="t"><i style="width:${(list.length / max) * 100}%"></i></div></button>`).join('');
    document.querySelectorAll('#depts .bar').forEach((b) => { b.onmouseenter = b.onfocus = b.onclick = () => showDept(b.dataset.d); });
    if (teams[0]) showDept(teams[0][0]);
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
startBackground();
token ? shell() : loginView();
