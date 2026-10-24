import { useCallback, useEffect, useRef, useState } from 'react';
import { toLiveFilter } from '../lib/logQuery.js';

// Live Tail client (owner: B). Connects to ws /ws/logs with the current filters and keeps the newest rows first.
// Reconnects by itself (backoff up to 5 s). Pause stops the list from moving; rows that arrive meanwhile are kept
// (up to MAX) and added when you resume.
//   const live = useLiveLogs({ enabled, filters });   // filters: { service, level, q, regex, tags, traceId, spanId }
//   live.error (text, when the server rejects the filter e.g. a bad regex)   live.rows  live.status ('idle'|'connecting'|'live'|'reconnecting')  live.paused  live.setPaused(bool)
//   live.buffered (rows waiting while paused)  live.dropped (rows the server skipped because we were too slow)  live.clear()
const MAX = 600;        // rows kept on screen; older stream rows fall off (they stay searchable)
const FLASH_MAX = 30;   // only flash new rows while the stream is slow enough to read

export function useLiveLogs({ enabled, filters }) {
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('idle');
  const [paused, setPausedState] = useState(false);
  const [buffered, setBuffered] = useState(0);
  const [dropped, setDropped] = useState(0);
  const pausedRef = useRef(false);
  const bufRef = useRef([]);
  const counter = useRef(0);
  const [error, setError] = useState('');
  const filterKey = JSON.stringify(toLiveFilter(filters));

  useEffect(() => {
    if (!enabled) { setStatus('idle'); return undefined; }
    let alive = true;
    let retry = 0;
    let timer;
    let ws;
    setRows([]); bufRef.current = []; setBuffered(0); setDropped(0); setError('');

    const connect = () => {
      setStatus(retry ? 'reconnecting' : 'connecting');
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${window.location.host}/ws/logs`);
      ws.onopen = () => {
        retry = 0;
        setStatus('live');
        setError('');
        ws.send(JSON.stringify({ type: 'filter', ...JSON.parse(filterKey) }));
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'error') { setError(m.message || 'the server rejected the filter'); return; }
        if (m.type !== 'logs') return;
        if (m.dropped) setDropped((d) => d + m.dropped);
        const flash = m.rows.length <= FLASH_MAX;
        const fresh = m.rows.map((r) => ({ ...r, _k: `l${counter.current++}`, _new: flash })).reverse(); // newest first
        if (pausedRef.current) {
          bufRef.current = [...fresh, ...bufRef.current].slice(0, MAX);
          setBuffered(bufRef.current.length);
        } else {
          setRows((prev) => [...fresh, ...prev].slice(0, MAX));
        }
      };
      ws.onclose = () => {
        if (!alive) return;
        setStatus('reconnecting');
        retry += 1;
        timer = setTimeout(connect, Math.min(5000, 500 * 2 ** retry));
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => { alive = false; clearTimeout(timer); if (ws) { ws.onclose = null; ws.close(); } };
  }, [enabled, filterKey]);

  const setPaused = useCallback((next) => {
    pausedRef.current = next;
    setPausedState(next);
    if (!next && bufRef.current.length) {
      const waiting = bufRef.current;
      bufRef.current = [];
      setBuffered(0);
      setRows((prev) => [...waiting, ...prev].slice(0, MAX));
    }
  }, []);

  const clear = useCallback(() => { setRows([]); bufRef.current = []; setBuffered(0); setDropped(0); }, []);

  return { rows, status, error, paused, setPaused, buffered, dropped, clear };
}