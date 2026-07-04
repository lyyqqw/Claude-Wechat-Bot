import { useState, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import type { LogEntry } from '../api';
import type { OutletContext } from '../components/Layout';

const LEVELS = [
  { key: 'all', label: '全部' },
  { key: 'info', label: '信息' },
  { key: 'warn', label: '警告' },
  { key: 'error', label: '错误' },
];

export default function LogsPage() {
  const { activity } = useOutletContext<OutletContext>();
  const logs = activity.slice().reverse();
  const [filter, setFilter] = useState('all');
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  useGSAP(() => {
    const s = pageRef.current;
    if (!s) return;
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const tl = gsap.timeline({ defaults: { ease: 'power4.out' } });
      const title = s.querySelector<HTMLElement>('.gsap-title');
      if (title) tl.fromTo(title, { autoAlpha: 0, y: -6 }, { autoAlpha: 1, y: 0, duration: 0.3 });
      const bar = s.querySelector<HTMLElement>('.gsap-bar');
      if (bar) tl.fromTo(bar, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.25 }, '-=0.15');
      const lc = s.querySelector<HTMLElement>('.log-container');
      if (lc) tl.fromTo(lc, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.35, delay: 0.15 });
    });
    return () => mm.revert();
  }, { scope: pageRef });

  // Auto-scroll and animate new entries
  var prevLen = useRef(0);
  useGSAP(() => {
    const el = containerRef.current;
    if (!el) return;
    if (autoScroll.current) el.scrollTop = el.scrollHeight;
    var last = el.lastElementChild as HTMLElement | null;
    if (last && last.dataset.a !== '1') { last.dataset.a = '1'; gsap.fromTo(last, { autoAlpha: 0, x: -6 }, { autoAlpha: 1, x: 0, duration: 0.15, ease: 'power2.out' }); }
    prevLen.current = logs.length;
  }, { scope: containerRef, dependencies: [logs.length] });

  const filtered = filter === 'all' ? logs : logs.filter(l => l.level === filter);

  return (
    <div ref={pageRef}>
      <div className="header-row gsap-title">
        <h1 className="page-title">实时日志</h1>
      </div>

      <div className="filter-bar gsap-bar">
        {LEVELS.map(l => (
          <button key={l.key} onClick={() => setFilter(l.key)}
            className={`filter-btn${filter === l.key ? ' active' : ''}`}>{l.label}</button>
        ))}
      </div>

      <div className="log-container" ref={containerRef} onScroll={() => {
        const el = containerRef.current;
        if (el) autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}>
        {filtered.length === 0 && <div className="empty-state">等待日志...</div>}
        {filtered.map((entry, i) => (
          <div key={`${entry.time}-${i}`} className="log-entry">
            <span className="log-time">{new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false })}</span>
            <span className={`log-level ${entry.level}`}>{entry.level.toUpperCase()}</span>
            <span className="log-msg">{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
