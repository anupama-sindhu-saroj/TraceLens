// "Tags" section of the Fields panel (owner: B): every attribute name found in the logs (user.id, order.id, sku, ...).
// Click a name to see its most common values, click a value to filter by it (click again to remove it).
import { useState } from 'react';
import { isTagActive } from '../lib/logQuery.js';

export default function TagFacet({ keys, query, loadValues, onToggle }) {
  const [open, setOpen] = useState(null);       // expanded key
  const [values, setValues] = useState({});     // key -> [{value,count}] | 'loading' | 'error'
  const [all, setAll] = useState(false);
  const shown = all ? keys : keys.slice(0, 10);

  const expand = async (key) => {
    if (open === key) { setOpen(null); return; }
    setOpen(key);
    setValues((v) => ({ ...v, [key]: 'loading' }));
    try { const list = await loadValues(key); setValues((v) => ({ ...v, [key]: list })); } catch { setValues((v) => ({ ...v, [key]: 'error' })); }
  };

  return (
    <div className="lg-facet">
      <h4>Tags</h4>
      {keys.length === 0 && <div className="muted small">no tags in these logs</div>}
      {shown.map((k) => {
        const list = values[k.key];
        const activeHere = keys.length > 0 && isTagActive(query, { key: k.key, op: 'has', value: '' });
        return (
          <div key={k.key}>
            <button className={`lg-fv${open === k.key ? ' on' : ''}`} onClick={() => expand(k.key)} aria-expanded={open === k.key} title={`Show values of ${k.key}`}>
              <span className="lg-fv-name"><span className="lg-tw">{open === k.key ? '▾' : '▸'}</span>{k.key}</span>
              <span className="lg-fv-count">{k.count.toLocaleString()}</span>
            </button>
            {open === k.key && (
              <div className="lg-tagvals">
                {list === 'loading' && <div className="muted small">loading…</div>}
                {list === 'error' && <div className="muted small">could not load values</div>}
                {Array.isArray(list) && list.length === 0 && <div className="muted small">no values</div>}
                {Array.isArray(list) && (
                  <button className={`lg-fv sub${activeHere ? ' on' : ''}`} onClick={() => onToggle({ key: k.key, op: 'has', value: '' })}>
                    <span className="lg-fv-name muted">exists</span></button>
                )}
                {Array.isArray(list) && list.map((v) => {
                  const tag = { key: k.key, op: 'eq', value: v.value };
                  return (
                    <button key={v.value} className={`lg-fv sub${isTagActive(query, tag) ? ' on' : ''}`} onClick={() => onToggle(tag)} title={`${k.key} = ${v.value}`}>
                      <span className="lg-fv-name">{v.value}</span><span className="lg-fv-count">{v.count.toLocaleString()}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {keys.length > 10 && <button className="btn small" style={{ marginTop: 6 }} onClick={() => setAll((a) => !a)}>{all ? 'Show fewer' : `Show all ${keys.length}`}</button>}
    </div>
  );
}
