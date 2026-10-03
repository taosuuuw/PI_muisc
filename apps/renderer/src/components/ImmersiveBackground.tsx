import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { LyricLine, Song } from '@pi/shared';

import { energyToScale, pseudoEnergy } from '../lib/audio-bands';
import { coverAt } from '../lib/cover';
import {
  deriveThemeColors,
  extractCoverPalette,
  hashSeed,
  mulberry32,
  neutralThemeColors,
  type ThemeColors,
} from '../lib/cover-palette';
import {
  analyzeLyricMood,
  composeTheme,
  detectChorus,
  neutralMood,
  type MoodFamily,
  type ThemeContract,
} from '../lib/lyric-mood';

/**
 * 播放页沉浸式背景（用户 m08768 第 5 条：学习 folia-major 的「按歌曲情绪与歌词内容生成的
 * 沉浸式背景」）。
 *
 * 六层（自下而上，全部绝对定位、`pointer-events: none`，父层只要有一个定位容器即可：
 * 播放页的 `.pi-home` 就是 `position: relative`）：
 * 1. `__blur` 封面层——里面**两层图**：`__cover-soft`（`blur(56px) scale(1.8)` 的柔焦铺底色）
 *    垫底，`__cover`（`blur(3px) scale(1.14)` + 按亮/暗档调亮度）压在上面，后者就是**认得出
 *    是哪张专辑封面**的那一层；两张图都在换歌时 1.5s 交叉淡入；
 * 2. `__wash` 底色洗染（`theme.backgroundColor`，opacity **0.34**——原来 0.75 会把封面糊掉）；
 * 3. `__aura` 氛围光晕：径向渐变，颜色是**当前这一句歌词的情绪色**（`--pi-immersive-line`），
 *    浓度跟着这一句的情绪走（`--pi-immersive-aura`，0.9s 过渡）；
 * 4. `__shapes` 几何浮层：15 个形状（圆/方/三角/十字，`clip-path` 画的）+ 20 个粒子；
 * 5. `__lyric-veil` 歌词区半透明遮罩：椭圆渐变，颜色取自**主题底色**
 *    （`--pi-immersive-bg`，和歌词配色做对比度校准时用的就是它），压在浮层之上、
 *    只罩住歌词那一列，保证正文对比度；
 * 6. `__vignette` 暗角（`radial-gradient(circle, transparent 42%, rgba(0,0,0,.5) 100%)`）；
 * 7. `__sidelight` 侧光（**用户第二十一轮第 4 条**：暗档左侧一道侧光打入、往右渐暗；
 *    亮档这一层不给背景色，数值见 `styles/immersive-background.css`）。
 *
 * 用户第 9 轮第 5 条：背景 = **这首歌的封面** + 配合情绪与歌词内容生成的沉浸层。所以
 * ①封面必须看得见（见第 1 层与 CSS 里的数值）**并且缓慢漂移**（`--pi-cover-drift-*`：幅度与
 * 周期按歌曲种子取，换歌才换一组，换行不动）；②第 2~5 层的颜色/能量/形状运动要跟着
 * `activeIndex` 指向的**那一句**走——两路信号：`LINE_VISUALS`（这一句的情绪族与情绪能量）与
 * `measureLineShape`（这一句的**文本形状**：字数 / 拉丁占比 / 情绪标点密度）。换行时只改
 * 这几个 CSS 变量，过渡交给 CSS 的 transition，不在每帧上算任何东西。
 *
 * === AGPL 说明 ===
 * folia-major 是 **AGPL-3.0**。这里借鉴的是它的**数值与做法**（模糊半径、形状/粒子的数量、
 * 尺寸/透明度/时长区间、暗角梯度、四层结构、封面取色与主题生成算法、副歌判据），
 * **没有拷贝任何 folia 源码文本**，所有选择器、动画与算式都是在本仓库里自己写的：
 * - 取色与主题数值在 `lib/cover-palette.ts`（头部注释列了具体数值与出处）；
 * - 情绪词典 / 副歌检测 / 主题契约在 `lib/lyric-mood.ts`（folia 那套是 LLM 驱动，我们换成本地词典）；
 * - 能量的真实来源在 `lib/audio-bands.ts`（**我们没有接 WebAudio**，那里写了硬证据）。
 *
 * === 三条硬约束 ===
 * 1. **只用 `transform` / `opacity` 动画**（外加底色/透明度过渡），不碰 `width/top/filter` 之类
 *    会触发布局或重绘的属性；**不给 `will-change`**：这里常驻 50 个动画图层，给了反而吃显存。
 * 2. **确定性**：形状/粒子的所有随机量都来自 `mulberry32(hashSeed(song.id))`（见 cover-palette），
 *    同一首歌每次渲染的图形完全一致，切歌回来不会「抖」成另一张图。
 * 3. **不能影响播放、不能空白**：取色异步且可能失败（CDN 无 CORS / canvas 被污染），
 *    失败就回退中性色（先中性色，取到再 1s 过渡过去），**不抛错**；`prefers-reduced-motion: reduce`
 *    时静止；窗口隐藏、没有歌、用户开了 reduced-motion 时整棵子树 `animation-play-state: paused`。
 *
 * === DOM 契约（UI 冒烟读这些） ===
 * 根节点 `data-immersive` / `data-mood` / `data-theme-source`（`cover` | `neutral`）/
 * `data-chorus` / `data-paused` / `data-reduced-motion`；封面上 `data-active`；
 * 形状上 `data-kind`（`circle` | `square` | `triangle` | `cross`）与 `data-filled`。
 */

export interface ImmersiveBackgroundProps {
  /** 当前歌曲：封面取色 + 几何随机数的种子（`song.id`）。 */
  song: Song;
  /** 歌词行（算情绪 / 副歌 / 关键词）。 */
  lines: readonly LyricLine[];
  /** 当前唱到第几行（-1 表示还没有）。 */
  activeIndex: number;
  /** 由设置决定：true 时用封面取色，false 时用一套中性色。 */
  enabled?: boolean;
  /**
   * 封面图地址覆盖（可选）。默认从 `song.album.coverUrl` 经 `coverAt(…, 640)` 派生——
   * 但网易云 CDN 不回 CORS 头、生产环境又是 `file://`，canvas 取色必然被污染，
   * 所以默认路径基本都会回退中性色。以后主进程能给出封面字节（docs/PLAN.md §4.1 计划的
   * `blob:` 封面）时，把那个 `blob:`/`data:` 地址从这里传进来，取色就能成功。
   */
  coverSrc?: string;
}

/** 形状/粒子的数量（folia 的浮层规模：约 15 个形状 + 约 20 个粒子）。 */
const SHAPE_COUNT = 15;
const PARTICLE_COUNT = 20;

type ShapeKind = 'circle' | 'square' | 'triangle' | 'cross';

const SHAPE_KINDS: readonly ShapeKind[] = ['circle', 'square', 'triangle', 'cross'];

/** 形状数值（folia）：`size 40 + rand*100`、位置 `rand*100%`、旋转 `rand*360°`、透明度 `0.11 + rand*0.08`。 */
const SHAPE_SIZE_MIN_PX = 40;
const SHAPE_SIZE_RANGE_PX = 100;
const SHAPE_OPACITY_MIN = 0.11;
const SHAPE_OPACITY_RANGE = 0.08;
/** 自转：`30 + rand*30` 秒、延迟 `rand*5` 秒、一半 `reverse`。 */
const SHAPE_SPIN_MIN_S = 30;
const SHAPE_SPIN_RANGE_S = 30;
const SHAPE_SPIN_DELAY_MAX_S = 5;
/** `rand < 0.3` 的形状改成实心（其余是 1px 描边）。 */
const SHAPE_FILL_PROBABILITY = 0.3;
/**
 * 漂移：x ±15px、y ±30px。folia 把位移和自转叠在同一个动画里；我们拆成内层元素做位移，
 * 时长沿用外层自转的 30~60s（`spinSeconds`），两个周期一致才不会互相追赶。
 * 每首歌的具体幅度在 0.5~1 倍之间取，保证不超过上面这个包络。
 */
const SHAPE_DRIFT_X_PX = 15;
const SHAPE_DRIFT_Y_PX = 30;
const SHAPE_DRIFT_MIN_FACTOR = 0.5;

/** 粒子数值（folia）：`size rand*4 + 1`、`opacity rand*0.3`、15~35 秒、延迟 `rand*10` 秒、向上飘 100px。 */
const PARTICLE_SIZE_MIN_PX = 1;
const PARTICLE_SIZE_RANGE_PX = 4;
const PARTICLE_OPACITY_MAX = 0.3;
const PARTICLE_RISE_MIN_S = 15;
const PARTICLE_RISE_RANGE_S = 20;
const PARTICLE_DELAY_MAX_S = 10;

/* ---- 「当前这一句歌词」的情绪 → 视觉量（用户第 9 轮第 5 条） ------------------------------
 *
 * 为什么单独做这一层：`composeTheme` 给出的是**整首歌的主导情绪**（写进 `data-mood`），
 * 它的权重里当前句只占一部分，换行时画面几乎只有能量抖动。用户要的是「配合情绪与歌词内容
 * 生成的沉浸式背景」，所以这里对 `activeIndex` 指向的**那一句**单独跑一次
 * `analyzeLyricMood([line], 0)`（一行 × 87 条词的短匹配，逐行 `useMemo`，不在每帧上），
 * 把它落到下面这些**只影响 transform / opacity / background-color** 的量上：
 * - `colorSlot`  这一句的情绪族落在主题的哪个色槽 → 换句时的**颜色**变化；
 * - `tiltDeg`    浮层整体的倾斜角（度）→ 换句时的**运动姿态**变化；
 * - `gain`       浮层整体的缩放倍率（再乘上能量推出的 `--pi-immersive-scale`）；
 * - `auraOpacity` 氛围光晕浓度；
 * - `driftFactor` 形状漂移幅度的倍率（漂移关键帧的终点，见 `shapeBodyStyle`）；
 * - `particleBoost` 粒子峰值透明度的倍率。
 *
 * 数值是本仓库自己定的（folia 那边字体的情绪色来自 LLM，我们没有那一步），只保证
 * 「同族集中、异族拉开」：热烈/能量最大最亮，孤独/悲伤最小最暗，温柔/明亮居中。
 * 色槽的分配刻意与 `lib/lyric-mood.ts` 的 `FAMILY_STYLE.colorSlot` 一致，这样「词色」
 * 与「背景色」不会在同一句上互相打架。
 */
interface LineVisual {
  /** 这一句的情绪族取主题里的哪个颜色（与 lyric-mood 的 FAMILY_STYLE.colorSlot 同口径）。 */
  readonly colorSlot: 'primaryColor' | 'accentColor' | 'secondaryColor';
  readonly tiltDeg: number;
  readonly gain: number;
  readonly auraOpacity: number;
  readonly driftFactor: number;
  readonly particleBoost: number;
}

const LINE_VISUALS: Readonly<Record<MoodFamily | 'neutral', LineVisual>> = {
  tender: {
    colorSlot: 'primaryColor',
    tiltDeg: -2.4,
    gain: 0.96,
    auraOpacity: 0.3,
    driftFactor: 0.7,
    particleBoost: 0.85,
  },
  passionate: {
    colorSlot: 'accentColor',
    tiltDeg: 2.6,
    gain: 1.12,
    auraOpacity: 0.44,
    driftFactor: 1.25,
    particleBoost: 1.3,
  },
  lonely: {
    colorSlot: 'secondaryColor',
    tiltDeg: -3.2,
    gain: 0.93,
    auraOpacity: 0.22,
    driftFactor: 0.55,
    particleBoost: 0.6,
  },
  positive: {
    colorSlot: 'primaryColor',
    tiltDeg: 1.6,
    gain: 1.06,
    auraOpacity: 0.38,
    driftFactor: 1,
    particleBoost: 1.05,
  },
  negative: {
    colorSlot: 'secondaryColor',
    tiltDeg: -4,
    gain: 0.9,
    auraOpacity: 0.26,
    driftFactor: 0.6,
    particleBoost: 0.7,
  },
  energetic: {
    colorSlot: 'accentColor',
    tiltDeg: 3.4,
    gain: 1.16,
    auraOpacity: 0.42,
    driftFactor: 1.35,
    particleBoost: 1.35,
  },
  neutral: {
    colorSlot: 'primaryColor',
    tiltDeg: 0,
    gain: 1,
    auraOpacity: 0.28,
    driftFactor: 0.85,
    particleBoost: 1,
  },
};

/** 光晕浓度的上下界：再淡看不见「这一句在变」，再浓就把封面与歌词都糊了。 */
const AURA_MIN = 0.12;
const AURA_MAX = 0.6;
/** 逐句微扰的盐值与幅度（用另一套种子，别和 `pseudoEnergy` 的抖动共用同一个随机序列）。 */
const LINE_JITTER_SALT = 0x5f3a;
const LINE_TILT_JITTER_DEG = 1.2;
const LINE_AURA_JITTER = 0.07;
/** 这一句命中几个情绪词也算进光晕浓度（越密越亮，最多算 3 个）。 */
const LINE_AURA_KEYWORD_GAIN = 0.04;
const LINE_AURA_KEYWORD_CAP = 3;
/** 这一句的情绪能量在总能量里占的比重（另一半是 `pseudoEnergy` 的行时长/副歌）。 */
const LINE_ENERGY_WEIGHT = 0.5;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/* ---- 「这一句的文本形状」→ 幅度/浓度的微调（用户第 9 轮第 5 条） --------------------------
 *
 * 情绪是从**词义**推出来的（`analyzeLyricMood` 的 87 条词典），可两句情绪同族、形状完全不同的
 * 歌词（「我好想你」vs「我不能原谅你！！！」）画面会一模一样。这里再补一层**只看字形**的度量：
 * - `density` 正文长度（可见字符数 / 14，取 0~1）：越长的句子浮层越「满」；
 * - `wide`    拉丁/宽字符占比（0 = 全 CJK，1 = 全拉丁）：英文句子给更大的漂移幅度；
 * - `burst`   情绪标点密度（`! ? … — ~`，0~1）：一句里砸了两个感叹号就是「在喊」，更亮更活跃。
 *
 * 这三个数**只乘到已有的幅度/浓度变量**上（`lineAura` / `lineGain` / `lineDrift` /
 * `lineParticleBoost`）——这些变量在 CSS 里都有 0.9~1.2s 的过渡，换行是「呼吸」不是跳变。
 * **刻意不碰 `animation-duration`**：改时长会让正在跑的循环动画相位跳一下，那才是真的闪。
 */
const LINE_SHAPE_DENSITY_CHARS = 14;
const LINE_SHAPE_AURA_DENSITY = 0.05;
const LINE_SHAPE_AURA_BURST = 0.08;
const LINE_SHAPE_GAIN_DENSITY = 0.08;
const LINE_SHAPE_DRIFT_WIDE = 0.18;
const LINE_SHAPE_DRIFT_BURST = 0.12;
const LINE_SHAPE_PARTICLE_BURST = 0.25;
/** 短句/中句/长句的粗档（写进 `data-line-shape`，肉眼与冒烟都能一眼看出这一句的「体量」）。 */
const LINE_SHAPE_SHORT_CHARS = 6;
const LINE_SHAPE_MEDIUM_CHARS = 16;

/** 「情绪标点」：出现它们通常意味着这一句在喊、在问、或者在留白。 */
const LINE_BURST_PUNCTUATION = /[!?！？…—–~～]/;
/** CJK / 假名 / 谚文：这些字更「方」，与拉丁词的词长不同。 */
const LINE_WIDE_SCRIPT = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;
/*
 * 上面两个正则**都不带 `g`**：带 `g` 的 `RegExp.prototype.test` 会记住 `lastIndex`，
 * 在逐字符循环里会「隔一个中一个」。也**不带 `u`**：这里用不到，顺带省掉「正则特性对
 * target 的要求」那一层不确定性；空白判定直接用 `char.trim() === ''`，不引入
 * `\p{P}` 这类 Unicode 属性转义（它要求 target ≥ ES2018，我没法在本机跑 typecheck 去赌）。
 */

interface LineShape {
  readonly density: number;
  readonly wide: number;
  readonly burst: number;
  readonly kind: 'short' | 'medium' | 'long';
}

/** 纯函数、O(这一句的字数)：一行跑一次（`useMemo` 按行缓存），不在每帧上。 */
function measureLineShape(text: string): LineShape {
  let letters = 0;
  let wide = 0;
  let burst = 0;
  for (const char of text) {
    if (LINE_BURST_PUNCTUATION.test(char)) burst += 1;
    // 「字数」= 可见字符数（空白不算、标点算）：用户说的「这一句有多少字」，标点也是版面的一部分。
    if (char.trim() === '') continue;
    letters += 1;
    if (LINE_WIDE_SCRIPT.test(char)) wide += 1;
  }
  const total = Math.max(letters, 1);
  const kind: LineShape['kind'] =
    letters <= LINE_SHAPE_SHORT_CHARS
      ? 'short'
      : letters <= LINE_SHAPE_MEDIUM_CHARS
        ? 'medium'
        : 'long';
  return {
    density: clampNumber(letters / LINE_SHAPE_DENSITY_CHARS, 0, 1),
    wide: wide / total,
    // ×3 是标定过的：一句 10 个字里 3 个情绪标点就到顶（再密也不会更亮）。
    burst: clampNumber((burst / total) * 3, 0, 1),
    kind,
  };
}

interface ShapeSpec {
  readonly id: string;
  readonly kind: ShapeKind;
  readonly sizePx: number;
  readonly leftPercent: number;
  readonly topPercent: number;
  readonly rotateDeg: number;
  readonly opacity: number;
  readonly filled: boolean;
  readonly spinSeconds: number;
  readonly spinDelaySeconds: number;
  readonly reverse: boolean;
  readonly driftXpx: number;
  readonly driftYpx: number;
}

interface ParticleSpec {
  readonly id: string;
  readonly sizePx: number;
  readonly leftPercent: number;
  readonly topPercent: number;
  readonly opacity: number;
  readonly riseSeconds: number;
  readonly delaySeconds: number;
}

/** 同一首歌永远铺出同一张图：所有随机量都从这个种子出来。 */
function buildShapes(seed: number): readonly ShapeSpec[] {
  const rand = mulberry32(hashSeed(seed, 0x51ed));
  const shapes: ShapeSpec[] = [];
  for (let index = 0; index < SHAPE_COUNT; index += 1) {
    shapes.push({
      id: `shape-${index}`,
      kind: SHAPE_KINDS[Math.floor(rand() * SHAPE_KINDS.length)] ?? 'circle',
      sizePx: SHAPE_SIZE_MIN_PX + rand() * SHAPE_SIZE_RANGE_PX,
      leftPercent: rand() * 100,
      topPercent: rand() * 100,
      rotateDeg: rand() * 360,
      opacity: SHAPE_OPACITY_MIN + rand() * SHAPE_OPACITY_RANGE,
      filled: rand() < SHAPE_FILL_PROBABILITY,
      spinSeconds: SHAPE_SPIN_MIN_S + rand() * SHAPE_SPIN_RANGE_S,
      spinDelaySeconds: rand() * SHAPE_SPIN_DELAY_MAX_S,
      // 「一半 reverse」用下标决定而不是随机，这样两种方向一定各占一半。
      reverse: index % 2 === 1,
      driftXpx: SHAPE_DRIFT_X_PX * (SHAPE_DRIFT_MIN_FACTOR + rand() * (1 - SHAPE_DRIFT_MIN_FACTOR)),
      driftYpx: SHAPE_DRIFT_Y_PX * (SHAPE_DRIFT_MIN_FACTOR + rand() * (1 - SHAPE_DRIFT_MIN_FACTOR)),
    });
  }
  return shapes;
}

function buildParticles(seed: number): readonly ParticleSpec[] {
  const rand = mulberry32(hashSeed(seed, 0x9a71));
  const particles: ParticleSpec[] = [];
  for (let index = 0; index < PARTICLE_COUNT; index += 1) {
    particles.push({
      id: `particle-${index}`,
      sizePx: PARTICLE_SIZE_MIN_PX + rand() * PARTICLE_SIZE_RANGE_PX,
      leftPercent: rand() * 100,
      topPercent: rand() * 100,
      opacity: rand() * PARTICLE_OPACITY_MAX,
      riseSeconds: PARTICLE_RISE_MIN_S + rand() * PARTICLE_RISE_RANGE_S,
      delaySeconds: rand() * PARTICLE_DELAY_MAX_S,
    });
  }
  return particles;
}

/**
 * 外层：定位 + 静态初始角 + 自转。
 * 初始角用**独立属性 `rotate`**（不是 `transform`），自转动画写 `transform: rotate()`，
 * 两者在规范里是相乘关系——所以不需要三层嵌套就能「从 rand*360° 开始转」。
 */
function shapeStyle(shape: ShapeSpec): CSSProperties {
  return {
    left: `${shape.leftPercent}%`,
    top: `${shape.topPercent}%`,
    width: `${shape.sizePx}px`,
    height: `${shape.sizePx}px`,
    marginLeft: `${-shape.sizePx / 2}px`,
    marginTop: `${-shape.sizePx / 2}px`,
    opacity: shape.opacity,
    rotate: `${shape.rotateDeg}deg`,
    animationDuration: `${shape.spinSeconds}s`,
    animationDelay: `${shape.spinDelaySeconds}s`,
    animationDirection: shape.reverse ? 'reverse' : 'normal',
  } as CSSProperties;
}

/** 内层：只做漂移（`transform: translate3d`），形状本体（描边/填充/圆角）在 CSS 里。 */
function shapeBodyStyle(shape: ShapeSpec): CSSProperties {
  return {
    // 漂移幅度 = 这首歌的固有幅度 × **当前这一句的** `--pi-immersive-drift`（0.55~1.35）。
    // 换句时漂移关键帧的终点会变，幅度差最大 ~10px 且漂移周期是 30~60s，肉眼看不到跳变。
    '--pi-drift-x': `calc(${shape.driftXpx}px * var(--pi-immersive-drift))`,
    '--pi-drift-y': `calc(${shape.driftYpx}px * var(--pi-immersive-drift))`,
    // 与自转同长同延迟：两个周期一致，形状不会一快一慢地「追」自己。
    animationDuration: `${shape.spinSeconds}s`,
    animationDelay: `${shape.spinDelaySeconds}s`,
  } as CSSProperties;
}

function particleStyle(particle: ParticleSpec): CSSProperties {
  return {
    left: `${particle.leftPercent}%`,
    top: `${particle.topPercent}%`,
    width: `${particle.sizePx}px`,
    height: `${particle.sizePx}px`,
    marginLeft: `${-particle.sizePx / 2}px`,
    marginTop: `${-particle.sizePx / 2}px`,
    // 峰值透明度 = 这颗粒子的固有值 × **当前这一句的** `--pi-immersive-particle-boost`。
    '--pi-particle-opacity': `calc(${particle.opacity.toFixed(3)} * var(--pi-immersive-particle-boost))`,
    animationDuration: `${particle.riseSeconds}s`,
    animationDelay: `${particle.delaySeconds}s`,
  } as CSSProperties;
}

function readDocumentDark(): boolean {
  return document.documentElement.dataset['theme'] === 'dark';
}

/** 背景的亮/暗档跟着文档主题走（`data-theme="dark"`）；用户切主题时重算，不能停在旧档上。 */
function useDocumentDark(): boolean {
  const [dark, setDark] = useState(readDocumentDark);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(readDocumentDark()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** 窗口隐藏时停掉动画（省电，也让后台不占合成线程）。 */
function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  useEffect(() => {
    const onChange = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return hidden;
}

/** `prefers-reduced-motion: reduce`：CSS 里已经静止，这里主要为了把状态写进 `data-` 供冒烟核对。 */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function ImmersiveBackground({
  song,
  lines,
  activeIndex,
  enabled = true,
  coverSrc,
}: ImmersiveBackgroundProps): ReactNode {
  // 父层只有在有歌时才渲染我们（HomePage 的空态是另一棵子树），但这里仍然防一手：
  // 没有 song.id 就当作「没有歌」，画面静止，绝不让种子随机数退化成 0 号歌的图形。
  const songId = song.id ?? 0;
  const hasSong = songId > 0;

  const seed = useMemo(() => hashSeed(songId, 0x1eaf), [songId]);
  /**
   * 封面漂移的幅度与周期（用户第 9 轮第 5 条）：每首歌一组、确定性（同一首歌永远同一张图），
   * 上限压在两层放大的余量之内（见 CSS 的 `pi-immersive-cover-drift`：1.14 倍 → 每边 7% 余量，
   * 漂移最多 2.2%），所以 3px 模糊在四边透出的那圈半透明不会被带进画面。
   * 与逐句变量分开：换行时这三个值**不变**，因此不会有动画相位跳变。
   */
  const coverDrift = useMemo(() => {
    const rand = mulberry32(hashSeed(seed, 0x7c0a));
    return {
      x: `${(1 + rand() * 1.2).toFixed(2)}%`,
      y: `${(0.8 + rand() * 1).toFixed(2)}%`,
      seconds: `${(46 + rand() * 18).toFixed(1)}s`,
    };
  }, [seed]);
  const shapes = useMemo(() => buildShapes(seed), [seed]);
  const particles = useMemo(() => buildParticles(seed), [seed]);
  const chorus = useMemo(() => detectChorus(lines.map((line) => line.text)), [lines]);
  const mood = useMemo(() => analyzeLyricMood(lines, activeIndex), [lines, activeIndex]);
  /** 伪能量（行时长 / 副歌 / 种子抖动），还没有掺入「这一句的情绪」。 */
  const pseudo = useMemo(
    () => pseudoEnergy({ lines, index: activeIndex, chorus, seed }),
    [lines, activeIndex, chorus, seed],
  );
  const isChorus = chorus.has(activeIndex);

  /**
   * **当前这一句**的情绪（用户第 9 轮第 5 条）：把 `activeIndex` 指的那一行单独丢给
   * `analyzeLyricMood`（`WEIGHT_ACTIVE` 对它自己生效），拿到这一句的情绪族、情绪能量与
   * 命中词数。逐行 `useMemo`：只在换行时算一次（一行 × 87 条词的短匹配），不在每帧上。
   */
  const activeLine = activeIndex >= 0 ? lines[activeIndex] : undefined;
  const lineMood = useMemo(
    () => (activeLine ? analyzeLyricMood([activeLine], 0) : neutralMood()),
    [activeLine],
  );
  const lineVisual = LINE_VISUALS[lineMood.mood];
  /** 这一句的**文本形状**（字数 / 拉丁占比 / 情绪标点）：与情绪族叠加，见 `measureLineShape`。 */
  const lineShape = useMemo(() => measureLineShape(activeLine?.text ?? ''), [activeLine]);
  /** 逐句微扰：同一句永远是同一个值（种子来自 `song.id` 与行号），拖着进度条来回不会抖。 */
  const lineJitter = useMemo(() => {
    const rand = mulberry32(hashSeed(seed ^ LINE_JITTER_SALT, activeIndex + 1));
    return rand() * 2 - 1;
  }, [seed, activeIndex]);
  /** 这一句的倾斜角 / 光晕浓度：情绪族基准 + 微扰 + 「这一句命中几个情绪词」+ 文本形状。 */
  const lineTilt = lineVisual.tiltDeg + lineJitter * LINE_TILT_JITTER_DEG;
  const lineAura = clampNumber(
    lineVisual.auraOpacity +
      lineJitter * LINE_AURA_JITTER +
      Math.min(lineMood.keywords.length, LINE_AURA_KEYWORD_CAP) * LINE_AURA_KEYWORD_GAIN +
      lineShape.density * LINE_SHAPE_AURA_DENSITY +
      lineShape.burst * LINE_SHAPE_AURA_BURST,
    AURA_MIN,
    AURA_MAX,
  );
  /*
   * 文本形状的三档叠在情绪族上（用户第 9 轮第 5 条）：长句更「满」（倍率）、
   * 拉丁句子漂得更开（宽字符占比）、带感叹号/省略号的句子更亮、粒子更活跃。
   * 用 `(x - 基准)` 的居中写法，保证「没有特色的一句话」不会把情绪族给定的姿态整体推偏。
   */
  const lineGain = lineVisual.gain * (1 + (lineShape.density - 0.5) * LINE_SHAPE_GAIN_DENSITY);
  const lineDrift =
    lineVisual.driftFactor *
    (1 + lineShape.wide * LINE_SHAPE_DRIFT_WIDE + lineShape.burst * LINE_SHAPE_DRIFT_BURST);
  const lineParticleBoost =
    lineVisual.particleBoost * (1 + (lineShape.burst - 0.35) * LINE_SHAPE_PARTICLE_BURST);
  /** 总能量：伪能量（行时长 / 副歌）与这一句的情绪能量各占一半，两边都推得动浮层。 */
  const energy = clampNumber((pseudo + lineMood.energy) * LINE_ENERGY_WEIGHT, 0, 1);

  const dark = useDocumentDark();
  const hidden = useDocumentHidden();
  const reducedMotion = useReducedMotion();
  const neutral = useMemo(() => neutralThemeColors(dark), [dark]);

  // 取色是异步的：先给中性色（首帧一定有色，不会白/不会空），取到再让 `__wash` 的
  // `background-color 1s` 过渡过去。**换歌时不重置成中性色**——上一首的颜色留着，
  // 新的分析结果到了直接过渡，比中间闪一下灰舒服；失败才回退中性色。
  const [palette, setPalette] = useState<{
    readonly source: 'cover' | 'neutral';
    readonly colors: ThemeColors;
  }>(() => ({ source: 'neutral', colors: neutralThemeColors(readDocumentDark()) }));

  const coverUrl = coverSrc ?? coverAt(song.album?.coverUrl, 640);

  useEffect(() => {
    if (!enabled || !coverUrl) {
      setPalette({ source: 'neutral', colors: neutral });
      return;
    }
    let cancelled = false;
    void extractCoverPalette(coverUrl).then((swatches) => {
      if (cancelled) return;
      if (swatches.length === 0) {
        setPalette({ source: 'neutral', colors: neutral });
        return;
      }
      setPalette({ source: 'cover', colors: deriveThemeColors(swatches, seed, dark) });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, coverUrl, neutral, seed, dark]);

  const theme: ThemeContract = useMemo(() => composeTheme(palette.colors, mood), [palette, mood]);

  // 封面交叉淡入：只留最近两张。旧的那张永远停在 opacity 0，等下一次换歌时才被替换——
  // 这样不需要定时器，也不会在过渡中间把 DOM 掀掉。
  const [coverStack, setCoverStack] = useState<readonly string[]>(() =>
    coverUrl ? [coverUrl] : [],
  );
  useEffect(() => {
    if (!coverUrl) {
      setCoverStack([]);
      return;
    }
    setCoverStack((previous) =>
      previous[previous.length - 1] === coverUrl ? previous : [...previous, coverUrl].slice(-2),
    );
  }, [coverUrl]);
  const activeCover = coverStack[coverStack.length - 1];

  const paused = !hasSong || hidden || reducedMotion;

  const rootStyle = {
    '--pi-immersive-bg': theme.backgroundColor,
    '--pi-immersive-primary': theme.primaryColor,
    '--pi-immersive-accent': theme.accentColor,
    '--pi-immersive-secondary': theme.secondaryColor,
    // 下面六个变量是**逐句**的（用户第 9 轮第 5 条）：换行时只改这几个值，
    // 由 CSS 的 transition 把颜色/倾斜/缩放/浓度平滑过去，不做任何每帧计算。
    '--pi-immersive-line': theme[lineVisual.colorSlot],
    '--pi-immersive-line-tilt': `${lineTilt.toFixed(2)}deg`,
    '--pi-immersive-line-gain': lineGain.toFixed(3),
    '--pi-immersive-aura': lineAura.toFixed(3),
    '--pi-immersive-drift': lineDrift.toFixed(3),
    '--pi-immersive-particle-boost': lineParticleBoost.toFixed(3),
    // 封面漂移（按歌取，与上面逐句变量分开：换行时它们不变，所以不会有相位跳变）。
    '--pi-cover-drift-x': coverDrift.x,
    '--pi-cover-drift-y': coverDrift.y,
    '--pi-cover-drift-s': coverDrift.seconds,
    '--pi-immersive-energy': energy.toFixed(3),
    '--pi-immersive-scale': energyToScale(energy).toFixed(3),
  } as CSSProperties;

  return (
    <div
      className="pi-immersive"
      data-immersive="true"
      data-mood={theme.mood}
      data-line-mood={lineMood.mood}
      data-line-shape={lineShape.kind}
      data-theme-source={palette.source}
      data-scheme={dark ? 'dark' : 'light'}
      data-chorus={isChorus ? 'true' : 'false'}
      data-paused={paused ? 'true' : 'false'}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      style={rootStyle}
      aria-hidden="true"
    >
      <div className="pi-immersive__blur">
        {/* 柔焦铺底：只提供环境色，不承担「认得出封面」。放在前面（DOM 序在下面）。 */}
        {coverStack.map((src) => (
          <img
            key={`soft-${src}`}
            className="pi-immersive__cover-soft"
            data-active={src === activeCover ? 'true' : 'false'}
            src={src}
            alt=""
            draggable={false}
          />
        ))}
        {/* 可辨认的封面：blur(3px) + scale(1.14)，暗角与歌词遮罩在后面几层里。 */}
        {coverStack.map((src) => (
          <img
            key={src}
            className="pi-immersive__cover"
            data-active={src === activeCover ? 'true' : 'false'}
            src={src}
            alt=""
            draggable={false}
          />
        ))}
      </div>
      <div className="pi-immersive__wash" />
      {/* 氛围光晕：颜色/浓度都由「当前这一句」的情绪决定（`--pi-immersive-line` / `_aura`）。 */}
      <div className="pi-immersive__aura" />
      <div className="pi-immersive__shapes">
        {shapes.map((shape) => (
          <div
            key={shape.id}
            className="pi-immersive__shape"
            data-kind={shape.kind}
            style={shapeStyle(shape)}
          >
            <div
              className="pi-immersive__shape-body"
              data-filled={shape.filled ? 'true' : 'false'}
              style={shapeBodyStyle(shape)}
            />
          </div>
        ))}
        {particles.map((particle) => (
          <div
            key={particle.id}
            className="pi-immersive__particle"
            style={particleStyle(particle)}
          />
        ))}
      </div>
      {/* 歌词区遮罩：压在浮层之上，只罩住歌词那一列，颜色取自主题底色
          （歌词配色的对比度就是对着它校准的），保证正文可读。 */}
      <div className="pi-immersive__lyric-veil" />
      <div className="pi-immersive__vignette" />
      {/*
        用户第二十一轮第 4 条：「暗色模式下背景光照要左侧一道侧光打入、往右渐暗」。
        压在暗角之上（暗角会把四角一起压暗，包括左边那道光的落点），只在暗档有背景色，
        数值与理由见 `styles/immersive-background.css` 的 `.pi-immersive__sidelight`。
      */}
      <div className="pi-immersive__sidelight" />
    </div>
  );
}
