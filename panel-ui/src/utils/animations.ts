/**
 * GSAP 动画工具 — 供 useGSAP() 内调用的动画工厂
 *
 * 所有函数返回 Tween/Timeline 实例，交由 useGSAP context 自动 revert。
 */
import gsap from 'gsap';

type StaggerOpts = {
  y?: number;
  duration?: number;
  stagger?: number;
  from?: 'start' | 'end' | 'center' | 'edges' | 'random';
};

/**
 * 页面分层切入（标题 → 内容块）
 */
export function pageEnterTL(
  scope: HTMLElement | null,
  itemSelector?: string,
) {
  if (!scope) return gsap.timeline();
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
  const title = scope.querySelector<HTMLElement>('.page-title');
  if (title) {
    tl.fromTo(title, { autoAlpha: 0, y: -10 }, { autoAlpha: 1, y: 0, duration: 0.3 }, 0);
  }
  if (itemSelector) {
    const items = scope.querySelectorAll<HTMLElement>(itemSelector);
    if (items.length) {
      tl.fromTo(
        items,
        { autoAlpha: 0, y: 14 },
        { autoAlpha: 1, y: 0, duration: 0.35, stagger: 0.04 },
        title ? '-=0.1' : 0,
      );
    }
  }
  return tl;
}

/**
 * 错位切入
 */
export function staggerIn(
  els: Element[] | NodeListOf<Element> | null,
  opts: StaggerOpts = {},
) {
  if (!els || !els.length) return gsap.timeline();
  const { y = 12, duration = 0.35, stagger = 0.05, from = 'start' } = opts;
  return gsap.fromTo(
    els,
    { autoAlpha: 0, y },
    { autoAlpha: 1, y: 0, duration, stagger: { each: stagger, from }, ease: 'power2.out' },
  );
}

/**
 * 单元素上移淡入
 */
export function fadeUp(el: HTMLElement | null, delay = 0, duration = 0.4) {
  if (!el) return gsap.timeline();
  return gsap.fromTo(
    el,
    { autoAlpha: 0, y: 12 },
    { autoAlpha: 1, y: 0, duration, delay, ease: 'power3.out' },
  );
}

/**
 * 缩放淡入
 */
export function scaleIn(el: HTMLElement | null, delay = 0, duration = 0.4) {
  if (!el) return gsap.timeline();
  return gsap.fromTo(
    el,
    { autoAlpha: 0, scale: 0.95 },
    { autoAlpha: 1, scale: 1, duration, delay, ease: 'power3.out' },
  );
}

/**
 * 数字递增计数器
 */
export function countUp(el: HTMLElement | null, value: number, duration = 0.8) {
  if (!el) return gsap.timeline();
  return gsap.fromTo(
    el,
    { textContent: 0 },
    { textContent: value, duration, ease: 'power2.out', snap: { textContent: 1 } },
  );
}

/**
 * 新条目滑入（日志流用）
 */
export function slideIn(el: HTMLElement | null) {
  if (!el) return;
  gsap.fromTo(el, { autoAlpha: 0, x: -8 }, { autoAlpha: 1, x: 0, duration: 0.2, ease: 'power2.out' });
}

/**
 * 元素删除（收缩淡出）
 */
export function fadeOutAndCollapse(el: HTMLElement | null): Promise<void> {
  return new Promise(resolve => {
    if (!el) { resolve(); return; }
    gsap.to(el, {
      autoAlpha: 0, scale: 0.9, height: 0, marginBottom: 0, padding: 0, duration: 0.3,
      ease: 'power2.in', onComplete: resolve,
    });
  });
}

/**
 * 呼吸脉冲（状态指示点）
 */
export function pulse(el: HTMLElement | null) {
  if (!el) return () => {};
  const anim = gsap.to(el, {
    keyframes: [
      { boxShadow: '0 0 0 0 rgba(0, 212, 126, 0.25)' },
      { boxShadow: '0 0 0 6px rgba(0, 212, 126, 0)' },
    ],
    duration: 2,
    repeat: -1,
    ease: 'power1.inOut',
  });
  return () => anim.kill();
}

/**
 * 创建 reduced-motion 匹配器
 * @param normal 非 reduced-motion 时执行的函数，返回清理函数
 */
export function withMotion(normal: () => (() => void) | void): () => void {
  const mm = gsap.matchMedia();
  mm.add('(prefers-reduced-motion: no-preference)', () => {
    const cleanup = normal();
    return () => { cleanup?.(); };
  });
  return () => mm.revert();
}
