import { AdminPage } from './pages/AdminPage';
import { GuestPage } from './pages/GuestPage';

export function App() {
  const path = window.location.pathname.replace(/\/+$/, '');
  return path === '/admin' ? <AdminPage /> : <GuestPage />;
}
