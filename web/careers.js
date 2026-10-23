// Public careers page: /careers.html#<tenantId>
import { applyTheme } from './ext.js';
applyTheme();
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tenant = location.hash.slice(1).split('/')[0];
const toB64 = (f) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = bad; r.readAsDataURL(f); });

async function render() {
  let d;
  try { const r = await fetch(`/api/public/careers/${encodeURIComponent(tenant)}`); d = await r.json(); if (!r.ok) throw new Error(d.error || 'Not found'); } catch (e) { $('#app').innerHTML = `<div class="pcard"><h1>Careers</h1><p class="pmuted">${esc(e.message)}</p></div>`; return; }
  document.title = `Careers · ${d.company}`;
  $('#app').innerHTML = `<div class="pbrand"><span class="mark">W</span><b>Careers at ${esc(d.company)}</b></div>
  <div class="pcard">${d.jobs.length ? d.jobs.map((j) => `<div class="job"><h2 style="margin:0">${esc(j.title)}</h2><p class="pmuted">${[j.department, j.location, j.employmentType].filter(Boolean).map(esc).join(' · ')}</p>${j.description ? `<p style="white-space:pre-line">${esc(j.description)}</p>` : ''}${(j.requirements || []).map((x) => `<span class="tag">${esc(x)}</span>`).join('')}<div style="margin-top:12px"><button class="pbtn" data-apply="${j._id}" data-title="${esc(j.title)}">Apply</button></div></div>`).join('') : '<p class="pmuted">There are no open positions right now. Please check back later.</p>'}</div><div id="form"></div>`;
  document.querySelectorAll('[data-apply]').forEach((b) => (b.onclick = () => form(b.dataset.apply, b.dataset.title)));
}
function form(id, title) {
  $('#form').innerHTML = `<div class="pcard"><h2>Apply · ${esc(title)}</h2><form id="af">
    <div class="pfield"><label for="n">Full name</label><input id="n" required autocomplete="name"></div>
    <div class="pfield"><label for="e">Email</label><input id="e" type="email" required autocomplete="email"></div>
    <div class="pfield"><label for="p">Mobile</label><input id="p" type="tel" autocomplete="tel"></div>
    <div class="pfield"><label for="v">Current UAE status</label><select id="v"><option value="outside_uae">Outside the UAE</option><option value="visit_visa">In the UAE on a visit visa</option><option value="residence_on_notice">UAE residence visa (serving notice)</option><option value="golden_visa">Golden visa</option><option value="uae_national">UAE National</option><option value="other">Other</option></select></div>
    <div class="pfield"><label for="cv">CV (PDF, up to 5 MB)</label><input id="cv" type="file" accept="application/pdf"></div>
    <div class="pfield"><label for="t">Or paste your CV</label><textarea id="t" rows="5"></textarea></div>
    <input id="w" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
    <label class="prow" style="margin-bottom:12px"><input type="checkbox" id="c" required> <span>I agree that my data is used to assess my application and kept for up to 12 months.</span></label>
    <div class="perr" id="er"></div><button class="pbtn" id="sb">Send application</button></form></div>`;
  $('#form').scrollIntoView({ behavior: 'smooth' });
  $('#af').onsubmit = async (e) => {
    e.preventDefault(); $('#er').textContent = ''; $('#sb').disabled = true;
    try {
      const f = $('#cv').files[0]; if (f && f.size > 5 * 1048576) throw new Error('The CV is larger than 5 MB.');
      const body = { name: $('#n').value, email: $('#e').value, phone: $('#p').value || undefined, visaStatus: $('#v').value, cvText: $('#t').value || undefined, consent: $('#c').checked, ...(f ? { file: await toB64(f), contentType: f.type, fileName: f.name } : {}), ...($('#w').value ? { website: $('#w').value } : {}) };
      const r = await fetch(`/api/public/careers/${encodeURIComponent(tenant)}/${id}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Could not send');
      $('#form').innerHTML = `<div class="pcard"><p class="pok">✓ ${esc(j.message)}</p></div>`;
    } catch (err) { $('#er').textContent = err.message; $('#sb').disabled = false; }
  };
}
render();
