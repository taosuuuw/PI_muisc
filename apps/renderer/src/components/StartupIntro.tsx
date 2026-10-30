import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useSettings } from '../lib/queries';
import {
  PI_PATHS,
  createWorldTexture,
  worldGlyphTransform,
  type IntroScheme,
} from './startupIntroWorld';
import '../styles/startup-intro.css';

/**
 * 应用启动品牌开场 V5：所有蓝白窗口都是同一张世界画面的裁切。
 *
 *   0.00–0.60  一个中心窗口，显示母版中部的蓝→青→白
 *   0.60–1.15  五窗错时滑入，各采样母版不同区域
 *   1.15–1.95  横排停顿
 *   1.95–2.25  阶梯错位 + 纸色过渡
 *   2.25–2.75  15 个非对称窗口展开，母版内的一个大π渐显
 *   2.75–3.60  构图停留
 *   3.60–4.08  camera 推近 + 窗口锚点扩张
 *   4.10–4.25  共享 mask 全幅显现，同一母版完整显露
 *   4.10–4.30  camera 平顺收束回完整构图
 *   4.20–4.70  完整母版 + 底部小字「愿你澄澈」
 *   4.70–5.00  淡出、卸载
 *
 * 关键：π和颜色场都只在母版里定义一次；窗口是同一 mask 里的白色矩形。
 * 窗口动画只改变“看哪里/看多大”，不重新绘制或缩放母版内容。
 */
const INTRO_HOLD_MS = 4700;
const INTRO_OUT_MS = 300;
const INTRO_CACHE_KEY = 'pi.startup-intro';
const WORLD_MASK_ID = 'pi-intro-world-mask';

type IntroPhase = 'waiting' | 'playing' | 'leaving' | 'done';
type WindowKind = 'one' | 'five' | 'many';

type FiveTile = {
  id: string;
  x: number;
  enterX: number;
  enterY: number;
  delay: number;
  stepX: number;
  stepY: number;
};

type Block = {
  id: string;
  x: number;
  y: number;
  size: number;
  delay: number;
  enterY: number;
  pushY: number;
  z: number;
};

type WorldWindow = {
  id: string;
  kind: WindowKind;
  x: number;
  y: number;
  size: number;
  style: CSSProperties;
};

const FIVE_TILES: ReadonlyArray<FiveTile> = [
  {
    id: 'five-0',
    x: 18,
    enterX: -6,
    enterY: -10,
    delay: 0.62,
    stepX: -0.8,
    stepY: 6,
  },
  {
    id: 'five-1',
    x: 34,
    enterX: 5,
    enterY: 8,
    delay: 0.68,
    stepX: 0.5,
    stepY: 11,
  },
  {
    id: 'five-2',
    x: 50,
    enterX: -4,
    enterY: -14,
    delay: 0.74,
    stepX: -0.4,
    stepY: 0,
  },
  {
    id: 'five-3',
    x: 66,
    enterX: 7,
    enterY: 6,
    delay: 0.8,
    stepX: 0.7,
    stepY: -3,
  },
  {
    id: 'five-4',
    x: 82,
    enterX: -5,
    enterY: -8,
    delay: 0.86,
    stepX: 1.0,
    stepY: -6,
  },
];

/**
 * 15 个非对称窗口。相比 V4 只轻调了 b1/b5/b6/b7/b10 的锚点，
 * 让大π的横梁、左腿、右腿各至少被两个窗口真实截到。
 */
const BLOCKS: ReadonlyArray<Block> = [
  { id: 'b0', x: 15, y: 12, size: 14, delay: 0.1, enterY: 2.2, pushY: -0.8, z: 3 },
  { id: 'b1', x: 39, y: 22, size: 8.5, delay: 0.15, enterY: 2.8, pushY: 0.4, z: 3 },
  { id: 'b2', x: 65, y: 16, size: 24, delay: 0.02, enterY: 1.8, pushY: -0.6, z: 2 },
  { id: 'b3', x: 80, y: 12, size: 8, delay: 0.16, enterY: 2.4, pushY: 0.8, z: 3 },
  { id: 'b4', x: 19, y: 41, size: 9, delay: 0.14, enterY: 2.0, pushY: -0.4, z: 3 },
  { id: 'b5', x: 36, y: 38, size: 22, delay: 0.04, enterY: 2.4, pushY: 0.2, z: 2 },
  { id: 'b6', x: 56.5, y: 31, size: 5.5, delay: 0.18, enterY: 3.2, pushY: -0.2, z: 4 },
  { id: 'b7', x: 60, y: 50, size: 23, delay: 0.06, enterY: 2.0, pushY: 0.6, z: 2 },
  { id: 'b8', x: 84, y: 42, size: 20, delay: 0.07, enterY: 1.8, pushY: 0.9, z: 3 },
  { id: 'b9', x: 12, y: 78, size: 12, delay: 0.12, enterY: 1.6, pushY: -0.6, z: 3 },
  { id: 'b10', x: 31, y: 73, size: 24, delay: 0.03, enterY: 2.6, pushY: 1.0, z: 2 },
  { id: 'b11', x: 52, y: 61, size: 14, delay: 0.1, enterY: 2.2, pushY: -0.2, z: 3 },
  { id: 'b12', x: 50, y: 81, size: 13, delay: 0.11, enterY: 1.4, pushY: 0.8, z: 3 },
  { id: 'b13', x: 72, y: 81, size: 15, delay: 0.09, enterY: 1.8, pushY: 0.4, z: 3 },
  { id: 'b14', x: 85, y: 79, size: 9, delay: 0.17, enterY: 2.2, pushY: -0.4, z: 3 },
];

const BLOCK_BY_ID = new Map(BLOCKS.map((block) => [block.id, block]));

/**
 * 32 条有构图关系的直线：三条主横轴、纵向落点、少量跨行 hub 连接。
 * 所有 15 个窗口都在同一张网络里；不随机穿插。
 */
const LINK_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['b0', 'b1'],
  ['b1', 'b2'],
  ['b2', 'b3'],
  ['b4', 'b5'],
  ['b5', 'b6'],
  ['b6', 'b7'],
  ['b7', 'b8'],
  ['b9', 'b10'],
  ['b10', 'b11'],
  ['b11', 'b12'],
  ['b12', 'b13'],
  ['b13', 'b14'],
  ['b0', 'b4'],
  ['b4', 'b9'],
  ['b1', 'b5'],
  ['b5', 'b10'],
  ['b2', 'b6'],
  ['b6', 'b11'],
  ['b3', 'b8'],
  ['b8', 'b14'],
  ['b0', 'b5'],
  ['b0', 'b6'],
  ['b1', 'b7'],
  ['b2', 'b11'],
  ['b4', 'b10'],
  ['b5', 'b11'],
  ['b7', 'b12'],
  ['b8', 'b11'],
  ['b10', 'b13'],
  ['b12', 'b14'],
  ['b3', 'b7'],
  ['b9', 'b11'],
];

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function initialPhase(): IntroPhase {
  if (prefersReducedMotion()) return 'done';
  try {
    const cached = window.localStorage.getItem(INTRO_CACHE_KEY);
    if (cached === 'off') return 'done';
    if (cached === 'on') return 'playing';
  } catch {
    /* 隐私模式禁 localStorage：没有缓存就走 waiting，等设置。 */
  }
  return 'waiting';
}

function px(value: number): string {
  return `${Number(value.toFixed(2))}px`;
}

function windowNode(window: WorldWindow, guide: boolean): ReactNode {
  const fill = guide ? 'none' : '#ffffff';
  const className = `pi-intro__window pi-intro__window--${window.kind}`;
  const rect = (
    <rect
      className={`${className}${guide ? ' pi-intro__window--guide' : ''}`}
      x={Number((window.x - window.size / 2).toFixed(2))}
      y={Number((window.y - window.size / 2).toFixed(2))}
      width={Number(window.size.toFixed(2))}
      height={Number(window.size.toFixed(2))}
      fill={fill}
      data-window={window.kind}
      data-window-id={window.id}
      data-size={window.kind === 'many' ? window.size : undefined}
      data-block={window.kind === 'many' ? window.id : undefined}
      data-piece={window.kind === 'five' ? window.id : undefined}
      data-stage={window.kind === 'one' ? 'one' : undefined}
    />
  );

  if (window.kind === 'five') {
    return (
      <g key={window.id} className="pi-intro__five-move" style={window.style}>
        {rect}
      </g>
    );
  }
  if (window.kind === 'many') {
    return (
      <g key={window.id} className="pi-intro__block-enter" style={window.style}>
        {rect}
      </g>
    );
  }
  return <g key={window.id}>{rect}</g>;
}

export function StartupIntro({ scheme = 'light' }: { scheme?: IntroScheme }): ReactNode {
  const settings = useSettings();
  const [phase, setPhase] = useState<IntroPhase>(initialPhase);
  const [viewport, setViewport] = useState(() => ({
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight),
  }));
  const syncedRef = useRef(false);
  const textureCacheRef = useRef(new Map<IntroScheme, string>());
  const visible = phase === 'playing' || phase === 'leaving';
  const texture = useMemo(() => {
    if (!visible) return '';
    const cached = textureCacheRef.current.get(scheme);
    if (cached) return cached;
    const next = createWorldTexture(scheme);
    textureCacheRef.current.set(scheme, next);
    return next;
  }, [visible, scheme]);

  useEffect(() => {
    if (syncedRef.current || settings.data === undefined) return;
    syncedRef.current = true;
    const enabled = settings.data.startupIntro !== false;
    setPhase((current) => {
      if (current === 'waiting') return enabled ? 'playing' : 'done';
      if (current === 'playing' && !enabled) return 'leaving';
      return current;
    });
  }, [settings.data]);

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
    if (!visible) return undefined;
    let frame = 0;
    const resize = (): void => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setViewport({
          width: Math.max(1, window.innerWidth),
          height: Math.max(1, window.innerHeight),
        });
      });
    };
    window.addEventListener('resize', resize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    };
  }, [visible]);

  useEffect(() => {
    if (phase !== 'playing') return undefined;
    const finish = (event: KeyboardEvent): void => {
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

  if (phase === 'waiting' || phase === 'done') return null;

  const { width, height } = viewport;
  const minSide = Math.min(width, height);
  const glyphTransform = worldGlyphTransform(width, height);
  const oneSize = minSide * 0.42;
  const fiveSize = Math.min(width * 0.138, height * 0.3);

  const oneWindow: WorldWindow = {
    id: 'one',
    kind: 'one',
    x: width / 2,
    y: height / 2,
    size: oneSize,
    style: {},
  };

  const fiveWindows: WorldWindow[] = FIVE_TILES.map((tile) => ({
    id: tile.id,
    kind: 'five',
    x: (tile.x / 100) * width,
    y: height / 2,
    size: fiveSize,
    style: {
      '--enter-x': px((tile.enterX / 100) * width),
      '--enter-y': px((tile.enterY / 100) * height),
      '--step-x': px((tile.stepX / 100) * minSide),
      '--step-y': px((tile.stepY / 100) * height),
      '--delay': `${tile.delay}s`,
    } as CSSProperties,
  }));

  const blockWindows: WorldWindow[] = BLOCKS.map((block) => ({
    id: block.id,
    kind: 'many',
    x: (block.x / 100) * width,
    y: (block.y / 100) * height,
    size: (block.size / 100) * minSide,
    style: {
      '--enter-y': px((block.enterY / 100) * minSide),
      '--push-scale': 1 + 6.5 / block.size,
      '--push-y': px((block.pushY / 100) * minSide),
      '--delay': `${block.delay}s`,
    } as CSSProperties,
  }));

  const lines = LINK_PAIRS.flatMap(([fromId, toId], index) => {
    const from = BLOCK_BY_ID.get(fromId);
    const to = BLOCK_BY_ID.get(toId);
    if (!from || !to) return [];
    return [
      {
        id: `${fromId}-${toId}`,
        fromId,
        toId,
        x1: (from.x / 100) * width,
        y1: (from.y / 100) * height,
        x2: (to.x / 100) * width,
        y2: (to.y / 100) * height,
        delay: 2.6 + index * 0.02,
      },
    ];
  });

  const maskGroups = (
    <>
      <g
        className="pi-intro__window-group pi-intro__window-group--onefive"
        data-window-group="onefive"
      >
        {windowNode(oneWindow, false)}
        {fiveWindows.map((window) => windowNode(window, false))}
      </g>
      <g className="pi-intro__window-group pi-intro__window-group--many" data-window-group="many">
        {blockWindows.map((window) => windowNode(window, false))}
      </g>
    </>
  );

  const guideGroups = (
    <>
      <g
        className="pi-intro__window-group pi-intro__window-group--onefive"
        data-window-group="onefive"
      >
        {windowNode(oneWindow, true)}
        {fiveWindows.map((window) => windowNode(window, true))}
      </g>
      <g className="pi-intro__window-group pi-intro__window-group--many" data-window-group="many">
        {blockWindows.map((window) => windowNode(window, true))}
      </g>
    </>
  );

  return (
    <div
      className="pi-intro"
      data-startup-intro="true"
      data-phase={phase}
      data-scheme={scheme}
      aria-hidden="true"
      onPointerDown={() => {
        if (phase === 'playing') setPhase('leaving');
      }}
    >
      <div className="pi-intro__paper" aria-hidden="true" />
      <div className="pi-intro__halftone" aria-hidden="true" />

      <div className="pi-intro__scene-marker pi-intro__scene-onefive" data-scene="onefive" />
      <div className="pi-intro__scene-marker pi-intro__scene-many" data-scene="many" />

      <div className="pi-intro__world" data-world>
        <svg
          className="pi-intro__world-svg"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <mask
              id={WORLD_MASK_ID}
              maskUnits="userSpaceOnUse"
              x="0"
              y="0"
              width={width}
              height={height}
            >
              {maskGroups}
              <rect
                className="pi-intro__full-mask"
                data-full-mask="true"
                x="0"
                y="0"
                width={width}
                height={height}
                fill="#ffffff"
              />
            </mask>
          </defs>

          <g className="pi-intro__camera" data-camera="true">
            <g className="pi-intro__links">
              {lines.map((line) => (
                <line
                  key={line.id}
                  className="pi-intro__link"
                  data-link={line.id}
                  data-link-from={line.fromId}
                  data-link-to={line.toId}
                  x1={line.x1}
                  y1={line.y1}
                  x2={line.x2}
                  y2={line.y2}
                  style={{ '--line-delay': `${line.delay}s` } as CSSProperties}
                />
              ))}
            </g>

            <g
              className="pi-intro__master"
              data-world-master="true"
              mask={`url(#${WORLD_MASK_ID})`}
            >
              <image
                className="pi-intro__world-image"
                href={texture}
                x="0"
                y="0"
                width={width}
                height={height}
                preserveAspectRatio="none"
              />
              <g
                className="pi-intro__master-glyph"
                data-world-glyph="true"
                transform={glyphTransform}
                fill="none"
                stroke={scheme === 'dark' ? '#f2f2f2' : '#ffffff'}
                strokeWidth="7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {PI_PATHS.map((path) => (
                  <path key={path} d={path} />
                ))}
              </g>
            </g>

            <g className="pi-intro__window-guide" data-window-guide="true">
              {guideGroups}
            </g>
          </g>
        </svg>
      </div>

      <div className="pi-intro__pale" aria-hidden="true" />

      <span className="pi-intro__footer" data-footer="true">
        愿你澄澈
      </span>
    </div>
  );
}
