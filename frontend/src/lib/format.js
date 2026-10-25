export const fmtMs = (ms) => {
  if (ms === null || ms === undefined) return '-';
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)} s`;
  if (ms >= 100) return `${Math.round(ms)} ms`;
  return `${ms.toFixed(ms >= 10 ? 1 : 2)} ms`;
};
export const fmtPct = (r) => (r === null || r === undefined ? '-' : `${(r * 100).toFixed(r > 0 && r < 0.001 ? 2 : 1)}%`);
export const fmtNum = (n) => (n === null || n === undefined ? '-' : n.toLocaleString());
export const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour12: false });
export const fmtDateTime = (ms) => new Date(ms).toLocaleString([], { hour12: false });
export const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};
