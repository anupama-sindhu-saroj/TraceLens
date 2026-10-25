import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { withParam } from '../lib/urlParams.js';

// Filters live in the URL, so links and the back button work between pages.
//   const [service, setService] = useUrlState('service', '');
//
// IMPORTANT: the new value is applied on top of the URL as it is RIGHT NOW (window.location), not on the copy React Router
// captured when the component last rendered. Router v6's setSearchParams does not queue updates, so a handler that calls two
// setters in a row (Logs: turn Live tail on + clear from/to; timeline zoom: set from + to) would otherwise lose all but the
// last change. history.replaceState is synchronous, so window.location is always up to date inside the same click.
export function useUrlState(key, def = '') {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? def;
  const set = useCallback((next) => {
    setParams(withParam(window.location.search, key, next, def), { replace: true });
  }, [key, def, setParams]);
  return [value, set];
}