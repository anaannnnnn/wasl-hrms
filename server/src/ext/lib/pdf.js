// Dependency-free PDF writer with an embedded TrueType font (DejaVu Sans subset, see assets/fonts/DejaVu-LICENSE.txt),
// Arabic shaping (presentation forms + lam-alef ligatures) and simple right-to-left runs, so payslips, letters and
// offers come out as real bilingual PDF files. Also draws QR codes for seal verification.
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import qrcode from '../../../../web/vendor/qrcode.mjs';

const FONT_PATH = fileURLToPath(new URL('../../../assets/fonts/DejaVuSans-subset.ttf', import.meta.url));

// ---------------------------------------------------------------- TrueType parsing (cmap format 4, hmtx, head, hhea)
function parseTtf(buf) {
  const numTables = buf.readUInt16BE(4); const tables = {};
  for (let i = 0; i < numTables; i++) { const o = 12 + i * 16; tables[buf.toString('latin1', o, o + 4)] = { offset: buf.readUInt32BE(o + 8), length: buf.readUInt32BE(o + 12) }; }
  const head = tables.head.offset; const unitsPerEm = buf.readUInt16BE(head + 18);
  const bbox = [buf.readInt16BE(head + 36), buf.readInt16BE(head + 38), buf.readInt16BE(head + 40), buf.readInt16BE(head + 42)];
  const hhea = tables.hhea.offset; const ascent = buf.readInt16BE(hhea + 4); const descent = buf.readInt16BE(hhea + 6); const nHM = buf.readUInt16BE(hhea + 34);
  const hmtx = tables.hmtx.offset; const numGlyphs = buf.readUInt16BE(tables.maxp.offset + 4);
  const adv = new Uint16Array(numGlyphs);
  for (let g = 0; g < numGlyphs; g++) adv[g] = buf.readUInt16BE(hmtx + Math.min(g, nHM - 1) * 4);
  // cmap: prefer (3,1) format 4
  const cmap = tables.cmap.offset; const n = buf.readUInt16BE(cmap + 2); let sub = null;
  for (let i = 0; i < n; i++) { const p = buf.readUInt16BE(cmap + 4 + i * 8), e = buf.readUInt16BE(cmap + 6 + i * 8), off = buf.readUInt32BE(cmap + 8 + i * 8); if (p === 3 && e === 1) sub = cmap + off; }
  if (!sub || buf.readUInt16BE(sub) !== 4) throw new Error('Font needs a format-4 Unicode cmap');
  const segX2 = buf.readUInt16BE(sub + 6); const ends = sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
  const map = new Map();
  for (let s = 0; s < segX2 / 2; s++) {
    const end = buf.readUInt16BE(ends + s * 2), start = buf.readUInt16BE(starts + s * 2), delta = buf.readInt16BE(deltas + s * 2), ro = buf.readUInt16BE(ranges + s * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let g;
      if (ro === 0) g = (c + delta) & 0xffff;
      else { const addr = ranges + s * 2 + ro + (c - start) * 2; g = buf.readUInt16BE(addr); if (g) g = (g + delta) & 0xffff; }
      if (g) map.set(c, g);
    }
  }
  return { unitsPerEm, bbox, ascent, descent, adv, map };
}

let FONT; const font = () => (FONT ||= { bytes: readFileSync(FONT_PATH), ...parseTtf(readFileSync(FONT_PATH)) });

// ---------------------------------------------------------------- Arabic shaping
// [isolated, final, initial, medial]; two entries = joins to the right only
const FORMS = {
  0x0621: [0xFE80], 0x0622: [0xFE81, 0xFE82], 0x0623: [0xFE83, 0xFE84], 0x0624: [0xFE85, 0xFE86], 0x0625: [0xFE87, 0xFE88],
  0x0626: [0xFE89, 0xFE8A, 0xFE8B, 0xFE8C], 0x0627: [0xFE8D, 0xFE8E], 0x0628: [0xFE8F, 0xFE90, 0xFE91, 0xFE92], 0x0629: [0xFE93, 0xFE94],
  0x062A: [0xFE95, 0xFE96, 0xFE97, 0xFE98], 0x062B: [0xFE99, 0xFE9A, 0xFE9B, 0xFE9C], 0x062C: [0xFE9D, 0xFE9E, 0xFE9F, 0xFEA0],
  0x062D: [0xFEA1, 0xFEA2, 0xFEA3, 0xFEA4], 0x062E: [0xFEA5, 0xFEA6, 0xFEA7, 0xFEA8], 0x062F: [0xFEA9, 0xFEAA], 0x0630: [0xFEAB, 0xFEAC],
  0x0631: [0xFEAD, 0xFEAE], 0x0632: [0xFEAF, 0xFEB0], 0x0633: [0xFEB1, 0xFEB2, 0xFEB3, 0xFEB4], 0x0634: [0xFEB5, 0xFEB6, 0xFEB7, 0xFEB8],
  0x0635: [0xFEB9, 0xFEBA, 0xFEBB, 0xFEBC], 0x0636: [0xFEBD, 0xFEBE, 0xFEBF, 0xFEC0], 0x0637: [0xFEC1, 0xFEC2, 0xFEC3, 0xFEC4],
  0x0638: [0xFEC5, 0xFEC6, 0xFEC7, 0xFEC8], 0x0639: [0xFEC9, 0xFECA, 0xFECB, 0xFECC], 0x063A: [0xFECD, 0xFECE, 0xFECF, 0xFED0],
  0x0641: [0xFED1, 0xFED2, 0xFED3, 0xFED4], 0x0642: [0xFED5, 0xFED6, 0xFED7, 0xFED8], 0x0643: [0xFED9, 0xFEDA, 0xFEDB, 0xFEDC],
  0x0644: [0xFEDD, 0xFEDE, 0xFEDF, 0xFEE0], 0x0645: [0xFEE1, 0xFEE2, 0xFEE3, 0xFEE4], 0x0646: [0xFEE5, 0xFEE6, 0xFEE7, 0xFEE8],
  0x0647: [0xFEE9, 0xFEEA, 0xFEEB, 0xFEEC], 0x0648: [0xFEED, 0xFEEE], 0x0649: [0xFEEF, 0xFEF0], 0x064A: [0xFEF1, 0xFEF2, 0xFEF3, 0xFEF4],
  0x0640: [0x0640, 0x0640, 0x0640, 0x0640],
};
const LAM_ALEF = { 0x0622: [0xFEF5, 0xFEF6], 0x0623: [0xFEF7, 0xFEF8], 0x0625: [0xFEF9, 0xFEFA], 0x0627: [0xFEFB, 0xFEFC] };
const isHaraka = (c) => (c >= 0x064B && c <= 0x065F) || c === 0x0670;
const isArabic = (c) => (c >= 0x0600 && c <= 0x06FF) || (c >= 0xFB50 && c <= 0xFDFF) || (c >= 0xFE70 && c <= 0xFEFF);
const joinsLeft = (c) => FORMS[c]?.length === 4;
const joinsRight = (c) => !!FORMS[c] && FORMS[c].length >= 2;

/** Shape a logical-order Arabic string into presentation forms (still logical order). */
export function shapeArabic(str) {
  const cps = [...str].map((ch) => ch.codePointAt(0)).filter((c) => !isHaraka(c));
  const out = [];
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    if (!FORMS[c]) { out.push(c); continue; }
    const prev = cps[i - 1]; const prevJoins = prev !== undefined && joinsLeft(prev);
    if (c === 0x0644 && LAM_ALEF[cps[i + 1]]) { out.push(LAM_ALEF[cps[i + 1]][prevJoins ? 1 : 0]); i++; continue; }
    const next = cps[i + 1]; const nextJoins = next !== undefined && joinsRight(next);
    const f = FORMS[c];
    let form;
    if (f.length === 1) form = f[0];
    else if (f.length === 2) form = prevJoins ? f[1] : f[0];
    else form = prevJoins && nextJoins ? f[3] : prevJoins ? f[1] : nextJoins ? f[2] : f[0];
    out.push(form);
  }
  return String.fromCodePoint(...out);
}

/** Visual order for a line: Arabic-dominant lines are laid out right-to-left with LTR runs (numbers, Latin) kept intact. */
export function visualOrder(str) {
  const cps = [...str].map((c) => c.codePointAt(0));
  if (!cps.some(isArabic)) return str;
  const shaped = [...shapeArabic(str)];
  // split into runs: 'r' Arabic, 'l' Latin/digits, 'n' neutral (space, punctuation)
  const kind = (ch) => { const c = ch.codePointAt(0); return isArabic(c) ? 'r' : /[A-Za-z0-9À-ɏ.,:/%@+-]/.test(ch) ? 'l' : 'n'; };
  const runs = [];
  for (const ch of shaped) { const k = kind(ch); const last = runs[runs.length - 1]; if (last && last.k === k) last.s += ch; else runs.push({ k, s: ch }); }
  // neutrals between two LTR runs become LTR (e.g. "AED 1,000.00")
  for (let i = 1; i < runs.length - 1; i++) if (runs[i].k === 'n' && runs[i - 1].k === 'l' && runs[i + 1].k === 'l') runs[i].k = 'l';
  const merged = []; for (const r of runs) { const last = merged[merged.length - 1]; if (last && last.k === r.k) last.s += r.s; else merged.push({ ...r }); }
  return merged.reverse().map((r) => (r.k === 'l' ? r.s : [...r.s].reverse().join('').replace(/[()[\]{}]/g, (b) => ({ '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{' }[b])))).join('');
}

// ---------------------------------------------------------------- Document
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const num = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (hex) => { const h = hex.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map(num).join(' '); };

export class PdfDoc {
  constructor({ title = 'Document', author = 'Wasl HRMS', size = [595.28, 841.89] } = {}) {
    this.size = size; this.pages = []; this.title = title; this.author = author; this.used = new Map(); // gid -> unicode
    this.page();
  }
  get W() { return this.size[0]; }
  get H() { return this.size[1]; }
  page() { this.cur = []; this.pages.push(this.cur); return this; }
  /** Width in points of a (visual-order) string. */
  width(str, size = 10) {
    const f = font(); let w = 0;
    for (const ch of visualOrder(String(str))) { const g = f.map.get(ch.codePointAt(0)) || 0; w += f.adv[g]; }
    return (w / f.unitsPerEm) * size;
  }
  _hex(str) {
    const f = font(); let hex = '';
    for (const ch of visualOrder(String(str))) { const cp = ch.codePointAt(0); const g = f.map.get(cp) || 0; this.used.set(g, cp); hex += g.toString(16).padStart(4, '0'); }
    return hex;
  }
  /** y is measured from the TOP of the page. align: left | right | center. */
  text(x, y, str, { size = 10, bold = false, color = '#111111', align = 'left', maxWidth } = {}) {
    let s = String(str ?? '');
    if (maxWidth) while (s.length > 1 && this.width(s, size) > maxWidth) s = s.slice(0, -2) + '…';
    const w = this.width(s, size); const px = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.cur.push(`BT ${rgb(color)} rg ${bold ? `${rgb(color)} RG 0.35 w 2 Tr` : '0 Tr'} /F1 ${num(size)} Tf ${num(px)} ${num(this.H - y)} Td <${this._hex(s)}> Tj ET`);
    return w;
  }
  /** Wrap text into lines that fit maxWidth; returns the y after the paragraph. */
  paragraph(x, y, str, { size = 10, maxWidth = 480, lineGap = 4, align = 'left', ...o } = {}) {
    const words = String(str ?? '').split(/\s+/); let line = ''; const lines = [];
    for (const w of words) { const t = line ? `${line} ${w}` : w; if (this.width(t, size) > maxWidth && line) { lines.push(line); line = w; } else line = t; }
    if (line) lines.push(line);
    for (const l of lines) { this.text(align === 'right' ? x + maxWidth : x, y, l, { size, align, ...o }); y += size + lineGap; }
    return y;
  }
  line(x1, y1, x2, y2, { color = '#d0d5d3', width = 0.6 } = {}) { this.cur.push(`${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(this.H - y1)} m ${num(x2)} ${num(this.H - y2)} l S`); return this; }
  rect(x, y, w, h, { fill, stroke, width = 0.6 } = {}) {
    const op = fill && stroke ? 'B' : fill ? 'f' : 'S';
    this.cur.push(`${fill ? `${rgb(fill)} rg ` : ''}${stroke ? `${rgb(stroke)} RG ${num(width)} w ` : ''}${num(x)} ${num(this.H - y - h)} ${num(w)} ${num(h)} re ${op}`); return this;
  }
  circle(cx, cy, r, { stroke = '#1f6f5c', width = 1.2, fill } = {}) {
    const k = 0.5523 * r; const Y = this.H - cy;
    const p = `${num(cx + r)} ${num(Y)} m ${num(cx + r)} ${num(Y + k)} ${num(cx + k)} ${num(Y + r)} ${num(cx)} ${num(Y + r)} c ${num(cx - k)} ${num(Y + r)} ${num(cx - r)} ${num(Y + k)} ${num(cx - r)} ${num(Y)} c ${num(cx - r)} ${num(Y - k)} ${num(cx - k)} ${num(Y - r)} ${num(cx)} ${num(Y - r)} c ${num(cx + k)} ${num(Y - r)} ${num(cx + r)} ${num(Y - k)} ${num(cx + r)} ${num(Y)} c`;
    this.cur.push(`${fill ? `${rgb(fill)} rg ` : ''}${rgb(stroke)} RG ${num(width)} w ${p} ${fill ? 'B' : 'S'}`); return this;
  }
  qr(x, y, text, sizePt = 72) {
    const q = qrcode(0, 'M'); q.addData(text); q.make(); const n = q.getModuleCount(); const m = sizePt / n; const ops = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) ops.push(`${num(x + c * m)} ${num(this.H - y - (r + 1) * m)} ${num(m + 0.02)} ${num(m + 0.02)} re`);
    this.cur.push(`0 0 0 rg ${ops.join(' ')} f`); return this;
  }
  /** Round official-style seal (drawn, not an image). */
  seal(cx, cy, top, bottom, { color = '#1f6f5c' } = {}) {
    this.circle(cx, cy, 46, { stroke: color, width: 1.6 }); this.circle(cx, cy, 39, { stroke: color, width: 0.6 });
    this.text(cx, cy - 4, top, { size: 6.5, align: "center", color, bold: true, maxWidth: 74 });
    this.text(cx, cy + 6, bottom, { size: 6.5, align: "center", color, maxWidth: 74 });
    return this;
  }

  toBuffer() {
    const f = font(); const objs = []; const add = (s) => { objs.push(s); return objs.length; };
    const fontStream = deflateSync(f.bytes);
    const fontFile = add(Buffer.concat([Buffer.from(`<< /Length ${fontStream.length} /Length1 ${f.bytes.length} /Filter /FlateDecode >>\nstream\n`), fontStream, Buffer.from('\nendstream')]));
    const s = 1000 / f.unitsPerEm;
    const desc = add(`<< /Type /FontDescriptor /FontName /AAAAAA+DejaVuSans /Flags 32 /FontBBox [${f.bbox.map((v) => Math.round(v * s)).join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(f.ascent * s)} /Descent ${Math.round(f.descent * s)} /CapHeight ${Math.round(f.ascent * s * 0.7)} /StemV 80 /FontFile2 ${fontFile} 0 R >>`);
    const gids = [...this.used.keys()].sort((a, b) => a - b);
    const W = gids.map((g) => `${g} [${Math.round(f.adv[g] * s)}]`).join(' ');
    const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+DejaVuSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /W [${W}] /CIDToGIDMap /Identity /DW 600 >>`);
    const hex4 = (n) => n.toString(16).padStart(4, '0');
    const bf = gids.map((g) => `<${hex4(g)}> <${this.used.get(g) > 0xffff ? '' : hex4(this.used.get(g))}>`).filter((x) => !x.endsWith('<>'));
    const cmapBody = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n${chunk(bf, 100).map((c) => `${c.length} beginbfchar\n${c.join('\n')}\nendbfchar`).join('\n')}\nendcmap CMapName currentdict /CMap defineresource pop end end`;
    const toUni = add(`<< /Length ${Buffer.byteLength(cmapBody)} >>\nstream\n${cmapBody}\nendstream`);
    const type0 = add(`<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+DejaVuSans /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUni} 0 R >>`);
    const pagesId = objs.length + 1 + this.pages.length * 2; const kids = [];
    for (const ops of this.pages) {
      const content = deflateSync(Buffer.from(ops.join('\n'), 'latin1'));
      const c = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`), content, Buffer.from('\nendstream')]));
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(this.W)} ${num(this.H)}] /Resources << /Font << /F1 ${type0} 0 R >> >> /Contents ${c} 0 R >>`));
    }
    const pages = add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
    if (pages !== pagesId) throw new Error('PDF object numbering error');
    const pdfDate = `D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
    const info = add(`<< /Title (${esc(this.title.replace(/[^\x20-\x7e]/g, ''))}) /Author (${esc(this.author)}) /Producer (Wasl HRMS) /CreationDate (${pdfDate}) >>`);
    const catalog = add(`<< /Type /Catalog /Pages ${pages} 0 R /Lang (en-AE) >>`);
    const parts = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')]; const offsets = []; let pos = parts[0].length;
    objs.forEach((o, i) => { const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'), Buffer.from('\nendobj\n')]); offsets.push(pos); pos += b.length; parts.push(b); });
    const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
    parts.push(Buffer.from(xref));
    return Buffer.concat(parts);
  }
}
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
