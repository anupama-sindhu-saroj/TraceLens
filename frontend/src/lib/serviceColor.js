const PALETTE = { gateway: '#4f8cff', cart: '#a78bfa', inventory: '#2dd4bf', payment: '#f472b6' };
const EXTRA = ['#fb923c', '#facc15', '#60a5fa', '#34d399'];
// Same service -> same color on every page.
export function serviceColor(name) {
  if (PALETTE[name]) return PALETTE[name];
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return EXTRA[h % EXTRA.length];
}
