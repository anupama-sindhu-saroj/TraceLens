// Features 11 and 12: Logs Explorer + Live Tail (owner: B). Layout follows Google Cloud's Logs Explorer:
// query bar with filter chips, severity timeline, Fields panel (counts per severity / service / tag) and expandable rows.
// The query text is the single source of truth for filters (see lib/logQuery.js) and lives in the URL (?q=...).
// Search supports full-text, regular expressions (.* button or /regex/) and dynamic tag filters (user.id:user-38).
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { traceLink } from '../lib/links.js';
import { usePolling } from '../hooks/usePolling.js';
import { useUrlState } from '../hooks/useUrlState.js';
import { useLiveLogs } from '../hooks/useLiveLogs.js';
import { useLogPages } from '../hooks/useLogPages.js';
import { serviceColor } from '../lib/serviceColor.js';
import { EmptyState, ErrorState, ServiceDot, SkeletonRows, TIME_RANGES, rangeMinutes } from '../components/ui.jsx';
import LogHistogram from '../components/LogHistogram.jsx';
import QueryInput from '../components/QueryInput.jsx';
import TagFacet from '../components/TagFacet.jsx';
import {
  LEVELS, LEVEL_COLORS, SEVERITY_PRESETS, parseQuery, parseTokens, removeTokenAt, setToken, toParams, toggleTag, toggleToken,
} from '../lib/logQuery.js';
import { fmtDateTime } from '../lib/format.js';

const SERVICES = ['gateway', 'cart', 'inventory', 'payment'];
const PAGE = 200;
const LIVE_POLL_MS = 3000; // timeline + Fields counts refresh this often in live mode (rows themselves stream instantly)
const rowKey = (l) => `${l.time_ms}|${l.service_name}|${l.level}|${l.message}|${l.trace_id}|${l.span_id}`;
const pad = (n, w = 2) => String(n).padStart(w, '0');
const clock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };

// Wrap matches in <mark>: the words of a text search, or every match of a regular expression.
function Highlight({ text, q, regex }) {
  if (!q) return text;
  let re;
  try {
    re = regex
      ? new RegExp(`(${q})`, 'ig')
      : new RegExp(`(${q.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  } catch { return text; } // a pattern the browser's RegExp does not understand: show the text unmarked
  if (regex && new RegExp(re.source, 'i').test('')) return text; // pattern that matches the empty string would mark everything
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

const LogRow = memo(function LogRow({ log, q, regex, open, onToggle, onFilter, onTag }) {
  return (
    <div className={`lg-item${open ? ' open' : ''}${log._new ? ' lg-new' : ''}`}>
      <div className="lg-row" onClick={() => onToggle(log._k)} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(log._k); } }}>
        <span className="lg-sev" style={{ background: LEVEL_COLORS[log.level] ?? '#64748b' }} title={log.level} />
        <span className="lg-time mono">{clock(log.time_ms)}</span>
        <span className="lg-svc"><ServiceDot name={log.service_name} />{log.service_name}</span>
        <span className={`lg-msg lv-${log.level}`}><Highlight text={log.message} q={q} regex={regex} /></span>
        <span className="lg-caret">{open ? '▾' : '▸'}</span>
      </div>
      {open && <LogDetail log={log} onFilter={onFilter} onTag={onTag} />}
    </div>
  );
});

function LogDetail({ log, onFilter, onTag }) {
  const attrs = log.attributes && typeof log.attributes === 'object' ? log.attributes : {};
  const json = JSON.stringify({ time: new Date(log.time_ms).toISOString(), service: log.service_name, level: log.level, message: log.message, trace_id: log.trace_id, span_id: log.span_id, attributes: attrs }, null, 2);
  const entries = Object.entries(attrs);
  return (
    <div className="lg-detail">
      <div className="lg-detail-actions">
        <button className="btn small" onClick={() => onFilter('service', log.service_name)}>Only {log.service_name}</button>
        <button className="btn small" onClick={() => onFilter('level', log.level)}>Only {log.level}</button>
        {log.trace_id && <button className="btn small" onClick={() => onFilter('traceId', log.trace_id)}>Same trace</button>}
        {log.trace_id && <Link className="btn small" to={traceLink(log.trace_id, log.span_id)}>View trace →</Link>}
        <button className="btn small" onClick={() => navigator.clipboard?.writeText(json)}>Copy JSON</button>
        <span className="muted small">{fmtDateTime(log.time_ms)}</span>
      </div>
      {entries.length > 0 && (
        <div className="lg-attrs">
          <div className="muted small">Tags: filter by any value with + (only this) or − (everything except this)</div>
          {entries.map(([k, v]) => {
            const value = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
            return (
              <div key={k} className="lg-attr">
                <button className="lg-pm" title={`Only ${k} = ${value}`} aria-label={`Only ${k} equals ${value}`} onClick={() => onTag({ key: k, op: 'eq', value })}>+</button>
                <button className="lg-pm" title={`Hide ${k} = ${value}`} aria-label={`Hide ${k} equals ${value}`} onClick={() => onTag({ key: k, op: 'ne', value })}>−</button>
                <span className="lg-attr-k mono">{k}</span><span className="lg-attr-v mono">{value}</span>
              </div>
            );
          })}
        </div>
      )}
      <pre className="lg-json mono">{json}</pre>
    </div>
  );
}

function FieldFacet({ title, items, active, onPick, colorOf, order }) {
  const list = order ? order.map((v) => items.find((i) => i.value === v) ?? { value: v, count: 0 }) : items;
  const max = Math.max(1, ...list.map((i) => i.count));
  return (
    <div className="lg-facet">
      <h4>{title}</h4>
      {list.length === 0 && <div className="muted small">none</div>}
      {list.map((it) => (
        <button key={it.value} className={`lg-fv${active === it.value ? ' on' : ''}`} onClick={() => onPick(it.value)} title={`Filter ${title.toLowerCase()}: ${it.value}`}>
          <span className="lg-fv-name">{colorOf && <span className="dot" style={{ background: colorOf(it.value) }} />}{it.value}</span>
          <span className="lg-fv-count">{it.count.toLocaleString()}</span>
          <i style={{ width: `${(it.count / max) * 100}%` }} />
        </button>
      ))}
    </div>
  );
}

const STATUS_TEXT = { connecting: 'Connecting…', live: 'Streaming', reconnecting: 'Reconnecting…', idle: '' };
const OP_TEXT = { eq: '=', ne: '≠', re: '~' };

function chipFor(t) {
  if (t.kind === 'field') return { label: t.field === 'traceId' ? 'trace' : t.field === 'spanId' ? 'span' : t.field, sep: ': ', value: t.value };
  if (t.kind === 'tag') {
    const { key, op, value } = t.tag;
    return op === 'has' ? { label: key, sep: ' ', value: 'exists' } : { label: key, sep: ` ${OP_TEXT[op]} `, value: op === 're' ? `/${value}/` : value };
  }
  return t.regex ? { label: 'regex', sep: ': ', value: `/${t.text}/` } : null;
}

export default function Logs() {
  const [query, setQuery] = useUrlState('q', '');
  const [reFlag, setReFlag] = useUrlState('re', '');
  const [range, setRange] = useUrlState('range', '1h');
  const [fromP, setFromP] = useUrlState('from', '');
  const [toP, setToP] = useUrlState('to', '');
  const [liveFlag, setLiveFlag] = useUrlState('live', '');
  const live = liveFlag === '1';
  const regexMode = reFlag === '1';

  const [draft, setDraft] = useState(query);
  useEffect(() => setDraft(query), [query]);
  const [runId, setRunId] = useState(0);
  const [openKey, setOpenKey] = useState(null);
  const [showFields, setShowFields] = useState(true);

  const filters = useMemo(() => parseQuery(query, { regexMode }), [query, regexMode]);
  const tokens = useMemo(() => parseTokens(query), [query]);
  const queryRef = useRef(query);
  queryRef.current = query;
  const zoomed = fromP !== '' && toP !== '';
  const minutes = rangeMinutes(range);
  // Fixed window for a search; re-evaluated on every run / filter change so "last 1h" moves forward with the clock.
  const win = useMemo(() => {
    if (zoomed) return { from: Number(fromP), to: Number(toP) };
    const to = Date.now();
    return { from: to - minutes * 60_000, to };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minutes, fromP, toP, runId, query, regexMode]);
  // Live mode: the window is "the last N minutes up to now" and slides on every refresh.
  const windowNow = () => { const to = Date.now(); return { from: to - minutes * 60_000, to }; };
  const currentWin = () => (live ? windowNow() : win);

  const filterQs = toParams(filters);
  const winQs = toParams({}, win);

  // Rows: first page + "load older" (infinite scroll). In live mode the first page is simply the latest rows.
  const pages = useLogPages({
    firstQs: live ? toParams(filters) : toParams(filters, win),
    pageSize: PAGE,
    resetKey: `${live}|${runId}`,
  });
  // Timeline, Fields counts and tag names: fixed in a search, rolling and refreshed every few seconds in live mode.
  const pollMs = live ? LIVE_POLL_MS : 0;
  const deps = [filterQs, winQs, runId, live, minutes];
  const histRes = usePolling((signal) => api(`/api/logs/histogram?${toParams(filters, { ...currentWin(), buckets: 60 })}`, { signal }), pollMs, deps);
  const facetRes = usePolling((signal) => api(`/api/logs/facets?${toParams(filters, currentWin())}`, { signal }), pollMs, deps);
  const fieldsRes = usePolling((signal) => api(`/api/logs/fields?${toParams(filters, currentWin())}`, { signal }), pollMs ? pollMs * 3 : 0, deps);
  const tagKeys = useMemo(() => fieldsRes.data?.keys ?? [], [fieldsRes.data]);

  // Most common values of one tag under the current filters (Tags panel + autocomplete). Cached for a few seconds.
  const valueCache = useRef(new Map());
  const loadValues = useCallback(async (key) => {
    const ck = `${filterQs}|${key}`;
    const hit = valueCache.current.get(ck);
    if (hit && Date.now() - hit.at < 10_000) return hit.values;
    const w = live ? windowNow() : win;
    const res = await api(`/api/logs/field-values?${toParams(filters, { ...w, key })}`);
    valueCache.current.set(ck, { at: Date.now(), values: res.values });
    return res.values;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterQs, winQs, live, minutes]);

  // Live mode: the stream goes on top of the loaded rows. A row can arrive twice (stream + first page); show it once.
  const stream = useLiveLogs({ enabled: live, filters });
  const haveKeys = useMemo(() => (live ? new Set(pages.rows.map(rowKey)) : null), [live, pages.rows]);
  const rows = useMemo(() => {
    if (!live) return pages.rows;
    return [...stream.rows.filter((l) => !haveKeys.has(rowKey(l))), ...pages.rows];
  }, [live, stream.rows, pages.rows, haveKeys]);

  // Infinite scroll: when the sentinel under the list comes into view, load the next older page.
  const sentinel = useRef(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) pages.loadOlder(); }, { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [pages.loadOlder, pages.rows.length, pages.hasMore]);

  const run = (text = draft) => { setOpenKey(null); if (text !== query) setQuery(text); else setRunId((n) => n + 1); };
  const commit = useCallback((next) => { setDraft(next); setQuery(next); }, [setQuery]);
  const applyToken = (field, value) => commit(toggleToken(query, field, value));
  const setField = useCallback((field, value) => commit(setToken(queryRef.current, field, value)), [commit]);
  const onTag = useCallback((tag) => commit(toggleTag(queryRef.current, tag)), [commit]);
  const toggleRow = useCallback((k) => setOpenKey((cur) => (cur === k ? null : k)), []);
  const zoom = (from, to) => { setFromP(Math.floor(from)); setToP(Math.ceil(to)); if (live) setLiveFlag(''); }; // like Cloud Logging: zooming stops the stream
  const resetZoom = () => { setFromP(''); setToP(''); };
  const toggleLive = () => { setLiveFlag(live ? '' : '1'); setOpenKey(null); if (!live) resetZoom(); };

  // A bad regular expression / tag is reported by the server (HTTP 400) or the stream: show it once, next to the box.
  const badQuery = [pages.error, histRes.error, facetRes.error].find((e) => e?.status === 400);
  const queryProblem = badQuery?.message || (live ? stream.error : '');
  const otherError = [pages.error, histRes.error].find((e) => e && e.status !== 400);

  const level = filters.level;
  const preset = SEVERITY_PRESETS.some(([v]) => v === level) ? level : '__custom';
  const chips = tokens.map((t, i) => ({ i, chip: chipFor(t) })).filter((c) => c.chip);
  const initialLoading = pages.loading;

  return (
    <div className="lg">
      <div className="toolbar">
        <h2>Logs Explorer</h2>
        <button className={`btn lg-live${live ? ' on' : ''}`} onClick={toggleLive} aria-pressed={live}>
          <span className="lg-live-dot" /> Live tail
        </button>
      </div>

      <div className="lg-query">
        <QueryInput value={draft} onChange={setDraft} onSubmit={() => run()} onClear={() => { setDraft(''); setQuery(''); }}
          tagKeys={tagKeys} services={SERVICES} loadValues={loadValues} regexMode={regexMode} onToggleRegex={() => setReFlag(regexMode ? '' : '1')}
          invalid={Boolean(queryProblem)}
          placeholder='Search all fields   e.g.  service:payment level:ERROR user.id:user-38 /timeout|declined/' />
        <button className="btn primary" onClick={() => run()}>Run query</button>
      </div>
      {queryProblem && <div className="lg-qerror" role="alert">{queryProblem}</div>}
      {!queryProblem && filters.ignored.length > 0 && <div className="lg-hint small">Only one /regex/ is searched at a time; ignoring: {filters.ignored.join(' ')}</div>}
      {!queryProblem && filters.regex && filters.ignored.length === 0 && <div className="lg-hint small">Regular expression search (case-insensitive; start with (?-i) to match case). Searches the message and the tags.</div>}
      <details className="lg-help small">
        <summary>Search syntax</summary>
        <div className="lg-help-grid mono">
          <span>timeout &quot;card declined&quot;</span><span className="muted">text in the message or tags</span>
          <span>/card (declined|refused)/</span><span className="muted">regular expression (or turn on the .* button)</span>
          <span>service:payment level:WARN,ERROR</span><span className="muted">built-in filters</span>
          <span>user.id:user-38</span><span className="muted">tag equals (any tag name works)</span>
          <span>-sku:sku-9</span><span className="muted">tag does not equal</span>
          <span>order.id:/^o-1[0-9]+$/</span><span className="muted">tag matches a regex</span>
          <span>user.id:*</span><span className="muted">tag exists</span>
        </div>
      </details>

      <div className="lg-filters">
        <select className="input" value={filters.service} onChange={(e) => setField('service', e.target.value)} aria-label="Service">
          <option value="">All services</option>
          {SERVICES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="input" value={preset} onChange={(e) => setField('level', e.target.value)} aria-label="Severity">
          {SEVERITY_PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          {preset === '__custom' && <option value="__custom">{level}</option>}
        </select>
        <select className="input" value={zoomed && !live ? '__zoom' : range} onChange={(e) => { if (e.target.value !== '__zoom') { resetZoom(); setRange(e.target.value); } }} aria-label="Time range">
          {zoomed && !live && <option value="__zoom">{clock(win.from)} – {clock(win.to)}</option>}
          {TIME_RANGES.map(([k]) => <option key={k} value={k}>Last {k}</option>)}
        </select>
        {zoomed && !live && <button className="btn small" onClick={resetZoom}>Reset zoom</button>}
        {chips.map(({ i, chip }) => (
          <span key={i} className="lg-chip">{chip.label}{chip.sep}<b>{chip.value.length > 24 ? `${chip.value.slice(0, 22)}…` : chip.value}</b>
            <button onClick={() => commit(removeTokenAt(query, i))} aria-label={`Remove filter ${chip.label} ${chip.value}`}>×</button></span>
        ))}
        <button className="btn small lg-fields-toggle" onClick={() => setShowFields((s) => !s)}>{showFields ? 'Hide fields' : 'Show fields'}</button>
      </div>

      {live && (
        <div className="lg-livebar">
          <span className={`lg-status ${stream.status}`}><i />{STATUS_TEXT[stream.status]}</span>
          <span className="muted small">{stream.rows.length.toLocaleString()} new rows{stream.dropped ? ` · ${stream.dropped.toLocaleString()} skipped (arriving faster than they can be shown)` : ''}</span>
          <span className="lg-spacer" />
          {stream.paused && stream.buffered > 0 && <span className="small">{stream.buffered.toLocaleString()} waiting</span>}
          <button className="btn small" onClick={() => stream.setPaused(!stream.paused)}>{stream.paused ? '▶ Resume' : '⏸ Pause'}</button>
          <button className="btn small" onClick={stream.clear}>Clear</button>
        </div>
      )}
      {histRes.error && histRes.error.status !== 400 ? <ErrorState error={histRes.error} /> : <LogHistogram data={histRes.data} onZoom={zoom} />}

      <div className={`lg-body${showFields ? '' : ' no-fields'}`}>
        {showFields && (
          <aside className="lg-fields">
            <FieldFacet title="Severity" items={facetRes.data?.level ?? []} order={LEVELS.slice().reverse()} active={filters.level}
              onPick={(v) => applyToken('level', v)} colorOf={(v) => LEVEL_COLORS[v]} />
            <FieldFacet title="Service" items={facetRes.data?.service ?? []} active={filters.service}
              onPick={(v) => applyToken('service', v)} colorOf={serviceColor} />
            <TagFacet keys={tagKeys} query={query} loadValues={loadValues} onToggle={onTag} />
            {live && <div className="muted small">Counts cover the last {range} and refresh every few seconds.</div>}
          </aside>
        )}

        <section className="lg-results">
          <div className="lg-head"><span /><span>Time</span><span>Service</span><span>Summary</span><span /></div>
          {otherError && <ErrorState error={otherError} />}
          {initialLoading && <SkeletonRows rows={8} />}
          {!initialLoading && !pages.error && rows.length === 0 && (
            <EmptyState title={live ? 'Waiting for new logs…' : 'No logs match this query'}
              hint={live ? 'Rows appear here as they are ingested. Is the load generator running?' : 'Try a wider time range or remove a filter.'} />
          )}
          {rows.map((l) => (
            <LogRow key={l._k} log={l} q={filters.q} regex={filters.regex} open={openKey === l._k} onToggle={toggleRow} onFilter={setField} onTag={onTag} />
          ))}
          <div ref={sentinel} className="lg-end small muted">
            {pages.loadingMore && 'Loading older logs…'}
            {!pages.loadingMore && pages.hasMore && !pages.capped && <button className="btn" onClick={pages.loadOlder}>Load older logs</button>}
            {pages.capped && 'Loaded the newest 20,000 logs. Narrow the query or zoom the timeline to reach older ones.'}
            {!pages.hasMore && !initialLoading && rows.length > 0 && `${rows.length.toLocaleString()} logs · reached the start of ${live ? 'the log' : 'this time range'}`}
          </div>
        </section>
      </div>
    </div>
  );
}
