// Link to a trace page. B: use this for the Log Explorer "View trace" button and anomaly related-trace links.
//   <Link to={traceLink(log.trace_id, log.span_id)}>View trace</Link>
// The Trace Detail page reads ?span= and highlights + opens that span (feature 13).
export const traceLink = (traceId, spanId) =>
  `/traces/${traceId}${spanId ? `?span=${encodeURIComponent(spanId)}` : ''}`;
