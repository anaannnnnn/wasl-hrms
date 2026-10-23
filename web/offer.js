// Candidate offer page: /offer.html#<tenantId>/<token> — review, download, upload documents, sign or decline.
import { applyTheme } from './ext.js';
applyTheme();
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AED = (f) => ((f || 0) / 100).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const [tenant, token] = location.hash.slice(1).split('/');
const base = `/api/public/offers/${encodeURIComponent(tenant || '')}/${encodeURIComponent(token || '')}`;
const call = async (path, body) => { const r = await fetch(base + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Error ${r.status}`); return j; };
const toB64 = (f) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = bad; r.readAsDataURL(f); });

async function render() {
  let o;
  try { o = await call(''); } catch (e) { $('#app').innerHTML = `<div class="pcard"><h1>Offer unavailable</h1><p class="pmuted">${esc(e.message)}</p></div>`; return; }
  const total = o.basicFils + o.housingFils + o.transportFils + (o.otherFils || 0);
  const signed = o.status === 'signed'; const closed = ['declined', 'withdrawn', 'expired'].includes(o.status);
  $('#app').innerHTML = `<div class="pbrand"><span class="mark">W</span><b>${esc(o.company)}</b><span class="pmuted" dir="rtl">${esc(o.companyAr || '')}</span></div>
  <div class="pcard"><h1>Offer of employment</h1><p class="pmuted">For ${esc(o.candidateName)} · ${esc(o.jobTitle)} · start ${new Date(o.startDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
    <div class="pgrid"><div><b>AED ${AED(total)}</b><span>Total monthly</span></div><div><b>AED ${AED(o.basicFils)}</b><span>Basic</span></div><div><b>AED ${AED(o.housingFils)}</b><span>Housing</span></div><div><b>AED ${AED(o.transportFils)}</b><span>Transport</span></div><div><b>${o.probationMonths} months</b><span>Probation</span></div><div><b>${o.noticeDays} days</b><span>Notice</span></div></div>
    <p class="pmuted">${esc(o.visaType || '')}${o.expiresAt && !signed ? ` · Valid until ${new Date(o.expiresAt).toLocaleDateString('en-GB')}` : ''}</p>
    <div class="prow"><button class="pbtn ghost" id="pdf">Download offer (PDF)</button></div></div>
  ${signed ? `<div class="pcard"><p class="pok">✓ You signed this offer on ${new Date(o.signedAt).toLocaleString('en-GB')}. HR will contact you about the next steps.</p></div>` : closed ? `<div class="pcard"><p>This offer is ${esc(o.status)}.</p></div>` : `
  <div class="pcard"><h2>Sign</h2><div class="pfield"><label for="nm">Type your full name exactly as on the offer</label><input id="nm" autocomplete="name"></div>
    <div class="pfield"><label>Draw your signature</label><canvas class="sigpad" id="pad" aria-label="Signature pad"></canvas></div>
    <label class="prow" style="margin-bottom:12px"><input type="checkbox" id="ok"> <span>I have read and accept this offer.</span></label>
    <div class="perr" id="err"></div><div class="prow"><button class="pbtn" id="sign">Sign and accept</button><button class="pbtn ghost" id="clr">Clear signature</button><button class="pbtn ghost" id="dec">Decline</button></div></div>`}
  ${closed ? '' : `<div class="pcard"><h2>Your documents</h2><p class="pmuted">Upload your passport, photo and certificates for the visa process (PDF, JPG or PNG, up to 8 MB each).</p>
    <div class="prow"><select id="dk" style="padding:10px;border-radius:10px"><option value="passport">Passport</option><option value="photo">Photo (white background)</option><option value="education_certificate">Education certificate</option><option value="experience_letter">Experience letter</option><option value="emirates_id">Emirates ID</option><option value="visa">Current visa</option><option value="other">Other</option></select><input type="file" id="df" accept="application/pdf,image/jpeg,image/png"><button class="pbtn ghost" id="up">Upload</button></div>
    <ul class="pmuted" id="docs">${o.documents.map((d) => `<li>${esc(d.kind.replace(/_/g, ' '))} · ${esc(d.fileName || '')}</li>`).join('')}</ul><div class="perr" id="derr"></div></div>`}
  <p class="pmuted" style="text-align:center">Secured by Wasl HRMS · your signature, time and IP address are recorded with a fingerprint of the offer.</p>`;
  $('#pdf').onclick = () => window.open(`${base}/pdf`, '_blank');
  const up = $('#up');
  if (up) up.onclick = async () => { const f = $('#df').files[0]; if (!f) return; $('#derr').textContent = ''; try { await call('/documents', { kind: $('#dk').value, file: await toB64(f), contentType: f.type, fileName: f.name }); render(); } catch (e) { $('#derr').textContent = e.message; } };
  if (signed || closed) return;
  const pad = $('#pad'); const ctx = pad.getContext('2d'); let drawing = false, drawn = false;
  const fit = () => { const r = pad.getBoundingClientRect(); pad.width = r.width * devicePixelRatio; pad.height = r.height * devicePixelRatio; ctx.scale(devicePixelRatio, devicePixelRatio); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#111'; };
  fit();
  const pt = (e) => { const r = pad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  pad.onpointerdown = (e) => { drawing = true; pad.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pt(e)); };
  pad.onpointermove = (e) => { if (!drawing) return; ctx.lineTo(...pt(e)); ctx.stroke(); drawn = true; };
  pad.onpointerup = () => (drawing = false);
  $('#clr').onclick = () => { ctx.clearRect(0, 0, pad.width, pad.height); drawn = false; };
  $('#sign').onclick = async () => {
    $('#err').textContent = '';
    if (!$('#ok').checked) return ($('#err').textContent = 'Tick the box to accept the offer.');
    if (!drawn) return ($('#err').textContent = 'Draw your signature.');
    $('#sign').disabled = true;
    try { await call('/sign', { name: $('#nm').value.trim(), accept: true, signature: pad.toDataURL('image/png') }); render(); } catch (e) { $('#err').textContent = e.message; $('#sign').disabled = false; }
  };
  $('#dec').onclick = async () => { const reason = prompt('Optional: tell us why you are declining'); if (reason === null) return; try { await call('/decline', { reason }); render(); } catch (e) { $('#err').textContent = e.message; } };
}
render();
