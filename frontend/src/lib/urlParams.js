// Pure helper behind useUrlState (no React, so it can be unit tested).
// Returns the NEW URLSearchParams after setting `key` to `next` on top of the URL text `search`.
// An empty value (or the default) removes the key.
export function withParam(search, key, next, def = '') {
  const p = new URLSearchParams(search);
  if (next === undefined || next === null || next === '' || next === def) p.delete(key);
  else p.set(key, String(next));
  return p;
}
