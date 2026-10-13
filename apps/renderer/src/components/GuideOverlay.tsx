import { useEffect, useLayoutEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from './Icons';
import { hasSeenGuide, useUi } from '../state/ui';
import '../styles/guide.css';

/**
 * 首次使用指引（用户第五轮第 1 条：「给 app 第一次使用的人整一个简单的功能介绍指引，
 * 给他介绍不同部件的作用，如何使用圆球手势等」）。
 *
 * ## 为什么要做成一整套「走一遍」而不是一条欢迎横幅
 *
 * 这个应用的交互**不是常规桌面应用那一套**：没有菜单栏、没有常驻侧边栏，
 * 导航靠「点空白处冒出 PI 键 → 朝四个方向划」。第一次打开的人不会自己发现这件事，
 * 而发现不了它等于这个应用没法用。所以指引必须**把四个手势一次讲清**，
 * 并且**指向真的那块地方**（而不是只说「屏幕右下角」）。
 *
 * ## 怎么做「指向」
 *
 * 每一步可以给一个 `target`（CSS 选择器）。组件在切换步骤时去量它当前的位置，
 * 在那一块上开一个**挖孔**（一个透明方块 + 一圈 9999px 的 `box-shadow` 压暗四周）
 * 并把卡片摆到不挡它的地方。量不到目标（页面状态不同、元素还没渲染）时**不挖孔**，
 * 只把卡片居中显示、文字照讲——指引绝不该因为「找不到那个元素」而卡住。
 *
 * ## 首次自动弹
 *
 * 挂载后延迟一点检查 `hasSeenGuide()`：等首帧的布局稳定下来再弹，
 * 免得卡片和背景图一起闪。看过之后 `closeGuide()` 会把版本号写进 localStorage。
 */
interface GuideStep {
  /** 抬头小字（哪一类部件）。 */
  kicker: string;
  title: string;
  /** 正文：一句话说清「这是什么、怎么用」。 */
  body: string;
  /** 挖孔的目标（CSS 选择器）；找不到只居中显示。 */
  target?: string;
  /** 手势示意（要画那四支箭头的步骤才给）。 */
  gestures?: readonly { icon: 'chevronUp' | 'chevronDown' | 'chevronLeft' | 'chevronRight'; label: string }[];
}

const GUIDE_STEPS: readonly GuideStep[] = [
  {
    kicker: '从这里开始',
    title: '欢迎用 PI',
    body: '这是一台「全靠手势」的播放器：没有菜单栏、没有常驻侧边栏。想找什么，点空白处把那颗 PI 键叫出来就行。下面五步花半分钟看完，后面就不用猜了。',
  },
  {
    kicker: '第 1 步 · 核心手势',
    title: '点空白处，PI 键就在指尖',
    body: '在播放页任意空白处按一下，那一处就会冒出一颗 PI 圆键。按住它往四个方向划到底再松手：上划去歌单、下划搜索、右划快速设置、左划切换「平凡 / 先锋」两套排版。没划到底就松手＝什么都不做。',
    target: '[data-guide-orb="true"]',
    gestures: [
      { icon: 'chevronUp', label: '上划 · 歌单' },
      { icon: 'chevronDown', label: '下划 · 搜索' },
      { icon: 'chevronRight', label: '右划 · 快速设置' },
      { icon: 'chevronLeft', label: '左划 · 换排版' },
    ],
  },
  {
    kicker: '第 2 步 · 正在播的歌',
    title: '左下角那张名片',
    body: '封面、歌名、歌手、专辑都在这里；点歌手名或专辑名会展开它们的作品，点封面回到歌词页。切歌时它会轻轻脉冲一下——那是「换了一首」的信号。',
    target: '.pi-home__card',
  },
  {
    kicker: '第 3 步 · 歌词',
    title: '歌词跟着唱，也可以点',
    body: '歌词一行为一句、唱到哪亮到哪，有逐字时间轴时会一个字一个字点亮。点某一句歌词可以直接跳到那一句播放。歌词来源、动效主题和逐字参数都在设置里的「歌词」页。',
    target: '[data-lyric-rail]',
  },
  {
    kicker: '第 4 步 · 设置与数据',
    title: '设置里能改什么',
    body: '音源、播放、界面、歌词、账号、日志六页。其中「播放」页底部写着**你的听歌数据与缓存存在哪、占了多少**，也有一键清理；换歌词源、导入自己的歌词都在「歌词」页。',
  },
];

/** 挖孔的四周留白（px）：比元素本身大一圈，看起来才像「点亮」而不是「贴边」。 */
const RING_PADDING = 10;

interface Ring {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 量某个选择器当前的位置；量不到（不存在 / 尺寸为 0）返回 `null`。 */
function measure(target: string): Ring | null {
  const element = document.querySelector(target);
  if (element === null) return null;
  const box = element.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return null;
  return {
    left: box.left - RING_PADDING,
    top: box.top - RING_PADDING,
    width: box.width + RING_PADDING * 2,
    height: box.height + RING_PADDING * 2,
  };
}

/**
 * 卡片摆哪儿：**优先放在挖孔没占的那半屏**。
 *
 * 规则简单到可以一眼看懂：孔在左半屏就把卡片放右侧，孔在下半屏就把卡片放上方，
 * 都没有就居中。指引用不着精确的避让算法，别把卡片压在要讲的那个东西上就够了。
 */
function cardSide(ring: Ring | null): 'left' | 'right' | 'up' | 'down' | 'center' {
  if (ring === null) return 'center';
  const width = window.innerWidth;
  const height = window.innerHeight;
  const ringCx = ring.left + ring.width / 2;
  const ringCy = ring.top + ring.height / 2;
  if (ringCx < width * 0.45) return 'right';
  if (ringCx > width * 0.55) return 'left';
  if (ringCy > height * 0.5) return 'up';
  return 'down';
}

/**
 * 手势那一步要指的那颗球：指引演示球。
 *
 * 位置与 `components/PiQuickOrb.tsx` 的 `quickOrbHomePoint()` **同一套算式**
 * （窗口右侧、垂直居中，留两个半径的呼吸位），但刻意不复用那个函数：
 * 这边只是把「球会长什么样、会在哪出来」指给用户看，不需要真的拖一个能用的球过来；
 * 共用函数会把两个组件绑在一起（改球的几何就得重新审一遍指引）。
 * 半径也照抄 18px，所以大小与真球一致。
 */
const DEMO_ORB_RADIUS = 18;

function demoOrbStyle(): CSSProperties {
  const width = typeof window === 'undefined' ? 0 : window.innerWidth;
  const height = typeof window === 'undefined' ? 0 : window.innerHeight;
  const left = Math.max(width - DEMO_ORB_RADIUS * 2, DEMO_ORB_RADIUS);
  const top = Math.min(Math.max(Math.round(height / 2), DEMO_ORB_RADIUS), Math.max(DEMO_ORB_RADIUS, height - DEMO_ORB_RADIUS));
  return {
    left: `${left - DEMO_ORB_RADIUS}px`,
    top: `${top - DEMO_ORB_RADIUS}px`,
    width: `${DEMO_ORB_RADIUS * 2}px`,
    height: `${DEMO_ORB_RADIUS * 2}px`,
  };
}

export function GuideOverlay(): ReactNode {
  const open = useUi((s) => s.guideOpen);
  const step = useUi((s) => s.guideStep);
  const setStep = useUi((s) => s.setGuideStep);
  const close = useUi((s) => s.closeGuide);
  const openGuide = useUi((s) => s.openGuide);
  const [ring, setRing] = useState<Ring | null>(null);

  /**
   * 首次自动弹。
   *
   * 延迟 900ms：第一帧还要去拉设置、取歌、算封面配色，太早弹出来会跟界面的入场动画抢戏。
   * 只弹一次——`hasSeenGuide()` 读的是 localStorage 里的**版本号**，关掉时写回。
   *
   * 另外两条不弹的例外：用户已经自己点开了设置框（指引会把它盖住），
   * 或者这一趟是冒烟跑（主进程已经把 `pi.onboarded` 写好，这里自然读到「看过了」）。
   */
  useEffect(() => {
    if (open) return undefined;
    const timer = window.setTimeout(() => {
      if (useUi.getState().settingsOpen) return;
      if (!hasSeenGuide()) openGuide(0);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [open, openGuide]);

  // 量孔：用 `useLayoutEffect`（切换步骤要在同一帧把孔摆好，否则会看到它跳一下）。
  useLayoutEffect(() => {
    if (!open) return undefined;
    const target = GUIDE_STEPS[step]?.target;
    const update = (): void => setRing(target === undefined ? null : measure(target));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open, step]);

  // 目标元素本身会动（做入场动画、切歌重新挂载）：每一帧复核一次位置，跟着它走。
  useEffect(() => {
    if (!open) return undefined;
    const target = GUIDE_STEPS[step]?.target;
    if (target === undefined) return undefined;
    let raf = 0;
    const tick = (): void => {
      setRing(measure(target));
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [open, step]);

  // Esc / 方向键：整套指引只用键盘也能走完。
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        setStep(Math.min(step + 1, GUIDE_STEPS.length - 1));
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') setStep(Math.max(step - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, open, setStep, step]);

  if (!open) return null;
  const current = GUIDE_STEPS[step];
  if (current === undefined) return null;
  const last = step === GUIDE_STEPS.length - 1;
  const side = cardSide(ring);

  return (
    <div className="pi-guide" data-guide="true" data-guide-step={step} data-guide-side={side}>
      {/* 背板：点它不关（指引要看完），只挡住下面的点击。
          它同时负责压暗四周：有孔时孔自己带一圈巨大的阴影把外面压暗，这里就不再叠一层。 */}
      <div className="pi-guide__veil" data-guide-veil={ring === null ? 'true' : 'false'} />

      {/* 手势那一步指一颗**演示球**：真正的球只在按下时出现，指引却要能一直指着它。
          这个球不可交互（`pointer-events: none`），也不写进任何业务状态。 */}
      {current.target === '[data-guide-orb="true"]' ? (
        <span className="pi-guide__orb" data-guide-orb="true" style={demoOrbStyle()} aria-hidden="true">
          PI
        </span>
      ) : null}

      {/* 挖孔。`box-shadow: 0 0 0 9999px rgba(...)` 是这套「只亮一块」的标准做法：
          一个方块 + 一片无边界的阴影，比真的去裁四块遮罩简单得多，也不会有缝。 */}
      {ring === null ? null : (
        <div
          className="pi-guide__ring"
          data-guide-ring="true"
          style={{
            left: `${ring.left}px`,
            top: `${ring.top}px`,
            width: `${ring.width}px`,
            height: `${ring.height}px`,
          }}
        />
      )}

      <section className="pi-guide__card" role="dialog" aria-modal="true" aria-label="使用指引">
        <header className="pi-guide__head">
          <span className="pi-guide__kicker">{current.kicker}</span>
          <button
            type="button"
            className="pi-guide__close"
            data-guide-close="true"
            aria-label="跳过指引"
            onClick={close}
          >
            <Icon name="close" size={15} />
          </button>
        </header>

        <h2 className="pi-guide__title">{current.title}</h2>
        <p className="pi-guide__body">{current.body}</p>

        {current.gestures === undefined ? null : (
          <div className="pi-guide__gestures" data-guide-gestures="true">
            {current.gestures.map((gesture) => (
              <span className="pi-guide__gesture" key={gesture.label}>
                <span className="pi-guide__gesture-arrow" aria-hidden="true">
                  <Icon name={gesture.icon} size={15} />
                </span>
                {gesture.label}
              </span>
            ))}
          </div>
        )}

        <footer className="pi-guide__foot">
          {/* 步骤圆点：既是进度也是「还剩几步」的暗示，点一下能直接跳过去。 */}
          <div className="pi-guide__dots" role="tablist" aria-label="指引步骤">
            {GUIDE_STEPS.map((entry, index) => (
              <button
                key={entry.title}
                type="button"
                role="tab"
                className="pi-guide__dot"
                data-guide-dot={index}
                data-active={index === step}
                aria-label={entry.title}
                aria-selected={index === step}
                onClick={() => setStep(index)}
              />
            ))}
          </div>
          <div className="pi-guide__actions">
            <button type="button" className="pi-btn pi-btn--ghost" data-guide-skip="true" onClick={close}>
              跳过
            </button>
            {step > 0 ? (
              <button
                type="button"
                className="pi-btn"
                data-guide-prev="true"
                onClick={() => setStep(step - 1)}
              >
                上一步
              </button>
            ) : null}
            <button
              type="button"
              className="pi-btn pi-btn--primary"
              data-guide-next="true"
              onClick={() => (last ? close() : setStep(step + 1))}
            >
              {last ? '开始用' : '下一步'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
