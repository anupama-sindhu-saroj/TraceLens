import { NavLink, Route, Routes } from 'react-router-dom';
import Dashboard from './pages/Dashboard.jsx';
import Traces from './pages/Traces.jsx';
import Logs from './pages/Logs.jsx';
import Topology from './pages/Topology.jsx';
import Anomalies from './pages/Anomalies.jsx';
import DemoControls from './components/DemoControls.jsx';

const links = [
  ['/', 'Dashboard'],
  ['/traces', 'Traces'],
  ['/logs', 'Logs'],
  ['/topology', 'Topology'],
  ['/anomalies', 'Anomalies'],
];

export default function App() {
  return (
    <>
      <nav className="nav">
        <strong>Observability Engine</strong>
        {links.map(([to, label]) => (
          <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
            {label}
          </NavLink>
        ))}
      </nav>
      <main className="page">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/traces/*" element={<Traces />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/topology" element={<Topology />} />
          <Route path="/anomalies" element={<Anomalies />} />
        </Routes>
      </main>
      <DemoControls />
    </>
  );
}
