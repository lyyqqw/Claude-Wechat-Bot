import { useState, useEffect, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { fetchStatus, type StatusData, type LogEntry } from '../api';
import type { OutletContext } from '../components/Layout';

function AnimatedCounter({ value = 0 }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useGSAP(() => {
    if (!ref.current) return;
    gsap.fromTo(ref.current, { textContent: 0 }, { textContent: value, duration: 0.8, ease: 'power2.out', snap: { textContent: 1 } });
  }, { dependencies: [value], revertOnUpdate: true });
  return <span ref={ref}>0</span>;
}

function WaveBars() {
  const ref = useRef<HTMLDivElement>(null);
  const h = useRef(Array.from({ length: 40 }, () => Math.random() * 16 + 6));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const id = setInterval(() => {
      h.current = h.current.map(v => Math.max(3, Math.min(28, v + (Math.random() - 0.5) * 6)));
      gsap.to(el.children, { height: (i: number) => h.current[i], duration: 0.5, ease: 'power1.inOut', overwrite: 'auto' });
    }, 700);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="wave-container" ref={ref}>
      {Array.from({ length: 40 }, (_, i) => <div key={i} className="wave-bar" />)}
    </div>
  );
}

const STAT_ICONS: Record<string, React.ReactNode> = {
  bot: (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="5" width="10" height="9" rx="1"/><path d="M5 5V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><circle cx="5.5" cy="9" r=".75"/><circle cx="10.5" cy="9" r=".75"/></svg>),
  chat: (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 8a6 6 0 0 1 6-6h0a6 6 0 0 1 6 6v4a1 1 0 0 1-1 1H8a6 6 0 0 1-6-6z"/><path d="M5 7h6"/><path d="M5 9h4"/></svg>),
  clock: (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 2"/></svg>),
  chip: (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="10" height="10" rx="1"/><path d="M3 6H1M3 10H1M13 6h2M13 10h2M6 3V1M10 3V1M6 13v2M10 13v2"/></svg>),
};

const HIDE_SEL = '.gsap-title, .gsap-tile, .gsap-wave, .gsap-ahead, .gsap-alist';

export default function Dashboard() {
  const { activity } = useOutletContext<OutletContext>();
  const [status, setStatus] = useState<StatusData | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dataSynced = useRef(false);

  useEffect(() => { fetchStatus().then(setStatus); }, []);

  // ---- Entrance animation ----
  useGSAP(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const mm = gsap.matchMedia();

    // Reduced motion: reveal everything immediately
    mm.add('(prefers-reduced-motion: reduce)', () => {
      gsap.set(wrap, { autoAlpha: 1 });
      wrap.querySelectorAll(HIDE_SEL).forEach(el => gsap.set(el, { autoAlpha: 1 }));
    });

    // Normal entrance: cascading pop-in
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      // Hide all animatable elements upfront (querySelectorAll avoids GSAP warnings
      // for conditional elements that may not be in DOM yet)
      wrap.querySelectorAll(HIDE_SEL).forEach(el => gsap.set(el, { autoAlpha: 0 }));

      const tl = gsap.timeline({ defaults: { ease: 'power4.out' } });

      // Wrap fade in
      tl.to(wrap, { autoAlpha: 1, duration: 0.3 });

      // Title — slide down + pop
      tl.fromTo('.gsap-title',
        { autoAlpha: 0, y: -12, scale: 0.97 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.35, ease: 'back.out(1.7)' },
        '-=0.1',
      );

      // Stat tiles — stagger pop from below
      tl.fromTo('.gsap-tile',
        { autoAlpha: 0, y: 20, scale: 0.9 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.4, stagger: 0.06, ease: 'back.out(1.7)' },
        '-=0.2',
      );

      // Wave — simple fade
      tl.to('.gsap-wave', { autoAlpha: 1, duration: 0.35 }, '-=0.2');
    });

    return () => mm.revert();
  }, { scope: wrapRef });

// ---- Sync animation: bot cards + activity items appear together ----
  useEffect(() => {
    if (dataSynced.current) return;
    if (!status) return;
    const wrap = wrapRef.current;
    if (!wrap) return;

    dataSynced.current = true;


    // Section headers: bot + activity — pop in together
    const headers = wrap.querySelectorAll<HTMLElement>('.gsap-bhead:not([data-a]), .gsap-ahead:not([data-a])');
    if (headers.length) {
      headers.forEach(el => { el.dataset.a = '1'; });
      gsap.set(headers, { autoAlpha: 0, y: -8, scale: 0.97 });
      gsap.to(headers, { autoAlpha: 1, y: 0, scale: 1, duration: 0.35, stagger: 0.08, ease: 'back.out(1.7)' });
    }

    // Activity list container — pop in (before its children stagger)
    const alist = wrap.querySelector<HTMLElement>('.gsap-alist:not([data-a])');
    if (alist) {
      alist.dataset.a = '1';
      gsap.set(alist, { autoAlpha: 0, y: 12, scale: 0.95 });
      gsap.to(alist, { autoAlpha: 1, y: 0, scale: 1, duration: 0.35, ease: 'back.out(1.7)' });
    }

    // Bot cards + activity items — staggered pop-in
    const items = wrap.querySelectorAll<HTMLElement>('.gsap-bcard:not([data-a]), .activity-item:not([data-a])');
    if (items.length) {
      items.forEach(el => { el.dataset.a = '1'; });
      gsap.fromTo(items,
        { autoAlpha: 0, y: 12, scale: 0.94 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.35, stagger: 0.04, ease: 'back.out(1.7)' },
      );
    }
  }, [status, activity.length]);

  // ---- Animate newly arriving activity items (after initial sync has run) ----
  useEffect(() => {
    if (!dataSynced.current) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const items = wrap.querySelectorAll<HTMLElement>('.activity-item:not([data-a])');
    if (!items.length) return;
    items.forEach(el => {
      el.dataset.a = '1';
      gsap.set(el, { autoAlpha: 0, y: 12, scale: 0.94 });
      gsap.to(el, { autoAlpha: 1, y: 0, scale: 1, duration: 0.2, ease: 'back.out(1.7)' });
    });
  }, [activity.length]);

  const botList = status?.botList || [];

  const stats = [
    { key: 'bot', val: status?.bots ?? 0, label: '在线 Bot', unit: '' },
    { key: 'chat', val: status?.totalSessions ?? 0, label: '活跃会话', unit: '' },
    { key: 'clock', val: 0, label: '运行时间', unit: '', display: status?.uptimeStr ?? '--' },
    { key: 'chip', val: Math.round(status?.memoryMB ?? 0), label: '内存占用', unit: 'MB' },
  ];

  return (
    <div ref={wrapRef} className="dashboard-wrap" style={{ opacity: 0 }}>
      <div className="header-row gsap-title">
        <h1 className="page-title">仪表盘</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <span className="status-dot" />
          <span style={{ color: 'var(--accent)', fontWeight: 500 }}>{status ? '系统正常' : '加载中...'}</span>
        </div>
      </div>

      <div className="stat-grid">
        {stats.map((s, i) => (
          <div key={i} className="stat-tile gsap-tile">
            <div className="stat-tile-accent" />
            <div className="stat-tile-icon">{STAT_ICONS[s.key]}</div>
            <div className="stat-tile-value">
              {s.display ?? (status ? <AnimatedCounter value={s.val as number} /> : '--')}
              {s.unit && <span className="stat-tile-unit">{s.unit}</span>}
            </div>
            <div className="stat-tile-label">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="wave-wrap gsap-wave">
        <WaveBars />
      </div>

      {botList.length > 0 && (
        <>
          <div className="section-head gsap-bhead"><h2>在线 Bot</h2></div>
          <div className="bot-grid">
            {botList.map(bot => (
              <div key={bot.id} className="bot-card gsap-bcard">
                <div className="bot-card-header">
                  <div className="bot-card-left">
                    <span className="bot-dot" />
                    <span className="bot-name">{bot.nickname}</span>
                  </div>
                </div>
                <div className="bot-meta">
                  <div className="bot-meta-row">
                    <span>会话数</span>
                    <span className="mono">{bot.sessions}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-head gsap-ahead"><h2>最近活动</h2></div>
      <div className="activity-list gsap-alist">
        {activity.length === 0 && <div className="empty-state">等待活动数据...</div>}
        {activity.slice(0, 20).map((e, i) => (
          <div key={i} className="activity-item gsap-aitem">
            <span className="activity-time">{new Date(e.time).toLocaleTimeString('zh-CN', { hour12: false })}</span>
            <span className={`level-badge ${e.level}`}>{e.level.toUpperCase()}</span>
            <span className="activity-msg">{e.message.slice(0, 120)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
