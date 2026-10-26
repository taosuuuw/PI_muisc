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
import {
  buildCombinedRainFieldPixels,
  prepareCombinedRainFieldBase,
  TRANSPARENT_FIELD_URL,
  type RainFieldBase,
  type RainFieldPixelsResult,
} from '../lib/rain-field-map';
import { RainFieldEncoder } from '../lib/rain-field-encoder';
import {
  RainFieldWorkerClient,
  type RainFieldWorkerLike,
} from '../lib/rain-field-worker-client';
import {
  applyRainFilterImageGeometry,
  buildRainFilterGeometry,
} from '../lib/rain-filter-geometry';
import { LENS_FILTER_SCALE } from '../lib/rain-lens-map';
import {
  createRainSimulation,
  snapshotRainReplay,
  stageControlledMergeReplay,
  stepRainSimulation,
  summarizeSimulation,
  takeDirtyRects,
  type RainReplayScenario,
  type RainReplaySnapshot,
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
 * 1. **附着水珠**（canvas）：团簇状、大小/形状/透明度都不同；全部可见珠都进入
 *    共享静态法线场，透过它看得到被真正弯折的背景。canvas 只留极小湿膜和不对称边缘。
 * 2. **动态水珠**（DOM + 仿真）：积聚 → 释放 → 重力加速 → 钉点停顿 → 合并 → 滑出，
 *    每颗有自己的节奏，不是匀速循环。
 * 3. **共享动态场**：全部可见滑滴 + 活跃/残留水路 + 消费洞进同一张 24Hz combined 场图，
 *    换一个 feImage href；`feDisplacementMap` 弯折真实背景，B 通道 coverage
 *    用来把“略柔玻璃”和“珠内清晰偏折”合成。没有逐水滴滤镜，也不逐帧全屏编码。
 * 4. **湿痕**：沿真实滑行路径的 180~450px 湿润水路，头部宽/尾部细，暗侧边 + 细亮边、
 *    中间透明；水珠离开后立即交接并独立保留 5~8 秒，不跟本体淡出或瞬移。
 *
 * === 三层结构 ===
 * - `__refract`：整屏折射层（在 `__wet` 外面，避免被祖先 mask/contain 隔离掉采样）；
 * - `__wet`：静态 canvas、动态湿痕 canvas、动态水珠本体；整层中心淡、四周浓，保歌词；
 * - `__tint` / `__fog` / `__glare`：湿玻璃的氛围层，浓度比上一版低，避免糊住歌词。
 *
 * === 性能约束 ===
 * - React 不参与逐帧：所有运动都在 rAF 里直接改 `transform` / `opacity` / `feImage` 属性；
 * - 静态 canvas 只在换歌、改窗口、合并小珠时重画；合并只重画一小块脏区；
 * - 动态湿痕 canvas 是 1x，每帧按 5 个宽度档批画，单条水迹最多 10 次 stroke；
 * - 隐藏时停 rAF；reduced-motion 只画一张静态快照。
 *
 * === 探针 ===
 * `window.__PI_RAIN_PROBE__` 每帧更新（只读数字，不参与渲染）：
 * `{ version, seed, frames, simTime, viewport, drops, visibleDrops, attached, sliding, paused, merges,
 *    residuals, consumedBeads, consumedLenses, restoredBeads, lensRevision, optics, staticFieldBeads,
 *    staticFieldCoveragePx, staticFieldWrites, staticFieldMs, staticFieldMapWidth/Height,
 *    dynamicFieldDrops, dynamicFieldTrails, dynamicFieldCoveragePx, dynamicFieldWrites,
 *    dynamicFieldMs, dynamicFieldHz, dynamicFieldMapWidth/Height, hidden, reducedMotion,
 *    staticRefraction, dynamicRefraction }`。
 * DEV 下另有 `window.__PI_RAIN_REPLAY__`：`stage('dynamic'|'static')` / `snapshot()`，
 * 只用于可控合并回放，不挂产品 UI。快照带 scenario/note；static 另带真实目标珠
 * `target: { beadId, x, y, radius, hasLens, consumed }`。
 * Codex 可以用 CDP 读它 + 外部 rAF 计数实测 FPS，不要用历史注释里的帧率。
 */

export interface RainWindowProps {
  /** 当前歌曲 id：同一首歌永远铺同一场雨（切歌才换）。 */
  seed: number;
}

/**
 * 动态共享场更新批次。
 *
 * 9 颗滑滴都进同一张 combined 场图，不再每颗一个 feImage；每个批次只换一个
 * feImage href。24Hz 是视觉/编码成本的折中（参考约 21.4fps），物理与主页面 rAF 不降频。
 */
const DYNAMIC_FIELD_BATCH_MS = 1000 / 24;

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
  visibleDrops: number;
  consumedBeads: number;
  consumedLenses: number;
  restoredBeads: number;
  lensesActive: number;
  lensRevision: number;
  hidden: boolean;
  reducedMotion: boolean;
  staticRefraction: boolean;
  dynamicRefraction: boolean;
  /** 透镜批次**目标上限**（Hz）；实际写入次数看 `lensWrites`。不等于渲染 FPS。 */
  lensBatchHz: number;
  /** 旧双透镜探针已无意义；null 表示该架构指标不存在。 */
  lensLeadPx: number | null;
  /** 兼容旧字段：等同 dynamicFieldWrites。 */
  lensWrites: number;
  /** 旧双透镜探针已无意义；null 表示该架构指标不存在。 */
  lensCenterGapPx: number | null;
  optics: string;
  staticFieldBeads: number;
  staticFieldCoveragePx: number;
  staticFieldWrites: number;
  staticFieldMs: number;
  staticFieldMapWidth: number;
  staticFieldMapHeight: number;
  /** 单张 combined 场语义；static/dynamic 计数都来自同一张图。 */
  combinedFieldMapWidth: number;
  combinedFieldMapHeight: number;
  combinedStaticBeads: number;
  combinedStaticTrails: number;
  combinedDynamicDrops: number;
  combinedDynamicTrails: number;
  combinedCoveragePx: number;
  combinedPrepareMs: number;
  combinedStampMs: number;
  combinedEncodeMs: number;
  combinedEncodeP95Ms: number;
  combinedFieldWrites: number;
  combinedCompletedWrites: number;
  combinedInFlight: boolean;
  combinedEncoderBackend: 'worker' | 'fallback' | 'none';
  combinedTargetHz: number;
  combinedUpdateAgeMs: number;
  dynamicFieldDrops: number;
  dynamicFieldTrails: number;
  dynamicFieldCoveragePx: number;
  dynamicFieldWrites: number;
  dynamicFieldMs: number;
  dynamicFieldP95Ms: number;
  dynamicFieldHz: number;
  dynamicFieldMapWidth: number;
  dynamicFieldMapHeight: number;
}

interface RainReplayApi {
  stage: (scenario?: RainReplayScenario) => RainReplaySnapshot | null;
  snapshot: () => RainReplaySnapshot | null;
}

declare global {
  interface Window {
    __PI_RAIN_PROBE__?: RainProbe;
    __PI_RAIN_REPLAY__?: RainReplayApi;
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
  const fieldImageRef = useRef<SVGFEImageElement | null>(null);
  const fieldCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const combinedBaseRef = useRef<RainFieldBase | null>(null);
  const combinedStatsRef = useRef<RainFieldPixelsResult | null>(null);
  const fieldEncoderRef = useRef<RainFieldEncoder | null>(null);
  const fieldWorkerClientRef = useRef<RainFieldWorkerClient | null>(null);
  const fieldSceneTokenRef = useRef(0);
  const fieldUrlRef = useRef(TRANSPARENT_FIELD_URL);
  const lastFieldBatchMsRef = useRef(0);
  const lastFieldCommitMsRef = useRef(0);
  const fieldWritesRef = useRef(0);
  const fieldCompletedRef = useRef(0);
  const fieldPrepareMsRef = useRef(0);
  const fieldStampMsRef = useRef(0);
  const fieldEncodeMsRef = useRef(0);
  const fieldEncodeSamplesRef = useRef<number[]>([]);
  const fieldEncodeP95Ref = useRef(0);
  const cycleRef = useRef<number[]>([]);
  const simRef = useRef<RainSimulationState | null>(null);
  const framesRef = useRef(0);
  const hiddenRef = useRef(hidden);
  const reducedRef = useRef(reduced);
  hiddenRef.current = hidden;
  reducedRef.current = reduced;
  const viewport = useElementSize(rootRef);
  const filterGeometry = buildRainFilterGeometry(viewport.width, viewport.height);
  // `useId` 带冒号，做 DOM id 不方便；剔掉非字母数字，保证 `url(#…)` 能解析。
  const idPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, '') || 'pi-rain';
  const dropRefCallbacks = useMemo(
    () =>
      layout.dynamicDrops.map((_, index) => (element: HTMLSpanElement | null) => {
        dropRefs.current[index] = element;
      }),
    [layout.dynamicDrops],
  );
  const fieldImageRefCallback = useCallback(
    (element: SVGFEImageElement | null) => {
      fieldImageRef.current = element;
      if (element) {
        element.setAttribute('href', fieldUrlRef.current);
        applyRainFilterImageGeometry(
          element,
          buildRainFilterGeometry(viewport.width, viewport.height),
        );
      }
    },
    [viewport.width, viewport.height],
  );

  /**
   * 每帧的 DOM 写入集中在这里：不 setState，不触发 React  reconcile。
   *
   * 这里同时更新：
   * - 9 颗动态水珠的 `transform` / `opacity` / 高光；
   * - 24Hz 更新一张 combined 场 feImage（全部滑滴 + 水路 + 消费洞）；
   * - 只读探针。
   */
  const renderFrame = useCallback(
    (sim: RainSimulationState, now: number): void => {
      const summary = summarizeSimulation(sim);
      const width = sim.viewport.width;

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
          // 形状直接来自 layout；和透镜同宽高、只是四角半径温和不对称。
          element.style.borderRadius = cycle.shape.borderRadius ?? '50%';
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
          glow.style.opacity = (drop.mergeFlash * 0.3).toFixed(3);
        }
      }

      /*
       * 2) 单张 combined 场：缓存静态原图 + 本批消费洞/水路/动态滴覆写。
       *    toBlob/decode 异步且单批 inflight；下一批只取最新 sim，不排队。
       */
      const base = combinedBaseRef.current;
      const encoder = fieldEncoderRef.current;
      const fieldCanvas = fieldCanvasRef.current;
      if (
        base &&
        encoder &&
        fieldCanvas &&
        fieldImageRef.current &&
        !encoder.busy &&
        now - lastFieldBatchMsRef.current >= DYNAMIC_FIELD_BATCH_MS
      ) {
        const token = encoder.tryStart();
        if (token !== null) {
          lastFieldBatchMsRef.current = now;
          fieldWritesRef.current += 1;
          const stampStarted = performance.now();
          const result = buildCombinedRainFieldPixels(base, sim);
          combinedStatsRef.current = result;
          const ctx = fieldCanvas.getContext('2d');
          if (!ctx) {
            encoder.abort(token);
          } else {
            ctx.putImageData(
              new ImageData(result.pixels, base.mapWidth, base.mapHeight),
              0,
              0,
            );
            fieldStampMsRef.current = performance.now() - stampStarted;
            const encodeStarted = performance.now();
            encoder.submit(
              {
                pixels: result.pixels,
                width: base.mapWidth,
                height: base.mapHeight,
                canvas: fieldCanvas,
              },
              token,
              (committed) => {
              if (token !== fieldSceneTokenRef.current) return;
              const encodeMs = performance.now() - encodeStarted;
              fieldEncodeMsRef.current = encodeMs;
              const samples = fieldEncodeSamplesRef.current;
              samples.push(encodeMs);
              if (samples.length > 120) samples.shift();
              const sorted = [...samples].sort((a, b) => a - b);
              fieldEncodeP95Ref.current =
                sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
                if (committed) {
                  fieldCompletedRef.current += 1;
                  lastFieldCommitMsRef.current = performance.now();
                }
              },
            );
          }
        }
      }
      const combinedStats = combinedStatsRef.current;

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
        visibleDrops:
          summary.attached + summary.sliding + summary.paused,
        consumedBeads: sim.consumedBeads.size,
        consumedLenses: sim.consumedLenses.size,
        restoredBeads: sim.restoredBeads,
        lensesActive: Math.max(0, layout.lenses.length - sim.consumedLenses.size),
        lensRevision: sim.lensRevision,
        hidden: hiddenRef.current,
        reducedMotion: reducedRef.current,
        staticRefraction: base !== null,
        dynamicRefraction: combinedStats !== null,
        lensBatchHz: 1000 / DYNAMIC_FIELD_BATCH_MS,
        lensLeadPx: null,
        lensWrites: fieldCompletedRef.current,
        lensCenterGapPx: null,
        optics: 'combined-displacement',
        staticFieldBeads: base?.coveredBeads ?? 0,
        staticFieldCoveragePx: base?.coveragePixels ?? 0,
        staticFieldWrites: base ? 1 : 0,
        staticFieldMs: base?.prepareMs ?? 0,
        staticFieldMapWidth: base?.mapWidth ?? 0,
        staticFieldMapHeight: base?.mapHeight ?? 0,
        combinedFieldMapWidth: base?.mapWidth ?? 0,
        combinedFieldMapHeight: base?.mapHeight ?? 0,
        combinedStaticBeads: base?.coveredBeads ?? 0,
        combinedStaticTrails: base?.coveredTrails ?? 0,
        combinedDynamicDrops: combinedStats?.coveredDrops ?? 0,
        combinedDynamicTrails: combinedStats?.coveredTrails ?? 0,
        combinedCoveragePx: combinedStats?.coveragePixels ?? 0,
        combinedPrepareMs: fieldPrepareMsRef.current,
        combinedStampMs: fieldStampMsRef.current,
        combinedEncodeMs: fieldEncodeMsRef.current,
        combinedEncodeP95Ms: fieldEncodeP95Ref.current,
        combinedFieldWrites: fieldWritesRef.current,
        combinedCompletedWrites: fieldCompletedRef.current,
        combinedInFlight: encoder?.busy ?? false,
        combinedEncoderBackend: fieldWorkerClientRef.current?.backend ?? 'none',
        combinedTargetHz: 1000 / DYNAMIC_FIELD_BATCH_MS,
        combinedUpdateAgeMs:
          lastFieldCommitMsRef.current > 0
            ? Math.max(0, now - lastFieldCommitMsRef.current)
            : 0,
        dynamicFieldDrops: combinedStats?.coveredDrops ?? 0,
        dynamicFieldTrails: combinedStats?.coveredTrails ?? 0,
        dynamicFieldCoveragePx: combinedStats?.coveragePixels ?? 0,
        dynamicFieldWrites: fieldCompletedRef.current,
        dynamicFieldMs: fieldStampMsRef.current,
        dynamicFieldP95Ms: fieldEncodeP95Ref.current,
        dynamicFieldHz: 1000 / DYNAMIC_FIELD_BATCH_MS,
        dynamicFieldMapWidth: base?.mapWidth ?? 0,
        dynamicFieldMapHeight: base?.mapHeight ?? 0,
      };
      const root = rootRef.current;
      if (root && framesRef.current % 20 === 0) {
        root.dataset.rainAttached = String(summary.attached);
        root.dataset.rainSliding = String(summary.sliding);
        root.dataset.rainMerges = String(summary.merges);
      }
    },
    [layout, seed],
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

    fieldEncoderRef.current?.dispose();
    fieldWorkerClientRef.current?.dispose();
    const workerClient = new RainFieldWorkerClient({
      createWorker: () =>
        new Worker(new URL('../lib/rain-field-worker.ts', import.meta.url), {
          type: 'module',
        }) as unknown as RainFieldWorkerLike,
      fallback: (canvas) =>
        new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (blob) => {
              if (blob) resolve(blob);
              else reject(new Error('fallback rain field toBlob failed'));
            },
            'image/png',
          );
        }),
    });
    const encoder = new RainFieldEncoder({
      encode: (request, done) => {
        void workerClient.encode(request).then(done, () => done(null));
      },
      decode: (url) =>
        new Promise<void>((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve();
          image.onerror = () => reject(new Error('rain field decode failed'));
          image.src = url;
        }),
      createUrl: (blob) => URL.createObjectURL(blob),
      revokeUrl: (url) => URL.revokeObjectURL(url),
      setHref: (url) => {
        fieldUrlRef.current = url;
        fieldImageRef.current?.setAttribute('href', url);
      },
      schedule: (callback) => {
        window.requestAnimationFrame(callback);
      },
      transparentUrl: TRANSPARENT_FIELD_URL,
    });
    fieldWorkerClientRef.current = workerClient;
    fieldEncoderRef.current = encoder;
    const sceneToken = encoder.beginScene();
    fieldSceneTokenRef.current = sceneToken;
    lastFieldBatchMsRef.current = 0;
    lastFieldCommitMsRef.current = 0;
    fieldWritesRef.current = 0;
    fieldCompletedRef.current = 0;
    fieldStampMsRef.current = 0;
    fieldEncodeMsRef.current = 0;
    fieldEncodeSamplesRef.current = [];
    fieldEncodeP95Ref.current = 0;
    combinedStatsRef.current = null;

    const base = prepareCombinedRainFieldBase(layout, viewport);
    combinedBaseRef.current = base;
    fieldPrepareMsRef.current = base.prepareMs;
    const fieldCanvas = fieldCanvasRef.current ?? document.createElement('canvas');
    fieldCanvasRef.current = fieldCanvas;
    fieldCanvas.width = base.mapWidth;
    fieldCanvas.height = base.mapHeight;

    const sim = createRainSimulation(layout, viewport);
    simRef.current = sim;
    framesRef.current = 0;
    cycleRef.current = [];
    paintStaticRain(staticCtx, layout, viewport, { consumed: sim.consumedBeads });
    paintDynamicTrails(trailCtx, sim, viewport);
    renderFrame(sim, performance.now());

    return () => {
      if (simRef.current === sim) simRef.current = null;
      if (fieldSceneTokenRef.current === sceneToken) {
        fieldSceneTokenRef.current = encoder.beginScene();
      }
      encoder.dispose();
      workerClient.dispose();
      if (fieldEncoderRef.current === encoder) fieldEncoderRef.current = null;
      if (fieldWorkerClientRef.current === workerClient) {
        fieldWorkerClientRef.current = null;
      }
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

  /*
   * DEV-only 合并回放：在真实 RainWindow 里把两颗可见水珠摆成“一滑一停”的清晰相遇。
   * 不挂产品 UI；生产构建的 import.meta.env.DEV 为 false，不会暴露。
   */
  useEffect(() => {
    const environment = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;
    if (!environment?.DEV) return undefined;
    const api: RainReplayApi = {
      stage: (scenario = 'dynamic') => {
        const sim = simRef.current;
        return sim ? stageControlledMergeReplay(sim, scenario) : null;
      },
      snapshot: () => {
        const sim = simRef.current;
        return sim ? snapshotRainReplay(sim) : null;
      },
    };
    window.__PI_RAIN_REPLAY__ = api;
    return () => {
      if (window.__PI_RAIN_REPLAY__ === api) delete window.__PI_RAIN_REPLAY__;
    };
  }, []);

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
      data-rain-optics="combined-normal-field"
      data-rain-optics-beads={layout.beads.length}
      data-rain-refraction="combined-displacement"
      data-rain-simulation="v2"
      data-paused={hidden ? 'true' : 'false'}
      data-reduced-motion={reduced ? 'true' : 'false'}
      aria-hidden="true"
    >
      {/*
       * 单张 combined 法线场 + 单次 feDisplacementMap。
       * 不再用 coverage 提 alpha、模糊玻璃或 composite 回源图；无水区域 RG=128,
       * 128 自然保持清晰，水体内部由真实背景位移呈现体积。
       */}
      <svg className="pi-rain__defs" aria-hidden="true" focusable="false">
        <defs>
          <filter
            id={filterId}
            filterUnits={filterGeometry.filterUnits}
            primitiveUnits={filterGeometry.primitiveUnits}
            x={filterGeometry.x}
            y={filterGeometry.y}
            width={filterGeometry.width}
            height={filterGeometry.height}
            colorInterpolationFilters="sRGB"
          >
            <feImage
              ref={fieldImageRefCallback}
              x={filterGeometry.x}
              y={filterGeometry.y}
              width={filterGeometry.width}
              height={filterGeometry.height}
              preserveAspectRatio="none"
              result="rainCombinedField"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="rainCombinedField"
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
