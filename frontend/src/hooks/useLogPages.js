import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

// Loads logs page by page (owner: B). First page for `firstQs`, then loadOlder() continues from the last row with the
// server cursor (before + skip), so nothing is skipped or repeated even when many rows share a millisecond.
//   const pages = useLogPages({ firstQs, pageSize: 200, resetKey })
//   pages.rows  pages.loading (first page)  pages.loadingMore  pages.hasMore  pages.error  pages.loadOlder()  pages.capped
// MAX_ROWS keeps the browser fast; past it the user is asked to narrow the query or zoom the timeline.
export const MAX_ROWS = 20_000;

export function useLogPages({ firstQs, pageSize = 200, resetKey }) {
  const [state, setState] = useState({ rows: [], hasMore: false, loading: true, loadingMore: false, error: null });
  const stateRef = useRef(state);
  stateRef.current = state;
  const seq = useRef(0); // ignore answers of an older query
  const keyCounter = useRef(0);

  const fetchPage = useCallback(async (qs, signal) => {
    const res = await api(`/api/logs?${qs}&limit=${pageSize}`, { signal });
    const logs = (res.logs ?? res).map((l) => ({ ...l, _k: `r${keyCounter.current++}` }));
    return { logs, hasMore: Boolean(res.hasMore) };
  }, [pageSize]);

  useEffect(() => {
    const my = ++seq.current;
    const ctl = new AbortController();
    setState({ rows: [], hasMore: false, loading: true, loadingMore: false, error: null });
    fetchPage(firstQs, ctl.signal)
      .then(({ logs, hasMore }) => { if (seq.current === my) setState({ rows: logs, hasMore, loading: false, loadingMore: false, error: null }); })
      .catch((error) => { if (error.name !== 'AbortError' && seq.current === my) setState((s) => ({ ...s, loading: false, error })); });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstQs, resetKey, fetchPage]);

  const loadOlder = useCallback(async () => {
    const s = stateRef.current;
    if (s.loading || s.loadingMore || !s.hasMore || s.rows.length === 0 || s.rows.length >= MAX_ROWS) return;
    const my = seq.current;
    const last = s.rows[s.rows.length - 1].time_ms;
    const skip = s.rows.reduce((n, r) => n + (r.time_ms === last ? 1 : 0), 0);
    setState((x) => ({ ...x, loadingMore: true }));
    try {
      const { logs, hasMore } = await fetchPage(`${firstQs}&before=${last}&skip=${skip}`);
      if (seq.current !== my) return;
      setState((x) => ({ ...x, rows: [...x.rows, ...logs], hasMore, loadingMore: false }));
    } catch (error) {
      if (seq.current === my) setState((x) => ({ ...x, loadingMore: false, error }));
    }
  }, [firstQs, fetchPage]);

  return { ...state, loadOlder, capped: state.rows.length >= MAX_ROWS };
}
