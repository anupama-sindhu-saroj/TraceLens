// A: features 8, 9, 10 (list, flamegraph, span panel). Mounted at /traces/* in App.jsx.
import { Route, Routes } from 'react-router-dom';
import TraceList from './TraceList.jsx';
import TraceDetail from './TraceDetail.jsx';

export default function Traces() {
  return (
    <Routes>
      <Route index element={<TraceList />} />
      <Route path=":traceId" element={<TraceDetail />} />
    </Routes>
  );
}
