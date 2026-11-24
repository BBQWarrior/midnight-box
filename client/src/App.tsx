import { AdminPage } from './pages/AdminPage';
import { GuestPage } from './pages/GuestPage';
import { TvPage } from './pages/TvPage';

export function App() {
  const path = window.location.pathname.replace(/\/+$/, '');
  if (path === '/admin') return <AdminPage />;
  if (path === '/tv') return <TvPage />;
  return <GuestPage />;
}
