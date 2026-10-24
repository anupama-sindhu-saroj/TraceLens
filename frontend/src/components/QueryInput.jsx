// The query box with autocomplete (owner: B). Suggests built-in fields (service:, level:, ...) and every tag name that
// exists in the data (user.id:, order.id:, sku:, ...), then the most common values of that tag.
// Tab or Enter on a highlighted suggestion accepts it; Enter with nothing highlighted runs the query; Esc closes.
import { useEffect, useRef, useState } from 'react';
import { BUILT_IN_KEYS, LEVELS, tokenAt } from '../lib/logQuery.js';

const needsQuotes = (v) => /[\s"]/.test(v);
const quote = (v) => (needsQuotes(v) ? `"${v.replace(/"/g, '')}"` : v);

export default function QueryInput({ value, onChange, onSubmit, onClear, tagKeys = [], services = [], loadValues, regexMode, onToggleRegex, invalid, placeholder }) {
  const inputRef = useRef(null);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [items, setItems] = useState([]);
  const [active, setActive] = useState(-1);
  const tok = tokenAt(value, Math.min(caret, value.length));

  useEffect(() => {
    if (!focused) { setItems([]); return undefined; }
    const neg = tok.text.startsWith('-') ? '-' : '';
    const raw = tok.text.slice(neg.length);
    if (!raw || raw.startsWith('/') || raw.startsWith('"')) { setItems([]); return undefined; }
    const colon = raw.indexOf(':');
    let alive = true;
    if (colon < 0) {
      const lower = raw.toLowerCase();
      const all = [...BUILT_IN_KEYS.map((key) => ({ key, hint: 'field' })), ...tagKeys.map((t) => ({ key: t.key, hint: `${t.count.toLocaleString()} logs` }))];
      const seen = new Set();
      const next = all.filter((k) => k.key.toLowerCase().startsWith(lower) && k.key !== raw && !seen.has(k.key) && seen.add(k.key))
        .slice(0, 8).map((k) => ({ label: `${k.key}:`, insert: `${neg}${k.key}:`, hint: k.hint }));
      setItems(next); setActive(-1);
      return undefined;
    }
    const key = raw.slice(0, colon);
    const typed = raw.slice(colon + 1).replace(/^"/, '').toLowerCase();
    const finish = (list) => {
      if (!alive) return;
      const next = list.filter((v) => String(v.value).toLowerCase().startsWith(typed) && String(v.value).toLowerCase() !== typed)
        .slice(0, 8).map((v) => ({ label: String(v.value), insert: `${neg}${key}:${quote(String(v.value))}`, hint: v.count !== undefined ? `${v.count.toLocaleString()}` : '' }));
      setItems(next); setActive(-1);
    };
    const kl = key.toLowerCase();
    if (kl === 'service' || kl === 'svc') finish(services.map((s) => ({ value: s })));
    else if (kl === 'level' || kl === 'severity') finish(LEVELS.map((l) => ({ value: l })));
    else if (kl === 'trace' || kl === 'span') finish([]);
    else {
      const timer = setTimeout(() => { Promise.resolve(loadValues?.(key)).then((v) => finish(v ?? [])).catch(() => finish([])); }, 150);
      return () => { alive = false; clearTimeout(timer); };
    }
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, caret, focused, tagKeys, services]);

  const accept = (item) => {
    const before = value.slice(0, tok.start);
    const after = value.slice(tok.end);
    const tail = item.insert.endsWith(':') ? '' : ' ';
    const next = `${before}${item.insert}${tail}${after.replace(/^\s+/, '')}`;
    const pos = before.length + item.insert.length + tail.length;
    onChange(next);
    setItems([]);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(pos, pos); setCaret(pos); });
  };

  const onKeyDown = (e) => {
    const open = items.length > 0;
    if (open && e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length); return; }
    if (open && e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a <= 0 ? items.length - 1 : a - 1)); return; }
    if (open && e.key === 'Tab') { e.preventDefault(); accept(items[active >= 0 ? active : 0]); return; }
    if (e.key === 'Enter') { if (open && active >= 0) { e.preventDefault(); accept(items[active]); } else { setItems([]); onSubmit(); } return; }
    if (e.key === 'Escape') { if (open) setItems([]); else e.currentTarget.blur(); }
  };

  return (
    <div className={`lg-qwrap${invalid ? ' invalid' : ''}`}>
      <input ref={inputRef} className="input lg-input" value={value} spellCheck={false} autoComplete="off" aria-label="Log query"
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); }}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)} onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onKeyDown={onKeyDown} />
      <div className="lg-qtools">
        {value && <button type="button" className="lg-qbtn" onClick={onClear} title="Clear query" aria-label="Clear query">✕</button>}
        <button type="button" className={`lg-qbtn re${regexMode ? ' on' : ''}`} onClick={onToggleRegex} aria-pressed={regexMode}
          title={regexMode ? 'Regular expression search is ON for the free text' : 'Treat the free text as a regular expression'}>.*</button>
      </div>
      {items.length > 0 && (
        <ul className="lg-suggest" role="listbox">
          {items.map((it, i) => (
            <li key={it.insert} role="option" aria-selected={i === active} className={i === active ? 'on' : ''}
              onMouseDown={(e) => { e.preventDefault(); accept(it); }} onMouseEnter={() => setActive(i)}>
              <span className="mono">{it.label}</span><span className="muted small">{it.hint}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
