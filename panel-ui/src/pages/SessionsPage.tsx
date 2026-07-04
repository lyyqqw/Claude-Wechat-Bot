import { useState, useEffect, useRef } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { fetchSessions, type SessionData } from '../api';

function timeAgo(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const pageRef = useRef<HTMLDivElement>(null);

  const load = async (userId?: string) => {
    setLoading(true);
    try { setSessions(await fetchSessions(userId || undefined)); } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  useGSAP(() => {
    if (loading) return;
    const rows = pageRef.current?.querySelectorAll<HTMLElement>('.gsap-row');
    if (!rows?.length) return;
    gsap.fromTo(rows, { autoAlpha: 0, x: -8 }, { autoAlpha: 1, x: 0, duration: 0.3, stagger: 0.03, ease: 'power4.out' });
  }, { scope: pageRef, dependencies: [loading], revertOnUpdate: true });

  const handleSearch = () => load(search);

  return (
    <div ref={pageRef}>
      <div className="header-row">
        <h1 className="page-title">会话</h1>
        <div className="btn-group">
          <input className="search-input" placeholder="搜索用户 ID..." value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()} />
          <button className="btn btn-primary" onClick={handleSearch}>搜索</button>
          <button className="btn btn-ghost" onClick={() => { setSearch(''); load(); }}>清除</button>
        </div>
      </div>

      {loading && <div className="empty-state">加载中...</div>}
      {!loading && sessions.length === 0 && <div className="empty-state">暂无活跃会话。</div>}

      {!loading && sessions.length > 0 && (
        <div className="session-table">
          <div className="session-row session-header">
            <div className="session-cell">用户 ID</div>
            <div className="session-cell">Bot</div>
            <div className="session-cell">消息数</div>
            <div className="session-cell">模型</div>
            <div className="session-cell">最后活动</div>
          </div>
          {sessions.map((s, i) => (
            <div key={i} className="session-row gsap-row">
              <div className="session-cell mono" title={s.userId}>{s.userId?.split('@')[0] || '—'}</div>
              <div className="session-cell">{s.botId || '—'}</div>
              <div className="session-cell mono">{s.messageCount}</div>
              <div className="session-cell">{s.selectedModel || '默认'}</div>
              <div className="session-cell mono">{timeAgo(s.age)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
