// All money is stored and computed as integer fils (1 AED = 100 fils).
// Never use binary floating point for payroll totals.

export const toFils = (aed) => {
  if (typeof aed === 'number') aed = aed.toFixed(2);
  const s = String(aed).replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Invalid AED amount: ${aed}`);
  const neg = s.startsWith('-');
  const [i, d = ''] = s.replace('-', '').split('.');
  const f = Number(i) * 100 + Number((d + '00').slice(0, 2));
  return neg ? -f : f;
};

// "1234.50" style, no thousands separator (for files)
export const filsToPlain = (f) => {
  const neg = f < 0; f = Math.abs(f);
  return `${neg ? '-' : ''}${Math.floor(f / 100)}.${String(f % 100).padStart(2, '0')}`;
};

export const filsToDisplay = (f) =>
  (f / 100).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Round half up on an intermediate (possibly fractional) fils value
export const roundFils = (x) => Math.round(x);

export const sumFils = (arr) => arr.reduce((a, b) => a + b, 0);
