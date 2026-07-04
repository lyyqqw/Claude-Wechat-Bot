import { useState, useEffect, useRef } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { fetchBots, deleteBot, type BotData } from '../api';

function MetaRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bot-meta-row">
      <span>{label}</span>
      <span className={mono ? 'mono' : ''} style={{ maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

export default function BotsPage() {
  const [bots, setBots] = useState<BotData[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  const load = async () => { setLoading(true); try { setBots(await fetchBots()); } finally { setLoading(false); } };
  useEffect(() => { load(); }, []);

  useGSAP(() => {
    if (loading) return;
    const cards = pageRef.current?.querySelectorAll<HTMLElement>('.gsap-card');
    if (!cards?.length) return;
    gsap.fromTo(cards, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.35, stagger: 0.05, ease: 'power4.out' });
  }, { scope: pageRef, dependencies: [loading, bots.length], revertOnUpdate: true });

  const handleDelete = async (id: string, nickname: string, el: HTMLElement | null) => {
    if (!confirm(`确定删除 "${nickname}"？Bot token 将永久失效。`)) return;
    setDeleting(id);
    if (el) {
      await new Promise<void>(r => gsap.to(el, { autoAlpha: 0, scale: 0.9, height: 0, marginBottom: 0, padding: 0, duration: 0.3, ease: 'power2.in', onComplete: r }));
    }
    await deleteBot(id);
    setBots(p => p.filter(b => b.id !== id));
    setDeleting(null);
  };

  return (
    <div ref={pageRef}>
      <div className="header-row">
        <h1 className="page-title">Bot 管理</h1>
      </div>

      {loading && <div className="empty-state">加载中...</div>}

      {!loading && bots.length === 0 && (
        <div className="empty-state">
          暂无 Bot 配置。运行 <code style={{ background: 'var(--bg-card)', padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>npm run login</code> 或 <code style={{ background: 'var(--bg-card)', padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>npm run add-bot</code> 添加。
        </div>
      )}

      {!loading && bots.length > 0 && (
        <div className="bot-list">
          {bots.map(bot => (
            <div key={bot.id} className="bot-card gsap-card">
              <div className="bot-card-header">
                <div className="bot-card-left">
                  <span className="bot-dot" />
                  <span className="bot-name">{bot.nickname}</span>
                </div>
                <button className="btn btn-danger" onClick={e => handleDelete(bot.id, bot.nickname, e.currentTarget.closest('.bot-card') as HTMLElement)} disabled={deleting === bot.id}>
                  删除
                </button>
              </div>
              <div className="bot-meta">
                <MetaRow label="ID" value={bot.id} mono />
                <MetaRow label="Token" value={`${bot.bot_token.slice(0, 20)}...`} mono />
                <MetaRow label="接入点" value={bot.bot_base_url} mono />
                <MetaRow label="创建时间" value={new Date(bot.createdAt).toLocaleString('zh-CN')} mono />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
