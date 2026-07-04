import { useState, useRef, FormEvent } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { login, setToken } from './api';

interface Props { onLogin: () => void }

export default function LoginPage({ onLogin }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    const card = cardRef.current;
    if (!card) return;
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const tl = gsap.timeline({ defaults: { ease: 'power4.out' } });
      tl.fromTo(card, { autoAlpha: 0, y: 20, scale: 0.97 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.5 });
      const inputs = card.querySelectorAll<HTMLElement>('input, button');
      tl.fromTo(inputs, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.25, stagger: 0.06 }, '-=0.15');
    });
    return () => mm.revert();
  }, { scope: cardRef });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await login(username, password);
      setToken(res.token);
      const card = cardRef.current;
      if (card) await gsap.to(card, { autoAlpha: 0, scale: 0.95, duration: 0.15, ease: 'power2.in' });
      onLogin();
    } catch {
      setError('用户名或密码错误');
      const card = cardRef.current;
      if (card) gsap.fromTo(card, { x: -5 }, { x: 5, duration: 0.06, repeat: 3, yoyo: true, ease: 'power1.inOut', clearProps: 'x' });
    } finally { setLoading(false); }
  };

  return (
    <div className="login-page">
      <div ref={cardRef} className="login-card">
        <form onSubmit={handleSubmit}>
          <h1>WeChat Bot</h1>
          <p>管理面板 — 请输入账号密码</p>
          <input className="login-input" type="text" placeholder="用户名" value={username}
            onChange={e => setUsername(e.target.value)} autoFocus />
          <input className="login-input" type="password" placeholder="密码" value={password}
            onChange={e => setPassword(e.target.value)} />
          {error && <div className="login-error">{error}</div>}
          <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%' }}>
            {loading ? '登录中...' : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
}
