// UAE IBAN: "AE" + 2 check digits + 3-digit bank code + 16-digit account = 23 chars.

const mod97 = (numeric) => {
  let r = 0;
  for (const ch of numeric) r = (r * 10 + Number(ch)) % 97;
  return r;
};

const letters = (s) => s.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));

export function isValidUaeIban(iban) {
  if (typeof iban !== 'string') return false;
  const v = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^AE\d{21}$/.test(v)) return false;
  return mod97(letters(v.slice(4) + v.slice(0, 4))) === 1;
}

export function buildUaeIban(bankCode3, account16) {
  const bban = String(bankCode3).padStart(3, '0') + String(account16).padStart(16, '0');
  const check = 98 - mod97(letters(bban + 'AE00'));
  return 'AE' + String(check).padStart(2, '0') + bban;
}

export const maskIban = (iban) => (iban ? `AE•• •••• ${iban.slice(-4)}` : '');
