// Layered left-to-right layout for the service graph (owner: B). Pure functions, unit tested.
//   layout(nodes, edges) -> Map(service -> { x, y })
// Services that only call others (the gateway) go on the left, the services they call to the right. A service sits one
// column after the LONGEST chain that reaches it. Cycles (A calls B calls A) are broken by ignoring the edge that
// closes the loop, so the layout always finishes. Inside a column services are ordered to keep edges short.
export const NODE_W = 190;
export const NODE_H = 96;
const GAP_X = 170;
const GAP_Y = 34;

export function assignLayers(services, edges) {
  const out = new Map(services.map((s) => [s, []]));
  for (const e of edges) if (out.has(e.source) && out.has(e.target) && e.source !== e.target) out.get(e.source).push(e.target);

  // depth-first search that skips back edges = the edges that would close a cycle
  const state = new Map(); // 1 = on the current path, 2 = finished
  const forward = new Map(services.map((s) => [s, []]));
  const visit = (s) => {
    state.set(s, 1);
    for (const t of out.get(s)) {
      if (state.get(t) === 1) continue; // back edge
      forward.get(s).push(t);
      if (!state.has(t)) visit(t);
    }
    state.set(s, 2);
  };
  const hasIncoming = new Set(edges.map((e) => e.target));
  for (const s of services) if (!hasIncoming.has(s) && !state.has(s)) visit(s);
  for (const s of services) if (!state.has(s)) visit(s); // anything only reachable through a cycle

  const layer = new Map(services.map((s) => [s, 0]));
  // longest path on the DAG of forward edges (Bellman-Ford style relaxation, at most n rounds)
  for (let round = 0; round < services.length; round += 1) {
    let changed = false;
    for (const [s, targets] of forward) {
      for (const t of targets) if (layer.get(t) < layer.get(s) + 1) { layer.set(t, layer.get(s) + 1); changed = true; }
    }
    if (!changed) break;
  }
  return layer;
}

export function layout(nodes, edges) {
  const services = nodes.map((n) => n.service);
  const layer = assignLayers(services, edges);
  const columns = [];
  for (const s of services) { const l = layer.get(s); (columns[l] ??= []).push(s); }

  // order each column by the average row of its callers (one left-to-right sweep), then by name for stable output
  const row = new Map();
  columns.forEach((col) => {
    if (!col) return;
    const score = (s) => {
      const callers = edges.filter((e) => e.target === s && row.has(e.source)).map((e) => row.get(e.source));
      return callers.length ? callers.reduce((a, b) => a + b, 0) / callers.length : Number.MAX_SAFE_INTEGER;
    };
    col.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
    col.forEach((s, i) => row.set(s, i));
  });

  const tallest = Math.max(1, ...columns.map((c) => (c ? c.length : 0)));
  const height = tallest * NODE_H + (tallest - 1) * GAP_Y;
  const pos = new Map();
  columns.forEach((col, ci) => {
    if (!col) return;
    const colH = col.length * NODE_H + (col.length - 1) * GAP_Y;
    col.forEach((s, i) => pos.set(s, { x: ci * (NODE_W + GAP_X), y: (height - colH) / 2 + i * (NODE_H + GAP_Y) }));
  });
  return pos;
}
