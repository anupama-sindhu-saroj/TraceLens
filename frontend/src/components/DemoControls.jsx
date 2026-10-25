// Demo Controls drawer (owner: B): break and fix the demo services from the UI instead of curl.
// A floating button (bottom right, every page) opens a drawer. It calls /api/demo/faults on the server, which forwards to
// each demo service's /_fault endpoint (see backend/server/src/api/demo.js).
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, send } from '../lib/api.js';
import { usePolling } from '../hooks/usePolling.js';
import { ServiceDot } from './ui.jsx';

const DURATIONS = [['', 'until cleared'], ['30', '30 seconds'], ['60', '1 minute'], ['180', '3 minutes'], ['300', '5 minutes']];
const PRESETS = [
  { label: 'Payment slow (1.5 s)', body: { service: 'payment', type: 'latency', latencyMs: 1500 } },
  { label: 'Inventory errors (40%)', body: { service: 'inventory', type: 'error', errorRate: 0.4 } },
  { label: 'Cart down (100% errors)', body: { service: 'cart', type: 'error', errorRate: 1 } },
];

const describe = (f) => (f.type === 'latency' ? `+${f.latencyMs} ms latency` : `${Math.round(f.errorRate * 100)}% errors`);

function Remaining({ expiresAt }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!expiresAt) return <span>until cleared</span>;
  const s = Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000));
  return <span>{s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`} left</span>;
}

function ServiceCard({ row, onChanged, onMessage }) {
  const [type, setType] = useState('latency');
  const [latency, setLatency] = useState(1500);
  const [errorPct, setErrorPct] = useState(40);
  const [duration, setDuration] = useState('');
  const [busy, setBusy] = useState(false);
  const { service, fault, reachable } = row;

  const run = async (fn, ok) => {
    setBusy(true);
    try { await fn(); onMessage({ kind: 'ok', text: ok }); } catch (e) { onMessage({ kind: 'bad', text: e.message }); }
    setBusy(false);
    onChanged();
  };
  const inject = () => run(
    () => send('/api/demo/faults', 'POST', {
      service, type, ...(type === 'latency' ? { latencyMs: Number(latency) } : { errorRate: Number(errorPct) / 100 }), ...(duration ? { durationSec: Number(duration) } : {}),
    }),
    `Injected into ${service}. Watch the Topology map; the detector reports it in a minute or two.`,
  );
  const clear = () => run(() => send(`/api/demo/faults/${encodeURIComponent(service)}`, 'DELETE'), `Cleared ${service}.`);

  return (
    <div className={`dc-card${fault ? ' broken' : ''}${reachable ? '' : ' down'}`}>
      <div className="dc-head">
        <span className="dc-name"><ServiceDot name={service} />{service}</span>
        {!reachable && <span className="badge grey">not reachable</span>}
        {reachable && !fault && <span className="badge green">healthy</span>}
        {fault && <span className="badge red">{describe(fault)}</span>}
      </div>
      {fault && (
        <div className="dc-active small">
          <span className="muted"><Remaining expiresAt={fault.expiresAt} /></span>
          <button className="btn small" disabled={busy} onClick={clear}>Clear</button>
        </div>
      )}
      {reachable && (
        <div className="dc-form">
          <div className="dc-seg" role="group" aria-label={`Fault type for ${service}`}>
            <button className={type === 'latency' ? 'on' : ''} onClick={() => setType('latency')}>Slow</button>
            <button className={type === 'error' ? 'on' : ''} onClick={() => setType('error')}>Errors</button>
          </div>
          {type === 'latency' ? (
            <label className="dc-field small">Extra latency <b>{latency} ms</b>
              <input type="range" min="100" max="5000" step="100" value={latency} onChange={(e) => setLatency(e.target.value)} aria-label="Extra latency in milliseconds" /></label>
          ) : (
            <label className="dc-field small">Failing requests <b>{errorPct}%</b>
              <input type="range" min="5" max="100" step="5" value={errorPct} onChange={(e) => setErrorPct(e.target.value)} aria-label="Percent of requests that fail" /></label>
          )}
          <label className="dc-field small">Lasts
            <select className="input" value={duration} onChange={(e) => setDuration(e.target.value)}>
              {DURATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
          <button className="btn primary" disabled={busy} onClick={inject}>{fault ? 'Replace fault' : 'Inject fault'}</button>
        </div>
      )}
    </div>
  );
}

export default function DemoControls() {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState(null);
  const [tick, setTick] = useState(0);
  const { data, error } = usePolling((signal) => api('/api/demo/faults', { signal }), open ? 3000 : 15_000, [tick]);
  const rows = Array.isArray(data) ? data : [];
  const active = rows.filter((r) => r.fault).length;
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  useEffect(() => { if (!msg) return undefined; const t = setTimeout(() => setMsg(null), 7000); return () => clearTimeout(t); }, [msg]);

  const preset = async (p) => {
    try { await send('/api/demo/faults', 'POST', p.body); setMsg({ kind: 'ok', text: `${p.label}: injected.` }); } catch (e) { setMsg({ kind: 'bad', text: e.message }); }
    refresh();
  };
  const clearAll = async () => {
    try { const r = await send('/api/demo/faults', 'DELETE'); setMsg({ kind: 'ok', text: r.cleared ? `Cleared ${r.cleared} fault${r.cleared === 1 ? '' : 's'}.` : 'No faults were active.' }); } catch (e) { setMsg({ kind: 'bad', text: e.message }); }
    refresh();
  };

  return (
    <>
      <button className={`dc-fab${active ? ' hot' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="demo-controls">
        <span aria-hidden="true">⚡</span> Demo Controls{active > 0 && <span className="dc-count">{active}</span>}
      </button>
      {open && (
        <aside id="demo-controls" className="dc-drawer" role="dialog" aria-label="Demo controls">
          <div className="panel-head">
            <div><div className="panel-title">Demo Controls</div><div className="muted small">Break the demo services on purpose and watch the system find it.</div></div>
            <button className="btn small" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>

          {msg && <div className={`dc-msg ${msg.kind}`} role="status">{msg.text}{msg.kind === 'ok' && msg.text.includes('Topology') && <> <Link to="/topology?range=2m" onClick={() => setOpen(false)}>Open the map →</Link></>}</div>}
          {error && !data && <div className="dc-msg bad">Could not reach the server: {error.message}</div>}

          <div className="dc-presets">
            {PRESETS.map((p) => <button key={p.label} className="btn small" onClick={() => preset(p)}>{p.label}</button>)}
            <button className="btn small" onClick={clearAll} disabled={active === 0}>Clear all{active ? ` (${active})` : ''}</button>
          </div>

          {rows.length === 0 && !error && <div className="muted small">Loading services…</div>}
          <div className="stack">
            {rows.map((r) => <ServiceCard key={r.service} row={r} onChanged={refresh} onMessage={setMsg} />)}
          </div>
          <p className="muted small">Latency and error faults live inside each demo service, so they are lost when a service restarts. Recovery shows on the map within 1 to 2 minutes if you pick the 1m or 2m range.</p>
        </aside>
      )}
    </>
  );
}
