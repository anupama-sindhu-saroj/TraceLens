// Redactor: masks secrets BEFORE rows are queued, so they never reach DuckDB or the live tail.
//
//   const { createRedactor } = require('./redactor');
//   const r = createRedactor({ keys: ['password', 'token'] });
//   rows = r.redact('logs', rows);          // returns new rows only where something changed; never mutates input
//   r.stats()                               // { redactedRows, redactedValues }
//
// Config (env): REDACT_KEYS = comma list, REDACT_KEYS=off disables it. Default list below.
// A key matches when its words contain the listed words in order, so "api_key", "apiKey" and "x.api.key" all match
// "api_key", but "cart.id" does NOT match "card" and "llm.tokens" does not match "token".
const MASK = '***';
const DEFAULT_KEYS = [
  'password', 'passwd', 'secret', 'token', 'authorization', 'api_key', 'apikey', 'cookie', 'set-cookie',
  'credit_card', 'card_number', 'cvv', 'ssn', 'private_key', 'access_key',
];

const words = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function containsRun(hay, needle) {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((w, j) => hay[i + j] === w)) return true;
  }
  return false;
}

// 13-19 digits, optionally grouped with spaces or dashes; kept only if it passes the Luhn check (so order ids survive).
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

function luhn(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function createRedactor({ keys, enabled } = {}) {
  const envKeys = process.env.REDACT_KEYS;
  const off = enabled === false || (enabled === undefined && String(envKeys ?? '').toLowerCase() === 'off');
  const list = keys ?? (envKeys && envKeys.toLowerCase() !== 'off' ? envKeys.split(',') : DEFAULT_KEYS);
  const wanted = list.map((k) => words(k.trim())).filter((w) => w.length);
  const counters = { redactedRows: 0, redactedValues: 0 };
  const sensitive = (key) => { const w = words(key); return wanted.some((n) => containsRun(w, n)); };

  // "password=abc123", "token: abc" inside a message; the value runs to the next space, comma or quote.
  const kvRes = wanted.map((n) => ({
    n,
    re: new RegExp(`\\b(${n.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[._\\- ]?')})(["']?\\s*[=:]\\s*["']?)([^\\s,;"'&]+)`, 'gi'),
  }));

  function maskText(text) {
    if (typeof text !== 'string' || text.length === 0) return { text, n: 0 };
    let n = 0;
    let out = text.replace(BEARER_RE, () => { n++; return `Bearer ${MASK}`; });
    out = out.replace(CARD_RE, (m) => {
      const digits = m.replace(/[ -]/g, '');
      if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return m;
      n++;
      return MASK;
    });
    for (const { re } of kvRes) out = out.replace(re, (_m, k, sep) => { n++; return `${k}${sep}${MASK}`; });
    return { text: out, n };
  }

  function maskValue(v) {
    if (typeof v === 'string') return maskText(v);
    return { text: v, n: 0 };
  }

  // Returns { value, n } with n = number of masked values; value is the same object when nothing changed.
  function maskAttrs(attrs) {
    if (attrs === null || attrs === undefined) return { value: attrs, n: 0 };
    let obj = attrs;
    const wasString = typeof attrs === 'string';
    if (wasString) { try { obj = JSON.parse(attrs); } catch { return { value: attrs, n: 0 }; } }
    if (obj === null || typeof obj !== 'object') return { value: attrs, n: 0 };
    let n = 0;
    const walk = (o) => {
      if (Array.isArray(o)) {
        let changed = false;
        const next = o.map((x) => {
          if (x && typeof x === 'object') { const y = walk(x); if (y !== x) changed = true; return y; }
          const m = maskValue(x); if (m.n) { n += m.n; changed = true; return m.text; }
          return x;
        });
        return changed ? next : o;
      }
      let changed = false;
      const next = {};
      for (const [k, x] of Object.entries(o)) {
        if (sensitive(k) && x !== null && x !== undefined && x !== '') { next[k] = MASK; n++; changed = true; continue; }
        if (x && typeof x === 'object') { const y = walk(x); if (y !== x) changed = true; next[k] = y; continue; }
        const m = maskValue(x);
        if (m.n) { n += m.n; changed = true; next[k] = m.text; } else next[k] = x;
      }
      return changed ? next : o;
    };
    const res = walk(obj);
    if (res === obj) return { value: attrs, n: 0 };
    return { value: wasString ? JSON.stringify(res) : res, n };
  }

  function redactRow(table, row) {
    let n = 0;
    let out = row;
    const a = maskAttrs(row.attributes);
    if (a.n) { out = { ...out, attributes: a.value }; n += a.n; }
    if (table === 'logs') {
      const m = maskText(row.message);
      if (m.n) { out = { ...out, message: m.text }; n += m.n; }
    }
    if (n) { counters.redactedRows++; counters.redactedValues += n; }
    return out;
  }

  function redact(table, rows) {
    if (off || !rows || rows.length === 0) return rows;
    let changed = false;
    const out = rows.map((r) => { const x = redactRow(table, r); if (x !== r) changed = true; return x; });
    return changed ? out : rows;
  }

  return { redact, stats: () => ({ enabled: !off, ...counters }), isSensitiveKey: sensitive, MASK };
}

module.exports = { createRedactor, DEFAULT_KEYS, MASK };
