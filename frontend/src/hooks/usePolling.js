import { useEffect, useRef, useState } from 'react';

// Calls load() now and then every intervalMs. Returns { data, error, loading }.
// deps: re-run (and reset loading) when they change.
export function usePolling(load, intervalMs, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let alive = true;
    let timer;
    const ctl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const tick = async () => {
      try {
        const data = await loadRef.current(ctl.signal);
        if (alive) setState({ data, error: null, loading: false });
      } catch (error) {
        if (alive && error.name !== 'AbortError') setState((s) => ({ data: s.data, error, loading: false }));
      }
      if (alive && intervalMs) timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => { alive = false; ctl.abort(); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);
  return state;
}
