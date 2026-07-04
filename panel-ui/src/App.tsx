import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { isLoggedIn } from './api';
import LoginPage from './LoginPage';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import BotsPage from './pages/BotsPage';
import ChatPage from './pages/ChatPage';
import SessionsPage from './pages/SessionsPage';
import LogsPage from './pages/LogsPage';

export default function App() {
  const [loggedIn, setLoggedIn] = useState(isLoggedIn());

  // Re-check on mount
  useEffect(() => {
    setLoggedIn(isLoggedIn());
  }, []);

  if (!loggedIn) {
    return <LoginPage onLogin={() => setLoggedIn(true)} />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/bots" element={<BotsPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/logs" element={<LogsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
