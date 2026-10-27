import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSettings } from '../lib/queries';
import '../styles/startup-intro.css';

/**
 * 应用启动时的品牌开场。
 *
 * 只在窗口第一次挂载时播一次：一个放大的艺术体 π + 一行「愿你澄澈」，
 * 约 1.4 秒后淡出；点击任意处 / 按任意键可以提前跳过。
 *
 * 一个启动时序上的取舍：
 * - 设置本身在主进程里，异步读回来要约几百毫秒；如果等它到位再盖开场，用户会先看到
 *   应用、再被开场盖住，像「迟到的一层遮罩」。
 * - 所以本机留一份 `pi.startup-intro` 小缓存（设置每次变化时同步写）。首帧先按缓存
 *   决定播不播：缓存说关就直接不渲染，缓存说开/还没有缓存就立刻播；设置读回来后再
 *   校对一次——真关了就让这层提前淡出，并把缓存改成正确的值。
 * - `startedRef` 只让「校对」发生一次；之后用户再改设置也不会在本次运行里重播。
 */
const INTRO_HOLD_MS = 1100;
const INTRO_OUT_MS = 360;
const INTRO_CACHE_KEY = 'pi.startup-intro';

type IntroPhase = 'playing' | 'leaving' | 'done';

function initialPhase(): IntroPhase {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'done';
  try {
    if (window.localStorage.getItem(INTRO_CACHE_KEY) === 'off') return 'done';
  } catch {
    /* 隐私模式禁 localStorage 时按默认「开」走，不影响开场。 */
  }
  return 'playing';
}

export function StartupIntro(): ReactNode {
  const settings = useSettings();
  const [phase, setPhase] = useState<IntroPhase>(initialPhase);
  const syncedRef = useRef(false);
  /**
   * 这次运行里到底播过没有：用来区分「首帧缓存说关所以没播」和「已经播完」。
   * 前者在设置读回来发现其实是开时可以补播；后者绝不能重播。
   */
  const playedRef = useRef(phase === 'playing');

  // 设置第一次读回来时校对首帧缓存；只认一次，之后不重播。
  useEffect(() => {
    if (syncedRef.current || settings.data === undefined) return;
    syncedRef.current = true;
    const enabled = settings.data.startupIntro !== false;
    if (!enabled) {
      setPhase((current) => (current === 'playing' ? 'leaving' : current));
      return;
    }
    // 缓存是旧的「关」、但设置其实是开：补播一次（迟到总比没有好）。
    if (!playedRef.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      playedRef.current = true;
      setPhase((current) => (current === 'done' ? 'playing' : current));
    }
  }, [settings.data]);

  // 设置每次变化都同步本机缓存，下次启动首帧就能直接判断。
  useEffect(() => {
    const enabled = settings.data?.startupIntro;
    if (enabled === undefined) return;
    try {
      window.localStorage.setItem(INTRO_CACHE_KEY, enabled ? 'on' : 'off');
    } catch {
      /* 缓存写不进去只影响下一次首帧，不影响本次。 */
    }
  }, [settings.data?.startupIntro]);

  useEffect(() => {
    if (phase !== 'playing') return undefined;
    const finish = (event: KeyboardEvent): void => {
      // 开场期间任意键都只负责跳过；别让空格 / 方向键同时落到下面的播放页。
      event.preventDefault();
      event.stopImmediatePropagation();
      setPhase('leaving');
    };
    const timer = window.setTimeout(() => setPhase('leaving'), INTRO_HOLD_MS);
    window.addEventListener('keydown', finish, { capture: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', finish, { capture: true });
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== 'leaving') return undefined;
    const timer = window.setTimeout(() => setPhase('done'), INTRO_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  if (phase === 'done') return null;

  return (
    <div
      className="pi-intro"
      data-startup-intro="true"
      data-phase={phase}
      aria-hidden="true"
      onPointerDown={() => {
        if (phase === 'playing') setPhase('leaving');
      }}
    >
      <div className="pi-intro__glow" aria-hidden="true" />
      <div className="pi-intro__content">
        <div className="pi-intro__glyph">
          <span className="pi-intro__logo">π</span>
        </div>
        <div className="pi-intro__tagline">愿你澄澈</div>
      </div>
    </div>
  );
}
