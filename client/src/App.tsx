import { AdminPage } from './pages/AdminPage';
import { GuestPage } from './pages/GuestPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { TvPage } from './pages/TvPage';

export function App() {
  const path = window.location.pathname.replace(/\/+$/, '');
  if (path === '/admin') return <AdminPage />;
  if (path === '/privacy') return <PrivacyPage />;
  if (path === '/tv') return <TvPage />;
  return <GuestPage />;
}
