// Feature 14: Service Topology Map (owner: B). Services are nodes, "A calls B" are arrows.
// Nodes and arrows are coloured with the same health rule as the Dashboard (shared/health.js on the server).
// Click a node or an arrow for its numbers and links to the traces and logs behind them. Drag nodes to rearrange them
// (the layout is remembered). Refreshes every 5 seconds without moving anything you placed. A service that is the
// root cause of a recent anomaly gets a red pulsing ring (data from /api/anomalies, written by the detector).
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, useNodesState, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../lib/api.js';
import { usePolling } from '../hooks/usePolling.js';
import { useUrlState } from '../hooks/useUrlState.js';
import { EmptyState, ErrorState, HealthBadge, ServiceDot, Skeleton, TIME_RANGES } from '../components/ui.jsx';
import { serviceColor } from '../lib/serviceColor.js';
import { fmtMs, fmtNum, fmtPct, ago } from '../lib/format.js';
import { NODE_H, NODE_W, layout } from '../lib/topologyLayout.js';

const POLL_MS = 5000;
// 1m and 2m let a recovery show quickly after a fault is cleared (the anomaly detector looks at 2 minutes too).
const RANGES = [['1m', 1], ['2m', 2], ...TIME_RANGES];
const rangeMinutes = (key) => (RANGES.find(([k]) => k === key) ?? RANGES.find(([k]) => k === '15m'))[1];
const HEALTH_COLOR = { healthy: '#22c55e', degraded: '#f59e0b', failing: '#ef4444', unknown: '#64748b' };
const STORE_KEY = 'topology.positions.v1';

const loadPositions = () => { try { return new Map(Object.entries(JSON.parse(localStorage.getItem(STORE_KEY) || '{}'))); } catch { return new Map(); } };
const savePositions = (map) => { try { localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(map))); } catch { /* storage unavailable */ } };
const rps = (v) => (v === null || v === undefined ? '-' : v >= 10 ? `${Math.round(v)}/s` : `${v.toFixed(v >= 1 ? 1 : 2)}/s`);

// ---- node ----
const ServiceNode = memo(function ServiceNode({ data, selected }) {
  const { n, rootCause, affected } = data;
  const color = HEALTH_COLOR[n.health] ?? HEALTH_COLOR.unknown;
  return (
    <div className={`tp-node${selected ? ' sel' : ''}${rootCause ? ' root' : ''}`} style={{ '--hc': color, width: NODE_W, height: NODE_H }}>
      <Handle type="target" position={Position.Left} className="tp-handle" isConnectable={false} />
      <div className="tp-node-head">
        <span className="tp-name"><ServiceDot name={n.service} />{n.service}</span>
        <span className={`tp-health ${n.health}`}>{n.health}</span>
      </div>
      <div className="tp-node-stats">
        <span><b>{rps(n.rps)}</b><i>req</i></span>
        <span className={n.errorRate >= 0.03 ? 'bad' : ''}><b>{fmtPct(n.errorRate)}</b><i>errors</i></span>
        <span className={n.p99Ms >= 1000 ? 'bad' : ''}><b>{fmtMs(n.p99Ms)}</b><i>p99</i></span>
      </div>
      <div className="tp-node-foot">
        {n.entry && <span className="tp-tag">entry point</span>}
        {rootCause && <span className="tp-tag red">⚠ root cause</span>}
        {!rootCause && affected && <span className="tp-tag amber">anomaly</span>}
      </div>
      <Handle type="source" position={Position.Right} className="tp-handle" isConnectable={false} />
    </div>
  );
});
const nodeTypes = { service: ServiceNode };

// ---- details panel ----
function Metric({ label, value, tone }) {
  return <div className="tp-metric"><div className="muted small">{label}</div><div className={`tp-mv${tone ? ` ${tone}` : ''}`}>{value}</div></div>;
}

function NodePanel({ node, edges, anomalies, minutes, onClose, onSelectEdge, onSelectNode }) {
  const calls = edges.filter((e) => e.source === node.service);
  const callers = edges.filter((e) => e.target === node.service);
  const mine = anomalies.filter((a) => a.service_name === node.service || a.root_cause === node.service);
  return (
    <aside className="tp-panel">
      <div className="panel-head">
        <div><div className="panel-title"><ServiceDot name={node.service} />{node.service}</div>
          <div className="muted small">last {minutes < 60 ? `${minutes} min` : `${minutes / 60} h`} · seen {ago(node.lastSeenMs)}</div></div>
        <button className="btn small" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div style={{ marginBottom: 10 }}><HealthBadge health={node.health} />{node.entry && <span className="badge blue">entry point</span>}</div>
      <div className="tp-metrics">
        <Metric label="Requests" value={fmtNum(node.requests)} />
        <Metric label="Throughput" value={rps(node.rps)} />
        <Metric label="Error rate" value={fmtPct(node.errorRate)} tone={node.errorRate >= 0.03 ? 'bad' : ''} />
        <Metric label="Avg latency" value={fmtMs(node.avgMs)} />
        <Metric label="p50" value={fmtMs(node.p50Ms)} />
        <Metric label="p95" value={fmtMs(node.p95Ms)} />
        <Metric label="p99" value={fmtMs(node.p99Ms)} tone={node.p99Ms >= 1000 ? 'bad' : ''} />
        <Metric label="Errors" value={fmtNum(node.errors)} />
      </div>

      {mine.length > 0 && (
        <>
          <h4>Anomalies</h4>
          {mine.slice(0, 4).map((a) => (
            <Link key={a.id} to="/anomalies" className={`anomaly ${a.severity === 'CRITICAL' ? 'red' : 'amber'}`}>
              <b>{a.severity}</b> {a.service_name} {a.metric === 'error_rate' ? 'error rate' : 'p99'} {a.ratio ? `${a.ratio.toFixed(1)}×` : ''}
              {a.root_cause && <span className="muted"> · root cause: {a.root_cause}</span>}
            </Link>
          ))}
        </>
      )}

      {calls.length > 0 && (
        <><h4>Calls ({calls.length})</h4>
          {calls.map((e) => <EdgeRow key={e.target} e={e} label={e.target} onClick={() => onSelectEdge(e)} />)}</>
      )}
      {callers.length > 0 && (
        <><h4>Called by ({callers.length})</h4>
          {callers.map((e) => <EdgeRow key={e.source} e={e} label={e.source} onClick={() => onSelectNode(e.source)} />)}</>
      )}

      <h4>Investigate</h4>
      <div className="tp-links">
        <Link className="btn small" to={`/traces?service=${encodeURIComponent(node.service)}`}>Traces</Link>
        <Link className="btn small" to={`/traces?service=${encodeURIComponent(node.service)}&status=error`}>Failed traces</Link>
        <Link className="btn small" to={`/logs?q=${encodeURIComponent(`service:${node.service}`)}&range=${minutes <= 5 ? '5m' : minutes <= 15 ? '15m' : '1h'}`}>Logs</Link>
        <Link className="btn small" to={`/logs?q=${encodeURIComponent(`service:${node.service} level:WARN,ERROR`)}`}>Warnings and errors</Link>
      </div>
    </aside>
  );
}

function EdgeRow({ e, label, onClick }) {
  return (
    <button className="tp-edgerow" onClick={onClick}>
      <span className="tp-dot" style={{ background: HEALTH_COLOR[e.health] }} />
      <span className="tp-er-name">{label}</span>
      <span className="muted small">{rps(e.rps)} · p95 {fmtMs(e.p95Ms)}{e.errors ? ` · ${fmtPct(e.errorRate)} err` : ''}</span>
    </button>
  );
}

function EdgePanel({ edge, minutes, onClose, onSelectNode }) {
  return (
    <aside className="tp-panel">
      <div className="panel-head">
        <div><div className="panel-title">
          <button className="tp-link" onClick={() => onSelectNode(edge.source)}>{edge.source}</button> → <button className="tp-link" onClick={() => onSelectNode(edge.target)}>{edge.target}</button></div>
          <div className="muted small">last {minutes < 60 ? `${minutes} min` : `${minutes / 60} h`}</div></div>
        <button className="btn small" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div style={{ marginBottom: 10 }}><HealthBadge health={edge.health} /></div>
      <div className="tp-metrics">
        <Metric label="Calls" value={fmtNum(edge.calls)} />
        <Metric label="Throughput" value={rps(edge.rps)} />
        <Metric label="Error rate" value={fmtPct(edge.errorRate)} tone={edge.errorRate >= 0.03 ? 'bad' : ''} />
        <Metric label="Errors" value={fmtNum(edge.errors)} />
        <Metric label="Avg" value={fmtMs(edge.avgMs)} />
        <Metric label="p50" value={fmtMs(edge.p50Ms)} />
        <Metric label="p95" value={fmtMs(edge.p95Ms)} />
        <Metric label="p99" value={fmtMs(edge.p99Ms)} tone={edge.p99Ms >= 1000 ? 'bad' : ''} />
      </div>
      <p className="muted small">Latency and errors are measured on {edge.target}&apos;s side of each call made by {edge.source}.</p>
      <h4>Investigate</h4>
      <div className="tp-links">
        <Link className="btn small" to={`/traces?service=${encodeURIComponent(edge.target)}`}>{edge.target} traces</Link>
        <Link className="btn small" to={`/logs?q=${encodeURIComponent(`service:${edge.target} level:WARN,ERROR`)}`}>{edge.target} warnings and errors</Link>
      </div>
    </aside>
  );
}

// ---- canvas ----
function Graph({ data, anomalies, selected, onSelect, panelOpen }) {
  const { fitView } = useReactFlow();
  const manual = useRef(loadPositions());
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const shape = useMemo(() => data.nodes.map((n) => n.service).join('|') + '#' + data.edges.map((e) => `${e.source}>${e.target}`).join('|'), [data]);
  const lastShape = useRef('');

  const rootCauses = useMemo(() => new Set(anomalies.map((a) => a.root_cause).filter(Boolean)), [anomalies]);
  const affectedSet = useMemo(() => new Set(anomalies.map((a) => a.service_name)), [anomalies]);

  // Build the nodes: your dragged position wins, otherwise the automatic layout.
  useEffect(() => {
    const auto = layout(data.nodes, data.edges);
    setNodes(data.nodes.map((n) => ({
      id: n.service, type: 'service', position: manual.current.get(n.service) ?? auto.get(n.service) ?? { x: 0, y: 0 },
      data: { n, rootCause: rootCauses.has(n.service), affected: affectedSet.has(n.service) },
      selected: selected?.type === 'node' && selected.id === n.service, draggable: true,
    })));
  }, [data, rootCauses, affectedSet, selected, setNodes]);

  // Fit the view the first time and whenever the set of services / arrows changes.
  useEffect(() => {
    if (shape === lastShape.current) return undefined;
    lastShape.current = shape;
    const t = setTimeout(() => fitView({ padding: 0.25, duration: 250, maxZoom: 1.1 }), 60);
    return () => clearTimeout(t);
  }, [shape, fitView]);

  // The canvas gets narrower when the side panel opens (and wider when it closes): fit the graph again.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return undefined; }
    const t = setTimeout(() => fitView({ padding: 0.25, duration: 250, maxZoom: 1.1 }), 140);
    return () => clearTimeout(t);
  }, [panelOpen, fitView]);

  const maxCalls = Math.max(1, ...data.edges.map((e) => e.calls));
  const focus = selected?.type === 'node' ? selected.id : null;
  const edges = useMemo(() => data.edges.map((e) => {
    const id = `${e.source}>${e.target}`;
    const color = HEALTH_COLOR[e.health] ?? HEALTH_COLOR.unknown;
    const dim = focus && e.source !== focus && e.target !== focus;
    const isSel = selected?.type === 'edge' && selected.id === id;
    const width = 1.5 + 3 * Math.sqrt(e.calls / maxCalls);
    return {
      id, source: e.source, target: e.target, type: 'default', animated: false,
      label: `${rps(e.rps)} · p95 ${fmtMs(e.p95Ms)}${e.errors ? ` · ${fmtPct(e.errorRate)} err` : ''}`,
      labelStyle: { fill: '#c3c9d4', fontSize: 11 }, labelBgStyle: { fill: '#12151b', fillOpacity: 0.92 }, labelBgPadding: [6, 3], labelBgBorderRadius: 4,
      style: { stroke: color, strokeWidth: isSel ? width + 2 : width, opacity: dim ? 0.18 : 1 },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18, markerUnits: 'userSpaceOnUse' },
      data: e, selected: isSel,
    };
  }), [data.edges, focus, selected, maxCalls]);

  const onDragStop = useCallback((_, node) => { manual.current.set(node.id, node.position); savePositions(manual.current); }, []);
  const resetLayout = () => { manual.current = new Map(); savePositions(manual.current); lastShape.current = ''; const auto = layout(data.nodes, data.edges);
    setNodes((ns) => ns.map((n) => ({ ...n, position: auto.get(n.id) ?? n.position }))); setTimeout(() => fitView({ padding: 0.25, duration: 250, maxZoom: 1.1 }), 60); };

  return (
    <div className="tp-canvas">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onNodeDragStop={onDragStop}
        onNodeClick={(_, n) => onSelect({ type: 'node', id: n.id })} onEdgeClick={(_, e) => onSelect({ type: 'edge', id: e.id })} onPaneClick={() => onSelect(null)}
        colorMode="dark" minZoom={0.3} maxZoom={1.8} nodesConnectable={false} elementsSelectable proOptions={{ hideAttribution: true }}
        fitView fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}>
        <Background gap={24} size={1} color="#232833" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(n) => HEALTH_COLOR[n.data?.n?.health] ?? '#64748b'} maskColor="rgba(15,17,21,.7)" style={{ background: '#12151b' }} />
      </ReactFlow>
      <button className="btn small tp-reset" onClick={resetLayout}>Reset layout</button>
    </div>
  );
}

export default function Topology() {
  const [range, setRange] = useUrlState('range', '15m');
  const [select, setSelect] = useUrlState('select', '');
  const minutes = rangeMinutes(range);

  const topo = usePolling((signal) => api(`/api/topology?minutes=${minutes}`, { signal }), POLL_MS, [minutes]);
  const anomRes = usePolling((signal) => api('/api/anomalies?limit=50', { signal }), 15_000, []);
  const anomalies = useMemo(() => {
    const since = Date.now() - minutes * 60_000;
    return (anomRes.data?.anomalies ?? []).filter((a) => a.detected_at_ms >= since);
  }, [anomRes.data, minutes]);

  const selected = useMemo(() => {
    if (!select) return null;
    const [type, id] = select.split(':');
    return type === 'node' || type === 'edge' ? { type, id: select.slice(type.length + 1) } : null;
  }, [select]);
  const setSelected = useCallback((s) => setSelect(s ? `${s.type}:${s.id}` : ''), [setSelect]);

  const data = topo.data;
  const node = selected?.type === 'node' ? data?.nodes.find((n) => n.service === selected.id) : null;
  const edge = selected?.type === 'edge' ? data?.edges.find((e) => `${e.source}>${e.target}` === selected.id) : null;
  const worst = data?.nodes.filter((n) => n.health === 'failing' || n.health === 'degraded') ?? [];

  return (
    <div className="tp">
      <div className="toolbar">
        <h2>Service Topology</h2>
        <select className="input" value={range} onChange={(e) => setRange(e.target.value)} aria-label="Time range">
          {RANGES.map(([k]) => <option key={k} value={k}>Last {k}</option>)}
        </select>
        <span className="tp-legend small">
          {['healthy', 'degraded', 'failing', 'unknown'].map((h) => <span key={h}><i style={{ background: HEALTH_COLOR[h] }} />{h}</span>)}
        </span>
        {data && <span className="muted small tp-summary">{data.nodes.length} services · {data.edges.length} connections{worst.length ? ` · ${worst.length} need attention` : ''}</span>}
      </div>

      {topo.error && !data && <ErrorState error={topo.error} />}
      {!data && !topo.error && <Skeleton height={420} />}
      {data && data.nodes.length === 0 && <EmptyState title={`No traffic in the last ${range}`} hint="Start the demo services and the load generator, or send OpenTelemetry data to :4318." />}
      {data && data.nodes.length > 0 && (
        <div className={`tp-body${node || edge ? ' open' : ''}`}>
          <ReactFlowProvider>
            <Graph data={data} anomalies={anomalies} selected={selected} onSelect={setSelected} panelOpen={Boolean(selected)} />
          </ReactFlowProvider>
          {node && <NodePanel node={node} edges={data.edges} anomalies={anomalies} minutes={minutes} onClose={() => setSelected(null)}
            onSelectEdge={(e) => setSelected({ type: 'edge', id: `${e.source}>${e.target}` })} onSelectNode={(s) => setSelected({ type: 'node', id: s })} />}
          {edge && <EdgePanel edge={edge} minutes={minutes} onClose={() => setSelected(null)} onSelectNode={(s) => setSelected({ type: 'node', id: s })} />}
          {selected && !node && !edge && <aside className="tp-panel"><div className="muted">That {selected.type} has no traffic in this time range.</div><button className="btn small" onClick={() => setSelected(null)}>Close</button></aside>}
        </div>
      )}
      {topo.error && data && <div className="notice" style={{ marginTop: 10 }}>Could not refresh: {topo.error.message}. Showing the last data.</div>}
    </div>
  );
}
