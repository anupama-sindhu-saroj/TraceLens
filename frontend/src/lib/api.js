// Tiny fetch helper. Vite proxies /api to the backend (see vite.config.js).
// When the server answers with { error: "..." } (for example a bad regular expression) that text becomes the message.
export async function api(path, { signal } = {}) {
  const res = await fetch(path, { signal });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error ?? ''; } catch { /* not JSON */ }
    const err = new Error(detail || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// POST / DELETE with an optional JSON body. Same error handling as api(): the server's { error } text becomes the message.
export async function send(path, method = 'POST', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}