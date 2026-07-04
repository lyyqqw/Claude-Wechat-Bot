import { useRef, useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { clearToken, connectLogStream, fetchVersion, type LogEntry } from '../api';

export interface OutletContext {
  activity: LogEntry[];
}

const ICONS: Record<string, React.ReactNode> = {
  grid:   (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>),
  bot:    (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="3" y="5" width="10" height="9" rx="1.5"/><path d="M5 5V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><circle cx="5.5" cy="9" r=".75"/><circle cx="10.5" cy="9" r=".75"/></svg>),
  chat:   (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 8a6 6 0 0 1 6-6h0a6 6 0 0 1 6 6v4a1 1 0 0 1-1 1H8a6 6 0 0 1-6-6z"/><path d="M5 7h6"/><path d="M5 9h4"/></svg>),
  message: (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 3h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5l-3 2V4a1 1 0 0 1 1-1z"/><line x1="5" y1="7" x2="11" y2="7"/><line x1="5" y1="10" x2="8" y2="10"/></svg>),
  list:   (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="2.5" y="2" width="11" height="12" rx="1.5"/><line x1="5" y1="6" x2="11" y2="6"/><line x1="5" y1="9" x2="11" y2="9"/><line x1="5" y1="12" x2="8" y2="12"/></svg>),
};

const NAV_ITEMS = [
  { path: '/', label: '仪表盘', icon: 'grid' },
  { path: '/chat', label: '对话', icon: 'message' },
  { path: '/bots', label: 'Bot 管理', icon: 'bot' },
  { path: '/sessions', label: '会话', icon: 'chat' },
  { path: '/logs', label: '日志', icon: 'list' },
];

export default function Layout() {
  const location = useLocation();
  const sidebarRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [ver, setVer] = useState('');

  useEffect(() => { fetchVersion().then(setVer); }, []);

  // SSE activity stream — kept alive at layout level so it persists across page switches
  const [activity, setActivity] = useState<LogEntry[]>([]);
  useEffect(() => {
    const cleanup = connectLogStream((e: LogEntry) => setActivity(p => [e, ...p].slice(0, 100)));
    return cleanup;
  }, []);

  useGSAP(() => {
    const items = sidebarRef.current?.querySelectorAll<HTMLElement>('.nav-item');
    if (!items?.length) return;
    gsap.fromTo(items, { autoAlpha: 0, x: -6 }, {
      autoAlpha: 1, x: 0, duration: 0.35, stagger: 0.04, ease: 'power4.out',
    });
  }, { scope: sidebarRef });

  useGSAP(() => {
    const el = contentRef.current;
    if (!el) return;
    gsap.fromTo(el, { autoAlpha: 0, y: 6 }, {
      autoAlpha: 1, y: 0, duration: 0.25, ease: 'power3.out',
    });
  }, { scope: contentRef, dependencies: [location.pathname], revertOnUpdate: true });

  const handleLogout = () => {
    const el = contentRef.current;
    if (el) gsap.to(el, { autoAlpha: 0, scale: 0.97, duration: 0.12 });
    setTimeout(() => { clearToken(); window.location.reload(); }, 100);
  };

  const ctx: OutletContext = { activity };

  return (
    <div className="app-layout">
      <aside className="sidebar" ref={sidebarRef}>
        <div className="sidebar-header">
          <h1>
            <span className="status-dot" />
            WeChat Bot
          </h1>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4, marginLeft: 14 }}>管理面板</div>
        </div>

        <nav className="sidebar-nav">
          {NAV_ITEMS.map(item => (
            <NavLink
              key={item.path} to={item.path} end={item.path === '/'}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <span className="nav-icon">{ICONS[item.icon]}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button className="nav-item" onClick={handleLogout}>
            <span className="nav-icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M6 3H3v10h3"/><path d="M6 8h8"/><path d="m10 5 3 3-3 3"/>
              </svg>
            </span>
            退出
          </button>
          <div className="sidebar-version">{ver ? `v${ver}` : ''}</div>
        </div>
      </aside>

      <main className="main-content" ref={contentRef}>
        <Outlet context={ctx} />
      </main>
    </div>
  );
}
