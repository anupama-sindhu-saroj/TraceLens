// Small query-string helpers shared by the REST routers.
function num(value, def, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return def;
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function parseJson(text) {
  if (text === null || text === undefined || text === '') return {};
  try { return JSON.parse(text); } catch { return {}; }
}

// "errored" span: 5xx, or status ERROR when there is no http status.
const ERROR_SQL = "(http_status >= 500 OR (http_status IS NULL AND status_code = 'ERROR'))";

module.exports = { num, parseJson, ERROR_SQL };
