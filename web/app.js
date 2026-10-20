// Wasl HRMS web client. Plain ES modules, no build step.
import { translateTree } from './i18n.js';
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
  en: { dash: 'Command Center', emp: 'Employees', pay: 'Payroll & WPS', emi: 'Emiratisation', docs: 'Document Radar', eosb: 'Gratuity (EOSB)', leave: 'Leave', audit: 'Audit log', requests: 'Requests', setup: 'Setup', me: 'My Workspace', run: 'Run', lang: 'العربية', signout: 'Sign out',
    ehome: 'Home', eclock: 'Attendance', eleave: 'Leave', epay: 'Payslips', edocs: 'Documents', ereq: 'Requests', eai: 'HR assistant', etag: 'My ID tag', attendance: 'Attendance',
    ph: 'Ask or instruct… e.g. Hire Omar Al-Maktoum as Senior Engineer, AED 22,000, start Nov 1' },
  ar: { dash: 'مركز القيادة', emp: 'الموظفون', pay: 'الرواتب ونظام حماية الأجور', emi: 'التوطين', docs: 'رادار الوثائق', eosb: 'مكافأة نهاية الخدمة', leave: 'الإجازات', audit: 'سجل التدقيق', requests: 'الطلبات', setup: 'الإعداد', me: 'مساحتي', run: 'تنفيذ', lang: 'English', signout: 'تسجيل الخروج',
    ehome: 'الرئيسية', eclock: 'الحضور', eleave: 'الإجازات', epay: 'قسائم الرواتب', edocs: 'الوثائق', ereq: 'الطلبات', eai: 'مساعد الموارد البشرية', etag: 'بطاقتي', attendance: 'الحضور',
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
const EMP_ENTRY = /^\/employee\/?$/.test(location.pathname);
function loginView() {
  const empMode = EMP_ENTRY;
  $('#root').innerHTML = `<div class="login"><form class="panel" id="lf">
    <div class="brand" style="padding:0"><span class="mark">W</span><div><b>Wasl</b><small>${empMode ? 'EMPLOYEE APP' : 'HRMS · UAE'}</small></div></div>
    ${empMode
      ? `<h1 style="font-size:38px;margin:4px 0 0">Your <em>workday</em>, in your pocket</h1>
         <p class="sub" style="margin:0">Clock in, apply for leave, get payslips and letters.</p>`
      : `<h1 style="font-size:38px;margin:4px 0 0">Run <em>payroll</em> with confidence</h1>
         <p class="sub" style="margin:0">UAE HR, payroll and compliance</p>`}
    <div class="field"><label class="lbl" for="em">${empMode ? 'Work email' : 'Email'}</label><input id="em" type="email" autocomplete="username" value="${empMode ? 'ahmed@alnoor.demo' : 'admin@alnoor.demo'}" required></div>
    <div class="field"><label class="lbl" for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" value="Demo@2026" required></div>
    <div class="err" id="le"></div>
    <button class="btn pri" type="submit">Sign in</button>
    <p class="note">${empMode
      ? 'Demo employees: ahmed@alnoor.demo (delivery driver), grace@alnoor.demo (sales). Password Demo@2026.'
      : 'Demo accounts: admin@alnoor.demo (HR + payroll maker), checker@alnoor.demo (payroll checker). Password Demo@2026.'}</p>
    <a href="${empMode ? '/' : '/employee'}" style="font-size:13px">${empMode ? 'HR or manager? Sign in here' : 'Employee? Use the employee app'}</a>
    <div class="powered" style="padding:12px 0 0"><span>POWERED BY</span><img src="devx-logo-dark.png" alt="DevX Technologies"></div>
  </form></div>`;
  translateTree($('#root'), L);
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
    ctx.strokeStyle = 'rgba(17,17,17,0.045)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 0; x <= w; x += G) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
    for (let y = 0; y <= h; y += G) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
    ctx.stroke();
    for (let x = 0; x < w; x += G) for (let y = 0; y < h; y += G) {
      const d = Math.hypot(x + G / 2 - bg.mx, y + G / 2 - bg.my);
      const wave = reduce ? 0 : Math.max(0, Math.sin(x * 0.013 + y * 0.021 - t * 1.4)) ** 8 * 0.3;
      const a = Math.max(wave, d < 200 ? (1 - d / 200) * 0.45 : 0);
      if (a > 0.02) { ctx.fillStyle = `rgba(255,91,31,${a * 0.45})`; ctx.fillRect(x + 4, y + 4, G - 8, G - 8); }
    }
    if (!reduce) bg.raf = requestAnimationFrame(draw);
  };
  addEventListener('pointermove', (e) => { bg.mx = e.clientX; bg.my = e.clientY; if (reduce) draw(); });
  addEventListener('resize', () => reduce && draw());
  draw();
}

// ---------------- Shell ----------------
const STAFF_MODS = ['dash', 'emp', 'attendance', 'pay', 'emi', 'docs', 'eosb', 'leave', 'requests', 'setup', 'audit'];
const EMP_MODS = ['ehome', 'eclock', 'eleave', 'epay', 'edocs', 'ereq', 'eai', 'etag'];
const isStaffUser = () => has('hr_admin', 'payroll_maker', 'payroll_checker', 'manager');
const mods = () => (isStaffUser() ? STAFF_MODS.filter((m) => !['audit', 'setup', 'requests'].includes(m) || has('hr_admin')) : EMP_MODS);
let ESTS = []; let EST = localStorage.getItem('wasl_est') || '';
const currentEst = () => ESTS.find((e) => e._id === EST) || ESTS.find((e) => e.jurisdiction === 'MAINLAND') || ESTS[0];
// Open an authenticated HTML document (payslip, letter) in a new tab
async function openHtml(path, opts = {}) {
  const w = window.open('', '_blank');
  try {
    const res = await fetch(API + path, { method: opts.method || 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `Failed (${res.status})`); }
    const url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/html' }));
    if (w) w.location = url; else location.href = url;
  } catch (e) { if (w) w.close(); fail(e); }
}
async function openFile(path) {
  const w = window.open('', '_blank');
  try {
    const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `Failed (${res.status})`); }
    if ((res.headers.get('content-type') || '').includes('application/json')) { const j = await res.json(); if (w) w.location = j.url; return; }
    const url = URL.createObjectURL(await res.blob()); if (w) w.location = url;
  } catch (e) { if (w) w.close(); fail(e); }
}
const fileToBase64 = (file) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = bad; r.readAsDataURL(file); });
const ICONS = {
  dash: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  emp: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8',
  pay: 'M3 7h15a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7zM3 7l2-3h11M16 13.5h2',
  emi: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3zM9 12l2 2 4-4',
  docs: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5zM14 3v5h5M9 13h6M9 17h4',
  eosb: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  leave: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  audit: 'M9 5h11M9 12h11M9 19h11M4 5h.01M4 12h.01M4 19h.01',
  requests: 'M4 5h16v11H9l-5 4z',
  setup: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  me: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  ehome: 'M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10',
  eclock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  attendance: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
  eleave: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  epay: 'M3 7h15a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7zM3 7l2-3h11M16 13.5h2',
  edocs: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5zM14 3v5h5M9 13h6M9 17h4',
  ereq: 'M4 5h16v11H9l-5 4z',
  eai: 'M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z',
  etag: 'M4 6h16v12H4zM8 10h3M8 14h5M15 10h2v4h-2z',
};
const icon = (d, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"></path></svg>`;
let collapsed = localStorage.getItem('wasl_rail') === '1';
function shell() {
  document.documentElement.dir = L === 'ar' ? 'rtl' : 'ltr'; document.documentElement.lang = L;
  if (!mods().includes(cur)) cur = mods()[0];
  document.body.classList.toggle('empmode', !isStaffUser());
    $('#root').innerHTML = `<div class="app ${isStaffUser() ? '' : 'emp'}">
  <header class="topbar"><div class="topbar-in">
    <a class="brand" href="${isStaffUser() ? '/' : '/employee'}" aria-label="Wasl home"><span class="mark">W</span><span class="brand-txt"><b>Wasl</b><span class="by">by <img src="devx-logo-dark.png" alt="DevX Technologies"></span></span></a>
    <nav class="navpills" aria-label="Main">${mods().map((m) => `<button class="nav ${m === cur ? 'on' : ''}" data-m="${m}" aria-label="${esc(t(m))}" title="${esc(t(m))}">${icon(ICONS[m], 18)}<span>${t(m)}</span></button>`).join('')}</nav>
    <div class="actions">
      <div style="position:relative"><button class="iconbtn" id="bell" aria-label="Notifications" title="Notifications">${icon('M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0', 18)}<span id="bellCt" class="ct" hidden></span></button>
        <div id="bellPanel" class="panel popover" hidden></div></div>
      <button class="iconbtn txt" id="lb" title="Language">${t('lang')}</button>
      <div style="position:relative"><button class="avatarbtn" id="whoBtn" aria-haspopup="true" aria-expanded="false"><span class="av">${esc(ini(me.name))}</span><span class="who-txt"><b>${esc(me.name)}</b><small>${esc(isStaffUser() ? me.roles.map((r) => r.replace('_', ' ')).join(', ') : 'Employee')}</small></span></button>
        <div id="whoMenu" class="panel popover" hidden style="width:240px"><div style="font-weight:600">${esc(me.name)}</div><div style="font-size:13px;color:var(--muted);margin-bottom:12px">${esc(me.email || '')}</div><button class="btn" id="so" style="width:100%">${t('signout')}</button></div></div>
    </div></div></header>
  <main>
    <div class="top"><form class="cmd" id="cf">${icon('M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z', 18)}<input id="cmd" autocomplete="off" placeholder="${esc(isStaffUser() ? t('ph') : 'Ask… e.g. I need a salary certificate for Emirates NBD')}"><button class="btn pri sm" type="submit">${t('run')}</button></form>
    ${isStaffUser() ? '<label class="sr" for="estSel">Entity</label><select id="estSel" class="btn" style="max-width:260px" title="Entity"></select>' : ''}</div>
    <div class="chips" id="chips" style="margin-bottom:18px"></div>
    <div id="agent"></div><section id="view"><div class="loading">Loading…</div></section>
  </main></div>`;
  document.querySelectorAll('.nav').forEach((b) => (b.onclick = () => go(b.dataset.m)));
  $('#so').onclick = signOut;
  $('#whoBtn').onclick = (e) => { e.stopPropagation(); const m = $('#whoMenu'); m.hidden = !m.hidden; $('#whoBtn').setAttribute('aria-expanded', String(!m.hidden)); };
  if (!window.__whoBound) { window.__whoBound = true; document.addEventListener('click', (e) => { const m = $('#whoMenu'); if (m && !m.hidden && !e.target.closest('#whoMenu')) m.hidden = true; }); }
  { const on = document.querySelector('.navpills .nav.on'); if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' }); }
  $('#lb').onclick = () => { L = L === 'en' ? 'ar' : 'en'; localStorage.setItem('wasl_lang', L); shell(); };
  $('#cf').onsubmit = (e) => { e.preventDefault(); const q = $('#cmd').value.trim(); if (!q) return; if (isStaffUser()) agent(q); else { pendingQuestion = q; go('eai'); } };
  ['Hire Omar Al-Maktoum as Senior Frontend Engineer, AED 22,000, start Nov 1', 'Ahmed Khan wants 3 days annual leave from 26 Oct', 'Salary certificate for Priya Menon addressed to Emirates NBD'].forEach((c) => {
    const b = document.createElement('button'); b.className = 'chip'; b.type = 'button'; b.textContent = c; b.onclick = () => { $('#cmd').value = c; agent(c); }; $('#chips').appendChild(b);
  });
  if (!isStaffUser()) $('#chips').hidden = true;
  translateTree($('#root'), L);
  loadBell();
  if (isStaffUser()) {
    api('/establishments').then((list) => {
      ESTS = list; const sel = $('#estSel'); if (!sel) return;
      sel.innerHTML = list.map((e) => `<option value="${e._id}" ${currentEst()?._id === e._id ? 'selected' : ''}>${esc(e.name)}${e.freeZone ? ` · ${esc(e.freeZone)}` : ' · Mainland'}</option>`).join('');
      sel.onchange = () => { EST = sel.value; localStorage.setItem('wasl_est', EST); views[cur]().catch(fail); };
    }).catch(() => {});
  }
  views[cur]().catch(fail);
}
async function loadBell() {
  try {
    const list = await api('/notifications');
    const unread = list.filter((n) => !n.read).length;
    const ct = $('#bellCt'); if (ct) { ct.hidden = !unread; ct.textContent = unread > 9 ? '9+' : unread; }
    const panel = $('#bellPanel');
    panel.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b style="font-family:var(--f-display);letter-spacing:-.01em">Notifications</b><button class="btn sm" id="readAll">Mark all read</button></div>
      ${list.length ? list.map((n) => `<div class="row" style="padding:10px 0"><span class="sev" style="background:var(--${sevVar(n.severity)})"></span><div class="grow"><div style="font-size:14px;${n.read ? 'color:var(--muted)' : ''}">${esc(n.title)}</div><div style="font-size:12px;color:var(--muted)">${esc(n.body || '')} · ${new Date(n.createdAt).toLocaleDateString('en-GB')}</div></div>${n.link ? `<button class="btn sm" data-link="${esc(n.link.slice(1))}">Open</button>` : ''}</div>`).join('') : '<div class="empty">No notifications yet.</div>'}`;
    translateTree(panel, L);
    $('#bell').onclick = () => { panel.hidden = !panel.hidden; };
    $('#readAll').onclick = async () => { await api('/notifications/read-all', { method: 'POST' }); loadBell(); };
    panel.querySelectorAll('[data-link]').forEach((b) => (b.onclick = () => { panel.hidden = true; go(b.dataset.link); }));
  } catch { /* bell is optional */ }
}
function go(m) { cur = m; location.hash = m; shell(); }
const V = (html) => { $('#view').innerHTML = html; translateTree($('#view'), L); animateView($('#view')); };
// Entrance motion: staggered card rise + count-up numbers (skipped for reduced-motion users)
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
function animateView(root) {
  if (REDUCE) return;
  root.querySelectorAll('.panel, .idcard').forEach((el, i) => { el.style.setProperty('--i', Math.min(i, 12)); el.classList.add('rise'); });
  root.querySelectorAll('.stat .v, .big').forEach((el) => {
    const node = [...el.childNodes].find((n) => n.nodeType === 3 && /\d/.test(n.textContent));
    if (!node) return;
    const m = node.textContent.match(/^(\s*)([\d,]+(?:\.\d+)?)(.*)$/s); if (!m) return;
    const target = parseFloat(m[2].replace(/,/g, '')); if (!isFinite(target) || target === 0) return;
    const dec = (m[2].split('.')[1] || '').length, comma = m[2].includes(','), t0 = performance.now(), dur = 900;
    const fmt = (v) => { const x = v.toFixed(dec); return comma ? Number(x).toLocaleString('en-AE', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : x; };
    const step = (now) => { const p = Math.min(1, (now - t0) / dur), e = 1 - (1 - p) ** 3; node.textContent = m[1] + fmt(target * e) + m[3]; if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}
const sevVar = (s) => ({ bad: 'bad', warn: 'warn', info: 'accent' }[s] || 'accent');
const pill = (cls, txt) => `<span class="pill ${cls}">${esc(txt)}</span>`;

// ---------------- Views ----------------
const views = {
  async dash() {
    const [d, runs, emps] = await Promise.all([api('/dashboard'), api('/payroll/runs'), api('/employees?status=active')]);
    const k = (f) => (f >= 100000000 ? `${Math.round(f / 100000)}k` : AED0(f));
    const first = (me.name || '').split(' ')[0];
    const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
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
        <defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5b1f" stop-opacity=".3"/><stop offset="1" stop-color="#ff5b1f" stop-opacity="0"/></linearGradient></defs>
        ${ticks.map((v) => `<line x1="40" x2="672" y1="${py(v)}" y2="${py(v)}" stroke="#ecece8"/><text x="0" y="${py(v) + 4}" fill="#8a8a84" font-size="11">${Math.round(v)}</text>`).join('')}
        <path d="${line} L${X1} ${Y0} L${X0} ${Y0} Z" fill="url(#ga)"/>
        <path d="${line}" fill="none" stroke="#ff5b1f" stroke-width="2.5" stroke-linejoin="round"/>
        ${data.map((x, i) => `<text x="${px(i)}" y="226" fill="#8a8a84" font-size="11" text-anchor="middle">${mon(x.p)}</text>`).join('')}
        <circle cx="${pts.at(-1)[0]}" cy="${pts.at(-1)[1]}" r="4.5" fill="#ff5b1f"/>
        <g id="hov" visibility="hidden"><line id="hl" y1="12" y2="200" stroke="#ff5b1f" stroke-opacity=".4" stroke-dasharray="3 4"/><circle id="hc" r="6" fill="#ffffff" stroke="#ff5b1f" stroke-width="2.5"/></g>
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
    const [ests, runs, emps] = await Promise.all([api('/establishments'), api('/payroll/runs'), api('/employees')]);
    const est = (EST && ests.find((e) => e._id === EST)) || ests.find((e) => e.jurisdiction === 'MAINLAND') || ests[0];
    const now = new Date(); const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let run = runs.find((r) => r.period === period && String(r.establishmentId) === String(est._id) && (r.type || 'regular') === 'regular');
    const extraRuns = runs.filter((r) => String(r.establishmentId) === String(est._id) && r.type && r.type !== 'regular');
    if (!run) {
      V(`<div class="eyebrow">${esc(est.name)}</div><h1>Payroll <em>studio</em></h1>
      <div class="panel"><p>No payroll computed for ${period} yet. Computing pulls salaries, overtime, unpaid leave and loans, then runs every WPS check.</p><button class="btn pri" id="comp">Compute ${period} payroll</button></div>`);
      $('#comp').onclick = () => compute(est._id, period); return;
    }
    run = await api(`/payroll/runs/${run._id}`);
    const pf = await api(`/payroll/runs/${run._id}/preflight`);
    const deptOf = Object.fromEntries(emps.map((e) => [String(e._id), e.department || 'Other']));
    const released = ['approved', 'exported', 'paid'].includes(run.status);
    const stepsAll = ['draft', 'pending_approval', 'approved', 'exported'];
    const at = run.status === 'preflight_failed' ? 0 : stepsAll.indexOf(run.status);
    const fixedT = run.lines.reduce((a, l) => a + l.fixedFils, 0), varT = run.lines.reduce((a, l) => a + l.variableFils, 0), dedT = run.lines.reduce((a, l) => a + (l.deductionsFils || 0), 0);
    const gross = fixedT + varT + dedT || 1;
    const C = 2 * Math.PI * 52, seg = (f) => (f / gross) * C;
    V(`<div class="eyebrow">${esc(est.name)} · RULE PACK ${esc(run.rulePack)}</div>
    <h1>Payroll <em>studio</em> · ${run.period}</h1><p class="sub">Export stays locked until pre-flight passes and a different person approves.</p>
    <div class="steps">${['Compute', 'Pre-flight & submit', 'Checker approval', 'SIF export'].map((s, i) => `<span class="${i < at + 1 ? 'done' : i === at + 1 ? 'on' : ''}">${s}</span>`).join('')}</div>
    <div class="grid g3">
      <div class="panel span2"><div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px"><h2 style="margin:0">Cost by team</h2><span style="font-size:13px;color:var(--muted)">Click a column to filter the register</span></div>
        <div id="cols" style="display:flex;align-items:flex-end;gap:16px;height:220px;margin-top:18px;border-bottom:1px solid var(--line)"></div>
        <div id="colLabels" style="display:flex;gap:16px;margin-top:8px"></div></div>
      <div class="panel"><h2>Pay mix</h2><div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap">
        <svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label="Pay mix">
          <circle cx="70" cy="70" r="52" fill="none" stroke="#f1f1ee" stroke-width="18"/>
          <circle cx="70" cy="70" r="52" fill="none" stroke="#ff5b1f" stroke-width="18" stroke-dasharray="${seg(fixedT)} 999" transform="rotate(-90 70 70)"/>
          <circle cx="70" cy="70" r="52" fill="none" stroke="#111111" stroke-width="18" stroke-dasharray="${seg(varT)} 999" stroke-dashoffset="${-seg(fixedT)}" transform="rotate(-90 70 70)"/>
          <circle cx="70" cy="70" r="52" fill="none" stroke="#d99a06" stroke-width="18" stroke-dasharray="${seg(dedT)} 999" stroke-dashoffset="${-seg(fixedT) - seg(varT)}" transform="rotate(-90 70 70)"/>
          <text x="70" y="66" text-anchor="middle" fill="#8a8a84" font-size="11">NET AED</text>
          <text x="70" y="88" text-anchor="middle" fill="#111" font-size="22" font-weight="600" font-family="Geist, sans-serif">${Math.round(run.totals.netFils / 100000)}k</text></svg>
        <div style="display:flex;flex-direction:column;gap:8px;font-size:13px">
          <div><span style="display:inline-block;width:10px;height:10px;background:#ff5b1f;margin-inline-end:8px"></span>Fixed ${Math.round((fixedT / gross) * 100)}%</div>
          <div><span style="display:inline-block;width:10px;height:10px;background:#111111;margin-inline-end:8px"></span>Overtime &amp; commission ${Math.round((varT / gross) * 100)}%</div>
          <div><span style="display:inline-block;width:10px;height:10px;background:#d99a06;margin-inline-end:8px"></span>Deductions ${Math.round((dedT / gross) * 100)}%</div></div></div></div>
    </div>
    <div class="grid g3" style="margin-top:16px">
      <div class="panel span2"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="margin:0" id="regTitle">Register · all teams</h2><button class="btn sm" id="regAll" hidden>Show all teams</button></div>
        <div class="tw" style="margin-top:10px"><table><thead><tr><th>Employee</th><th>Team</th><th class="r">Fixed</th><th class="r">Variable</th><th class="r">Net</th><th>Status</th>${released ? '<th>Payslip</th>' : ''}</tr></thead><tbody id="reg"></tbody></table></div></div>
      <div class="panel"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="margin:0">WPS pre-flight</h2>${pf.blocking ? pill('p-bad', `${pf.blocking} blocking`) : pill('p-ok', 'No blocking errors')}</div>
        <div class="meter" style="margin:12px 0 4px"><i id="pfBar" style="width:0%"></i></div>
        <div id="pfList"></div>
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap" id="acts"><button class="btn" id="rerun">Re-run checks</button></div></div>
    </div><div id="sifOut"></div>
    <div class="grid g2" style="margin-top:16px">
      <div class="panel"><h2>Payslips</h2>
        ${released ? `<p style="margin:0 0 12px;color:var(--muted)">Bilingual payslips are ready. Releasing notifies every employee in My Workspace, and by email or WhatsApp where configured.</p><button class="btn pri" id="relSlips">Release payslips</button>` : '<p style="margin:0;color:var(--muted)">Payslips become available once this payroll is approved by a checker.</p>'}
        <h2 style="margin-top:22px">Off-cycle payment</h2>
        <form id="ocForm" class="form"><div class="field" style="grid-column:1/-1"><label class="lbl" for="ocTitle">Title</label><input id="ocTitle" placeholder="e.g. Eid bonus, missed overtime" required></div>
          <div class="field"><label class="lbl" for="ocEmp">Employee</label><select id="ocEmp">${emps.filter((e) => String(e.establishmentId) === String(est._id) && e.status !== 'exited').map((e) => `<option value="${e._id}">${esc(e.fullName)}</option>`).join('')}</select></div>
          <div class="field"><label class="lbl" for="ocAmt">Amount (AED)</label><input id="ocAmt" type="number" min="1" step="0.01" required></div>
          <div style="grid-column:1/-1"><button class="btn" type="submit">Create off-cycle run</button></div></form></div>
      <div class="panel"><h2>Off-cycle &amp; final settlement runs</h2>
        ${extraRuns.length ? `<div class="list">${extraRuns.map((x) => `<div class="row"><div class="grow"><b style="font-weight:600">${esc(x.title || x.type)}</b><div style="font-size:12px;color:var(--muted)">${esc(x.period)} · ${esc(x.type)} #${x.runNo} · AED ${AED(x.totals?.netFils)}</div></div>${pill(x.status === 'draft' ? 'p-n' : x.status === 'pending_approval' ? 'p-warn' : 'p-ok', x.status.replace('_', ' '))}
          ${x.status === 'draft' && has('payroll_maker', 'hr_admin') ? `<button class="btn sm" data-sub="${x._id}">Submit</button>` : ''}${x.status === 'pending_approval' && has('payroll_checker') ? `<button class="btn sm pri" data-appr="${x._id}">Approve</button>` : ''}${['approved', 'exported'].includes(x.status) ? `<button class="btn sm" data-sif="${x._id}">SIF</button>` : ''}</div>`).join('')}</div>` : '<div class="empty">None yet. Final settlements are created from the Gratuity screen.</div>'}</div>
    </div>`);

    if ($('#relSlips')) $('#relSlips').onclick = async () => { try { const r2 = await api(`/payroll/runs/${run._id}/payslips/send`, { method: 'POST' }); toast(`Released ${r2.released} payslips${r2.channels.email || r2.channels.whatsapp ? ' (with email/WhatsApp)' : ''}`); } catch (e) { fail(e); } };
    $('#ocForm').onsubmit = async (e) => { e.preventDefault(); try { await api('/payroll/offcycle', { method: 'POST', body: { establishmentId: est._id, period, title: $('#ocTitle').value, items: [{ employeeId: $('#ocEmp').value, amount: $('#ocAmt').value }] } }); toast('Off-cycle run created as draft'); views.pay(); } catch (err) { fail(err); } };
    document.querySelectorAll('[data-sub]').forEach((b) => (b.onclick = async () => { try { const r2 = await api(`/payroll/runs/${b.dataset.sub}/submit`, { method: 'POST' }); toast(r2.blocking ? `Blocked: ${r2.blocking} error(s)` : 'Sent to checker'); views.pay(); } catch (e) { fail(e); } }));
    document.querySelectorAll('[data-appr]').forEach((b) => (b.onclick = async () => { try { await api(`/payroll/runs/${b.dataset.appr}/approve`, { method: 'POST' }); toast('Approved'); views.pay(); } catch (e) { fail(e); } }));
    document.querySelectorAll('[data-sif]').forEach((b) => (b.onclick = async () => { try { const r2 = await api(`/payroll/runs/${b.dataset.sif}/sif`, { method: 'POST' }); const url = URL.createObjectURL(new Blob([r2.content], { type: 'text/plain' })); const a = document.createElement('a'); a.href = url; a.download = r2.filename; a.click(); } catch (e) { fail(e); } }));

    // Team columns + register filter
    const teams = {}; run.lines.forEach((l) => { const d = deptOf[String(l.employeeId)] || 'Other'; teams[d] = (teams[d] || 0) + l.netFils; });
    const tlist = Object.entries(teams).sort((a, b) => b[1] - a[1]); const tmax = tlist[0]?.[1] || 1;
    let team = null;
    const drawReg = () => {
      const rows = run.lines.filter((l) => !team || deptOf[String(l.employeeId)] === team);
      $('#reg').innerHTML = rows.map((l) => `<tr><td>${esc(l.employeeName)}</td><td style="color:var(--muted)">${esc(deptOf[String(l.employeeId)] || '')}</td><td class="r num">${AED(l.fixedFils)}</td><td class="r num">${AED(l.variableFils)}</td><td class="r num">${AED(l.netFils)}</td><td>${l.held ? pill('p-bad', 'Held') : l.flags.some((f) => f.severity === 'warn') ? pill('p-warn', 'Review') : l.unpaidLeaveDays ? pill('p-warn', `${l.unpaidLeaveDays}d unpaid`) : pill('p-ok', 'Ready')}</td>${released ? `<td><button class="btn sm" data-slip="${l.employeeId}">View</button></td>` : ''}</tr>`).join('');
      document.querySelectorAll('[data-slip]').forEach((b) => (b.onclick = () => openHtml(`/payroll/runs/${run._id}/payslips/${b.dataset.slip}`)));
      $('#regTitle').textContent = `Register · ${team || 'all teams'}`; $('#regAll').hidden = !team;
      document.querySelectorAll('#cols button').forEach((b) => { const on = b.dataset.t === team; b.querySelector('i').style.background = team ? (on ? 'var(--accent)' : '#e9e9e5') : '#1a1a1a'; });
    };
    $('#cols').innerHTML = tlist.map(([n, v]) => `<button data-t="${esc(n)}" aria-label="${esc(n)} AED ${Math.round(v / 100000)} thousand" style="all:unset;cursor:pointer;flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:6px"><span class="num" style="font-size:12px;color:var(--muted)">${Math.round(v / 100000)}k</span><i style="display:block;width:100%;max-width:60px;height:0%;background:#1a1a1a;border-radius:3px 3px 0 0;transition:height .6s cubic-bezier(.2,.8,.2,1),background .2s"></i></button>`).join('');
    $('#colLabels').innerHTML = tlist.map(([n]) => `<span style="flex:1;text-align:center;font-size:12px;color:var(--muted)">${esc(n)}</span>`).join('');
    requestAnimationFrame(() => document.querySelectorAll('#cols button').forEach((b, i) => { b.querySelector('i').style.height = `${(tlist[i][1] / tmax) * 88}%`; }));
    document.querySelectorAll('#cols button').forEach((b) => (b.onclick = () => { team = team === b.dataset.t ? null : b.dataset.t; drawReg(); }));
    $('#regAll').onclick = () => { team = null; drawReg(); };
    drawReg();

    // Animated pre-flight reveal
    let timer;
    const reveal = () => {
      clearInterval(timer); let n = 0; const list = pf.checks;
      const paint = () => {
        if (!$('#pfBar')) { clearInterval(timer); return; } // user navigated away
        $('#pfBar').style.width = `${(n / list.length) * 100}%`;
        $('#pfList').innerHTML = list.map((c, i) => i < n
          ? `<div class="check"><span class="ic ${c.status === 'pass' ? 'ok' : c.status === 'fail' ? 'bad' : 'warn'}">${c.status === 'pass' ? '✓' : c.status === 'fail' ? '!' : '~'}</span><div style="min-width:0"><div>${esc(c.label)}</div><div class="mono" style="font-size:12px;color:var(--muted);overflow-wrap:anywhere">${esc(c.detail)}</div></div></div>`
          : `<div class="check" style="color:var(--muted)"><span class="ic" style="background:var(--surface-2)"></span><div>${esc(c.label)}</div></div>`).join('');
      };
      paint();
      timer = setInterval(() => { n++; paint(); if (n >= list.length) clearInterval(timer); }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220);
    };
    $('#rerun').onclick = reveal; reveal();

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
    const list = await api('/compliance/emiratisation');
    const a = list.find((x) => x.applicable) || list[0];
    if (!a) { V(`<h1>${t('emi')}</h1><div class="panel empty">No establishments yet.</div>`); return; }
    const others = list.filter((x) => x !== a);
    V(`<div class="eyebrow">RULE PACK ${esc(a.rulePack || '')}</div><h1>Emiratisation <em>shield</em></h1>
    <p class="sub">Quota status from the versioned rule pack, plus a planner to compare hiring against paying the fine. Figures need legal validation.</p>
    ${a.applicable ? `<div class="grid g2">
      <div class="panel"><div class="lbl">${esc(a.establishment.name)} · Tier ${a.tier} · ${a.headcount} staff</div>
        <div class="big" style="margin-top:8px">${a.qualifyingCount} <span style="color:var(--muted);font-size:24px">/ ${a.required}</span></div>
        <div class="meter" style="margin:12px 0"><i style="width:${Math.min(100, (a.qualifyingCount / a.required) * 100)}%"></i></div>
        <div class="list">${a.qualifying.map((q) => `<div class="row"><span class="av">${esc(ini(q.name))}</span><div class="grow">${esc(q.name)}<div style="font-size:12px;color:var(--muted)">AED ${AED0(q.wageFils)} / month</div></div>${pill('p-ok', 'Counts')}</div>`).join('')}
        ${a.notQualifying.map((q) => `<div class="row"><span class="av">${esc(ini(q.name))}</span><div class="grow">${esc(q.name)}<div style="font-size:12px;color:var(--bad)">${esc(q.reasons.join(' · '))}</div></div>${pill('p-bad', 'Not counted')}</div>`).join('')}
        ${(a.inGrace || []).map((q) => `<div class="row"><span class="av">${esc(ini(q.name))}</span><div class="grow">${esc(q.name)}<div style="font-size:12px;color:var(--muted)">Left ${fmtDate(q.exitDate)} · slot protected until ${fmtDate(q.graceUntil)}</div></div>${pill('p-warn', 'Grace period')}</div>`).join('')}</div>
        ${a.checkpoint ? `<p class="note">Next checkpoint ${esc(a.checkpoint.date)}: ${a.checkpoint.pct}% of skilled roles.</p>` : ''}
        ${(a.alerts || []).map((al) => `<div class="row" style="padding:8px 0"><span class="sev" style="background:var(--${sevVar(al.severity)})"></span><div class="grow" style="font-size:13px">${esc(al.msg)}</div></div>`).join('')}</div>
      <div class="panel"><h2>Hire vs. pay the fine</h2>
        <div class="field"><label class="lbl" for="pH" style="display:flex;justify-content:space-between">New UAE national hires <span class="num" id="pHv" style="color:var(--accent-hi)"></span></label><input id="pH" type="range" min="0" max="4" step="1" value="${a.gap}" style="accent-color:#ff5b1f"></div>
        <div class="field" style="margin-top:12px"><label class="lbl" for="pW" style="display:flex;justify-content:space-between">Monthly wage per hire <span class="num" id="pWv" style="color:var(--accent-hi)"></span></label><input id="pW" type="range" min="6000" max="15000" step="500" value="6500" style="accent-color:#ff5b1f"></div>
        <div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:14px">
          <div class="panel" style="padding:14px;background:var(--surface-2)"><div class="lbl">Quota</div><div class="big" id="pQ" style="font-size:34px"></div></div>
          <div class="panel" style="padding:14px;background:var(--surface-2)"><div class="lbl">Fine / year</div><div class="big" id="pF" style="font-size:34px"></div></div>
          <div class="panel" style="padding:14px;background:var(--surface-2);grid-column:span 2"><div class="lbl">Net hiring cost / year after modelled NAFIS</div><div class="big" id="pC" style="font-size:34px"></div></div>
        </div><p class="note">Scenario only. NAFIS support depends on the candidate and programme rules.</p></div>
    </div>` : `<div class="panel">${esc(a.reason || 'Below quota thresholds.')}</div>`}
    ${others.map((o) => `<div class="panel" style="margin-top:16px"><h2>${esc(o.establishment.name)}</h2><p style="margin:0;color:var(--muted)">${esc(o.reason || (o.applicable ? `Tier ${o.tier}: ${o.qualifyingCount}/${o.required}` : 'Below quota thresholds.'))}</p></div>`).join('')}`);
    if (!a.applicable) return;
    const upd = () => {
      const h = +$('#pH').value, w = +$('#pW').value;
      const quota = Math.min(a.required, a.qualifyingCount + h), gap = Math.max(0, a.required - quota);
      const fine = gap * 9000 * 12, sub = Math.min(Math.round(w * 0.5), 7000), cost = h * (w - sub) * 12;
      $('#pHv').textContent = h; $('#pWv').textContent = `AED ${w.toLocaleString('en-AE')}`;
      $('#pQ').textContent = `${quota}/${a.required}`; $('#pQ').style.color = gap ? 'var(--warn)' : 'var(--ok)';
      $('#pF').textContent = fine ? `AED ${fine.toLocaleString('en-AE')}` : 'None'; $('#pF').style.color = fine ? 'var(--bad)' : 'var(--ok)';
      $('#pC').textContent = `AED ${cost.toLocaleString('en-AE')}`;
    };
    $('#pH').oninput = $('#pW').oninput = upd; upd();
  },

  async docs() {
    const docs = await api('/documents/expiring?days=120');
    const col = (d) => (d <= 14 ? '#e5484d' : d <= 30 ? '#d99a06' : '#16a34a');
    const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
    const dots = docs.map((d, i) => {
      // golden-angle spacing spreads points evenly around the radar; hash keeps each document's spot stable
      const days = Math.max(0, Math.min(120, d.daysLeft)), r = 14 + (days / 120) * 146, ang = ((i * 137.508 + (hash(d._id) % 23)) % 360) * (Math.PI / 180);
      return { d, x: 180 + r * Math.cos(ang), y: 180 - r * Math.sin(ang) };
    });
    const week = Array.from({ length: 12 }, (_, i) => docs.filter((d) => d.daysLeft >= i * 7 && d.daysLeft < (i + 1) * 7));
    const overdue = docs.filter((d) => d.daysLeft < 0).length;
    const nextStep = { residence_visa: 'Medical fitness → EID biometrics → visa stamping', emirates_id: 'Typing centre application → biometrics', passport: 'Collect new passport scan', labour_card: 'MOHRE renewal', health_insurance: 'Insurer renewal quote', driving_licence: 'RTA renewal', trade_licence: 'DED renewal + tenancy contract', establishment_card: 'ICP online renewal' };
    V(`<div class="eyebrow">NEXT 120 DAYS · ${docs.length} DOCUMENTS${overdue ? ` · ${overdue} OVERDUE` : ''}</div><h1>Compliance <em>radar</em></h1>
    <p class="sub">Each point is a document. The closer to the centre, the sooner it expires. Click a point to open it.</p>
    <style>@keyframes rdSweep{to{transform:rotate(360deg)}}.rd-sweep{transform-origin:180px 180px;animation:rdSweep 6s linear infinite}.rd-dot{cursor:pointer}.rd-dot:focus{outline:none}.rd-dot:focus circle:last-child{stroke:#fff}@media (prefers-reduced-motion:reduce){.rd-sweep{animation:none}}</style>
    <div class="grid g2">
      <div class="panel" style="display:flex;gap:24px;flex-wrap:wrap;align-items:center">
        <svg viewBox="0 0 360 360" width="340" style="max-width:100%;height:auto;flex:0 1 340px" role="img" aria-label="Document expiry radar">
          <defs><linearGradient id="beam" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff5b1f" stop-opacity="0"/><stop offset="1" stop-color="#ff5b1f" stop-opacity=".35"/></linearGradient></defs>
          ${[30, 60, 90, 120].map((dd) => { const r = 14 + (dd / 120) * 146; return `<circle cx="180" cy="180" r="${r}" fill="none" stroke="${dd === 30 ? '#ffd3bf' : '#e6e6e1'}"/><text x="184" y="${180 - r + 12}" fill="#8a8a84" font-size="10">${dd}d</text>`; }).join('')}
          <line x1="20" y1="180" x2="340" y2="180" stroke="#ecece8"/><line x1="180" y1="20" x2="180" y2="340" stroke="#ecece8"/>
          <g class="rd-sweep"><path d="M180 180 L340 180 A160 160 0 0 0 293 67 Z" fill="url(#beam)"/></g>
          ${dots.map((p, i) => `<g class="rd-dot" data-i="${i}" tabindex="0" role="button" aria-label="${esc(p.d.holder)}, ${esc(p.d.docType.replace(/_/g, ' '))}, ${p.d.daysLeft} days"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="10" fill="${col(p.d.daysLeft)}" fill-opacity=".18"/><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5.5" fill="${col(p.d.daysLeft)}" stroke="#ffffff" stroke-width="2"/></g>`).join('')}
          <circle cx="180" cy="180" r="4" fill="#ff5b1f"/>
        </svg>
        <div id="rdSel" style="flex:1 1 200px;min-width:0;display:flex;flex-direction:column;gap:10px"></div>
      </div>
      <div class="panel"><h2>Next 12 weeks</h2><div id="wkCap" style="font-size:13px;color:var(--muted);min-height:40px"></div>
        <div style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin-top:10px">
          ${week.map((w, i) => `<button class="wk" data-w="${i}" aria-label="Week ${i + 1}: ${w.length} documents" style="all:unset;cursor:pointer;display:flex;flex-direction:column;gap:4px"><span style="height:52px;border-radius:4px;display:grid;place-items:center;font-family:var(--f-mono);font-size:15px;font-weight:600;background:${['#f1f1ee', '#ffd9c7', '#ff9a6b', '#ff5b1f'][Math.min(3, w.length)]};color:${w.length >= 2 ? '#fff' : '#111'};border:1px solid transparent">${w.length}</span><span style="font-size:11px;color:var(--muted);text-align:center">W${i + 1}</span></button>`).join('')}
        </div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:16px">
          <span><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#e5484d;margin-inline-end:6px"></span>≤ 14 days</span>
          <span><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#d99a06;margin-inline-end:6px"></span>15–30 days</span>
          <span><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#16a34a;margin-inline-end:6px"></span>30+ days</span></div></div>
    </div>
    <div class="panel tw" style="margin-top:16px"><table><thead><tr><th>Holder</th><th>Document</th><th>Expiry</th><th>Expires in</th><th>Renewal</th></tr></thead><tbody>
    ${docs.map((d) => `<tr><td>${esc(d.holder)}</td><td>${esc(d.docType.replace(/_/g, ' '))}</td><td class="mono">${fmtDate(d.expiryDate)}</td><td>${pill(d.daysLeft < 0 ? 'p-bad' : d.daysLeft <= 14 ? 'p-bad' : d.daysLeft <= 30 ? 'p-warn' : 'p-ok', d.daysLeft < 0 ? `${-d.daysLeft} days overdue` : `${d.daysLeft} days`)}</td>
      <td>${d.renewalCase?.status && d.renewalCase.status !== 'none' ? pill('p-ok', `Case ${d.renewalCase.status}`) : has('hr_admin') ? `<button class="btn sm" data-case="${d._id}">Open case</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="5" class="empty">No documents expiring in 120 days.</td></tr>`}
    </tbody></table></div>`);
    const openCase = async (id) => { try { const c = await api(`/documents/${id}/renewal`, { method: 'POST' }); toast(`Case opened: ${c.steps.map((s) => s.name).join(' → ')}`); views.docs(); } catch (e) { fail(e); } };
    const select = (i) => {
      const d = dots[i]?.d; if (!d) { $('#rdSel').innerHTML = '<div class="empty">Nothing due.</div>'; return; }
      const done = d.renewalCase?.status && d.renewalCase.status !== 'none';
      $('#rdSel').innerHTML = `<div class="lbl">Selected</div><div style="font-family:var(--f-display);font-size:24px;font-weight:600;letter-spacing:-.02em;line-height:1.1">${esc(d.holder)}</div>
        <div style="color:var(--soft)">${esc(d.docType.replace(/_/g, ' '))}</div>
        <div class="big" style="color:${col(d.daysLeft)}">${d.daysLeft < 0 ? -d.daysLeft : d.daysLeft}<span style="font-size:16px;color:var(--muted);font-weight:500"> days ${d.daysLeft < 0 ? 'overdue' : 'left'}</span></div>
        <div style="font-size:13px;color:var(--muted)">Next step: ${esc(nextStep[d.docType] || 'Collect new copy')}</div>
        ${done ? pill('p-ok', `Case ${d.renewalCase.status}`) : has('hr_admin') ? `<button class="btn pri" id="rdCase" style="align-self:flex-start">Open renewal case</button>` : ''}`;
      const b = $('#rdCase'); if (b) b.onclick = () => openCase(d._id);
      document.querySelectorAll('.rd-dot').forEach((g) => g.querySelectorAll('circle')[0].setAttribute('r', +g.dataset.i === i ? 15 : 10));
    };
    document.querySelectorAll('.rd-dot').forEach((g) => { g.onclick = () => select(+g.dataset.i); g.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(+g.dataset.i); } }; });
    const showWeek = (i) => {
      const w = week[i];
      $('#wkCap').textContent = `Week ${i + 1}: ${w.length ? w.map((d) => `${d.holder} (${d.docType.replace(/_/g, ' ')})`).join(', ') : 'nothing due'}`;
      document.querySelectorAll('.wk span:first-child').forEach((s, j) => (s.style.borderColor = j === i ? '#ff5b1f' : 'transparent'));
    };
    document.querySelectorAll('.wk').forEach((b) => { b.onmouseenter = b.onfocus = b.onclick = () => showWeek(+b.dataset.w); });
    document.querySelectorAll('[data-case]').forEach((b) => (b.onclick = () => openCase(b.dataset.case)));
    select(dots.findIndex((p) => p.d.daysLeft >= 0) >= 0 ? dots.findIndex((p) => p.d.daysLeft >= 0) : 0); showWeek(0);
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


// ================= Phase 1 screens: request centre, setup, employee workspace, uploads, settlements =================
const LETTER_LABEL = { salary_certificate: 'Salary certificate', bank_transfer: 'Salary transfer letter', noc: 'No objection certificate', experience: 'Experience certificate' };
const KIND_LABEL = { letter: 'Letter', bank_change: 'Bank details change', personal_data: 'Personal data change', salary_query: 'Salary query', document_renewal: 'Document renewal', it_facilities: 'IT / facilities', other: 'Other' };
const DOC_LABEL = { passport: 'Passport', residence_visa: 'Residence visa', emirates_id: 'Emirates ID', labour_card: 'Labour card', driving_licence: 'Driving licence', health_insurance: 'Health insurance', trade_licence: 'Trade licence', establishment_card: 'Establishment card' };
const after = (html) => { const v = $('#view'); const div = document.createElement('div'); div.innerHTML = html; v.appendChild(div); translateTree(div, L); return div; };
const empOptions = (list) => list.map((e) => `<option value="${e._id}">${esc(e.fullName)} · ${esc(e.employeeNo)}</option>`).join('');
const statusPill = (s) => pill(s === 'done' || s === 'approved' ? 'p-ok' : s === 'rejected' ? 'p-bad' : s === 'in_progress' || s === 'pending' ? 'p-warn' : 'p-n', s.replace('_', ' '));

Object.assign(views, {
  // ---------- Request centre (HR) ----------
  async requests() {
    const [list, emps] = await Promise.all([api('/requests'), api('/employees?status=active')]);
    const open = list.filter((x) => ['open', 'in_progress'].includes(x.status));
    V(`<div class="eyebrow">${open.length} OPEN · SLA TRACKED</div><h1>Request <em>centre</em></h1>
    <p class="sub">Letters, bank changes and salary queries from employees. Approving a letter issues it with a reference number and digital stamp; approving a bank change updates the IBAN.</p>
    <div class="grid g3"><div class="panel span2"><div class="list">
      ${list.length ? list.map((x) => `<div class="row"><span class="av">${esc(ini(x.employeeId?.fullName || '?'))}</span><div class="grow"><b style="font-weight:600">${esc(x.employeeId?.fullName || '')}</b> · ${esc(KIND_LABEL[x.kind] || x.kind)}${x.letterType ? ` · ${esc(LETTER_LABEL[x.letterType])}` : ''}
        <div style="font-size:12px;color:var(--muted)">${esc(x.reference || '')}${x.addressee ? ` · to ${esc(x.addressee)}` : ''}${x.details ? ` · ${esc(x.details)}` : ''}${x.slaDueAt && ['open', 'in_progress'].includes(x.status) ? ` · due ${fmtDate(x.slaDueAt)}${new Date(x.slaDueAt) < new Date() ? ' (overdue)' : ''}` : ''}</div></div>
        ${statusPill(x.status)}
        ${['open', 'in_progress'].includes(x.status) ? `${x.status === 'open' ? `<button class="btn sm" data-d="${x._id}" data-v="in_progress">In progress</button>` : ''}<button class="btn sm" data-d="${x._id}" data-v="rejected">Reject</button><button class="btn sm pri" data-d="${x._id}" data-v="done">${x.kind === 'letter' ? 'Issue letter' : 'Mark done'}</button>` : ''}
        ${x.kind === 'letter' && x.status === 'done' ? `<button class="btn sm" data-letter='${esc(JSON.stringify({ employeeId: x.employeeId?._id, type: x.letterType, addressee: x.addressee, purpose: x.purpose, lang: x.lang }))}'>Open letter</button>` : ''}</div>`).join('') : '<div class="empty">No requests yet.</div>'}
    </div></div>
    <div class="panel"><h2>Issue letter</h2><form id="ltrForm" style="display:flex;flex-direction:column;gap:12px">
      <div class="field"><label class="lbl" for="lEmp">Employee</label><select id="lEmp">${empOptions(emps)}</select></div>
      <div class="field"><label class="lbl" for="lType">Letter</label><select id="lType">${Object.entries(LETTER_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <div class="field"><label class="lbl" for="lTo">Addressed to</label><input id="lTo" placeholder="e.g. Emirates NBD" value="To whom it may concern"></div>
      <div class="field"><label class="lbl" for="lPurpose">Purpose (NOC only)</label><input id="lPurpose" placeholder="e.g. travelling to India"></div>
      <div class="field"><label class="lbl" for="lLang">Language</label><select id="lLang"><option value="dual">English + Arabic</option><option value="en">English</option><option value="ar">Arabic</option></select></div>
      <button class="btn pri" type="submit">Issue letter</button></form></div></div>`);
    document.querySelectorAll('[data-d]').forEach((b) => (b.onclick = async () => {
      try {
        const x = list.find((y) => y._id === b.dataset.d);
        await api(`/requests/${b.dataset.d}/decision`, { method: 'POST', body: { decision: b.dataset.v } });
        toast(`Request ${b.dataset.v.replace('_', ' ')}`);
        if (b.dataset.v === 'done' && x.kind === 'letter') openHtml('/letters', { method: 'POST', body: { employeeId: x.employeeId._id, type: x.letterType, addressee: x.addressee, purpose: x.purpose, lang: x.lang } });
        views.requests();
      } catch (e) { fail(e); }
    }));
    document.querySelectorAll('[data-letter]').forEach((b) => (b.onclick = () => openHtml('/letters', { method: 'POST', body: JSON.parse(b.dataset.letter) })));
    $('#ltrForm').onsubmit = (e) => { e.preventDefault(); openHtml('/letters', { method: 'POST', body: { employeeId: $('#lEmp').value, type: $('#lType').value, addressee: $('#lTo').value || undefined, purpose: $('#lPurpose').value || undefined, lang: $('#lLang').value } }); };
  },

  // ---------- Setup: go-live checklist, CSV import, settings, rule registry ----------
  async setup() {
    const [ck, rules, settings, ests] = await Promise.all([api('/setup/checklist'), api('/rules'), api('/settings'), api('/establishments')]);
    V(`<div class="eyebrow">${ck.done} OF ${ck.total} READY</div><h1>Go-live <em>setup</em></h1>
    <p class="sub">Everything a new company needs before its first real payroll. Automatic checks update themselves; tick the manual ones when done.</p>
    <div class="meter" style="margin-bottom:18px"><i style="width:${(ck.done / ck.total) * 100}%"></i></div>
    <div class="grid g2"><div class="panel"><h2>Go-live checklist</h2>
      ${ck.items.map((i) => `<div class="chk"><span class="ic ${i.ok ? 'ok' : 'warn'}">${i.ok ? '✓' : '!'}</span><div style="flex:1;min-width:0"><div>${esc(i.label)}</div>${i.detail ? `<div style="font-size:12px;color:var(--muted)">${esc(i.detail)}</div>` : ''}</div>
        ${i.manual ? `<label style="display:flex;gap:6px;align-items:center;font-size:13px;white-space:nowrap"><input type="checkbox" data-ck="${i.id}" ${i.ok ? 'checked' : ''} style="accent-color:#ff5b1f;width:18px;height:18px"> Done</label>` : ''}</div>`).join('')}</div>
    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="panel"><h2>Import employees</h2><p style="margin:0 0 12px;color:var(--muted);font-size:14px">Upload a CSV. Every row is validated (IBAN checksum, 14-digit labour card, dates, duplicates) before anything is saved.</p>
        <div class="form"><div class="field"><label class="lbl" for="impEst">Establishment</label><select id="impEst">${ests.map((e) => `<option value="${e._id}">${esc(e.name)}</option>`).join('')}</select></div>
        <div class="field"><label class="lbl" for="impFile">CSV file</label><input id="impFile" type="file" accept=".csv,text/csv"></div></div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn" id="impTpl">Download template</button><button class="btn" id="impCheck">Check file</button><button class="btn pri" id="impGo" disabled>Import</button></div>
        <div id="impOut" style="margin-top:12px"></div></div>
      <div class="panel"><h2>Settings</h2><div class="field"><label class="lbl" for="capBasis">Gratuity cap basis</label><select id="capBasis"><option value="total" ${settings.gratuityCapBasis !== 'basic' ? 'selected' : ''}>Total remuneration (PRD default)</option><option value="basic" ${settings.gratuityCapBasis === 'basic' ? 'selected' : ''}>Basic salary</option></select></div>
        <p class="note">Gratuity is capped at 24 months of wage. Confirm the basis with UAE employment counsel.</p></div>
    </div></div>
    <div class="panel tw" style="margin-top:16px"><h2>Rule packs</h2><table><thead><tr><th>Profile</th><th>Version</th><th>Effective</th><th>Status</th><th>Gratuity</th><th>Annual leave</th><th>Emiratisation</th><th>Source</th></tr></thead><tbody>
      ${rules.map((p) => `<tr><td><b style="font-weight:600">${esc(p.id)}</b></td><td class="mono">${esc(p.version)}</td><td class="mono">${esc(p.effectiveFrom)}${p.effectiveTo ? ` → ${esc(p.effectiveTo)}` : ''}</td><td>${pill(p.status === 'approved' ? 'p-ok' : 'p-warn', p.status)}</td>
        <td>${p.gratuity?.basis === 'dews' ? 'DEWS fund' : `${p.gratuity?.daysPerYearFirst5}/${p.gratuity?.daysPerYearAfter5} days, cap ${p.gratuity?.capMonthsOfWage}m ${p.gratuity?.capBasis || 'basic'}`}</td><td>${p.leave ? `${p.leave.annualDays} ${p.leave.annualDaysUnit || 'calendar'} days` : '—'}</td><td>${p.emiratisation ? 'MOHRE quota' : 'Not applied'}</td>
        <td style="font-size:12px;color:var(--muted);max-width:280px">${esc(p.source)}${(p.sourceUrls || []).map((u) => ` <a href="${esc(u)}" target="_blank" rel="noopener">link</a>`).join('')}</td></tr>`).join('')}</tbody></table></div>`);
    document.querySelectorAll('[data-ck]').forEach((c) => (c.onchange = async () => { try { await api('/setup/checklist', { method: 'PATCH', body: { id: c.dataset.ck, ok: c.checked } }); views.setup(); } catch (e) { fail(e); } }));
    $('#capBasis').onchange = async () => { try { await api('/settings', { method: 'PATCH', body: { gratuityCapBasis: $('#capBasis').value } }); toast('Saved'); } catch (e) { fail(e); } };
    $('#impTpl').onclick = async () => { try { const res = await fetch(`${API}/import/template`, { headers: { Authorization: `Bearer ${token}` } }); const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = 'wasl-employee-template.csv'; a.click(); } catch (e) { fail(e); } };
    let csv = '';
    const run = async (dryRun) => {
      const f = $('#impFile').files[0]; if (!f) return toast('Choose a CSV file first');
      csv = await f.text();
      try {
        const r2 = await api('/import/employees', { method: 'POST', body: { csv, establishmentId: $('#impEst').value, dryRun } });
        $('#impOut').innerHTML = r2.dryRun
          ? `<div>${pill(r2.errors.length ? 'p-bad' : 'p-ok', r2.errors.length ? `${r2.errors.length} problem(s)` : `${r2.toCreate} ready to import`)}</div>
             ${r2.errors.length ? `<div class="tw" style="margin-top:8px"><table><thead><tr><th>Row</th><th>Field</th><th>Problem</th></tr></thead><tbody>${r2.errors.slice(0, 50).map((x) => `<tr><td class="mono">${x.row}</td><td>${esc(x.field)}</td><td>${esc(x.msg)}</td></tr>`).join('')}</tbody></table></div>` : `<div style="font-size:13px;color:var(--muted);margin-top:8px">${r2.preview.map((p) => `${esc(p.employeeNo)} ${esc(p.fullName)}`).join(' · ')}${r2.toCreate > 5 ? ' …' : ''}</div>`}`
          : `${pill('p-ok', `Imported ${r2.created} employees`)}`;
        $('#impGo').disabled = !(r2.dryRun && !r2.errors.length && r2.toCreate);
        if (!r2.dryRun) toast(`Imported ${r2.created} employees`);
      } catch (e) { fail(e); }
    };
    $('#impCheck').onclick = () => run(true); $('#impGo').onclick = () => run(false);
  },

  // ---------- Employee workspace (self-service) ----------
  async me() {
    const tab = localStorage.getItem('wasl_metab') || 'overview';
    const [p, bal] = await Promise.all([api('/me/profile'), api('/me/balances')]);
    V(`<div class="eyebrow">${esc(p.establishment?.name || '')}</div><h1>Hello, <em>${esc(p.fullName.split(' ')[0])}</em></h1>
    <div class="tabs" role="tablist">${[['overview', 'Overview'], ['payslips', 'Payslips'], ['leave', 'Leave'], ['docs', 'My documents'], ['req', 'My requests']].map(([k, v]) => `<button role="tab" data-tab="${k}" class="${tab === k ? 'on' : ''}">${v}</button>`).join('')}</div><div id="meBody"></div>`);
    document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { localStorage.setItem('wasl_metab', b.dataset.tab); views.me(); }));
    const body = $('#meBody');
    const put = (html) => { body.innerHTML = html; translateTree(body, L); };
    if (tab === 'overview') {
      put(`<div class="grid g4">
        <div class="panel stat"><div class="v">${bal.annual.remaining}</div><span class="lbl">Annual leave remaining</span><div class="d">of ${bal.annual.entitlement} · ${esc(bal.annual.basis)}</div></div>
        <div class="panel stat"><div class="v">${bal.sick.fullPayLeft}</div><span class="lbl">Full-pay sick days left</span><div class="d">${bal.sick.taken} taken this year</div></div>
        <div class="panel stat"><div class="v num" style="font-size:40px">${esc(p.employeeNo)}</div><span class="lbl">Employee number</span><div class="d">${esc(p.jobTitle || '')}</div></div>
        <div class="panel stat"><div class="v num" style="font-size:40px">${fmtDate(p.joinDate).slice(0, 4)}</div><span class="lbl">Joined</span><div class="d">${fmtDate(p.joinDate)}</div></div></div>
        <div class="panel" style="margin-top:16px"><h2>My details</h2><table><tbody>
          <tr><td style="color:var(--muted)">Department</td><td>${esc(p.department || '')}</td></tr><tr><td style="color:var(--muted)">Nationality</td><td>${esc(p.nationality || '')}</td></tr>
          <tr><td style="color:var(--muted)">Bank</td><td>${esc(p.bank?.bankName || '')} ${esc(p.bank?.ibanMasked || '')}</td></tr><tr><td style="color:var(--muted)">Contract</td><td>${esc(p.contractType || '')}</td></tr></tbody></table>
          <p class="note">To change your bank or personal details, send a request from My requests.</p></div>`);
    } else if (tab === 'payslips') {
      const list = await api('/me/payslips');
      put(`<div class="panel"><h2>Payslips</h2>${list.length ? `<table><thead><tr><th>Period</th><th>Type</th><th class="r">Net</th><th></th></tr></thead><tbody>${list.map((x) => `<tr><td class="mono">${esc(x.period)}</td><td>${esc(x.type || 'regular')}</td><td class="r num">AED ${AED(x.netFils)}</td><td><button class="btn sm" data-ps="${x.runId}">View</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No payslips released yet.</div>'}</div>`);
      body.querySelectorAll('[data-ps]').forEach((b) => (b.onclick = () => openHtml(`/me/payslips/${b.dataset.ps}`)));
    } else if (tab === 'leave') {
      const list = await api('/me/leave');
      put(`<div class="grid g2"><div class="panel"><h2>Request leave</h2><form id="lvForm" class="form">
        <div class="field" style="grid-column:1/-1"><label class="lbl" for="lvType">Leave type</label><select id="lvType">${['annual', 'sick', 'parental', 'maternity', 'hajj', 'unpaid'].map((x) => `<option value="${x}">${x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select></div>
        <div class="field"><label class="lbl" for="lvS">Start date</label><input id="lvS" type="date" required></div><div class="field"><label class="lbl" for="lvE">End date</label><input id="lvE" type="date" required></div>
        <div class="field" id="lvBirthWrap" hidden style="grid-column:1/-1"><label class="lbl" for="lvBirth">Child's date of birth</label><input id="lvBirth" type="date"></div>
        <div class="field" style="grid-column:1/-1"><label class="lbl" for="lvR">Reason</label><input id="lvR"></div>
        <div id="lvPrev" style="grid-column:1/-1"></div>
        <div style="grid-column:1/-1;display:flex;gap:8px"><button class="btn" type="button" id="lvCheck">Check policy</button><button class="btn pri" type="submit">Submit</button></div></form></div>
        <div class="panel"><h2>My leave</h2>${list.length ? `<div class="list">${list.map((x) => `<div class="row"><div class="grow">${esc(x.type)} · <span class="mono">${fmtDate(x.startDate)} → ${fmtDate(x.endDate)}</span> (${x.days}d)${x.unpaidDays ? `<div style="font-size:12px;color:var(--warn)">${x.unpaidDays} unpaid day(s)</div>` : ''}</div>${statusPill(x.status)}</div>`).join('')}</div>` : '<div class="empty">No leave yet.</div>'}</div></div>`);
      const bodyOf = () => ({ type: $('#lvType').value, startDate: $('#lvS').value, endDate: $('#lvE').value, reason: $('#lvR').value || undefined, childBirthDate: $('#lvBirth').value || undefined });
      $('#lvType').onchange = () => { $('#lvBirthWrap').hidden = $('#lvType').value !== 'parental'; };
      $('#lvCheck').onclick = async () => { try { const ev = await api('/leave', { method: 'POST', body: { ...bodyOf(), preview: true } }); showLeavePreview($('#lvPrev'), ev); } catch (e) { fail(e); } };
      $('#lvForm').onsubmit = async (e) => { e.preventDefault(); try { const r2 = await api('/leave', { method: 'POST', body: bodyOf() }); toast(`Leave requested${r2.warnings?.length ? `: ${r2.warnings[0]}` : ''}`); views.me(); } catch (err) { fail(err); } };
    } else if (tab === 'docs') {
      const list = await api('/me/documents');
      put(`<div class="panel"><h2>My documents</h2>${list.length ? `<table><thead><tr><th>Document</th><th>Expiry</th><th>Expires in</th><th></th></tr></thead><tbody>${list.map((d) => `<tr><td>${esc(DOC_LABEL[d.docType] || d.docType)}</td><td class="mono">${fmtDate(d.expiryDate)}</td><td>${pill(d.daysLeft <= 14 ? 'p-bad' : d.daysLeft <= 30 ? 'p-warn' : 'p-ok', d.daysLeft < 0 ? `${-d.daysLeft} days overdue` : `${d.daysLeft} days`)}</td><td>${d.hasFile ? `<button class="btn sm" data-f="${d._id}">View</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No documents on file.</div>'}</div>`);
      body.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => openFile(`/me/documents/${b.dataset.f}/file`)));
    } else {
      const list = await api('/me/requests');
      put(`<div class="grid g2"><div class="panel"><h2>New request</h2><form id="rqForm" style="display:flex;flex-direction:column;gap:12px">
        <div class="field"><label class="lbl" for="rqKind">Request type</label><select id="rqKind">${Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div id="rqLetter" style="display:flex;flex-direction:column;gap:12px"><div class="field"><label class="lbl" for="rqLt">Letter</label><select id="rqLt">${Object.entries(LETTER_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <div class="field"><label class="lbl" for="rqTo">Addressed to</label><input id="rqTo" placeholder="e.g. Emirates NBD"></div>
          <div class="field"><label class="lbl" for="rqLang">Language</label><select id="rqLang"><option value="dual">English + Arabic</option><option value="en">English</option><option value="ar">Arabic</option></select></div></div>
        <div class="field" id="rqIbanWrap" hidden><label class="lbl" for="rqIban">New IBAN</label><input id="rqIban" placeholder="AE.. (23 characters)"></div>
        <div class="field"><label class="lbl" for="rqDet">Details</label><textarea id="rqDet"></textarea></div>
        <button class="btn pri" type="submit">Send request</button></form></div>
        <div class="panel"><h2>My requests</h2>${list.length ? `<div class="list">${list.map((x) => `<div class="row"><div class="grow">${esc(KIND_LABEL[x.kind])}${x.letterType ? ` · ${esc(LETTER_LABEL[x.letterType])}` : ''}<div style="font-size:12px;color:var(--muted)">${esc(x.reference || '')} · ${fmtDate(x.createdAt)}</div></div>${statusPill(x.status)}${x.kind === 'letter' && x.status === 'done' ? `<button class="btn sm" data-lt="${x._id}">Open letter</button>` : ''}</div>`).join('')}</div>` : '<div class="empty">No requests yet.</div>'}</div></div>`);
      const sync = () => { const k = $('#rqKind').value; $('#rqLetter').hidden = k !== 'letter'; $('#rqIbanWrap').hidden = k !== 'bank_change'; };
      $('#rqKind').onchange = sync; sync();
      body.querySelectorAll('[data-lt]').forEach((b) => (b.onclick = () => openHtml(`/me/letters/${b.dataset.lt}`)));
      $('#rqForm').onsubmit = async (e) => { e.preventDefault(); const k = $('#rqKind').value; try { await api('/me/requests', { method: 'POST', body: { kind: k, details: $('#rqDet').value || undefined, ...(k === 'letter' ? { letterType: $('#rqLt').value, addressee: $('#rqTo').value || undefined, lang: $('#rqLang').value } : {}), ...(k === 'bank_change' ? { iban: $('#rqIban').value } : {}) } }); toast('Request sent to HR'); views.me(); } catch (err) { fail(err); } };
    }
  },
});

function showLeavePreview(el, ev) {
  el.innerHTML = `<div class="panel" style="padding:14px;background:var(--surface-2)">${ev.errors?.length ? `<div class="err">${ev.errors.map(esc).join('<br>')}</div>` : pill('p-ok', 'Allowed by policy')}
    ${ev.warnings?.length ? `<div style="color:var(--warn);font-size:13px;margin-top:6px">${ev.warnings.map(esc).join('<br>')}</div>` : ''}
    <div class="trace" style="margin-top:8px">${ev.days} day(s): <b>${ev.split?.fullDays ?? 0}</b> full pay · <b>${ev.split?.halfDays ?? 0}</b> half pay · <b>${ev.split?.unpaidDays ?? 0}</b> unpaid<br>Annual balance <b>${ev.balances?.annual?.remaining ?? '—'}</b> of ${ev.balances?.annual?.entitlement ?? '—'} · sick days taken <b>${ev.balances?.sick?.taken ?? 0}</b></div></div>`;
  translateTree(el, L);
}

// ---------- Enhancements to existing screens ----------
const baseDocs = views.docs, baseEosb = views.eosb, baseLeave = views.leave;
views.docs = async () => {
  await baseDocs();
  if (!has('hr_admin')) return;
  const [emps, ests] = await Promise.all([api('/employees?status=active'), api('/establishments')]);
  const box = document.createElement('div');
  box.className = 'panel'; box.style.marginBottom = '16px';
  box.innerHTML = `<details><summary style="cursor:pointer;font-family:var(--f-display);font-weight:600;font-size:16px">Upload document</summary>
    <form id="upForm" class="form" style="margin-top:14px">
      <div class="field"><label class="lbl" for="upOwner">Holder</label><select id="upOwner"><optgroup label="Employees">${emps.map((e) => `<option value="employee:${e._id}">${esc(e.fullName)}</option>`).join('')}</optgroup><optgroup label="Company">${ests.map((e) => `<option value="establishment:${e._id}">${esc(e.name)}</option>`).join('')}</optgroup></select></div>
      <div class="field"><label class="lbl" for="upFile">File</label><input id="upFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"></div>
      <div class="field"><label class="lbl" for="upType">Document type</label><select id="upType">${Object.entries(DOC_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <div class="field"><label class="lbl" for="upNo">Document number</label><input id="upNo"></div>
      <div class="field"><label class="lbl" for="upIssue">Issue date</label><input id="upIssue" type="date"></div>
      <div class="field"><label class="lbl" for="upExp">Expiry date</label><input id="upExp" type="date" required></div>
      <div id="upMsg" style="grid-column:1/-1;font-size:13px;color:var(--muted)">PDF, JPG, PNG or WEBP up to 8 MB. "Read with AI" fills the fields for you to check.</div>
      <div style="grid-column:1/-1;display:flex;gap:8px"><button class="btn" type="button" id="upOcr">Read with AI</button><button class="btn pri" type="submit">Save document</button></div></form></details>`;
  $('#view').insertBefore(box, $('#view').children[3] || null);
  translateTree(box, L);
  const fileData = async () => { const f = $('#upFile').files[0]; if (!f) return null; if (f.size > 8 * 1024 * 1024) throw new Error('That file is larger than 8 MB.'); return { fileBase64: await fileToBase64(f), contentType: f.type, fileName: f.name }; };
  $('#upOcr').onclick = async () => {
    try {
      const fd = await fileData(); if (!fd) return toast('Choose a file first');
      $('#upMsg').textContent = 'Reading the document…';
      const r2 = await api('/documents/ocr', { method: 'POST', body: fd });
      if (!r2.available) { $('#upMsg').textContent = r2.message; return; }
      const f = r2.fields || {};
      if (f.docType) $('#upType').value = f.docType; if (f.number) $('#upNo').value = f.number; if (f.issueDate) $('#upIssue').value = f.issueDate; if (f.expiryDate) $('#upExp').value = f.expiryDate;
      $('#upMsg').textContent = `Filled from the document${f.holderName ? ` (${f.holderName})` : ''}, confidence ${Math.round((f.confidence || 0) * 100)}%. Check every field before saving.`;
    } catch (e) { $('#upMsg').textContent = ''; fail(e); }
  };
  $('#upForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const [ownerType, id] = $('#upOwner').value.split(':');
      const fd = await fileData();
      await api('/documents', { method: 'POST', body: { ownerType, [ownerType === 'employee' ? 'employeeId' : 'establishmentId']: id, docType: $('#upType').value, number: $('#upNo').value || undefined, issueDate: $('#upIssue').value || undefined, expiryDate: $('#upExp').value, ...(fd || {}) } });
      toast('Document saved'); views.docs();
    } catch (err) { fail(err); }
  };
  // file links in the table
  const docs = await api('/documents/expiring?days=120');
  document.querySelectorAll('#view table tbody tr').forEach((tr, i) => { const d = docs[i]; if (d?.storageKey) { const td = tr.lastElementChild; td.insertAdjacentHTML('beforeend', ` <button class="btn sm" data-file="${d._id}">File</button>`); } });
  document.querySelectorAll('[data-file]').forEach((b) => (b.onclick = () => openFile(`/documents/${b.dataset.file}/file`)));
};

views.eosb = async () => {
  await baseEosb();
  if (!has('hr_admin', 'payroll_maker')) return;
  after(`<div class="panel" style="margin-top:16px"><h2>Final settlement</h2><p style="margin:0 0 12px;color:var(--muted);font-size:14px">Uses the employee and last working day selected above. Adds pro-rata salary, unused annual leave, gratuity and notice pay, minus loans; creates a draft run for maker-checker approval and WPS export.</p>
    <div class="form"><div class="field"><label class="lbl" for="fsNotice">Notice pay in lieu (days)</label><input id="fsNotice" type="number" min="0" max="90" value="0"></div>
      <div class="field"><label class="lbl" for="fsLoan">Outstanding loan (AED)</label><input id="fsLoan" type="number" min="0" step="0.01" value="0"></div>
      <div class="field"><label class="lbl" for="fsOther">Other deductions (AED)</label><input id="fsOther" type="number" min="0" step="0.01" value="0"></div>
      <div class="field"><label class="lbl" for="fsReason">Reason</label><input id="fsReason" placeholder="Resignation, end of contract…"></div></div>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="btn" id="fsPrev">Preview</button><button class="btn pri" id="fsGo" disabled>Create final settlement</button></div><div id="fsOut" style="margin-top:12px"></div></div>`);
  const body = () => ({ employeeId: $('#eE').value, lastWorkingDate: $('#eD').value, noticePayDays: Number($('#fsNotice').value) || 0, outstandingLoan: $('#fsLoan').value || 0, otherDeductions: $('#fsOther').value || 0, reason: $('#fsReason').value || undefined });
  $('#fsPrev').onclick = async () => {
    try {
      const s2 = await api('/payroll/settlements/preview', { method: 'POST', body: body() });
      const c = s2.components;
      $('#fsOut').innerHTML = `<div class="grid g2"><table><tbody>
        <tr><td>Pro-rata salary</td><td class="r num">${AED(c.proRataSalaryFils)}</td></tr><tr><td>Leave encashment (${s2.unusedLeaveDays} days)</td><td class="r num">${AED(c.leaveEncashmentFils)}</td></tr>
        <tr><td>Gratuity</td><td class="r num">${AED(c.gratuityFils)}</td></tr><tr><td>Notice pay</td><td class="r num">${AED(c.noticePayFils)}</td></tr>
        <tr><td>Deductions</td><td class="r num">−${AED(s2.deductionsFils)}</td></tr><tr><td><b>Net settlement</b></td><td class="r num"><b style="color:var(--accent)">AED ${AED(s2.netFils)}</b></td></tr></tbody></table>
        <div class="trace" style="font-size:12.5px">${s2.trace.map(esc).join('<br>')}</div></div>`;
      $('#fsGo').disabled = false;
    } catch (e) { fail(e); }
  };
  $('#fsGo').onclick = async () => { try { await api('/payroll/settlements', { method: 'POST', body: body() }); toast('Final settlement created as a draft run. Submit it from Payroll & WPS.'); $('#fsGo').disabled = true; } catch (e) { fail(e); } };
};

views.leave = async () => {
  await baseLeave();
  if (!has('hr_admin', 'manager')) return;
  const emps = await api('/employees?status=active');
  after(`<div class="panel" style="margin-top:16px"><h2>Request leave</h2><form id="hlForm" class="form">
    <div class="field"><label class="lbl" for="hlEmp">Employee</label><select id="hlEmp">${empOptions(emps)}</select></div>
    <div class="field"><label class="lbl" for="hlType">Leave type</label><select id="hlType">${['annual', 'sick', 'parental', 'maternity', 'hajj', 'unpaid'].map((x) => `<option value="${x}">${x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select></div>
    <div class="field"><label class="lbl" for="hlS">Start date</label><input id="hlS" type="date" required></div><div class="field"><label class="lbl" for="hlE">End date</label><input id="hlE" type="date" required></div>
    <div class="field" id="hlBirthWrap" hidden><label class="lbl" for="hlBirth">Child's date of birth</label><input id="hlBirth" type="date"></div>
    <div class="field"><label class="lbl" for="hlCert"><input id="hlCert" type="checkbox" style="accent-color:#ff5b1f"> Medical certificate attached</label></div>
    <div id="hlPrev" style="grid-column:1/-1"></div>
    <div style="grid-column:1/-1;display:flex;gap:8px"><button class="btn" type="button" id="hlCheck">Check policy</button><button class="btn pri" type="submit">Submit</button></div></form></div>`);
  const bodyOf = () => ({ employeeId: $('#hlEmp').value, type: $('#hlType').value, startDate: $('#hlS').value, endDate: $('#hlE').value, childBirthDate: $('#hlBirth').value || undefined, certificateAttached: $('#hlCert').checked });
  $('#hlType').onchange = () => { $('#hlBirthWrap').hidden = $('#hlType').value !== 'parental'; };
  $('#hlCheck').onclick = async () => { try { showLeavePreview($('#hlPrev'), await api('/leave', { method: 'POST', body: { ...bodyOf(), preview: true } })); } catch (e) { fail(e); } };
  $('#hlForm').onsubmit = async (e) => { e.preventDefault(); try { await api('/leave', { method: 'POST', body: bodyOf() }); toast('Leave request created'); views.leave(); } catch (err) { fail(err); } };
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

// ================= Employee app (self-service): home, clock in/out, leave, payslips, documents, requests, assistant, tag =================
const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dubai' }) : '—');
const hmFromMin = (m) => (m == null ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`);
const distLabel = (m) => (m == null ? '' : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);
const flagPills = (flags = []) => flags.map((f) => pill(f.code === 'LATE' || f.code === 'LOW_GPS_ACCURACY' ? 'p-warn' : f.code === 'OVERTIME' || f.code === 'HR_APPROVED' ? 'p-n' : 'p-bad', { LATE: 'Late', OUTSIDE_GEOFENCE: 'Outside site', NO_GPS: 'No GPS', LOW_GPS_ACCURACY: 'Weak GPS', OVERTIME: 'Overtime', HR_APPROVED: 'HR approved' }[f.code] || f.code)).join(' ');
let assistantLog = [];
let pendingQuestion = '';

function getLocation() {
  return new Promise((ok) => {
    if (!navigator.geolocation) return ok({ gpsError: 'This browser cannot share location' });
    navigator.geolocation.getCurrentPosition(
      (p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) }),
      (e) => ok({ gpsError: e.code === 1 ? 'Location permission denied' : e.code === 3 ? 'Location timed out' : 'Location unavailable' }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
}
// Downscale any image source to a small JPEG data URL (keeps uploads ~40–80 KB)
function toJpeg(source, w, h) {
  const scale = Math.min(1, 480 / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  const g = c.getContext('2d'); g.drawImage(source, 0, 0, c.width, c.height);
  g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, c.height - 22, c.width, 22);
  g.fillStyle = '#fff'; g.font = '12px sans-serif'; g.fillText(`${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })} GST`, 8, c.height - 7);
  return c.toDataURL('image/jpeg', 0.72);
}

// Camera sheet: live front camera with a capture button; falls back to the phone's camera picker.
function captureSelfie() {
  return new Promise((resolve) => {
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.innerHTML = `<div class="sheet-card panel" role="dialog" aria-modal="true" aria-label="Clock-in photo">
      <h2 style="margin:0">Clock-in photo</h2><p style="margin:0;color:var(--muted);font-size:14px">Centre your face in the frame. The photo and your location are attached to today's clock-in.</p>
      <div class="cam"><video id="camV" playsinline muted autoplay></video><div class="cam-ring"></div><img id="camP" alt="Captured photo" hidden></div>
      <div id="camMsg" style="font-size:13px;color:var(--muted)">Starting camera…</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn pri" id="camShot" disabled>Take photo</button>
        <label class="btn" for="camFile" style="display:inline-flex;align-items:center">Use phone camera</label><input id="camFile" type="file" accept="image/*" capture="user" hidden>
        <button class="btn" id="camRetake" hidden>Retake</button>
        <button class="btn pri" id="camUse" hidden>Use this photo</button>
        <button class="btn" id="camCancel">Cancel</button></div></div>`;
    document.body.appendChild(sheet);
    translateTree(sheet, L);
    let stream = null, shot = null;
    const v = sheet.querySelector('#camV'), img = sheet.querySelector('#camP'), msg = sheet.querySelector('#camMsg');
    const stop = () => stream?.getTracks().forEach((tr) => tr.stop());
    const close = (val) => { stop(); sheet.remove(); resolve(val); };
    const show = (dataUrl) => {
      shot = dataUrl; img.src = dataUrl; img.hidden = false; v.hidden = true;
      sheet.querySelector('#camShot').hidden = true; sheet.querySelector('#camRetake').hidden = false; sheet.querySelector('#camUse').hidden = false; msg.textContent = 'Looks good?';
    };
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 } }, audio: false });
        v.srcObject = stream; await v.play().catch(() => {});
        sheet.querySelector('#camShot').disabled = false; msg.textContent = 'Camera ready.';
      } catch {
        msg.textContent = 'Camera access is blocked. Use “Use phone camera” instead, or allow camera access in your browser settings.';
      }
    })();
    sheet.querySelector('#camShot').onclick = () => show(toJpeg(v, v.videoWidth || 640, v.videoHeight || 480));
    sheet.querySelector('#camRetake').onclick = () => { img.hidden = true; v.hidden = false; shot = null; sheet.querySelector('#camShot').hidden = false; sheet.querySelector('#camRetake').hidden = true; sheet.querySelector('#camUse').hidden = true; };
    sheet.querySelector('#camUse').onclick = () => close(shot);
    sheet.querySelector('#camCancel').onclick = () => close(null);
    sheet.querySelector('#camFile').onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      const im = new Image(); im.onload = () => show(toJpeg(im, im.naturalWidth, im.naturalHeight)); im.src = URL.createObjectURL(f);
    };
  });
}

async function doClockIn(after) {
  const photo = await captureSelfie();
  if (!photo) return;
  toast('Getting your location…');
  const gps = await getLocation();
  try {
    const r = await api('/me/clock-in', { method: 'POST', body: { photo, ...gps, device: navigator.userAgent.slice(0, 180) } });
    toast(r.message + (r.record.clockIn?.insideGeofence === false ? ' · outside the site, HR will review' : '') + (gps.gpsError ? ` · ${gps.gpsError}` : ''));
  } catch (e) { fail(e); }
  after();
}
async function doClockOut(after) {
  toast('Getting your location…');
  const gps = await getLocation();
  try { const r = await api('/me/clock-out', { method: 'POST', body: { ...gps, device: navigator.userAgent.slice(0, 180) } }); toast(r.message); } catch (e) { fail(e); }
  after();
}

// Live clock-in card used on Home and Attendance
function clockCardHtml(today, shift, site) {
  const rec = today;
  const state = !rec?.clockIn?.at ? 'out' : (rec.open ?? !rec.clockOut?.at) ? 'in' : 'done';
  const sessions = rec?.sessions || (rec ? [rec] : []);
  return `<div class="panel clockcard state-${state}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
      <div><div class="lbl">${state === 'in' ? (sessions.length > 1 ? `On shift · session ${sessions.length}` : 'On shift') : state === 'done' ? 'Clocked out' : 'Not clocked in'}</div>
        <div class="bigclock num" id="liveClock">--:--</div>
        <div style="color:var(--muted);font-size:13px">Shift ${esc(shift?.start || '08:00')}–${esc(shift?.end || '17:00')} · ${esc(site?.label || 'Work site')}</div></div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
        ${state === 'out' ? `<button class="btn pri big-btn" id="ciBtn">${icon('M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM4 8h3l2-3h6l2 3h3v11H4z', 20)}<span>Clock in</span></button><span style="font-size:12px;color:var(--muted)">Selfie + location required</span>` : ''}
        ${state === 'in' ? `<button class="btn pri big-btn" id="coBtn">${icon('M10 17l5-5-5-5M15 12H3M21 3v18', 20)}<span>Clock out</span></button><span style="font-size:12px;color:var(--muted)">Location captured</span>` : ''}
        ${state === 'done' ? `<button class="btn big-btn" id="ciBtn">${icon('M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM4 8h3l2-3h6l2 3h3v11H4z', 20)}<span>Clock in again</span></button><span style="font-size:12px;color:var(--muted)">${hmFromMin(rec.minutesWorked)} worked today</span>` : ''}
      </div></div>
    ${rec ? `<div class="punches">
      <div><span class="lbl">${sessions.length > 1 ? 'First in' : 'In'}</span><b class="num">${fmtTime(rec.clockIn?.at)}</b><small>${rec.clockIn?.insideGeofence === false ? `${distLabel(rec.clockIn.distanceM)} from site` : rec.clockIn?.insideGeofence ? 'On site' : rec.clockIn?.gpsError ? esc(rec.clockIn.gpsError) : ''}</small></div>
      <div><span class="lbl">${sessions.length > 1 ? 'Last out' : 'Out'}</span><b class="num">${fmtTime(rec.clockOut?.at)}</b><small>${rec.clockOut?.at ? (rec.clockOut.insideGeofence === false ? `${distLabel(rec.clockOut.distanceM)} from site` : 'Location saved') : ''}</small></div>
      <div><span class="lbl">Worked today</span><b class="num" id="liveWorked">${hmFromMin(rec.minutesWorked || 0)}</b><small>${rec.overtimeMinutes ? `${hmFromMin(rec.overtimeMinutes)} overtime` : ''}</small></div>
    </div>${sessions.length > 1 ? `<div class="sessions">${sessions.map((x, i) => `<span class="pill p-n">${i + 1}. ${fmtTime(x.clockIn?.at)} – ${x.clockOut?.at ? fmtTime(x.clockOut.at) : 'now'}</span>`).join('')}</div>` : ''}<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">${flagPills(rec.flags)}</div>` : ''}
  </div>`;
}
function wireClockCard(rec, refresh) {
  const tick = () => {
    const el = document.getElementById('liveClock'); if (!el) return clearInterval(window.__clk);
    el.textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Dubai' });
    const w = document.getElementById('liveWorked');
    const curS = rec?.current || rec;
    if (w && curS?.clockIn?.at && !curS.clockOut?.at) w.textContent = hmFromMin((rec.minutesWorked || 0) + Math.max(0, Math.round((Date.now() - new Date(curS.clockIn.at)) / 60000)));
  };
  clearInterval(window.__clk); tick(); window.__clk = setInterval(tick, 1000);
  const ci = $('#ciBtn'); if (ci) ci.onclick = () => doClockIn(refresh);
  const co = $('#coBtn'); if (co) co.onclick = () => doClockOut(refresh);
}

Object.assign(views, {
  async ehome() {
    const h = await api('/me/home');
    const first = h.profile.fullName.split(' ')[0];
    const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Dubai' });
    const pays = h.payslips; const lastPay = pays.at(-1);
    const maxPay = Math.max(1, ...pays.map((p) => p.netFils));
    const an = h.balances.annual || {}; const annPct = an.entitlement ? Math.min(100, (an.remaining / an.entitlement) * 100) : 0;
    V(`<div class="eyebrow">${esc(today)} · ${esc(h.profile.establishment || '')}</div>
    <h1>Hello, <em>${esc(first)}</em></h1><p class="sub">${esc(h.profile.jobTitle || '')} · ${esc(h.profile.department || '')} · ${esc(h.profile.employeeNo)}</p>
    <div class="grid emp-top">
      <div id="clockSlot">${clockCardHtml(h.today, h.shift, h.site)}</div>
      <div class="panel"><h2>Quick actions</h2><div class="qa">
        ${[['eleave', 'Apply for leave', ICONS.leave], ['epay', 'My payslips', ICONS.pay], ['ereq', 'Salary certificate', ICONS.requests], ['edocs', 'My documents', ICONS.docs], ['etag', 'My ID tag', ICONS.etag], ['eai', 'Ask HR assistant', ICONS.eai]]
          .map(([go2, label, ic]) => `<button class="qa-btn" data-go="${go2}">${icon(ic, 22)}<span>${label}</span></button>`).join('')}</div></div>
    </div>
    <div class="grid g4" style="margin-top:16px">
      <div class="panel stat"><div class="v">${an.remaining ?? '—'}</div><span class="lbl">Annual leave left</span><div class="meter" style="margin-top:10px"><i style="width:${annPct}%"></i></div><div class="d">of ${an.entitlement ?? '—'} days</div></div>
      <div class="panel stat"><div class="v">${h.balances.sick?.fullPayLeft ?? '—'}</div><span class="lbl">Full-pay sick days</span><div class="d">${h.balances.sick?.taken ?? 0} taken this year</div></div>
      <div class="panel stat"><div class="v">${h.month.daysPresent}</div><span class="lbl">Days present this month</span><div class="d">${h.month.lateDays} late · ${h.month.hoursWorked} h worked</div></div>
      <div class="panel stat"><div class="v num">${lastPay ? Math.round(lastPay.netFils / 100).toLocaleString('en-AE') : '—'}</div><span class="lbl">Last net pay · AED</span><div class="d">${lastPay ? esc(lastPay.period) : 'No payslip yet'}</div></div>
    </div>
    <div class="grid g3" style="margin-top:16px">
      <div class="panel"><h2>Pay history</h2>${pays.length ? `<div class="paybars">${pays.map((p) => `<button class="paybar" data-ps="${p.runId}" title="${esc(p.period)}: AED ${AED(p.netFils)}"><span class="num">${Math.round(p.netFils / 100000 * 10) / 10}k</span><i style="height:${Math.max(6, (p.netFils / maxPay) * 100)}%"></i><small>${esc(p.period.slice(5))}</small></button>`).join('')}</div><div style="font-size:12px;color:var(--muted);margin-top:28px">Tap a bar to open that payslip.</div>` : '<div class="empty">Payslips appear here once HR releases them.</div>'}</div>
      <div class="panel"><h2>Coming up</h2><div class="list">
        ${h.upcomingLeave.map((l) => `<div class="row"><span class="sev" style="background:var(--accent)"></span><div class="grow">${esc(l.type)} leave<div style="font-size:12px;color:var(--muted)">${fmtDate(l.startDate)} → ${fmtDate(l.endDate)}</div></div>${statusPill(l.status)}</div>`).join('')}
        ${h.holidays.map((x) => `<div class="row"><span class="sev" style="background:var(--ok)"></span><div class="grow">${esc(x.name)}<div style="font-size:12px;color:var(--muted)">${esc(x.date)}${x.estimated ? ' · estimated' : ''}</div></div>${pill('p-ok', 'Public holiday')}</div>`).join('')}
      </div></div>
      <div class="panel"><h2>My documents</h2><div class="list">
        ${h.documents.length ? h.documents.map((d) => `<div class="row"><div class="grow">${esc(DOC_LABEL[d.docType] || d.docType)}<div style="font-size:12px;color:var(--muted)">Expires ${fmtDate(d.expiryDate)}</div></div>${pill(d.daysLeft < 0 ? 'p-bad' : d.daysLeft <= 30 ? 'p-warn' : 'p-ok', d.daysLeft < 0 ? 'Expired' : `${d.daysLeft} days`)}</div>`).join('') : '<div class="empty">No documents on file.</div>'}
      </div></div>
    </div>
    <div class="panel" style="margin-top:16px"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="margin:0">My requests</h2><button class="btn sm" data-go="ereq">New request</button></div>
      <div class="list" style="margin-top:6px">${h.requests.length ? h.requests.map((x) => `<div class="row"><div class="grow">${esc(KIND_LABEL[x.kind] || x.kind)}${x.letterType ? ` · ${esc(LETTER_LABEL[x.letterType] || x.letterType)}` : ''}<div style="font-size:12px;color:var(--muted)">${esc(x.reference || '')} · ${fmtDate(x.createdAt)}</div></div>${statusPill(x.status)}</div>`).join('') : '<div class="empty">No requests yet.</div>'}</div></div>`);
    wireClockCard(h.today, () => views.ehome().catch(fail));
    document.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => go(b.dataset.go)));
    document.querySelectorAll('[data-ps]').forEach((b) => (b.onclick = () => openHtml(`/me/payslips/${b.dataset.ps}`)));
  },

  async eclock() {
    const month = localStorage.getItem('wasl_attmonth') || new Date().toISOString().slice(0, 7);
    const [t0, hist] = await Promise.all([api('/me/attendance/today'), api(`/me/attendance?month=${month}`)]);
    const s = hist.summary;
    const months = Array.from({ length: 4 }, (_, i) => { const d = new Date(); d.setMonth(d.getMonth() - i); return d.toISOString().slice(0, 7); });
    V(`<div class="eyebrow">ATTENDANCE · ${esc(t0.date)}${t0.ramadan ? ' · RAMADAN HOURS' : ''}</div><h1>Clock <em>in &amp; out</em></h1>
    <p class="sub">Clocking in takes a selfie and your GPS location; clocking out records your location. If you're away from the site (a delivery, say), clock in anyway: HR reviews it.</p>
    <div class="grid g2">
      <div id="clockSlot">${clockCardHtml(t0.record, t0.site?.shift, t0.site)}</div>
      <div class="panel"><h2>Where you clock in</h2>
        <div class="sitemap" aria-hidden="true"><span class="ring r3"></span><span class="ring r2"></span><span class="ring r1"></span><span class="pin"></span>
          ${t0.record?.clockIn?.distanceM != null ? `<span class="me" style="--d:${Math.min(1, (t0.record.clockIn.distanceM || 0) / ((t0.site?.radiusM || 300) * 3))}"></span>` : ''}</div>
        <div style="font-size:14px;margin-top:10px"><b>${esc(t0.site?.label || t0.site?.name || 'Work site')}</b></div>
        <div style="font-size:13px;color:var(--muted)">Allowed radius ${esc(t0.site?.radiusM || 300)} m${t0.record?.clockIn?.distanceM != null ? ` · today you were ${distLabel(t0.record.clockIn.distanceM)} away` : ''}</div>
        ${t0.site?.lat != null ? `<a class="btn sm" style="margin-top:10px;display:inline-block;text-decoration:none" href="https://www.google.com/maps?q=${t0.site.lat},${t0.site.lng}" target="_blank" rel="noopener">Open in Maps</a>` : ''}</div>
    </div>
    <div class="grid g4" style="margin-top:16px">
      <div class="panel stat"><div class="v">${s.daysPresent}</div><span class="lbl">Days present</span></div>
      <div class="panel stat"><div class="v ${s.lateDays ? 'warn' : ''}">${s.lateDays}</div><span class="lbl">Late arrivals</span></div>
      <div class="panel stat"><div class="v">${s.hoursWorked}</div><span class="lbl">Hours worked</span></div>
      <div class="panel stat"><div class="v">${s.overtimeHours}</div><span class="lbl">Overtime hours</span></div>
    </div>
    <div class="panel tw" style="margin-top:16px"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="margin:0">History</h2>
      <div class="seg" role="group" aria-label="Month">${months.map((m) => `<button data-m="${m}" class="${m === month ? 'on' : ''}">${new Date(m + '-01').toLocaleDateString('en-GB', { month: 'short' })}</button>`).join('')}</div></div>
      <table style="margin-top:8px"><thead><tr><th>Date</th><th>In</th><th>Out</th><th>Worked</th><th>Notes</th><th></th></tr></thead><tbody>
      ${hist.records.map((a) => `<tr><td class="mono">${esc(a.date)}</td><td class="num">${fmtTime(a.clockIn?.at)}</td><td class="num">${fmtTime(a.clockOut?.at)}</td><td class="num">${hmFromMin(a.minutesWorked)}</td><td>${flagPills(a.flags) || '<span style="color:var(--muted)">On time</span>'}</td><td>${a.hasPhoto ? `<button class="btn sm" data-ph="${a._id}">Photo</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No attendance this month.</td></tr>'}
      </tbody></table></div><div id="phView"></div>`);
    wireClockCard(t0.record, () => views.eclock().catch(fail));
    document.querySelectorAll('.seg [data-m]').forEach((b) => (b.onclick = () => { localStorage.setItem('wasl_attmonth', b.dataset.m); views.eclock().catch(fail); }));
    document.querySelectorAll('[data-ph]').forEach((b) => (b.onclick = async () => { try { const r = await api(`/me/attendance/${b.dataset.ph}/photo`); $('#phView').innerHTML = `<div class="panel" style="margin-top:16px;max-width:360px"><h2>Clock-in photo</h2><img src="${r.photo}" alt="Clock-in photo" style="width:100%;border-radius:4px"></div>`; } catch (e) { fail(e); } }));
  },

  async eleave() { localStorage.setItem('wasl_metab', 'leave'); await views.me(); empStrip('Leave', 'Apply for leave and track your requests. The policy check shows paid, half-paid and unpaid days before you submit.'); },
  async epay() { localStorage.setItem('wasl_metab', 'payslips'); await views.me(); empStrip('Payslips', 'Open any payslip to view, print or save it as a PDF.'); },
  async edocs() { localStorage.setItem('wasl_metab', 'docs'); await views.me(); empStrip('My documents', 'Your passport, visa, Emirates ID and other documents held by HR, with expiry dates.'); },
  async ereq() { localStorage.setItem('wasl_metab', 'req'); await views.me(); empStrip('Requests', 'Ask for letters and certificates, update your bank or personal details, or raise a salary or IT query.'); },

  async eai() {
    V(`<div class="eyebrow">ASK IN ENGLISH, عربي, हिंदी, اردو, MALAYALAM OR TAGALOG</div><h1>HR <em>assistant</em></h1>
    <p class="sub">Answers come from your own records (leave, payslips, documents, attendance). It never changes anything itself: it points you to the right button.</p>
    <div class="panel chat"><div id="chatLog" class="chat-log" aria-live="polite"></div>
      <div class="chips" id="chatChips" style="margin:10px 0"></div>
      <form id="chatForm" class="cmd" style="margin:0"><label class="sr" for="chatIn">Message</label><input id="chatIn" autocomplete="off" placeholder="e.g. How many leave days do I have left?"><button class="btn pri sm" type="submit">Send</button></form></div>`);
    const log = $('#chatLog');
    const draw = () => {
      log.innerHTML = assistantLog.length ? assistantLog.map((m) => `<div class="msg ${m.who}"><div class="bubble">${esc(m.text)}</div>${(m.actions || []).length ? `<div class="msg-actions">${m.actions.map((a) => `<button class="btn sm" data-go="${a.go}">${esc(a.label)}</button>`).join('')}</div>` : ''}</div>`).join('')
        : '<div class="empty">Ask anything about your leave, pay, documents or attendance.</div>';
      log.scrollTop = log.scrollHeight;
      log.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => go(b.dataset.go)));
    };
    const ask = async (q) => {
      assistantLog.push({ who: 'me', text: q }); assistantLog.push({ who: 'bot', text: '…' }); draw();
      try { const r = await api('/me/assistant', { method: 'POST', body: { message: q } }); assistantLog[assistantLog.length - 1] = { who: 'bot', text: r.reply, actions: r.actions }; } catch (e) { assistantLog[assistantLog.length - 1] = { who: 'bot', text: e.message }; }
      draw();
    };
    ['How many leave days do I have left?', 'Show my last payslip', 'I need a salary certificate for Emirates NBD', 'When does my visa expire?', 'Next public holiday?'].forEach((c) => {
      const b = document.createElement('button'); b.className = 'chip'; b.type = 'button'; b.textContent = c; b.onclick = () => ask(c); $('#chatChips').appendChild(b);
    });
    $('#chatForm').onsubmit = (e) => { e.preventDefault(); const q = $('#chatIn').value.trim(); if (!q) return; $('#chatIn').value = ''; ask(q); };
    draw();
    if (pendingQuestion) { const q = pendingQuestion; pendingQuestion = ''; ask(q); }
  },

  async etag() {
    const tg = await api('/me/tag');
    const { default: qrcode } = await import('./vendor/qrcode.mjs');
    const q = qrcode(0, 'M'); q.addData(tg.token); q.make();
    V(`<div class="eyebrow">DIGITAL EMPLOYEE TAG</div><h1>My <em>ID tag</em></h1>
    <p class="sub">Show this tag at a site kiosk or to your supervisor. The code is signed for your company, so it can't be copied to another person's record.</p>
    <div class="idcard">
      <div class="idcard-top"><span class="mark">W</span><div><b>${esc(tg.establishment || '')}</b><small>EMPLOYEE TAG · بطاقة الموظف</small></div></div>
      <div class="idcard-body">
        <div class="idcard-av">${esc(ini(tg.fullName))}</div>
        <div style="min-width:0"><div class="idcard-name">${esc(tg.fullName)}</div>${tg.fullNameAr ? `<div dir="rtl" style="color:var(--soft)">${esc(tg.fullNameAr)}</div>` : ''}
          <div style="color:var(--muted);font-size:14px;margin-top:4px">${esc(tg.jobTitle || '')} · ${esc(tg.department || '')}</div></div></div>
      <div class="idcard-qr">${q.createSvgTag({ cellSize: 5, margin: 2, scalable: true, alt: 'Employee tag QR code' })}</div>
      <div class="idcard-foot"><div><span class="lbl">Employee no.</span><b class="num">${esc(tg.employeeNo)}</b></div><div><span class="lbl">Joined</span><b class="num">${fmtDate(tg.joinDate)}</b></div><div><span class="lbl">Nationality</span><b>${esc(tg.nationality || '')}</b></div></div>
      <div class="powered" style="padding:10px 0 0;border:0"><span>POWERED BY</span><img src="devx-logo-dark.png" alt="DevX Technologies"></div>
    </div>`);
  },

  // ---------- HR: live attendance monitor ----------
  async attendance() {
    const date = localStorage.getItem('wasl_attdate') || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
    const estQ = currentEst()?._id ? `&establishmentId=${currentEst()._id}` : '';
    const d = await api(`/attendance?date=${date}${estQ}`);
    const c = d.counts;
    const stateP = { in: pill('p-ok', 'On shift'), out: pill('p-n', 'Clocked out'), leave: pill('p-g', 'On leave'), absent: pill('p-bad', 'Not in') };
    V(`<div class="eyebrow">LIVE ATTENDANCE · ${esc(currentEst()?.name || '')}</div><h1>Who's <em>in</em> today</h1>
    <p class="sub">Every clock-in carries a selfie and GPS position. Review anything outside the site or without location.</p>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px"><label class="lbl" for="attDate">Date</label><input id="attDate" type="date" value="${esc(date)}" class="btn" style="padding:7px 10px"></div>
    <div class="grid g4">
      <div class="panel stat"><div class="v">${c.in + c.out}<span style="font-size:24px;color:var(--muted)"> / ${c.total}</span></div><span class="lbl">Clocked in</span><div class="meter" style="margin-top:10px"><i style="width:${c.total ? ((c.in + c.out) / c.total) * 100 : 0}%"></i></div></div>
      <div class="panel stat"><div class="v warn">${c.late}</div><span class="lbl">Late arrivals</span></div>
      <div class="panel stat"><div class="v ${c.outside ? 'bad' : ''}">${c.outside}</div><span class="lbl">Outside the site</span></div>
      <div class="panel stat"><div class="v">${c.leave}</div><span class="lbl">On approved leave</span><div class="d">${c.absent} not in yet</div></div>
    </div>
    <div class="panel tw" style="margin-top:16px"><table><thead><tr><th>Employee</th><th>Status</th><th>In</th><th>Out</th><th>Location</th><th>Flags</th><th></th></tr></thead><tbody>
    ${d.rows.map((x) => { const a = x.record; return `<tr><td><div style="display:flex;gap:10px;align-items:center"><span class="av">${esc(ini(x.employee.fullName))}</span><div>${esc(x.employee.fullName)}<div style="font-size:12px;color:var(--muted)">${esc(x.employee.department || '')} · ${esc(x.employee.employeeNo)}</div></div></div></td>
      <td>${stateP[x.state]}${x.leaveType ? ` <span style="font-size:12px;color:var(--muted)">${esc(x.leaveType)}</span>` : ''}</td><td class="num">${fmtTime(a?.clockIn?.at)}</td><td class="num">${fmtTime(a?.clockOut?.at)}</td>
      <td style="font-size:13px">${a?.clockIn?.lat != null ? `<a href="https://www.google.com/maps?q=${a.clockIn.lat},${a.clockIn.lng}" target="_blank" rel="noopener">${a.clockIn.insideGeofence ? 'On site' : distLabel(a.clockIn.distanceM) + ' away'}</a>` : a ? '<span style="color:var(--bad)">No GPS</span>' : ''}</td>
      <td>${a ? flagPills(a.flags) : ''}</td>
      <td style="white-space:nowrap">${a?.hasPhoto ? `<button class="btn sm" data-ph="${a._id}">Photo</button> ` : ''}${a && a.flags.some((f) => ['OUTSIDE_GEOFENCE', 'NO_GPS', 'LOW_GPS_ACCURACY'].includes(f.code)) && has('hr_admin', 'manager') ? `<button class="btn sm" data-ok="${a._id}">Approve</button>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div><div id="phView"></div>`);
    $('#attDate').onchange = () => { localStorage.setItem('wasl_attdate', $('#attDate').value); views.attendance().catch(fail); };
    document.querySelectorAll('[data-ph]').forEach((b) => (b.onclick = async () => { try { const r = await api(`/attendance/${b.dataset.ph}/photo`); $('#phView').innerHTML = `<div class="panel" style="margin-top:16px;max-width:360px"><h2>Clock-in photo</h2><img src="${r.photo}" alt="Clock-in photo" style="width:100%;border-radius:4px"></div>`; $('#phView').scrollIntoView({ behavior: 'smooth' }); } catch (e) { fail(e); } }));
    document.querySelectorAll('[data-ok]').forEach((b) => (b.onclick = async () => {
      const row = b.closest('td'); row.innerHTML = `<form style="display:flex;gap:6px"><input placeholder="Reason, e.g. delivery run" style="min-width:0;width:170px;font:inherit;padding:4px 6px;border:1px solid var(--line-2);border-radius:4px;background:var(--surface-2);color:var(--ink)" required minlength="3"><button class="btn sm pri">Save</button></form>`;
      row.querySelector('form').onsubmit = async (e) => { e.preventDefault(); try { await api(`/attendance/${b.dataset.ok}`, { method: 'PATCH', body: { note: row.querySelector('input').value, approveException: true } }); toast('Exception approved'); views.attendance().catch(fail); } catch (err) { fail(err); } };
    }));
  },
});

// Employee section pages reuse the self-service tabs, without the tab strip, under their own heading.
function empStrip(title, sub) {
  const tabs = document.querySelector('#view .tabs'); if (tabs) tabs.remove();
  const h1 = document.querySelector('#view h1'); if (h1) h1.innerHTML = `${esc(title.split(' ')[0])} <em>${esc(title.split(' ').slice(1).join(' ') || '')}</em>`;
  const eb = document.querySelector('#view .eyebrow'); if (eb) eb.insertAdjacentHTML('afterend', '');
  if (h1 && !document.querySelector('#view .sub')) h1.insertAdjacentHTML('afterend', `<p class="sub">${esc(sub)}</p>`);
  translateTree($('#view'), L);
}

window.addEventListener('hashchange', () => { const m = location.hash.slice(1); if (token && mods().includes(m) && m !== cur) { cur = m; shell(); } });
startBackground();
token ? shell() : loginView();
