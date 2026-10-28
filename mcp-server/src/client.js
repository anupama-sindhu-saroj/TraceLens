'use strict';
// Thin REST client for the observability API. The MCP server never touches DuckDB directly:
// the database file is owned by the backend process (DuckDB allows one writer process), so everything goes through REST.

class ApiError extends Error {
  constructor(message, { status = 0, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (cause) this.cause = cause;
  }
}

function createClient({ baseUrl = 'http://localhost:8080', timeoutMs = 10_000, fetchImpl = globalThis.fetch } = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');

  async function get(path, params = {}) {
    const url = new URL(root + path);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    } catch (e) {
      const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new ApiError(
        timedOut
          ? `The observability API at ${root} did not answer within ${timeoutMs} ms.`
          : `Cannot reach the observability API at ${root}. Is the backend running? (start it with: npm run server)`,
        { cause: e },
      );
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = body && body.error ? body.error : `HTTP ${res.status}`;
      throw new ApiError(detail, { status: res.status });
    }
    return body;
  }

  return { baseUrl: root, get };
}

module.exports = { createClient, ApiError };
