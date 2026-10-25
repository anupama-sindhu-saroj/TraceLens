// Query box syntax for the Logs Explorer (owner: B). The text box is the single source of truth for filters.
//
//   service:payment  level:ERROR  level:WARN,ERROR  trace:<id>  span:<id>     built-in fields (aliases: svc, severity)
//   user.id:user-38          tag equals          -user.id:user-38      tag does NOT equal (or is missing)
//   order.id:/^o-1[0-9]+$/   tag matches a regex  sku:*                 tag exists
//   "card declined"  timeout                    free text: searched in the message and in the attributes
//   /card (declined|refused)/                   a /regex/ in the free text: regular expression search (RE2 syntax)
//
// The ".*" button next to the box does the same for ALL the free text (no slashes needed). Values with spaces go in quotes.
export const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
export const LEVEL_COLORS = { DEBUG: '#64748b', INFO: '#4f8cff', WARN: '#f59e0b', ERROR: '#ef4444' };
export const SEVERITY_PRESETS = [
  ['', 'Any severity'],
  ['ERROR', 'Error'],
  ['WARN,ERROR', 'Warning and above'],
  ['INFO,WARN,ERROR', 'Info and above'],
  ['DEBUG', 'Debug'],
];

const KEY_ALIASES = { service: 'service', svc: 'service', level: 'level', severity: 'level', trace: 'traceId', span: 'spanId' };
const CANONICAL = { service: 'service', level: 'level', traceId: 'trace', spanId: 'span' }; // field -> key written back to the box
export const BUILT_IN_KEYS = ['service', 'level', 'trace', 'span'];
const KEY_RE = /^-?[A-Za-z_][\w.-]*$/;

// Split into tokens on whitespace, keeping "quoted phrases" and /regex literals/ (which may contain spaces) together,
// also after a key: ( user.id:"a b"  order.id:/o- [0-9]+/ ).
export function tokenize(text) {
  const out = [];
  const s = text ?? '';
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i += 1;
    if (i >= n) break;
    const start = i;
    let j = i;
    while (j < n && !/[\s":/]/.test(s[j])) j += 1;
    if (j < n && s[j] === ':' && j > i) i = j + 1; // value starts after the key
    if (s[i] === '"') {
      const e = s.indexOf('"', i + 1);
      i = e < 0 ? n : e + 1;
    } else if (s[i] === '/') {
      let k = i + 1;
      while (k < n && s[k] !== '/') { if (s[k] === '\\') k += 1; k += 1; }
      i = k < n ? k + 1 : i; // no closing slash yet: it is just a word, scanned below
    }
    while (i < n && !/\s/.test(s[i])) i += 1;
    out.push(s.slice(start, i));
  }
  return out;
}

const unquote = (v) => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);
const isRegexLiteral = (v) => v.length >= 3 && v.startsWith('/') && v.endsWith('/');

/**
 * One token -> { raw, kind: 'field' | 'tag' | 'free', ... }
 *   field: { field: 'service'|'level'|'traceId'|'spanId', value }
 *   tag:   { tag: { key, op: 'eq'|'ne'|'re'|'has', value } }
 *   free:  { text, regex }   regex = the token was written as /.../
 */
export function parseToken(raw) {
  const i = raw.indexOf(':');
  const key = i > 0 ? raw.slice(0, i) : '';
  if (key && KEY_RE.test(key)) {
    const val = raw.slice(i + 1);
    const negated = key.startsWith('-');
    const bare = negated ? key.slice(1) : key;
    const field = !negated && KEY_ALIASES[bare.toLowerCase()];
    if (field && val) return { raw, kind: 'field', field, value: unquote(val) };
    if (val) {
      if (val === '*') return { raw, kind: 'tag', tag: { key: bare, op: negated ? 'ne' : 'has', value: '' } };
      if (isRegexLiteral(val)) return { raw, kind: 'tag', tag: { key: bare, op: 're', value: val.slice(1, -1) } };
      return { raw, kind: 'tag', tag: { key: bare, op: negated ? 'ne' : 'eq', value: unquote(val) } };
    }
  }
  if (isRegexLiteral(raw)) return { raw, kind: 'free', text: raw.slice(1, -1), regex: true };
  return { raw, kind: 'free', text: unquote(raw), regex: false };
}

export const parseTokens = (text) => tokenize(text).map(parseToken);

/**
 * Query text -> filters. `regexMode` is the ".*" button: all free text is one regular expression.
 * Returns { service, level, traceId, spanId, q, regex, tags, ignored }. `ignored` lists free words that could not be
 * used (a /regex/ was found, and only one regular expression is searched at a time).
 */
export function parseQuery(text, { regexMode = false } = {}) {
  const f = { service: '', level: '', traceId: '', spanId: '', q: '', regex: false, tags: [], ignored: [] };
  const free = [];
  for (const t of parseTokens(text)) {
    if (t.kind === 'field') f[t.field] = t.value;
    else if (t.kind === 'tag') f.tags.push(t.tag);
    else free.push(t);
  }
  const literal = free.find((t) => t.regex);
  if (literal) {
    f.q = literal.text; f.regex = true;
    f.ignored = free.filter((t) => t !== literal).map((t) => t.raw);
  } else {
    f.q = free.map((t) => t.text).join(' ');
    f.regex = Boolean(regexMode && f.q);
  }
  return f;
}

export const getToken = (text, field) => parseQuery(text)[field];

const fmt = (v) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v);

// Put field:value into the text (replacing any existing one). Empty value removes it.
export function setToken(text, field, value) {
  const kept = tokenize(text).filter((tok) => parseToken(tok).field !== field);
  if (value) kept.push(`${CANONICAL[field]}:${fmt(value)}`);
  return kept.join(' ');
}

// Click on a value: add it, or remove it when it is already the active filter.
export function toggleToken(text, field, value) {
  return getToken(text, field) === value ? setToken(text, field, '') : setToken(text, field, value);
}

export function tagToken({ key, op, value }) {
  if (op === 'has') return `${key}:*`;
  if (op === 're') return `${key}:/${value}/`;
  return `${op === 'ne' ? '-' : ''}${key}:${fmt(value)}`;
}

const sameTag = (a, b) => a.key === b.key && a.op === b.op && a.value === b.value;

// Add a tag filter, or remove it if the same one is already there. Returns the new text.
export function toggleTag(text, tag) {
  const tokens = tokenize(text);
  const at = tokens.findIndex((t) => { const p = parseToken(t); return p.kind === 'tag' && sameTag(p.tag, tag); });
  if (at >= 0) return tokens.filter((_, i) => i !== at).join(' ');
  // "key = a" and "key != a" on the same key and value cancel out
  const opposite = { eq: 'ne', ne: 'eq' }[tag.op];
  const kept = tokens.filter((t) => { const p = parseToken(t); return !(opposite && p.kind === 'tag' && sameTag(p.tag, { ...tag, op: opposite })); });
  return [...kept, tagToken(tag)].join(' ');
}

export const isTagActive = (text, tag) => parseTokens(text).some((t) => t.kind === 'tag' && sameTag(t.tag, tag));

export const removeTokenAt = (text, index) => tokenize(text).filter((_, i) => i !== index).join(' ');

// Filters -> query string for the API. Only the filters the server knows; tags go as a JSON array.
const API_KEYS = ['service', 'level', 'traceId', 'spanId', 'q'];
export function toParams(filters, extra = {}) {
  const p = new URLSearchParams();
  for (const k of API_KEYS) if (filters[k]) p.set(k, String(filters[k]));
  if (filters.regex && filters.q) p.set('regex', '1');
  if (filters.tags?.length) p.set('tags', JSON.stringify(filters.tags));
  for (const [k, v] of Object.entries(extra)) if (v !== '' && v !== null && v !== undefined) p.set(k, String(v));
  return p.toString();
}

// What the live-tail WebSocket gets (same meaning as the query string).
export const toLiveFilter = (f) => ({
  service: f.service, level: f.level, q: f.q, regex: f.regex, tags: f.tags, traceId: f.traceId, spanId: f.spanId,
});

// The word under the caret, for autocomplete: { start, end, text } (text without the leading "-").
export function tokenAt(text, caret) {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  return { start, end, text: text.slice(start, end) };
}
