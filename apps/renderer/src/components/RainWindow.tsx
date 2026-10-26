import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';

import { paintDynamicTrails, paintStaticRain, paintStaticRainRegion } from '../lib/rain-canvas';
import {
  buildRainLayout,
  dynamicDropMetrics,
  rainSizeScale,
  type RainDynamicCycle,
  type RainDynamicDrop,
} from '../lib/rain-layout';
import { buildRefractionMap } from '../lib/rain-refraction-map';
import {
  dynamicLensSpriteUrl,
  LENS_FILTER_SCALE,
  TRANSPARENT_LENS_URL,
} from '../lib/rain-lens-map';
import {
  createRainSimulation,
  stepRainSimulation,
  summarizeSimulation,
  takeDirtyRects,
  type RainSimulationState,
  type RainViewport,
} from '../lib/rain-simulation';

/**
 * 播放页的「雨窗」效果。
 *
 * 它是一层**纯装饰**：挂在播放页的舞台里（歌词之后、名片之前），`z-index: 2`；
 * `pointer-events: none`，不挡任何点击。左边名片、进度条、评论抽屉仍在它上面。
 *
 * === 这一版解决什么 ===
 * 上一版的雨是「几百颗白点 + 22 颗肥皂泡 + 6 颗匀速下滑的 blur 球」：小珠像雪、大水珠
 * 有一圈完整白边，滑动水珠的折射不跟位置（只是普通 backdrop blur）。这一版：
 *
 * 1. **附着水珠**（canvas）：团簇状、大小/形状/透明度都不同；大珠进静态折射图，透过它
 *    看得到被真正弯折的背景。小珠不再点白高光，只在偏心位置留一颗很小的冷光。
 * 2. **动态水珠**（DOM + 仿真）：积聚 → 释放 → 重力加速 → 钉点停顿 → 合并 → 滑出，
 *    每颗有自己的节奏，不是匀速循环。
 * 3. **动态折射**：不再给每颗水珠挂 `backdrop-filter`。整场雨共用**一个** SVG 滤镜：
 *    静态位移图当底，2 个 `feImage` 透镜精灵按当前坐标叠上去，`feDisplacementMap`
 *    每帧弯折真实背景。没有逐帧全屏 PNG，也没有「逐水滴 SVG backdrop」。
 * 4. **湿痕**：短的、弯的、1px 上下的水痕，按年龄变淡；不是从上到下的长亮线。
 *
 * === 三层结构 ===
 * - `__refract`：整屏折射层（在 `__wet` 外面，避免被祖先 mask/contain 隔离掉采样）；
 * - `__wet`：静态 canvas、动态湿痕 canvas、动态水珠本体；整层中心淡、四周浓，保歌词；
 * - `__tint` / `__fog` / `__glare`：湿玻璃的氛围层，浓度比上一版低，避免糊住歌词。
 *
 * === 性能约束 ===
 * - React 不参与逐帧：所有运动都在 rAF 里直接改 `transform` / `opacity` / `feImage` 属性；
 * - 静态 canvas 只在换歌、改窗口、合并小珠时重画；合并只重画一小块脏区；
 * - 动态湿痕 canvas 是 1x，每帧只画几条短痕；
 * - 隐藏时停 rAF；reduced-motion 只画一张静态快照。
 *
 * === 探针 ===
 * `window.__PI_RAIN_PROBE__` 每帧更新（只读数字，不参与渲染）：
 * `{ version, seed, frames, simTime, viewport, drops, attached, sliding, paused, merges,
 *    hidden, reducedMotion, staticRefraction, dynamicRefraction }`。
 * Codex 可以用 CDP 读它 + 外部 rAF 计数实测 FPS，不要用历史注释里的帧率。
 */

export interface RainWindowProps {
  /** 当前歌曲 id：同一首歌永远铺同一场雨（切歌才换）。 */
  seed: number;
}

/**
 * 动态折射槽位数。
 *
 * 不是「不想给 9 颗都折射」，而是**真实透镜图的数量会直接压垮整屏滤镜**：实测 0 张
 * 144fps、1 张 144fps、2 张 128fps、3 张 85fps、4 张约 95fps（水珠本体还在动）。
 * 所以只给尺寸最大的 2 颗配透镜，其余 7 颗保留本体高光/暗边；这样既保留「滑动水珠
 * 真的折背景」，又不让滤镜每帧重算到掉帧。
 */
const DYNAMIC_LENS_SLOTS = 2;

/**
 * 动态透镜的**整批**更新节流。
 *
 * 滤镜是整屏的：任何一个 `feImage` 属性变化，都会让整张折射图重算一次。之前每颗水珠
 * 各按自己的节奏写属性，三四颗在滑就等于每帧都在重算。这里改成**一批一起写**：
 * 每 45fps 扫一遍所有槽位，只写真正动了的透镜；其余帧完全不碰滤镜，浏览器可以复用
 * 上一帧的折射结果。水珠本体仍然 144fps 平滑移动。
 */
const LENS_BATCH_INTERVAL_MS = 1000 / 45;
/** 位置/尺寸变化小于这个值就当没动，省掉一次整屏滤镜重算。 */
const LENS_MIN_DELTA_PX = 0.5;

interface LensAttrState {
  href: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

interface RainProbe {
  version: 2;
  seed: number;
  frames: number;
  simTime: number;
  viewport: RainViewport;
  drops: number;
  attached: number;
  sliding: number;
  paused: number;
  finished: number;
  merges: number;
  residuals: number;
  hidden: boolean;
  reducedMotion: boolean;
  staticRefraction: boolean;
  dynamicRefraction: boolean;
}

declare global {
  interface Window {
    __PI_RAIN_PROBE__?: RainProbe;
  }
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  useEffect(() => {
    const onChange = (): void => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return hidden;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (): void => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** 监听雨窗根节点的实际像素尺寸；rAF 合帧，拖窗口时不要每毫秒 setState。 */
function useElementSize(ref: RefObject<HTMLDivElement | null>): RainViewport {
  const [size, setSize] = useState<RainViewport>({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    let frame = 0;
    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      const width = Math.max(0, Math.round(rect.width));
      const height = Math.max(0, Math.round(rect.height));
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    const schedule = (): void => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ref]);
  return size;
}

function scaledBaseSize(cycle: RainDynamicCycle, width: number): number {
  return Math.max(0.1, cycle.baseSizePx * rainSizeScale(Math.max(1, width)));
}

export function RainWindow({ seed }: RainWindowProps): ReactNode {
  const layout = useMemo(() => buildRainLayout(seed), [seed]);
  const hidden = useDocumentHidden();
  const reduced = useReducedMotion();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const staticCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const trailCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dropRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const lensRefs = useRef<Array<SVGFEImageElement | null>>([]);
  const lensStateRef = useRef<Array<LensAttrState | undefined>>([]);
  const lastLensBatchRef = useRef(0);
  const cycleRef = useRef<number[]>([]);
  const simRef = useRef<RainSimulationState | null>(null);
  const framesRef = useRef(0);
  const staticRefractionRef = useRef(false);
  const hiddenRef = useRef(hidden);
  const reducedRef = useRef(reduced);
  hiddenRef.current = hidden;
  reducedRef.current = reduced;
  const viewport = useElementSize(rootRef);
  const [refractionUrl, setRefractionUrl] = useState('');
  // `useId` 带冒号，做 DOM id 不方便；剔掉非字母数字，保证 `url(#…)` 能解析。
  const idPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, '') || 'pi-rain';
  /*
   * 只给「最大」的 2 颗动态水珠配透镜：它们的折射最容易被看见，而且槽位数固定，
   * 不会因为某颗滑到一半换槽导致折射闪一下。其余 7 颗仍保留可见的水珠本体。
   */
  const lensDropIndices = useMemo(
    () =>
      layout.dynamicDrops
        .map((drop, index) => ({
          index,
          size: Math.max(...drop.cycles.map((cycle) => cycle.baseSizePx)),
        }))
        .sort((a, b) => b.size - a.size || a.index - b.index)
        .slice(0, DYNAMIC_LENS_SLOTS)
        .map((item) => item.index),
    [layout.dynamicDrops],
  );

  /*
   * 稳定的 ref 回调：内联箭头每次渲染都会换身份，React 会把 ref 先置 null 再设回元素，
   * 静态图生成等普通重渲染就会把 feImage 的动态属性擦回透明。这里只建一次。
   */
  const lensRefCallbacks = useMemo(
    () =>
      Array.from(
        { length: DYNAMIC_LENS_SLOTS },
        (_, index) => (element: SVGFEImageElement | null) => {
          lensRefs.current[index] = element;
          if (!element) return;
          element.setAttribute('href', TRANSPARENT_LENS_URL);
          element.setAttribute('x', '0');
          element.setAttribute('y', '0');
          element.setAttribute('width', '0');
          element.setAttribute('height', '0');
          lensStateRef.current[index] = {
            href: TRANSPARENT_LENS_URL,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            visible: false,
          };
        },
      ),
    [],
  );
  const dropRefCallbacks = useMemo(
    () =>
      layout.dynamicDrops.map((_, index) => (element: HTMLSpanElement | null) => {
        dropRefs.current[index] = element;
      }),
    [layout.dynamicDrops],
  );

  staticRefractionRef.current = refractionUrl !== '';

  /*
   * 静态整屏位移图：只在换歌 / 改窗口尺寸时烤一次。
   * 用 rAF 把这次生成推到下一帧，先让页面把雨层挂上，不要阻塞首屏。
   */
  useEffect(() => {
    if (viewport.width < 2 || viewport.height < 2) return undefined;
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) return;
      const url = buildRefractionMap(layout, viewport);
      if (!cancelled) setRefractionUrl(url);
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [layout, viewport]);

  /**
   * 每帧的 DOM 写入集中在这里：不 setState，不触发 React  reconcile。
   *
   * 这里同时更新：
   * - 9 颗动态水珠的 `transform` / `opacity` / 高光；
   * - 2 个 `feImage` 透镜的位置和尺寸（只挑最大的 2 颗，动态折射跟位置走）；
   * - 只读探针。
   */
  const renderFrame = useCallback(
    (sim: RainSimulationState, now: number): void => {
      const summary = summarizeSimulation(sim);
      const width = sim.viewport.width;
      const lensBatchDue = now - lastLensBatchRef.current >= LENS_BATCH_INTERVAL_MS;
      if (lensBatchDue) lastLensBatchRef.current = now;

      // 1) 所有动态水珠的本体：每帧平滑更新 transform / opacity / 高光。
      for (let index = 0; index < sim.drops.length; index += 1) {
        const drop = sim.drops[index];
        const element = dropRefs.current[index];
        if (!drop || !element) continue;
        const def: RainDynamicDrop | undefined = layout.dynamicDrops[index];
        const cycle = def?.cycles[drop.cycleIndex];
        if (!cycle) continue;

        /*
         * 本体固定成 baseDiameter，长多大/拉多长都只靠 transform；折射框直接用
         * `dynamicDropMetrics` 的同一对 width/height。两套几何从此只有一个来源。
         */
        const baseDiameter = scaledBaseSize(cycle, width);
        if (cycleRef.current[index] !== drop.cycleIndex) {
          cycleRef.current[index] = drop.cycleIndex;
          element.style.width = `${baseDiameter}px`;
          element.style.height = `${baseDiameter}px`;
          element.style.marginLeft = `${-baseDiameter / 2}px`;
          element.style.marginTop = `${-baseDiameter / 2}px`;
        }

        const metrics = dynamicDropMetrics(
          baseDiameter,
          drop.radius,
          drop.speed,
          cycle.shape.squash,
        );
        element.style.transform = `translate3d(${drop.x.toFixed(2)}px, ${drop.y.toFixed(
          2,
        )}px, 0) scale(${metrics.scaleX.toFixed(3)}, ${metrics.scaleY.toFixed(3)})`;
        element.style.opacity = drop.opacity.toFixed(3);
        if (element.dataset.phase !== drop.phase) element.dataset.phase = drop.phase;
        const glow = element.firstElementChild;
        if (glow instanceof HTMLElement) {
          glow.style.opacity = (drop.mergeFlash * 0.55).toFixed(3);
        }
      }

      /*
       * 2) 折射批次：只扫 2 个固定槽位。不在批次里的帧完全不碰滤镜，浏览器可以复用
       *    上一帧的整屏折射结果；这就是「减少每帧滤镜更新」的落点。
       */
      if (lensBatchDue) {
        for (let slot = 0; slot < DYNAMIC_LENS_SLOTS; slot += 1) {
          const dropIndex = lensDropIndices[slot];
          const lens = lensRefs.current[slot];
          const state = lensStateRef.current[slot];
          if (dropIndex === undefined || !lens || !state) continue;
          const drop = sim.drops[dropIndex];
          const def = layout.dynamicDrops[dropIndex];
          if (!drop) continue;
          const cycle = def?.cycles[drop.cycleIndex];
          if (!cycle) continue;

          const baseDiameter = scaledBaseSize(cycle, width);
          const metrics = dynamicDropMetrics(
            baseDiameter,
            drop.radius,
            drop.speed,
            cycle.shape.squash,
          );
          const visible =
            drop.phase !== 'finished' &&
            drop.opacity >= 0.04 &&
            metrics.width >= 3.5 &&
            metrics.height >= 3.5;

          if (!visible) {
            // 只写一次透明图；静止/结束的槽位之后完全不碰滤镜。
            if (state.visible) {
              lens.setAttribute('href', TRANSPARENT_LENS_URL);
              lens.setAttribute('x', '-10000');
              lens.setAttribute('y', '-10000');
              lens.setAttribute('width', '1');
              lens.setAttribute('height', '1');
              state.href = TRANSPARENT_LENS_URL;
              state.x = -10000;
              state.y = -10000;
              state.width = 1;
              state.height = 1;
              state.visible = false;
            }
            continue;
          }

          const x = drop.x - metrics.width / 2;
          const y = drop.y - metrics.height / 2;
          const href = dynamicLensSpriteUrl(Math.max(metrics.width, metrics.height));
          const hrefChanged = href !== state.href;
          const firstVisible = !state.visible;
          const moved =
            Math.abs(x - state.x) >= LENS_MIN_DELTA_PX ||
            Math.abs(y - state.y) >= LENS_MIN_DELTA_PX ||
            Math.abs(metrics.width - state.width) >= LENS_MIN_DELTA_PX ||
            Math.abs(metrics.height - state.height) >= LENS_MIN_DELTA_PX;

          // 没动到半个像素就不重算整屏滤镜；同一批里所有透镜一起写。
          if (!firstVisible && !hrefChanged && !moved) continue;

          if (firstVisible || hrefChanged) lens.setAttribute('href', href);
          if (firstVisible || hrefChanged || Math.abs(x - state.x) >= 0.01) {
            lens.setAttribute('x', x.toFixed(2));
          }
          if (firstVisible || hrefChanged || Math.abs(y - state.y) >= 0.01) {
            lens.setAttribute('y', y.toFixed(2));
          }
          if (firstVisible || hrefChanged || Math.abs(metrics.width - state.width) >= 0.01) {
            lens.setAttribute('width', metrics.width.toFixed(2));
          }
          if (firstVisible || hrefChanged || Math.abs(metrics.height - state.height) >= 0.01) {
            lens.setAttribute('height', metrics.height.toFixed(2));
          }

          state.href = href;
          state.x = x;
          state.y = y;
          state.width = metrics.width;
          state.height = metrics.height;
          state.visible = true;
        }
      }

      // 探针只读、不参与渲染；每帧覆盖一个小对象，几乎不花钱。
      framesRef.current += 1;
      window.__PI_RAIN_PROBE__ = {
        version: 2,
        seed,
        frames: framesRef.current,
        simTime: sim.time,
        viewport: { width: sim.viewport.width, height: sim.viewport.height },
        drops: sim.drops.length,
        attached: summary.attached,
        sliding: summary.sliding,
        paused: summary.paused,
        finished: summary.finished,
        merges: summary.merges,
        residuals: sim.residualTrails.length,
        hidden: hiddenRef.current,
        reducedMotion: reducedRef.current,
        staticRefraction: staticRefractionRef.current,
        dynamicRefraction: true,
      };
      const root = rootRef.current;
      if (root && framesRef.current % 20 === 0) {
        root.dataset.rainAttached = String(summary.attached);
        root.dataset.rainSliding = String(summary.sliding);
        root.dataset.rainMerges = String(summary.merges);
      }
    },
    [layout, lensDropIndices, seed],
  );

  /*
   * 建仿真 + 画静态层。这个 effect 只在换歌 / 改窗口 / 切 reduced-motion 时重跑；
   * 切后台只停动画，不重置雨。
   */
  useEffect(() => {
    const root = rootRef.current;
    const staticCanvas = staticCanvasRef.current;
    const trailCanvas = trailCanvasRef.current;
    if (!root || !staticCanvas || !trailCanvas) return undefined;
    if (viewport.width < 2 || viewport.height < 2) return undefined;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    staticCanvas.width = Math.max(1, Math.round(viewport.width * dpr));
    staticCanvas.height = Math.max(1, Math.round(viewport.height * dpr));
    const staticCtx = staticCanvas.getContext('2d');
    if (!staticCtx) return undefined;
    staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 湿痕是软的细线，1x 就够；换来的是每帧清空/重画的面积小一半以上。
    trailCanvas.width = Math.max(1, Math.round(viewport.width));
    trailCanvas.height = Math.max(1, Math.round(viewport.height));
    const trailCtx = trailCanvas.getContext('2d');
    if (!trailCtx) return undefined;
    trailCtx.setTransform(1, 0, 0, 1, 0, 0);

    const sim = createRainSimulation(layout, viewport);
    simRef.current = sim;
    framesRef.current = 0;
    cycleRef.current = [];
    paintStaticRain(staticCtx, layout, viewport, { consumed: sim.consumedBeads });
    paintDynamicTrails(trailCtx, sim, viewport);
    renderFrame(sim, performance.now());

    return () => {
      if (simRef.current === sim) simRef.current = null;
    };
  }, [layout, renderFrame, viewport]);

  /*
   * 动画循环。切后台 / reduced-motion 时整个 rAF 停掉；回到前台从当前状态继续，
   * 不重置仿真，也不会把后台那段时间一次性补上。
   */
  useEffect(() => {
    if (hidden || reduced) return undefined;
    const sim = simRef.current;
    const staticCanvas = staticCanvasRef.current;
    const trailCanvas = trailCanvasRef.current;
    if (!sim || !staticCanvas || !trailCanvas) return undefined;
    const staticCtx = staticCanvas.getContext('2d');
    const trailCtx = trailCanvas.getContext('2d');
    if (!staticCtx || !trailCtx) return undefined;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let raf = 0;
    let last = performance.now();
    const loop = (now: number): void => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      stepRainSimulation(sim, dt);
      const rects = takeDirtyRects(sim);
      if (rects.length > 0) {
        staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        paintStaticRainRegion(staticCtx, layout, sim.viewport, rects, {
          consumed: sim.consumedBeads,
        });
      }
      paintDynamicTrails(trailCtx, sim, sim.viewport);
      renderFrame(sim, now);
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, [hidden, layout, reduced, renderFrame, viewport]);

  // 切后台/减少动效时，即使 rAF 已停，探针也要如实反映暂停状态。
  useEffect(() => {
    const probe = window.__PI_RAIN_PROBE__;
    if (probe) {
      probe.hidden = hidden;
      probe.reducedMotion = reduced;
    }
  }, [hidden, reduced]);

  useEffect(
    () => () => {
      const probe = window.__PI_RAIN_PROBE__;
      if (probe?.seed === seed) delete window.__PI_RAIN_PROBE__;
    },
    [seed],
  );

  const staticReady = refractionUrl !== '';
  const filterId = `${idPrefix}-refract`;

  return (
    <div
      ref={rootRef}
      className="pi-rain"
      data-rain-window="true"
      data-rain-version="2"
      data-rain-seed={seed}
      data-rain-beads={layout.beads.length}
      data-rain-drops={layout.dynamicDrops.length}
      data-rain-lenses={layout.lenses.length}
      data-rain-lens-drops={lensDropIndices.join(',')}
      data-rain-refraction={staticReady ? 'static+dynamic' : 'dynamic'}
      data-rain-simulation="v2"
      data-paused={hidden ? 'true' : 'false'}
      data-reduced-motion={reduced ? 'true' : 'false'}
      aria-hidden="true"
    >
      {/*
       * 折射滤镜定义。整场雨只有一个 filter：
       * - `feFlood` 128 灰 = 不位移的底；
       * - 静态位移图（一次生成）盖在底上；
       * - 每个动态槽位一个透明边透镜精灵，位置每帧更新；
       * - 最后 `feDisplacementMap` 弯折真实的 SourceGraphic（页面背景/歌词/封面）。
       */}
      <svg className="pi-rain__defs" aria-hidden="true" focusable="false">
        <defs>
          <filter
            id={filterId}
            x="0"
            y="0"
            width="100%"
            height="100%"
            colorInterpolationFilters="sRGB"
          >
            <feFlood floodColor="rgb(128,128,128)" result="rainBase" />
            {staticReady ? (
              <feImage
                href={refractionUrl}
                x="0"
                y="0"
                width="100%"
                height="100%"
                preserveAspectRatio="none"
                result="rainStatic"
              />
            ) : null}
            {Array.from({ length: DYNAMIC_LENS_SLOTS }, (_, index) => (
              <feImage
                key={`rain-lens-${index}`}
                data-lens-drop={lensDropIndices[index]}
                /*
                 * href/x/y/width/height **故意不写进 JSX**：它们每帧由 renderFrame 直接
                 * setAttribute。如果写成 props，React 每次重渲染（切后台、reduced-motion）
                 * 都会把它们重置回初始值，而暂停时没有下一帧来恢复，折射就会突然消失。
                 */
                ref={lensRefCallbacks[index]}
                preserveAspectRatio="none"
                result={`rainDynamic${index}`}
              />
            ))}
            {/*
             * 用**一个** feMerge 把所有透镜叠成一张位移图，而不是逐个 feComposite 串联。
             * 每多一个滤镜 primitive，整屏 backdrop 滤镜就多一次全画布合成；多个 over 是
             * 这版 72fps 的主要来源之一（关掉折射立刻回到 144fps）。
             * feMerge 的透明区域不会盖掉下层，正好符合「精灵外面是透明」的约定。
             */}
            <feMerge result="rainDisplacement">
              <feMergeNode in="rainBase" />
              {staticReady ? <feMergeNode in="rainStatic" /> : null}
              {Array.from({ length: DYNAMIC_LENS_SLOTS }, (_, index) => (
                <feMergeNode key={`rain-mix-${index}`} in={`rainDynamic${index}`} />
              ))}
            </feMerge>
            <feDisplacementMap
              in="SourceGraphic"
              in2="rainDisplacement"
              scale={LENS_FILTER_SCALE}
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>

      {/* 1. 冷色罩染 + 暗角：压一点夜色，但比上一版轻，避免糊住歌词。 */}
      <div className="pi-rain__tint" />
      {/* 2. 玻璃上的水汽：只有四周几团很淡的模糊，不铺满中心。 */}
      <div className="pi-rain__fog" />

      {/*
       * 3. 折射层。**故意放在 __wet 外面**：祖先一旦带 mask/contain/paint，Chromium 可能
       * 把 backdrop 采样隔离在这个子树里，滤镜就只看到透明背景。这里直接对舞台采样。
       */}
      <div
        className="pi-rain__refract"
        style={
          {
            backdropFilter: `url(#${filterId})`,
            WebkitBackdropFilter: `url(#${filterId})`,
          } as CSSProperties
        }
      />

      {/* 4. 雨本体：整层中心淡、四周浓；只罩 canvas/湿痕/水珠本体，不罩折射层。 */}
      <div className="pi-rain__wet">
        <canvas ref={staticCanvasRef} className="pi-rain__static" />
        <canvas ref={trailCanvasRef} className="pi-rain__trails" />
        {layout.dynamicDrops.map((drop, index) => {
          const cycle = drop.cycles[0];
          if (!cycle) return null;
          return (
            <span
              key={`rain-drop-${index}`}
              ref={dropRefCallbacks[index]}
              className="pi-rain__drop"
              data-rain-drop={index}
            >
              <span className="pi-rain__drop-glow" aria-hidden="true" />
            </span>
          );
        })}
      </div>

      {/* 5. 窗面反光：一道很淡的斜向亮带。 */}
      <div className="pi-rain__glare" />
    </div>
  );
}
