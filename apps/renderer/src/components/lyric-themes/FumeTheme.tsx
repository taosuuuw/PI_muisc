/**
 * 浮名 = `fume`（用户 m08768 第 4 条）。
 *
 * === AGPL 说明 ===
 * 数值借鉴自 folia-major 的 **fume** 歌词主题（AGPL-3.0，`chthollyphile/folia-major@c249bde`），
 * **只取数值与思路**：下面每一个表达式都是在本仓库里自己写的，没有拷贝 folia 源码文本。
 * folia 原版是「一整张全屏 Canvas2D + pretext 排版 + 相机」；我们**不许新增依赖**（没有 pretext），
 * 所以这是一次 **DOM 重写**：整篇文章 = 绝对定位的块 + 逐字素 `<span>`，
 * 相机 = 一个 wrapper 的 `transform`，由 rAF 手写弹簧驱动。这是本主题最大的一处近似。
 *
 * 观感：全部歌词被**确定性打乱**后排成多列铺在一张比视口大的「纸」上（构图 ≠ 时间顺序，
 * 这是 fume 的灵魂），文字用**逐字素打印**的方式亮起（没有位移 / 缩放 / 旋转），
 * 相机像拍纪录片一样跟着「正亮着的那一句」推进 / 缩放，插值方式（定格 / 平滑）与跟手速度在设置页可调，
 * 并在没人唱的时候轻微漂移。
 *
 * === 本次改造（用户第十四轮第 3 条：镜头中心跟随当前句 + 速度 / 追焦方式可调）===
 * 1) **焦点从「正在打印的字素」换成「当前句的中心」**：目标机位由激活块（`activeBlock ?? viewBlock`）
 *    的中心（`block.x + block.width / 2`、`block.y + block.height / 2`）求出（见 `resolveFocus`）。
 *    `frameCameraOffset` / `clampCameraOffset` 那套守卫（`CAMERA_EDGE_GUARD` 纸面覆盖 +
 *    `CAMERA_CONTENT_MARGIN` 当前块左缘 / 整行不出窗口）**一条不动**，所以换焦点不会把当前句推出可见范围。
 *    取景倍率与改造前逐位相同：缩放目标仍只看 `lineHeightPx × 1.34`，与焦点取在块内哪个点是哪件事。
 * 2) **插值换成对 `dt` 无关的隐式阻尼弹簧**（`springStep`）：原来那条显式欧拉
 *    `v += ((target - x) × k - v × c) × dt` 有稳定性条件（约 `ω·dt < 2`）。原来 `dt` 被
 *    `clamp(…, 1/240, 0.05)` 兜着，`k` 最大 780 ⇒ `ω·dt` 已经到 1.4 贴着边界；速度倍率会让
 *    `k` 按 `s²` 涨，`s = 2.5` 时 `ω·dt ≈ 3.5`，特征值 |λ| ≈ 2.25 ⇒ 镜头会自我放大地抖。
 *    隐式解没有稳定性条件，`fpsCap` 丢帧（`dt` 变大）/ 拖窗口都抖不坏。
 * 3) **速度倍率 = 弹簧自然频率的倍率**：`ω' = ω × fumeCameraSpeed`（⇔ `k' = k × s²`、`c' = c × s`，
 *    阻尼比 `ζ` 与过冲手感不变），`maxVelocity` 同量纲也跟着乘 `s`。`s = 1` 时换算退化成恒等，
 *    就是改造前那组常数（详见 `springStep` / `cameraSpring` 的注释）。
 * 4) **追焦方式**：`fumeCameraFollow === 'snap'`（定格）= 切句瞬间直接换机位、速度清零、没有插值；
 *    `'smooth'`（默认）= 走弹簧。idle 浮动两种模式都保留（它由 `motionAmount` 管，不属于「追焦插值」）。
 *    `prefers-reduced-motion` 仍走 `paintStatic` 的静态取景（不动相机），语义不变。
 *
 * === 本次修复（用户第九轮第 4 条：三套动效主题铺满整个 app 视口，任意尺寸 / 全屏都不变形不留白）===
 * 1) **舞台铺满**：`styles/lyric-themes.css` 里三套主题的舞台盒子改成 `position: absolute; inset: 0`
 *    ——包含块是 `position: relative` 的 `.pi-home__stage`（播放页视口那一格）。不再用
 *    「负外边距去抵消 `.pi-home__stage-lyrics` 的 padding」那种必须跟 `global.css` 的
 *    `108px / 24px / 92px` 和两个媒体查询逐像素对齐的写法（对不齐就露边、会被裁）。因此
 *    `useFullStageSize()` 量到的就是整个视口，窗口任意尺寸 / 最大化 / 全屏都跟着走。
 * 2) **相机不再把纸面推出视口**：新增 `frameCameraOffset()`，同时解「焦点落在视口锚点」与
 *    「缩放后的纸面盖住视口」两条约束。旧写法平移量漏了 `× scale`（世界层是
 *    `translate3d(x, y, 0) scale(s)`，世界点 `w` 的屏幕位置是 `x + w × s`），于是 scale > 1 时
 *    焦点被 `w × (s − 1)` 推离锚点——窗口越宽 / 越高越明显，靠后的列会被推出屏幕。
 * 3) 纸面高度撑到内容真实边界：块放不下时会被「再铺一张纸」推到 `paperHeight` 之下，
 *    而盖满约束是拿纸面矩形算的（见 `buildFumePlan` 结尾的 `contentRight / contentBottom`）。
 *
 * === 已修复（用户第八轮第 4 条：全屏 / 多语言 / 颜色跟随歌曲）===
 * 1) **尺寸来源**：不再走「`useElementSize` 量歌词盒子 + 量不到回退 `window.innerWidth/Height`」
 *    的双路径，改用 `useFullStageSize()`；窗口缩放 / 转向由 `ResizeObserver` + `resize` 事件重算
 *    （重算会重建 plan，相机重新对齐）。
 * 2) **多语言自适应**：折行估算（`estimateRowCount`）与相机焦点（`resolveFocus`）里的宽度
 *    从 `estimateTextWidth()`（CJK 每字 1em、其余 0.55em 的**估算**）换成 `measureTextWidth()`
 *    （离屏 canvas `measureText`，字体栈取舞台的 computed `font-family`，字重按 hero 780 / body 640）；
 *    词间空格宽度只在「用空格分词」的语言里加（`usesWordSpaces`）。字距 / 字号 / 列数全都不用改：
 *    真实字宽一准，行数就准，块高也就准（原来拉丁文会因低估宽度而**块高偏小、块与块重叠**）。
 * 3) **颜色跟随歌曲**：删掉 `paletteRef` 的硬编码初值 `#5ab6ff`，改用 `useResolvedThemeColors()`
 *    —— 祖先注入的 `--pi-th-primary / --pi-th-accent / --pi-th-surface`（播放页按当前歌曲封面注入）
 *    优先，`theme` palette 兜底；**每帧从 ref 现读**，所以换歌后下一帧就换色（原来是把
 *    `paletteRef.current` 的对象在 effect 里捕获成常量，换色要等整条 rAF 依赖变化才生效）。
 *    正文颜色再按 `--pi-th-surface` 过一遍 `ensureContrast()`，保证跟歌曲走的配色下仍读得清。
 * 4) 行元素补上 `data-lyric-line` / `data-line-time`（父代理要做「点歌词行 seek」的事件委托）。
 *
 * 数值表（来自任务书 / folia 源码研究报告）：
 * - 纸面：`paperWidth = clamp(max(vw × 1.95, vw + 520), 920, 2400)`、`targetHeight = max(vh, 240) × 2.45`；
 *   列数 `paperWidth >= 1120 ? 4 : >= 760 ? 3 : >= 500 ? 2 : 1`；
 *   `gap = clamp(round(paperWidth × (cols >= 4 ? 0.0065 : cols === 3 ? 0.0085 : 0.0115)), 6, 14)`；
 *   `columnWidth = (paperWidth - gap × (cols - 1)) / cols`。
 * - 块宽：body = `columnWidth`；hero：`cols <= 1 → paperWidth`、`cols === 2 → columnWidth × 1.5 + gap × 0.5`、
 *   否则 `columnWidth × 2 + gap`。
 * - 放置：body 进当前**最矮**的列（平手按 round-robin），hero 跨列、起始列取「被覆盖列最大高度最小」的那一列；
 *   行按 `seededFraction(seed)` **确定性打乱**后再排；块间距 `hero ? max(round(lineHeight × 0.2), 6) : max(round(lineHeight × 0.08), 2)`。
 * - 字号：hero `clamp(width / max(sqrt(字素数 + 词数 × 1.4) × 1.5, 4.5), 24, 54)`、
 *   body `clamp(width / max(sqrt(density) × 2.25, 7), 14, 28)`，`density = 字素数 + 词数 × 1.4`；
 *   `lineHeight = fontPx × (hero ? 1.02 : 1.06)`；字重 hero 780 / body 640。
 * - hero 判定：`isChorusLine && 字素数 <= 22` 直接用；否则要
 *   `4 <= 字素数 <= 28 && |index - total/2| / max(total,1) < 0.72 && ((index+1) % 6 === 0 || seededFraction(seed+index) > 0.965)`；
 *   若全片没有 natural hero，再按 `居中分 × 0.62 + 长度分 × 0.34 + 副歌分 + seededFraction(...) × 0.04` 选一个
 *   （长度分：6..22 → 1、<= 28 → 0.72、否则 0.36；副歌分 0.28），再不行取最短非空块。
 * - 三态：waiting `alpha = hero ? 0.06 : 0.035`；打印前沿固定 `alpha = 0.82`；
 *   active `p = clamp((t - glyphStart)/glyphDuration + 0.16, 0, 1)` 再 easeOutCubic，
 *   `alpha = mix(hero ? 0.06 : 0.035, hero ? 0.985 : 0.92, eased)`，
 *   颜色 `mix(primary, activeColor, 0.22 + eased × 0.78)`，
 *   `text-shadow: 0 0 <(4 + fontPx × 0.22) × eased × boost>px <activeColor@(0.4 + eased × 0.44)>`，
 *   `boost = (chaotic ? 1.15 : calm ? 0.72 : 0.92) × 1`；
 *   passed `alpha = hero ? 0.74 : 0.58`、辉光 `(2 + fontPx × 0.1) × 0.65 × passedGlowBase`、
 *   `passedGlowBase = chaotic ? 0.95 : calm ? 0.35 : 0.62`；`linePassCutoff = min(行渲染结束, 下一行 startMs)`。
 * - 整行辉光：`lineGlowAlpha = (hero ? 0.16 : 0.12) + envelope × (hero ? 0.26 : 0.2)`、
 *   `lineGlowBlur = (hero ? 12 : 8) + envelope × fontPx × (hero ? 0.7 : 0.52)`（颜色 accent），
 *   `envelope` 是 `peak = 0.8` 的「先涨后落」包络（`t <= 0.8` 用 `easeOutCubic(t / 0.8)`，
 *   否则 `1 - easeInCubic((t - 0.8) / 0.2)`）。
 * - colour trail：亮完之后颜色从 activeColor 混回 primary，
 *   `trailDuration = clamp(lineDuration × (hero ? 0.42 : 0.52), 0.45, 1.45)`s、
 *   `p = ((t - trailStart) / trailDuration) ^ 1.35`、`fill = mix(activeColor, primary, 0.18 + p × 0.82)`。
 * - 相机（第十四轮第 3 条改造后：`springStep` 的隐式阻尼弹簧，作用在 wrapper 的
 *   `transform: translate3d(x, y, 0) scale(s)`，`transformOrigin: '0 0'`）：
 *   目标 = **当前激活块（`activeBlock ?? viewBlock`）的中心**（`block.x + width / 2`、`block.y + height / 2`）；
 *   `targetLineHeight = clamp(min(vw, vh) × 0.115, 64, 124)`、
 *   `scale = clamp(targetLineHeight / (lineHeightPx × 1.34), 0.88, 2.2)`（硬钳制 `CAMERA_SCALE_HARD_MIN 0.22 / MAX 2.24`，
 *   再按 `motionAmount` 缩放「离 1 有多远」）；
 *   位置弹簧 `ω = sqrt(clamp(15.8 / max(duration, 0.05)², 260, 780)) × fumeCameraSpeed`、
 *   `ζ = clamp(sqrt(k) × 1.36, 24, 40) / (2 × sqrt(k))`（≈ 0.68~0.74，欠阻尼小过冲，与速度倍率无关）、
 *   `maxVelocity = clamp(distance / max(duration × 0.28, 0.028), 2600, 8800) × fumeCameraSpeed`；
 *   缩放弹簧 `ω = sqrt(108) × fumeCameraSpeed` / `ζ = 21 / (2 × sqrt(108)) ≈ 1.01`（临界阻尼附近）；
 *   `fumeCameraFollow === 'snap'`（定格）时位姿与速度直接硬设，不过弹簧。
 * - idle 浮动（正常强度）：`distance 18px / duration 7s / scaleAmplitude 0.011`；
 *   `x = sin(phase × 0.74 + 0.8) × d × 0.34`、`y = sin(phase) × d + sin(phase × 0.5 + 1.1) × d × 0.22`
 *   （`phase = (now / 1000 / 7) × 2π`），世界位移要除以当前 scale；初始相机 = 文章中心、`scale 1.18`。
 *
 * 本仓库的取舍（都写进交付报告）：
 * - **不新增依赖 / 没有 pretext**：排版用 `measureTextWidth()`（canvas `measureText`，取不到时
 *   内部回退 `estimateTextWidth()`）量宽 + 自己实现的贪心列填充，
 *   块高是「按量出来的行数」推出来的，不是真实字形测量 —— 换行位置与原版不会逐像素一致。
 * - 只挂**相机附近 12 行**的块进 DOM（`blockIndex ∈ [viewIndex - 8, viewIndex + 12]`），
 *   原版是 canvas 全量绘制 + 屏外剔除；我们靠 React 只渲染窗口内的块。
 * - 逐字素 `<span>` 按**词**分组缓存 DOM，每帧只改已存在节点的 `style.opacity / color / textShadow`，
 *   不 setState、不新建 / 销毁节点、不查 DOM。
 * - 「重复文本层做整行辉光」原版是 canvas blur；我们改成给块加 `text-shadow`（同样数值），更可靠。
 * - 没有 WebAudio：`motionEnergy` 取恒定 1；`boost` 取常值 1（不做桥接 / 瞬移）。
 * - 译文按任务书样式自写在块内（右下角、更小更淡）。
 */

import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import {
  clamp,
  ensureContrast,
  isChorusLine,
  measureTextWidth,
  mixColor,
  parseRgb,
  rgba,
  seededFraction,
  createFrameGate,
  tuningOf,
  useElementFontFamily,
  useFullStageSize,
  usePositionClock,
  usePrefersReducedMotion,
  useResolvedThemeColors,
  usesWordSpaces,
  wordColorOf,
  type LyricPalette,
  type LyricThemeProps,
  type RgbColor,
  type ResolvedThemeColors,
  type StageLine,
} from './types';

/* ------------------------------------------------------------------ *
 * 数值常量（folia fume 那一套）
 * ------------------------------------------------------------------ */

const PAPER_WIDTH_MIN = 920;
const PAPER_WIDTH_MAX = 2400;
const PAPER_WIDTH_VW = 1.95;
const PAPER_WIDTH_EXTRA = 520;
const PAPER_HEIGHT_MULT = 2.45;
const PAPER_HEIGHT_FLOOR = 240;
/** `gap` 的三个基数：4 列 / 3 列 / <= 2 列。 */
const GAP_RATIO_4 = 0.0065;
const GAP_RATIO_3 = 0.0085;
const GAP_RATIO_2 = 0.0115;
const GAP_MIN = 6;
const GAP_MAX = 14;
/** 字号：hero / 正文各自的上下限（folia fume 的原始数值）。 */
const FONT_HERO_MIN_PX = 24;
const FONT_HERO_MAX_PX = 54;
const FONT_BODY_MIN_PX = 14;
const FONT_BODY_MAX_PX = 28;
/** 设置里 `fontScale` 的上限，跟 `LyricTuningSchema` 的 `.max(1.3)` 对齐。 */
const FONT_SCALE_MAX = 1.3;
/** 未打印字素的亮度。 */
const WAIT_ALPHA_HERO = 0.06;
const WAIT_ALPHA_BODY = 0.035;
/** 打印前沿（正在打印的那个字素）固定亮度。 */
const PRINT_FRONT_ALPHA = 0.82;
/** 打印前沿之后的 `+0.16` 提前量。 */
const PRINT_LEAD = 0.16;
/** 逐字素辉光：`(4 + fontPx × 0.22) × eased × boost`。 */
const GLYPH_GLOW_BASE = 4;
const GLYPH_GLOW_PER_FONT = 0.22;
/** activeColor 的起步混色比例。 */
const ACTIVE_MIX_FLOOR = 0.22;
const ACTIVE_MIX_SPAN = 0.78;
/** passed 亮度。 */
const PASSED_ALPHA_HERO = 0.74;
const PASSED_ALPHA_BODY = 0.58;
/** 整行辉光。 */
const LINE_GLOW_ALPHA_HERO = 0.16;
const LINE_GLOW_ALPHA_BODY = 0.12;
const LINE_GLOW_ALPHA_SPAN_HERO = 0.26;
const LINE_GLOW_ALPHA_SPAN_BODY = 0.2;
const LINE_GLOW_BLUR_HERO = 12;
const LINE_GLOW_BLUR_BODY = 8;
const LINE_GLOW_BLUR_SPAN_HERO = 0.7;
const LINE_GLOW_BLUR_SPAN_BODY = 0.52;
/** 行包络的峰值位置。 */
const LINE_ENVELOPE_PEAK = 0.8;
/** colour trail。 */
const TRAIL_DURATION_MIN = 0.45;
const TRAIL_DURATION_MAX = 1.45;
const TRAIL_RATIO_HERO = 0.42;
const TRAIL_RATIO_BODY = 0.52;
const TRAIL_MIX_FLOOR = 0.18;
const TRAIL_MIX_SPAN = 0.82;
const TRAIL_EXPONENT = 1.35;
/** 相机弹簧。 */
const CAMERA_LINE_HEIGHT_RATIO = 0.115;
const CAMERA_LINE_HEIGHT_MIN = 64;
const CAMERA_LINE_HEIGHT_MAX = 124;
const CAMERA_SCALE_MIN = 0.88;
const CAMERA_SCALE_MAX = 2.2;
const CAMERA_SCALE_HARD_MIN = 0.22;
const CAMERA_SCALE_HARD_MAX = 2.24;
const CAMERA_CATCHUP_STRENGTH = 15.8;
const CAMERA_STRENGTH_MIN = 260;
const CAMERA_STRENGTH_MAX = 780;
const CAMERA_DAMPING_BASE = 24;
const CAMERA_DAMPING_MAX = 40;
const CAMERA_VELOCITY_MIN = 2600;
const CAMERA_VELOCITY_MAX = 8800;
const CAMERA_ZOOM_K = 108;
const CAMERA_ZOOM_C = 21;
/**
 * 缩放弹簧换算成二阶系统的自然频率 / 阻尼比（第十四轮第 3 条）：`ω = √k`、`ζ = c / (2ω)`。
 * `springStep` 要的是这两个量；速度倍率只抬 `ω`，`ζ` 不动。由改造前的 `k = 108` / `c = 21`
 * 得 `ω ≈ 10.39` / `ζ ≈ 1.01`（临界阻尼附近），`fumeCameraSpeed = 1` 时与原观感等价。
 */
const CAMERA_ZOOM_OMEGA = Math.sqrt(CAMERA_ZOOM_K);
const CAMERA_ZOOM_ZETA = CAMERA_ZOOM_C / (2 * CAMERA_ZOOM_OMEGA);
/** idle 浮动：18px / 7s / 0.011。 */
const IDLE_DISTANCE = 18;
const IDLE_PERIOD_SEC = 7;
const IDLE_SCALE_AMPLITUDE = 0.011;
/** 初始相机。 */
const INITIAL_CAMERA_SCALE = 1.18;
/** DOM 里保留的块：`[viewIndex - WINDOW_BACK, viewIndex + WINDOW_AHEAD]`。 */
const WINDOW_BACK = 8;
const WINDOW_AHEAD = 12;
/** 焦点钉在视口 42% 高处（folia 的 fume 相机用的锚点比例，与 cadenza 同一个值）。 */
const CAMERA_FOCUS_Y = 0.42;
/** 纸面要比视口多铺出去的余量（视口比例）：给弹簧的过冲留一点，别在边缘露空白。 */
const CAMERA_EDGE_GUARD = 0.06;
/** 正在唱的那一块离视口边缘至少留这么多（视口比例）。第十一轮第 1 条：横向夹取用。 */
const CAMERA_CONTENT_MARGIN = 0.03;
/**
 * 镜头移动速度倍率的兜底区间，与 `LyricTuningSchema.fumeCameraSpeed` 的 `.min(0.4).max(2.5)`
 * 对齐（设置页已经夹过，这里只是热路径上的保险）。`1` = 改造前那组弹簧常数的等效速度。
 */
const FUME_CAMERA_SPEED_MIN = 0.4;
const FUME_CAMERA_SPEED_MAX = 2.5;

/**
 * 相机的平移分量（世界层是 `translate3d(x, y, 0) scale(s)`，`transform-origin: 0 0`，
 * 所以世界点 `w` 的屏幕位置是 `x + w * s`）。
 *
 * 两个约束一起解：① 焦点世界点 `focusWorld` 落在视口锚点 `anchor` 上；
 * ② 缩放后的纸面（`paper` = 纸面尺寸 × scale）**仍然盖住整个视口**——否则焦点靠近纸面
 * 左 / 上边缘时，另一侧就会露出一条没有文字的空白。folia 的 fume 相机同样是在场地边缘
 * 停住、不继续平移（它没有把场地推出视口）。纸面本身按视口算（≥ 1.95 视口宽 × 2.45 视口高），
 * 所以绝大多数时候是 ① 说了算，②只在曲首 / 曲尾那几行兜底。
 */
function frameCameraOffset(
  anchor: number,
  focusWorld: number,
  paper: number,
  viewport: number,
  scale: number,
  contentLead: number | null = null,
  contentSize: number | null = null,
): number {
  const guard = viewport * CAMERA_EDGE_GUARD;
  return clampCameraOffset(
    anchor - focusWorld * scale,
    viewport,
    paper * scale,
    guard,
    contentLead === null ? null : contentLead * scale,
    contentSize === null ? null : contentSize * scale,
  );
}

/**
 * 把相机平移量夹进「纸面盖住视口 + 正在唱的那一块别被切掉」的区间
 * （`covered` = 纸面尺寸 × 当前 scale）。`frameCameraOffset` 用它做目标位姿的兜底，
 * `tick` 里积分之后再夹一次防过冲。
 *
 * 第十轮第 5 条：平移量必须带 `* scale`（世界点 `w` 的屏幕位置是 `x + w * s`）。
 *
 * 第十一轮第 1 条（用户 m03279：「浮名的歌词动效左边的歌词会超出窗口边框，看不到」）：
 * 只按纸面夹不够，还要按**正在唱的那一块**（`contentLead` / `contentSize`，都已乘 scale
 * 的屏幕像素）夹：
 *   ① 左缘：相机最多退到「块的左缘正好落在视口左缘内侧 `margin`」——块永远切不到左边；
 *   ② 右缘：块在视口里放得下（`contentLead + contentSize + 2 × margin ≤ viewport`）时，
 *      右缘也一起夹住，等于「整行看得见」；放不下（长句 / 镜头缩放很大）时只钉左缘，
 *      尾巴留在窗口外先等着——参考图里当前句也是左对齐、尾巴出画。
 * 之前那版把「内容左缘」写进了 `max`（上界），方向是反的：那只是允许纸面左边缘贴住视口，
 * 完全没拦住相机往左退（`min` 仍由纸面覆盖决定，实测能退到 −2541px，正是用户看到的那一刀）。
 */
function clampCameraOffset(
  value: number,
  viewport: number,
  covered: number,
  guard: number,
  contentLead: number | null = null,
  contentSize: number | null = null,
): number {
  if (covered <= viewport) return (viewport - covered) * 0.5; // 纸面比视口还小：只能居中
  const margin = viewport * CAMERA_CONTENT_MARGIN;
  let min = viewport - covered + guard;
  let max = -guard;
  if (contentLead !== null) {
    const headMin = margin - contentLead;
    if (headMin > min) min = headMin;
    if (headMin > max) max = headMin;
  }
  if (contentLead !== null && contentSize !== null) {
    const fitMax = viewport - margin - contentLead - contentSize;
    if (fitMax < max) max = fitMax;
  }
  if (min > max) max = min; // 内容比视口宽：钉住左缘，右缘出画
  return clamp(value, min, max);
}

/**
 * 位置弹簧的 `(ω, ζ)`（第十四轮第 3 条）：把改造前那组常数换算成二阶系统的
 * 自然频率与阻尼比 —— `k = clamp(15.8 / duration², 260, 780)`、`c = clamp(√k × 1.36, 24, 40)`
 * ⇒ `ω = √k`、`ζ = c / (2ω)`。`speed` 是设置页的 `fumeCameraSpeed`，按「等效速度」只抬 `ω`：
 * 二阶系统的快慢由 `ω` 定、`ζ` 只管过冲，所以 `ω' = ω × speed` ⇔ `k' = k × speed²`、`c' = c × speed`。
 * `speed = 1` 时逐位等于改造前（`ζ` 也保持 ≈ 0.68~0.74 那点小过冲）。
 */
function cameraSpring(duration: number, speed: number): { omega: number; zeta: number } {
  const stiffness = clamp(
    CAMERA_CATCHUP_STRENGTH / (duration * duration),
    CAMERA_STRENGTH_MIN,
    CAMERA_STRENGTH_MAX,
  );
  const root = Math.sqrt(stiffness);
  const damping = clamp(root * 1.36, CAMERA_DAMPING_BASE, CAMERA_DAMPING_MAX);
  return { omega: root * speed, zeta: damping / (2 * root) };
}

/**
 * 一步阻尼弹簧积分（第十四轮第 3 条）。
 *
 * 取 Game Programming Gems 系那条**隐式**离散解（隐式欧拉 + 精确求解，Juckett 的 damped springs）：
 *   `f = 1 + 2·dt·ζ·ω`、`det = f + dt²·ω²`、
 *   `x' = (f·x + dt·v + dt²·ω²·target) / det`、`v' = (v + dt·ω²·(target − x)) / det`。
 *
 * 为什么不继续用显式欧拉 `v += ((target − x)·k − v·c)·dt; x += v·dt`：它有稳定性条件
 * （半隐式欧拉约 `ω·dt < 2`）。原来只有 `dt ∈ [1/240, 0.05]` 兜着，`k` 最大 780 ⇒
 * `ω·dt` 最大 ≈ 1.4，已经贴着边界；设置页把速度开到 2.5 时 `k' = k·s²` ⇒ `ω·dt ≈ 3.5`，
 * 特征值 |λ| ≈ 2.25 ⇒ 镜头会自我放大地抖。隐式解对任意 `dt` / `ζ` 都稳定，
 * 所以 `fpsCap` 丢帧（`dt` 变大）或窗口卡顿都不会把相机抖坏，且 60 / 90 / 120 档走同一条轨迹。
 */
function springStep(
  position: number,
  velocity: number,
  target: number,
  omega: number,
  zeta: number,
  dt: number,
): { position: number; velocity: number } {
  const f = 1 + 2 * dt * zeta * omega;
  const omegaSq = omega * omega;
  const hoo = dt * omegaSq;
  const detInv = 1 / (f + dt * hoo);
  return {
    position: (f * position + dt * velocity + hoo * dt * target) * detInv,
    velocity: (velocity + hoo * (target - position)) * detInv,
  };
}

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
const easeInCubic = (t: number): number => t * t * t;
const mixNumber = (a: number, b: number, t: number): number => a + (b - a) * clamp(t, 0, 1);

/* ------------------------------------------------------------------ *
 * 文本 / 颜色小工具
 * ------------------------------------------------------------------ */

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function graphemesOf(text: string): string[] {
  if (segmenter === null) return Array.from(text);
  const out: string[] = [];
  for (const part of segmenter.segment(text)) out.push(part.segment);
  return out;
}

/** 颜色 → `rgba()` 里要用的字符串（`mixColor` 已返回 `rgb(...)`，这里只兜底）。 */
function glowColor(activeColor: string, alpha: number): string {
  return rgba(activeColor, clamp(alpha, 0, 1));
}

/* ------------------------------------------------------------------ *
 * 第十五轮第 4 / 6 条：常态白 + 结尾「缩小铺满」
 * ------------------------------------------------------------------ */

/** 第 4 条：常态（未唱 / 唱过）字色 —— 白。底色撑不住白时由 `readableColor` 降到对比度 3 的墨色。 */
const FUME_INK = '#ffffff';
/**
 * 第 4 条：一句「唱过」之后，块色与亮度从主题色 / 全亮**逐渐**淡到常态白的时长。
 * 与其它五套主题共用的 `--pi-lyric-fade-ms: 900ms` 同值（这里在 rAF 里手算，读不到 CSS 变量）。
 */
const FUME_PASSED_FADE_MS = 900;
/** 第 6 条：结尾镜头留的边 —— 整张纸按视口的 94% 铺满，别贴死边。 */
const FUME_OUTRO_MARGIN = 0.94;
/** 第 6 条：结尾镜头的缩放下限（极长歌词的兜底，与 `CAMERA_SCALE_HARD_MIN` 同源）。 */
const FUME_OUTRO_SCALE_MIN = 0.16;
/**
 * **用户 m01402 第 3 条**（M4 剩余项之一）：曲尾的提前量。歌词已经唱完、或整首只剩这么多时，
 * 就进结尾镜头 —— 用户要的是「歌曲播放最后几秒」，而歌词常在曲末之前就唱完了。
 */
const FUME_OUTRO_LEAD_MS = 5000;

/** 第 6 条：结尾镜头的判定结果。 */
export interface FumeOutroPlan {
  /** 歌词是否已经全部唱完（判据见 `fumeOutroPlan`）。 */
  readonly active: boolean;
  /** 整张纸铺满视口所需的缩放（`active` 为 false 时是 1）。 */
  readonly scale: number;
}

/**
 * 第十五轮第 6 条（用户原话）：「浮名歌词动效，歌曲播放最后几秒歌词已经结束时，缩小画面展示整个
 * 歌词，如图 2 所示。并且镜头要跟随高亮的歌词移动」。
 *
 * **判据**（用户 m01402 第 3 条补上「剩余 N 秒」）：
 *   ① `ms >= lastEndMs`（最后一行的 `endMs` 已经过去）；或
 *   ② 知道整首时长且 `durationMs - ms <= FUME_OUTRO_LEAD_MS` —— 歌词写完之后还有一段纯音乐时，
 *      只靠 ① 要等到曲末才进镜头，用户要的「最后几秒」就落不到。
 * 两条都判不了（`lastEndMs <= 0` 且 `durationMs <= 0`）时恒不激活，不传时长的老调用点行为一字不改。
 * **缩放值**：`scale = min(视口宽 / 纸宽, 视口高 / 纸高) × 0.94`，再夹到 `[0.16, 1]`：
 * 两个方向里先贴满的那一边正好铺满视口（「铺满全屏」），另一边居中留边，整首歌词一个字都不切。
 */
export function fumeOutroPlan(
  ms: number,
  lastEndMs: number,
  paperWidth: number,
  paperHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  durationMs = 0,
): FumeOutroPlan {
  const finished = lastEndMs > 0 && ms >= lastEndMs;
  if (!finished && !fumeOutroSoon(ms, lastEndMs, durationMs)) return { active: false, scale: 1 };
  const fit = Math.min(
    viewportWidth / Math.max(paperWidth, 1),
    viewportHeight / Math.max(paperHeight, 1),
  );
  return { active: true, scale: clamp(fit * FUME_OUTRO_MARGIN, FUME_OUTRO_SCALE_MIN, 1) };
}

/**
 * 「歌词**还没**唱完，但整首只剩 `FUME_OUTRO_LEAD_MS` 以内」——`data-fume-state='outro-soon'`
 * 用的就是它（纯函数，另有单测）。不知道时长、`ms` 越过曲长、或歌词已经唱完时返回 false，
 * 这样「唱完」与「快到点」在 DOM 上是两个可分辨的态。
 */
export function fumeOutroSoon(ms: number, lastEndMs: number, durationMs: number): boolean {
  if (!(durationMs > 0) || ms > durationMs) return false;
  if (lastEndMs > 0 && ms >= lastEndMs) return false;
  return durationMs - ms <= FUME_OUTRO_LEAD_MS;
}

/**
 * 结尾镜头的位移：把 `focusWorld` 推到视口中心，但**整张纸不许出画**（这就是用户要的
 * 「镜头要跟随高亮的歌词移动」——跟随被夹在「整首歌词始终可见」的区间里，所以既跟了又不切）。
 * 纸完全可见时允许的位移区间是 `[0, 视口 − 纸 × scale]`（区间本来就很小 ⇒ 观感接近居中）；
 * 纸比视口还大时反过来是 `[视口 − 纸 × scale, 0]`（必须盖住视口）。两种情况一条式子写完。
 */
export function fumeOutroOffset(
  focusWorld: number,
  paperSize: number,
  viewportSize: number,
  scale: number,
): number {
  const free = viewportSize - paperSize * scale;
  const follow = viewportSize * 0.5 - focusWorld * scale;
  return clamp(follow, Math.min(0, free), Math.max(0, free));
}

/** 这一帧要用的颜色（已解析成 `rgb()` / 已过对比度兜底）。 */
interface FumePaint {
  readonly primary: string;
  readonly accent: string;
  /** 第十五轮第 4 条：常态（未唱 / 唱过）字色 = 白（底色撑不住白时降到可读墨色）。 */
  readonly ink: string;
  /** 底色（拿不到就是 null：不做对比度调整，颜色照用）。 */
  readonly surface: RgbColor | null;
}

/** palette 色 → 可直接写进 DOM 的字符串：解析得出就按底色调对比度，解析不出就用原值。 */
function readableColor(value: string, surface: RgbColor | null): string {
  if (surface === null) return value;
  const parsed = parseRgb(value);
  if (parsed === null) return value;
  return ensureContrast(parsed, surface, 3);
}

function buildFumePaint(colors: ResolvedThemeColors): FumePaint {
  const surface = parseRgb(colors.surface);
  return {
    primary: readableColor(colors.primary, surface),
    accent: readableColor(colors.accent, surface),
    // 第十五轮第 4 条：常态白。`readableColor` 只在底色撑不住白的时候才把它降到对比度 3 的墨色，
    // 深底（folia 那种）/ 暗档返回的就是纯白 —— 与其它五套主题的 `--pi-lyric-ink` 同一套判据。
    ink: readableColor(FUME_INK, surface),
    surface,
  };
}

/* ------------------------------------------------------------------ *
 * 排版求解
 * ------------------------------------------------------------------ */

interface FumeGlyph {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

interface FumeWordClump {
  readonly wordIndex: number;
  readonly color: string;
  readonly glyphs: readonly FumeGlyph[];
}

interface FumeBlock {
  readonly index: number;
  readonly text: string;
  readonly hero: boolean;
  /** 字重（hero 780 / body 640）：canvas 度量必须和 DOM 一致，所以随块一起存下来。 */
  readonly weight: number;
  readonly fontPx: number;
  readonly lineHeightPx: number;
  readonly column: number;
  readonly span: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly words: readonly FumeWordClump[];
  /** 这一块里第一个字素的绝对时间（做逐字素打印的 fallback）。 */
  readonly startMs: number;
  readonly endMs: number;
  readonly lineDurationMs: number;
  readonly translated?: string;
}

interface FumePlan {
  readonly paperWidth: number;
  readonly paperHeight: number;
  readonly blocks: readonly FumeBlock[];
  /** 内容（歌词块）在纸面坐标系里的左上角。第十一轮第 1 条：相机靠它避免切掉左边的字。 */
  readonly contentLeft: number;
  readonly contentTop: number;
}

/** 把一个词的时间区间按字素数均分给每个字素（与 `LyricStage.buildStageLines` 同款近似）。 */
function wordGlyphs(
  text: string,
  startMs: number,
  endMs: number,
): FumeGlyph[] {
  const parts = graphemesOf(text);
  const count = Math.max(parts.length, 1);
  const step = (endMs - startMs) / count;
  const out: FumeGlyph[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const start = startMs + step * index;
    out.push({ text: parts[index] ?? '', startMs: start, endMs: start + step });
  }
  return out;
}

function buildFumeColours(
  line: StageLine,
  palette: LyricPalette,
): readonly { color: string; glyphs: readonly FumeGlyph[] }[] {
  const starts = line.starts;
  const ends = line.ends;
  const wordCount = Math.max(starts.length, line.words.length);
  const out: { color: string; glyphs: readonly FumeGlyph[] }[] = [];
  for (let index = 0; index < wordCount; index += 1) {
    const word = line.words[index];
    const text = word?.text ?? '';
    if (text === '') continue;
    const startMs = starts[index] ?? word?.startMs ?? line.timeMs;
    const endMs = ends[index] ?? word?.endMs ?? line.timeMs + line.durationMs;
    out.push({
      color: wordColorOf(palette, text, palette.accentColor),
      glyphs: wordGlyphs(text, startMs, endMs),
    });
  }
  return out;
}

/**
 * 量一块文字会折成几行。
 *
 * 用 `measureTextWidth()`（canvas `measureText`，字体栈 / 字重和 DOM 完全一致）而不是
 * 「CJK 每字 1em、其余 0.55em」的估算：估算在拉丁 / 西里尔 / 假名混排下会低估宽度，
 * 折行数偏小 → 块高偏小 → 打乱的块会**互相压住**。
 * 词间空格只在「用空格分词」的语言里加（CJK / 假名 / 泰文没有词间空格）。
 */
function estimateRowCount(
  words: readonly FumeWordClump[],
  availableWidth: number,
  fontPx: number,
  weight: number,
  fontFamily: string,
): number {
  let width = 0;
  for (const word of words) {
    const text = word.glyphs.map((glyph) => glyph.text).join('');
    if (text === '') continue;
    width +=
      measureTextWidth(text, fontPx, weight, fontFamily, 0) +
      (usesWordSpaces(text) ? fontPx * 0.12 : 0);
  }
  return Math.max(1, Math.ceil(width / Math.max(availableWidth, 1)));
}

/** hero 判定的确定性种子（全局回退用；固定值保证同一行每次渲染都被选中 / 不被选中）。 */
const HERO_SEED = 13.7;

/** 一级：自然 hero —— 副歌短句，或「靠中间 + 中等长度 + 每 6 行一次 / 随机命中」的长句。 */
function isNaturalHero(
  lines: readonly StageLine[],
  line: StageLine,
  graphemes: number,
): boolean {
  if (isChorusLine(lines, line.index) && graphemes <= 22) return true;
  if (graphemes < 4 || graphemes > 28) return false;
  const total = Math.max(lines.length, 1);
  if (Math.abs(line.index - total / 2) / total >= 0.72) return false;
  return (line.index + 1) % 6 === 0 || seededFraction(HERO_SEED + line.index) > 0.965;
}

/**
 * 二级：全局回退 —— 整首一个自然 hero 都没有时，按
 * `centerScore × 0.62 + lengthScore × 0.34 + chorusScore + seededFraction(seed) × 0.04`
 * 选出**恰好一个** hero（种子确定，同一份歌词每次渲染选中的都是同一行）；
 * 再不行退回最短的非空块。
 */
function pickGlobalHero(
  candidates: readonly { readonly line: StageLine; readonly graphemes: number }[],
  lines: readonly StageLine[],
): number {
  const total = Math.max(lines.length, 1);
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    const { line, graphemes } = candidate;
    const centerScore = 1 - Math.abs(line.index - total / 2) / total;
    const lengthScore = graphemes >= 6 && graphemes <= 22 ? 1 : graphemes <= 28 ? 0.72 : 0.36;
    const chorusScore = isChorusLine(lines, line.index) ? 1 : 0;
    const score =
      centerScore * 0.62 + lengthScore * 0.34 + chorusScore + seededFraction(HERO_SEED + line.index) * 0.04;
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }
  if (best >= 0) return best;
  let shortest = -1;
  let shortestLength = Number.POSITIVE_INFINITY;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    if (candidate.graphemes < shortestLength) {
      shortestLength = candidate.graphemes;
      shortest = index;
    }
  }
  return shortest;
}

function buildFumePlan(
  lines: readonly StageLine[],
  translated: ReadonlyMap<number, string>,
  viewportWidth: number,
  viewportHeight: number,
  palette: LyricPalette,
  fontFamily: string,
): FumePlan {
  // 这套主题只有字号吃设置：构图 / 分栏 / 打乱都按「纸面」算，动字号会连带纸面重排，
  // 所以必须在 buildFumePlan 里乘，而不是渲染时改 CSS（那样只会把字挤出自己那一格）。
  const { fontScale } = tuningOf(palette);
  const paperWidth = clamp(
    Math.max(viewportWidth * PAPER_WIDTH_VW, viewportWidth + PAPER_WIDTH_EXTRA),
    PAPER_WIDTH_MIN,
    PAPER_WIDTH_MAX,
  );
  const paperHeight = Math.max(viewportHeight, PAPER_HEIGHT_FLOOR) * PAPER_HEIGHT_MULT;
  const cols = paperWidth >= 1120 ? 4 : paperWidth >= 760 ? 3 : paperWidth >= 500 ? 2 : 1;
  const gap = clamp(
    Math.round(paperWidth * (cols >= 4 ? GAP_RATIO_4 : cols === 3 ? GAP_RATIO_3 : GAP_RATIO_2)),
    GAP_MIN,
    GAP_MAX,
  );
  const columnWidth = (paperWidth - gap * (cols - 1)) / cols;

  // 1. 先切字素（hero 判定只依赖字素数 / 词数 / 是否副歌，与几何无关）。
  interface Candidate {
    readonly line: StageLine;
    readonly graphemes: number;
    readonly words: readonly FumeWordClump[];
  }
  const candidates: Candidate[] = [];
  for (const line of lines) {
    const clumps = buildFumeColours(line, palette);
    let graphemes = 0;
    for (const clump of clumps) graphemes += clump.glyphs.length;
    if (graphemes === 0) continue;
    candidates.push({
      line,
      graphemes,
      words: clumps.map((clump, wordIndex) => ({
        wordIndex,
        color: clump.color,
        glyphs: clump.glyphs,
      })),
    });
  }
  if (candidates.length === 0) {
    return {
      paperWidth,
      paperHeight,
      blocks: [],
      contentLeft: paperWidth * 0.5,
      contentTop: paperHeight * 0.5,
    };
  }

  // 2. hero 判定：自然 hero → 一个都没有时走全局回退（最多一个 hero）。
  const heroFlags = candidates.map((candidate) =>
    isNaturalHero(lines, candidate.line, candidate.graphemes),
  );
  if (!heroFlags.some((flag) => flag)) {
    const fallback = pickGlobalHero(candidates, lines);
    if (fallback >= 0) heroFlags[fallback] = true;
  }

  // 3. 块宽 / 字号 / 折行估算（现在 hero 已知，几何才对得上）。
  interface Sized {
    readonly line: StageLine;
    readonly hero: boolean;
    readonly width: number;
    readonly span: number;
    readonly weight: number;
    readonly fontPx: number;
    readonly lineHeightPx: number;
    readonly height: number;
    readonly words: readonly FumeWordClump[];
  }
  const sized: Sized[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    const { line, graphemes, words } = candidate;
    const hero = heroFlags[index] === true;
    const wordCount = words.length;
    const density = graphemes + wordCount * 1.4;
    const span = hero && cols > 1 ? 2 : 1;
    const rawWidth =
      hero && cols > 1
        ? cols === 2
          ? columnWidth * 1.5 + gap * 0.5
          : columnWidth * 2 + gap
        : hero && cols <= 1
          ? paperWidth
          : columnWidth;
    const width = rawWidth;
    const availableInner = width;
    // 字号 = 原公式 × 设置里的 `fontScale`，中间那层 clamp 的上下限也跟着放宽同样倍数：
    // 只乘不放上限的话，fontScale > 1 时 hero 行会被原来的 54px 夹回去，旋钮在最显眼的
    // 那几行上等于失效。最后再按 `FONT_SCALE_MAX` 夹一次，保证 1.3 倍时也不会把
    // 一行字撑出它所在的栏（超长的单个词本来就换不了行，这里只能保证不比原来更容易撞）。
    const rawFontPx = hero
      ? clamp(width / Math.max(Math.sqrt(density) * 1.5, 4.5), FONT_HERO_MIN_PX, FONT_HERO_MAX_PX)
      : clamp(width / Math.max(Math.sqrt(density) * 2.25, 7), FONT_BODY_MIN_PX, FONT_BODY_MAX_PX);
    const fontPx = clamp(
      rawFontPx * fontScale,
      FONT_BODY_MIN_PX,
      (hero ? FONT_HERO_MAX_PX : FONT_BODY_MAX_PX) * FONT_SCALE_MAX,
    );
    const lineHeightPx = fontPx * (hero ? 1.02 : 1.06);
    const weight = hero ? 780 : 640;
    const rows = estimateRowCount(words, availableInner, fontPx, weight, fontFamily);
    const height = rows * lineHeightPx * 1.34 + lineHeightPx * 0.35;
    const block: Sized = {
      line,
      hero,
      width,
      span,
      weight,
      fontPx,
      lineHeightPx,
      height,
      words,
    };
    sized.push(block);
  }

  // 4. 确定性打乱（fume 的灵魂：构图不是时间顺序）。
  const order = sized.map((_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const seed = 91.7 + index * 3.7;
    const swap = Math.floor(seededFraction(seed) * (index + 1));
    const tmp = order[index] ?? 0;
    order[index] = order[swap] ?? 0;
    order[swap] = tmp;
  }

  // 5. 贪心填列：body 进最矮列，hero 跨列并挑「被覆盖列最大高度最小」的起始列。
  const cursors = new Array<number>(cols).fill(0);
  const blocks: FumeBlock[] = [];
  let roundRobin = 0;
  /** 放不下时整体往下再铺一张纸（保证不重叠；DOM 只挂相机附近的块，越界部分自然被裁掉）。 */
  let pageOffset = 0;
  for (const orderIndex of order) {
    const item = sized[orderIndex];
    if (item === undefined) continue;
    const { line, hero, width, span, weight, fontPx, lineHeightPx, height, words } = item;
    const gapBefore = hero
      ? Math.max(Math.round(lineHeightPx * 0.2), 6)
      : Math.max(Math.round(lineHeightPx * 0.08), 2);
    let column = 0;
    if (span >= 2) {
      let bestColumn = 0;
      let bestHeight = Number.POSITIVE_INFINITY;
      const last = Math.max(cols - span, 0);
      for (let candidate = 0; candidate <= last; candidate += 1) {
        let maxHeight = 0;
        for (let offset = 0; offset < span; offset += 1) {
          maxHeight = Math.max(maxHeight, cursors[candidate + offset] ?? 0);
        }
        if (maxHeight < bestHeight) {
          bestHeight = maxHeight;
          bestColumn = candidate;
        }
      }
      column = bestColumn;
    } else {
      let minHeight = Number.POSITIVE_INFINITY;
      let candidateColumns: number[] = [];
      for (let index = 0; index < cols; index += 1) {
        const cursor = cursors[index] ?? 0;
        if (cursor < minHeight) {
          minHeight = cursor;
          candidateColumns = [index];
        } else if (cursor === minHeight) {
          candidateColumns.push(index);
        }
      }
      column = candidateColumns[roundRobin % Math.max(candidateColumns.length, 1)] ?? 0;
      roundRobin += 1;
    }
    // 找一个放得下的 y（放不下就整体再铺一张纸，保证块之间不重叠）。
    let top = 0;
    for (let offset = 0; offset < span; offset += 1) {
      top = Math.max(top, cursors[column + offset] ?? 0);
    }
    if (top + gapBefore + height > paperHeight) {
      pageOffset += paperHeight + gap * 4;
      for (let index = 0; index < cols; index += 1) cursors[index] = 0;
      top = 0;
    }
    const y = top + gapBefore;
    const bottom = y + height;
    for (let offset = 0; offset < span; offset += 1) {
      const target = column + offset;
      if (target >= 0 && target < cols) cursors[target] = bottom;
    }
    const x = column * (columnWidth + gap);
    const lineHeightOut = lineHeightPx;
    blocks.push({
      index: line.index,
      text: line.text,
      hero,
      weight,
      fontPx,
      lineHeightPx: lineHeightOut,
      column,
      span,
      x,
      y: y + pageOffset,
      width,
      height,
      words,
      startMs: item.line.timeMs,
      endMs: item.line.timeMs + item.line.durationMs,
      lineDurationMs: item.line.durationMs,
      translated: translated.get(line.timeMs),
    });
  }
  // 放不下的块会被「再铺一张纸」（`pageOffset`）推到 `paperHeight` 之下。相机那条
  // 「纸面必须盖住视口」的约束是拿 `paperWidth / paperHeight` 算的，所以这里把纸面撑到
  // 内容真实边界——否则唱到后面几页时，焦点在纸面之外、约束会把相机夹回底边，
  // 正在打印的块反而被顶出屏幕。撑大只影响世界层 div 的尺寸（绝对定位子元素本来就越界渲染），
  // 不影响列布局（列参数每帧都由视口重算）。
  let contentRight = paperWidth;
  let contentBottom = paperHeight;
  // 第十一轮第 1 条：同时要记内容的**左上**角。相机那条「纸面盖住视口」的约束只按纸面算，
  // 而块是贴着纸面左边 / 上边排的，所以左边界的兜底必须知道内容从哪儿开始（详见
  // `clampCameraOffset`）。没有任何块时退化成纸面中心 ⇒ 与旧行为完全一致。
  let contentLeft = paperWidth * 0.5;
  let contentTop = paperHeight * 0.5;
  for (const block of blocks) {
    contentRight = Math.max(contentRight, block.x + block.width);
    contentBottom = Math.max(contentBottom, block.y + block.height);
    contentLeft = Math.min(contentLeft, block.x);
    contentTop = Math.min(contentTop, block.y);
  }
  return {
    paperWidth: contentRight,
    paperHeight: contentBottom,
    blocks,
    contentLeft: Math.min(contentLeft, contentRight),
    contentTop: Math.min(contentTop, contentBottom),
  };
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

interface FumeBlockViewProps {
  readonly block: FumeBlock;
  readonly registerBlock: (index: number, element: HTMLDivElement | null) => void;
  readonly registerGlyph: (key: string, element: HTMLSpanElement | null) => void;
}

function FumeBlockView({ block, registerBlock, registerGlyph }: FumeBlockViewProps): ReactNode {
  const hero = block.hero;
  return (
    <div
      className={`pi-lyricfume__block${hero ? ' pi-lyricfume__block--hero' : ''}`}
      // 父代理的「点歌词行 seek」靠事件委托：块 = 一行歌词，块左上角就是这一行的时间。
      data-lyric-line={block.index}
      data-line-time={block.startMs}
      // `LyricStage.tsx:26-27` 的行元素契约要 `data-active`：fume 的「当前行」就是正在打印的
      // 那一块（`hero`），别的四套主题都写了这个属性，缺了它冒烟的歌词轨道探针会读成 active=-1。
      data-active={hero}
      ref={(element) => {
        registerBlock(block.index, element);
      }}
      style={
        {
          left: `${block.x.toFixed(2)}px`,
          top: `${block.y.toFixed(2)}px`,
          width: `${block.width.toFixed(2)}px`,
          '--pi-fume-font': `${block.fontPx.toFixed(2)}px`,
          '--pi-fume-line-height': `${block.lineHeightPx.toFixed(2)}px`,
          '--pi-fume-weight': hero ? '780' : '640',
        } as CSSProperties
      }
    >
      <div className="pi-lyricfume__text">
        {block.words.map((clump) => (
          <span className="pi-lyricfume__word" key={`${clump.wordIndex}-${clump.color}`}>
            {clump.glyphs.map((glyph, glyphIndex) => (
              <span
                className="pi-lyricfume__glyph"
                data-glyph
                key={`${glyphIndex}-${glyph.text}`}
                ref={(element) => {
                  registerGlyph(`${block.index}:${clump.wordIndex}:${glyphIndex}`, element);
                }}
              >
                {glyph.text}
              </span>
            ))}
          </span>
        ))}
      </div>
      {block.translated === undefined || block.translated === '' ? null : (
        <span className="pi-lyricfume__translated">{block.translated}</span>
      )}
    </div>
  );
}

/**
 * 浮名主题。
 *
 * 每帧：把纸面 wrapper 按弹簧相机位移 / 缩放，再给「当前块」的每个字素写 opacity / color / textShadow，
 * 其余块只在状态跨越时写一次。全程不 setState、不新建 / 销毁节点、不查 DOM。
 */
export function FumeTheme(props: LyricThemeProps): ReactNode {
  const { lines, translated, activeIndex, viewIndex, positionMs, theme } = props;
  // 用户 m01402 第 3 条：整首时长（拿不到就是 0 = 不知道），只服务曲尾「剩余 N 秒」那条判据。
  const durationMs = props.durationMs ?? 0;
  const rootRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const blockRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const glyphRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  // 舞台 = 整个播放页可视区域（首帧 / 量不到回退视口）；窗口缩放由 ResizeObserver 重算。
  const stage = useFullStageSize(rootRef);
  const viewportWidth = stage.width;
  const viewportHeight = stage.height;
  // canvas 度量必须和 DOM 同一套字体栈，否则量出来的宽度和真实折行对不上。
  const fontFamily = useElementFontFamily(rootRef);
  const clock = usePositionClock(positionMs);
  const reduced = usePrefersReducedMotion();
  const positionRef = useRef(positionMs);
  positionRef.current = positionMs;

  const plan = useMemo(
    () => buildFumePlan(lines, translated, viewportWidth, viewportHeight, theme, fontFamily),
    [fontFamily, lines, translated, viewportWidth, viewportHeight, theme],
  );

  // 设置里的动效参数（字号走 plan，其余三个走 rAF）。取成局部变量是为了给下面那个
  // effect 一个**具体**的依赖：直接写 `theme` 会因为主题色每次换歌都变而白重启一次循环。
  const tuning = tuningOf(theme);

  // 颜色跟随歌曲：祖先注入的 `--pi-th-*`（播放页按当前歌曲封面注入）优先，palette 兜底，
  // 再按底色做对比度兜底。rAF **每帧从 `paintRef.current` 现读**，换歌后下一帧就换色。
  const liveColors = useResolvedThemeColors(rootRef, theme);
  const paint = buildFumePaint(liveColors.current);
  const paintRef = useRef<FumePaint>(paint);
  paintRef.current = paint;

  const blocks = plan.blocks;
  /** 最后一块歌词的结束时间 —— 第十五轮第 6 条「整首歌词已经唱完」的判据基准。 */
  const lastEndMs = useMemo(
    () => blocks.reduce((max, block) => Math.max(max, block.endMs), 0),
    [blocks],
  );
  const viewBlock = useMemo(() => {
    for (const block of blocks) if (block.index === viewIndex) return block;
    return undefined;
  }, [blocks, viewIndex]);
  const activeBlock = useMemo(() => {
    for (const block of blocks) if (block.index === activeIndex) return block;
    return undefined;
  }, [blocks, activeIndex]);

  /**
   * 第十五轮第 6 条：整首歌词唱完之后，把镜头拉到「整张纸铺满视口」。
   * 判据与缩放值都在 `fumeOutroPlan` 里（纯函数，另有单测）。
   * 注意这里用的是播放器传进来的 `positionMs`（不是 rAF 里平滑过的 clock）：差一次属性更新
   * （≤ 数百 ms）就能翻转，换来的是「DOM 该挂哪些块」这件事在渲染期就有定论。
   */
  const outro = useMemo(
    () =>
      fumeOutroPlan(
        positionMs,
        lastEndMs,
        plan.paperWidth,
        plan.paperHeight,
        viewportWidth,
        viewportHeight,
        durationMs,
      ),
    [
      durationMs,
      lastEndMs,
      plan.paperHeight,
      plan.paperWidth,
      positionMs,
      viewportHeight,
      viewportWidth,
    ],
  );
  // 拆成两个**标量**再进 effect 依赖：`outro` 每次 `positionMs` 更新都是一个新对象，直接当依赖
  // 会让整个 rAF（连弹簧状态机）每几百 ms 重启一次。
  const outroActive = outro.active;
  const outroScale = outro.scale;
  /** 歌词还没唱完、整首已经只剩不到 5s（`data-fume-state='outro-soon'` 用；唱完时它是 false）。 */
  const outroSoon = fumeOutroSoon(positionMs, lastEndMs, durationMs);

  /** 只挂相机附近的块；第十五轮第 6 条的结尾镜头要**整首**都铺出来，所以那时全挂。 */
  const visible = useMemo(
    () =>
      outroActive
        ? blocks
        : blocks.filter(
            (block) =>
              block.index >= viewIndex - WINDOW_BACK && block.index <= viewIndex + WINDOW_AHEAD,
          ),
    [blocks, outroActive, viewIndex],
  );

  // 相机状态：只在 rAF 闭包里维护。
  const cameraRef = useRef({
    x: 0,
    y: 0,
    scale: INITIAL_CAMERA_SCALE,
    velocityX: 0,
    velocityY: 0,
    zoomVelocity: 0,
    seeded: false,
  });

  useEffect(() => {
    const root = rootRef.current;
    const world = worldRef.current;
    if (root === null || world === null) return undefined;

    const calm = theme.animationIntensity === 'calm';
    const chaotic = theme.animationIntensity === 'chaotic';
    // 设置项（辉光强度 / 动效幅度 / 帧率上限 / 镜头追焦）在 effect 起点取一次：`theme` 是稳定引用的
    // palette，它变一次 effect 就重启一次，所以这里当闭包常量用，不必每帧查表。
    const { fpsCap, glowIntensity, motionAmount, fumeCameraFollow, fumeCameraSpeed } = tuningOf(theme);
    // 镜头追焦（第十四轮第 3 条）：速度倍率夹一次兜底，`1` = 改造前那组弹簧常数的等效速度；
    // `snap` = 定格（切句瞬间直接换机位，没有插值）。
    const cameraSpeed = clamp(fumeCameraSpeed, FUME_CAMERA_SPEED_MIN, FUME_CAMERA_SPEED_MAX);
    const snapCamera = fumeCameraFollow === 'snap';
    const frameGate = createFrameGate(fpsCap);
    // 原来那个 `* 1` 就是 folia 留给 glowIntensity 的位子：辉光的两档强度都乘它。
    const glyphGlowBoost = (chaotic ? 1.15 : calm ? 0.72 : 0.92) * glowIntensity;
    const passedGlowBase = (chaotic ? 0.95 : calm ? 0.35 : 0.62) * glowIntensity;
    const targetLineHeight = clamp(
      Math.min(viewportWidth, viewportHeight) * CAMERA_LINE_HEIGHT_RATIO,
      CAMERA_LINE_HEIGHT_MIN,
      CAMERA_LINE_HEIGHT_MAX,
    );
    // 每个块上一次的「阶段」（waiting / active / passed），只在跨越时写整块样式。
    const phaseCache = new Map<number, string>();
    const glyphGlowCache = new Map<string, number>();

    /** 静止渲染（减少动效 / 初始化时用）。 */
    const paintStatic = (): void => {
      const ms = positionRef.current;
      const paintNow = paintRef.current;
      const primary = paintNow.primary;
      const camera = cameraRef.current;
      const contentBlock = activeBlock ?? viewBlock;
      // 第十五轮第 6 条：静止渲染也要能给出「整张纸铺满视口」这一档（判据与 rAF 同源）。
      const staticFocus = resolveFocus(activeBlock, viewBlock);
      const scale = outroActive ? outroScale : INITIAL_CAMERA_SCALE;
      camera.scale = scale;
      if (outroActive) {
        camera.x = fumeOutroOffset(
          staticFocus?.worldX ?? plan.paperWidth * 0.5,
          plan.paperWidth,
          viewportWidth,
          scale,
        );
        camera.y = fumeOutroOffset(
          staticFocus?.worldY ?? plan.paperHeight * 0.5,
          plan.paperHeight,
          viewportHeight,
          scale,
        );
      } else {
        // 静态渲染也要满足「纸面盖住视口 + 正在唱的那一块不被切」这条：纸面居中 + 夹取。
        // 第十一轮第 1 条：横向的第二个约束按**正在唱的那一块**（`activeBlock ?? viewBlock`，
        // 与 `resolveFocus` 的选择同源）；纵向仍只按纸面。
        camera.x = frameCameraOffset(
          viewportWidth * 0.5,
          plan.paperWidth * 0.5,
          plan.paperWidth,
          viewportWidth,
          scale,
          contentBlock?.x ?? null,
          contentBlock?.width ?? null,
        );
        camera.y = frameCameraOffset(
          viewportHeight * CAMERA_FOCUS_Y,
          plan.paperHeight * 0.5,
          plan.paperHeight,
          viewportHeight,
          scale,
        );
      }
      camera.velocityX = 0;
      camera.velocityY = 0;
      camera.zoomVelocity = 0;
      camera.seeded = true;
      world.style.transform = `translate3d(${camera.x.toFixed(2)}px, ${camera.y.toFixed(
        2,
      )}px, 0) scale(${scale})`;
      // 第十五轮第 6 条的可判定接缝：世界缩放写到 `data-fume-scale`（缩小态一定 < 1）。
      world.dataset.fumeScale = scale.toFixed(3);
      // 第十五轮第 6 条：结尾镜头里最后一句保持高亮（主题色 + 满不透明），其余照旧「唱过」的淡白。
      const outroFocusIndex = outroActive ? contentBlock?.index : undefined;
      for (const block of visible) {
        const element = blockRefs.current[block.index];
        if (element === null || element === undefined) continue;
        const passed = ms > block.endMs;
        const active = !passed && ms >= block.startMs;
        const alpha = active
          ? block.hero
            ? 0.985
            : 0.92
          : passed
            ? block.hero
              ? PASSED_ALPHA_HERO
              : PASSED_ALPHA_BODY
            : block.hero
              ? WAIT_ALPHA_HERO
              : WAIT_ALPHA_BODY;
        const isOutroFocus = outroFocusIndex !== undefined && block.index === outroFocusIndex;
        // 第十五轮第 4 条：常态（未唱 / 唱过）白、当前高亮句才主题色；第 6 条：结尾那句继续高亮。
        element.style.opacity = isOutroFocus ? '1' : alpha.toFixed(3);
        element.style.color = isOutroFocus ? paintNow.accent : active ? primary : paintNow.ink;
        element.style.textShadow = 'none';
        element.style.filter = 'none';
      }
      for (const glyph of Object.values(glyphRefs.current)) {
        if (glyph === null || glyph === undefined) continue;
        glyph.style.color = 'inherit';
        glyph.style.opacity = '1';
        glyph.style.textShadow = 'none';
      }
    };

    if (reduced) {
      paintStatic();
      return undefined;
    }

    let frame = 0;
    let running = false;
    let last = performance.now();
    const tick = (now: number): void => {
      // 帧率上限：这一帧不许画就整帧跳过（含所有样式写入），只把 rAF 链接下去。
      // `last` 故意不更新，下一次通过的 dt 才是「距上帧真实经过的时间」，相机速度不会抖。
      // `fpsCap === 'off'` 时 frameGate 恒为 true，路径与加这个旋钮之前完全一致。
      if (!frameGate(now)) {
        if (running) frame = window.requestAnimationFrame(tick);
        return;
      }
      const dt = clamp((now - last) / 1000, 1 / 240, 0.05);
      last = now;
      const ms = clock.current();
      const camera = cameraRef.current;
      // 颜色每帧现读：换歌 / 切换亮暗 → 祖先重写 `--pi-th-*` → 下一帧就是新色（相机不重启）。
      const palette = paintRef.current;
      // 目标：当前**句**（激活块）的中心（第十四轮第 3 条：镜头中心跟着正亮着的那一句走）。
      // 没有激活块（还没唱到第一句 / 手动查看）时退化成 `viewBlock` 的中心。
      const focus = resolveFocus(activeBlock, viewBlock);
      const focusLineHeight = focus?.lineHeightPx ?? 48;
      // 第十五轮第 6 条：歌词全部唱完 ⇒ 缩放目标换成「整张纸铺满视口」那一档；这一档允许低于
      // `CAMERA_SCALE_MIN`（否则永远缩不到「能一次看全整首歌词」的比例）。
      const scaleFloor = outroActive ? FUME_OUTRO_SCALE_MIN : CAMERA_SCALE_HARD_MIN;
      // 动效幅度裁的是「离 1 有多远」：motionAmount = 1 时结果与加这个旋钮之前逐位相同，
      // 调小 → 推近/拉远收敛成接近原始比例，调大 → 更冲。硬上下限由后面的 framingScale 兜底。
      const rawScaleTarget = outroActive
        ? outroScale
        : clamp(
            targetLineHeight / Math.max(focusLineHeight, 1),
            CAMERA_SCALE_MIN,
            CAMERA_SCALE_MAX,
          );
      const scaleTarget = outroActive
        ? outroScale
        : clamp(1 + (rawScaleTarget - 1) * motionAmount, CAMERA_SCALE_MIN, CAMERA_SCALE_MAX);
      // 相机按 `scaleTarget`（弹簧的收敛值）算目标位姿：世界点 w 的屏幕位置是 `x + w * s`，
      // 所以平移量必须带 `* s`——旧写法漏了这一项，scale > 1 时焦点会被 `w * (s - 1)` 推离锚点，
      // 靠后的列甚至会被推出屏幕（窗口越宽 / 越高越明显）。夹取再保证纸面始终盖住视口。
      const framingScale = clamp(scaleTarget, scaleFloor, CAMERA_SCALE_HARD_MAX);
      const focusWorldX = focus?.worldX ?? plan.paperWidth * 0.5;
      const focusWorldY = focus?.worldY ?? plan.paperHeight * 0.5;
      // 第十一轮第 1 条：横向的第二个约束按**正在唱的那一块**（与 `resolveFocus` 同源），
      // 保证它左缘不出窗口；纵向不按内容夹（否则曲首第一行会被钉到窗口顶、取景全变）。
      const contentBlock = activeBlock ?? viewBlock;
      // 第十五轮第 6 条：结尾镜头把高亮句推到视口中心，但整张纸不许出画（`fumeOutroOffset`）。
      const targetX = outroActive
        ? fumeOutroOffset(focusWorldX, plan.paperWidth, viewportWidth, framingScale)
        : frameCameraOffset(
            viewportWidth * 0.5,
            focusWorldX,
            plan.paperWidth,
            viewportWidth,
            framingScale,
            contentBlock?.x ?? null,
            contentBlock?.width ?? null,
          );
      const targetY = outroActive
        ? fumeOutroOffset(focusWorldY, plan.paperHeight, viewportHeight, framingScale)
        : frameCameraOffset(
            viewportHeight * CAMERA_FOCUS_Y,
            focusWorldY,
            plan.paperHeight,
            viewportHeight,
            framingScale,
          );
      // 追焦方式（第十四轮第 3 条）：`snap` = 定格，切句瞬间直接换机位、速度清零，没有插值。
      if (!camera.seeded) {
        // 首帧 / 重新挂载：不插值直接落位，免得从 (0, 0) 或上一首歌的位姿弹簧过去。
        camera.x = targetX;
        camera.y = targetY;
        camera.scale = clamp(scaleTarget, scaleFloor, CAMERA_SCALE_HARD_MAX);
        camera.velocityX = 0;
        camera.velocityY = 0;
        camera.zoomVelocity = 0;
        camera.seeded = true;
      } else if (snapCamera && !outroActive) {
        // 第十五轮第 6 条：结尾那次「缩小铺满」即使设置成「定格」也要**插值**走过去
        //（否则整张纸会瞬间跳成一张缩略图，而用户第 6 条要的是「缩小画面」这个过程）。
        camera.x = targetX;
        camera.y = targetY;
        camera.velocityX = 0;
        camera.velocityY = 0;
      } else {
        // `duration` / 弹簧强度 / 阻尼 / 限速都沿用改造前那套（换算见 `cameraSpring`），
        // 只把「速度」量纲乘 `cameraSpeed`：`ω' = ω × s` ⇔ `k' = k × s²`、`c' = c × s`。
        const duration = Math.max((focus?.catchUpMs ?? 1600) / 1000, 0.05);
        const { omega, zeta } = cameraSpring(duration, cameraSpeed);
        const maxVelocity =
          clamp(
            Math.hypot(targetX - camera.x, targetY - camera.y) / Math.max(duration * 0.28, 0.028),
            CAMERA_VELOCITY_MIN,
            CAMERA_VELOCITY_MAX,
          ) * cameraSpeed;
        // 限速在积分之前（改造前也是先夹速度、再拿夹过的速度推位置）。
        const velocityMag = Math.hypot(camera.velocityX, camera.velocityY);
        if (velocityMag > maxVelocity) {
          const factor = maxVelocity / velocityMag;
          camera.velocityX *= factor;
          camera.velocityY *= factor;
        }
        const nextX = springStep(camera.x, camera.velocityX, targetX, omega, zeta, dt);
        camera.x = nextX.position;
        camera.velocityX = nextX.velocity;
        const nextY = springStep(camera.y, camera.velocityY, targetY, omega, zeta, dt);
        camera.y = nextY.position;
        camera.velocityY = nextY.velocity;
      }
      // 第十轮第 5 条加固（用户 m02362：浮名歌词「会飘出窗口界面而显示不全」）：弹簧积分之后
      // **再夹一次**。只夹「目标位姿」不够——跨页时页偏移让 target 跳出去一整张纸
      // （`pageOffset += paperHeight + gap * 4`），过冲那几帧仍会把纸面推出视口、露出空白。
      // 边界与 `frameCameraOffset` 完全同源。定格模式也走这一段（对已经夹过的目标位姿是幂等的）。
      if (outroActive) {
        // 第十五轮第 6 条：结尾镜头按「整张纸铺满视口、高亮句居中、纸不许出画」夹取，
        // 不能再沿用「纸面必须盖住视口」那条（它正好把缩略图推出画面）。
        camera.x = fumeOutroOffset(focusWorldX, plan.paperWidth, viewportWidth, camera.scale);
        camera.y = fumeOutroOffset(focusWorldY, plan.paperHeight, viewportHeight, camera.scale);
      } else {
        camera.x = clampCameraOffset(
          camera.x,
          viewportWidth,
          plan.paperWidth * camera.scale,
          viewportWidth * CAMERA_EDGE_GUARD,
          contentBlock === undefined ? null : contentBlock.x * camera.scale,
          contentBlock === undefined ? null : contentBlock.width * camera.scale,
        );
        camera.y = clampCameraOffset(
          camera.y,
          viewportHeight,
          plan.paperHeight * camera.scale,
          viewportHeight * CAMERA_EDGE_GUARD,
        );
      }
      if (snapCamera && !outroActive) {
        // 定格：缩放也直接给到位（`framingScale` 就是 `clamp(scaleTarget, 硬上下限)`）。
        camera.scale = clamp(scaleTarget, scaleFloor, CAMERA_SCALE_HARD_MAX);
        camera.zoomVelocity = 0;
      } else {
        // 缩放弹簧也是同一条隐式解：`ω = √108 × cameraSpeed`、`ζ = 21 / (2√108) ≈ 1.01`。
        const nextScale = springStep(
          camera.scale,
          camera.zoomVelocity,
          scaleTarget,
          CAMERA_ZOOM_OMEGA * cameraSpeed,
          CAMERA_ZOOM_ZETA,
          dt,
        );
        camera.scale = nextScale.position;
        camera.zoomVelocity = nextScale.velocity;
      }
      camera.scale = clamp(camera.scale, scaleFloor, CAMERA_SCALE_HARD_MAX);
      // idle 浮动（世界位移要除以当前 scale）。整套飘移幅度乘设置的 `motionAmount`：
      // 位移用 `idleSpan`，缩放项乘在振幅上（`1 + 振幅 × motionAmount`，motionAmount = 1 时原样）。
      const idleSpan = IDLE_DISTANCE * motionAmount;
      const phase = ((now / 1000) / IDLE_PERIOD_SEC) * Math.PI * 2;
      const idleX = (Math.sin(phase * 0.74 + 0.8) * idleSpan * 0.34) / camera.scale;
      const idleY =
        ((Math.sin(phase) * idleSpan + Math.sin(phase * 0.5 + 1.1) * idleSpan * 0.22) /
          camera.scale) *
        (1 + IDLE_SCALE_AMPLITUDE * motionAmount);
      world.style.transform = `translate3d(${(camera.x + idleX).toFixed(2)}px, ${(
        camera.y + idleY
      ).toFixed(2)}px, 0) scale(${camera.scale.toFixed(4)})`;
      // 第十五轮第 6 条的可判定接缝：世界缩放写到 `data-fume-scale`，只在第三位小数变化时写，
      // 避免每帧都动 dataset（探针可以直接读它断言「缩小」，不用解析 transform 的矩阵）。
      const scaleMark = camera.scale.toFixed(3);
      if (world.dataset.fumeScale !== scaleMark) world.dataset.fumeScale = scaleMark;

      // 当前正在打印的字素（用于「前沿」提示）。
      const activeKey = resolveFrontKey(activeBlock, ms);
      // 第十五轮第 6 条：结尾镜头里「当前高亮的那一句」= 最后唱过的那一块（`activeBlock ?? viewBlock`），
      // 它在缩略图里保持主题色 + 满不透明，其余全部是淡白 —— 对应用户图 2 的样子。
      const outroFocusIndex = outroActive ? contentBlock?.index : undefined;

      for (const block of visible) {
        const element = blockRefs.current[block.index];
        if (element === null || element === undefined) continue;
        const passed = ms > block.endMs;
        const active = !passed && ms >= block.startMs && activeBlock !== undefined && block.index === activeBlock.index;
        // 第十五轮第 4 条：从「唱过」那一刻起，块色 / 亮度按 900ms **逐渐**淡回常态白（不是瞬间跳色）。
        const passedFade = passed ? clamp((ms - block.endMs) / FUME_PASSED_FADE_MS, 0, 1) : 1;
        const fading = passed && passedFade < 1;
        const phase =
          outroFocusIndex !== undefined
            ? block.index === outroFocusIndex
              ? 'outro-current'
              : 'outro-away'
            : active
              ? 'active'
              : passed
                ? 'passed'
                : 'waiting';
        // 第十五轮第 4 条的可判定接缝：把这一块**当前所在的相位**写到 DOM（只在变化时写），
        // 探针不必解析内联样式就能区分 `waiting` / `active` / `passed` / `outro-current` / `outro-away`。
        if (element.dataset.fumePhase !== phase) element.dataset.fumePhase = phase;
        const previousPhase = phaseCache.get(block.index);
        const lineProgress = clamp(
          (ms - block.startMs) / Math.max(block.lineDurationMs, 1),
          0,
          1,
        );
        const envelope =
          lineProgress <= LINE_ENVELOPE_PEAK
            ? easeOutCubic(lineProgress / LINE_ENVELOPE_PEAK)
            : 1 - easeInCubic((lineProgress - LINE_ENVELOPE_PEAK) / (1 - LINE_ENVELOPE_PEAK));
        const hero = block.hero;
        if (previousPhase !== phase || active || fading) {
          phaseCache.set(block.index, phase);
          if (phase === 'outro-current') {
            // 第十五轮第 6 条：结尾镜头里的高亮句 —— 主题色 + 满不透明 + 一圈主题色光晕。
            element.style.color = palette.accent;
            element.style.opacity = '1';
            element.style.textShadow = `0 0 ${(
              (hero ? LINE_GLOW_BLUR_HERO : LINE_GLOW_BLUR_BODY) * 2
            ).toFixed(2)}px ${glowColor(palette.accent, 0.5)}`;
            paintPassedGlyphs(block, glyphRefs, glyphGlowCache);
          } else if (phase === 'outro-away') {
            // 其余整首歌词：常态白 + 「唱过」那档暗度（用户图 2 里那些白而淡的字）。
            element.style.color = palette.ink;
            element.style.opacity = (hero ? PASSED_ALPHA_HERO : PASSED_ALPHA_BODY).toFixed(3);
            element.style.textShadow = 'none';
            paintPassedGlyphs(block, glyphRefs, glyphGlowCache);
          } else if (phase === 'active') {
            // 整行辉光 + 逐字素打印。
            const glowAlpha = (hero ? LINE_GLOW_ALPHA_HERO : LINE_GLOW_ALPHA_BODY) +
              envelope * (hero ? LINE_GLOW_ALPHA_SPAN_HERO : LINE_GLOW_ALPHA_SPAN_BODY);
            const glowBlur =
              (hero ? LINE_GLOW_BLUR_HERO : LINE_GLOW_BLUR_BODY) +
              envelope * block.fontPx * (hero ? LINE_GLOW_BLUR_SPAN_HERO : LINE_GLOW_BLUR_SPAN_BODY);
            element.style.textShadow = `0 0 ${glowBlur.toFixed(2)}px ${glowColor(palette.accent, glowAlpha)}`;
            element.style.color = palette.primary;
            element.style.opacity = '1';
            paintActiveGlyphs(block, ms, activeKey, palette, glyphGlowBoost, glyphRefs, glyphGlowCache);
          } else if (phase === 'passed') {
            // 第十五轮第 4 条：唱过之后整块淡成常态白，残余光晕也随 900ms 一起淡到零
            //（「高亮时才有其他颜色（辉光）」——唱过就不该继续挂着主题色光晕）。
            const glow = (2 + block.fontPx * 0.1) * 0.65 * passedGlowBase * (1 - passedFade);
            // 第十五轮第 4 条：块色也从**它上一帧还在用的** `palette.primary` 起，按同一条 900ms
            // 淡到常态白 —— `passedFade = 0` 那一帧等于 `palette.primary`，所以字素从
            // `paintPassedGlyphs` 的 `color: inherit` 接手时不会跳色；`passedFade = 1` 时正好是 ink。
            element.style.color = mixColor(palette.primary, palette.ink, passedFade);
            element.style.opacity = mixNumber(
              1,
              hero ? PASSED_ALPHA_HERO : PASSED_ALPHA_BODY,
              passedFade,
            ).toFixed(3);
            element.style.textShadow =
              passedFade >= 1
                ? 'none'
                : `0 0 ${glow.toFixed(2)}px ${glowColor(palette.accent, 0.42 * (1 - passedFade))}`;
            paintPassedGlyphs(block, glyphRefs, glyphGlowCache);
          } else {
            element.style.color = palette.ink;
            element.style.opacity = (hero ? WAIT_ALPHA_HERO : WAIT_ALPHA_BODY).toFixed(3);
            element.style.textShadow = 'none';
            paintWaitingGlyphs(block, glyphRefs);
          }
        }
      }
      if (running) frame = window.requestAnimationFrame(tick);
    };
    // 页面不可见时停掉循环，可见时按当前 positionMs 重新对齐再继续（重置 last，不累积时间差跳字）。
    const startLoop = (): void => {
      if (running) return;
      running = true;
      last = performance.now();
      frame = window.requestAnimationFrame(tick);
    };
    const stopLoop = (): void => {
      running = false;
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') stopLoop();
      else startLoop();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    startLoop();
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopLoop();
    };
  }, [activeBlock, clock, fontFamily, outroActive, outroScale, plan, reduced, theme.animationIntensity, viewportHeight, viewportWidth, visible, viewBlock, tuning]);

  if (viewBlock === undefined) return null;

  // 契约：主题根元素带 `data-theme='fume'`（`LyricStage` 的舞台根也有同名属性；
  // 这里再挂一份，让「主题根」自己就能被定位 / 断言）。
  return (
    <div
      className="pi-lyricmood pi-lyricmood--fume"
      data-theme="fume"
      data-mood-theme="fume"
      data-active-index={activeIndex}
      data-view-index={viewIndex}
      /* 第十五轮第 6 条 + 用户 m01402 第 3 条的可判定接缝：`playing` = 正常跟随镜头，
       * `outro-soon` = 歌词还没唱完但整首只剩 ≤5s，`finished` = 歌词已唱完；后两者都会把整张纸
       * 缩小铺满（判据见 `fumeOutroPlan`；`outroActive` 与 rAF 用的是同一个值）。 */
      data-fume-state={outroSoon ? 'outro-soon' : outroActive ? 'finished' : 'playing'}
      ref={rootRef}
      style={
        {
          '--pi-fume-paper-width': `${plan.paperWidth}px`,
          '--pi-fume-paper-height': `${plan.paperHeight}px`,
          // 祖先注入的歌曲色优先；解析不到时才是 palette 原值。
          '--pi-fume-primary': paint.primary,
          '--pi-fume-accent': paint.accent,
        } as CSSProperties
      }
    >
      <div
        className="pi-lyricfume__world"
        ref={worldRef}
        style={{ width: `${plan.paperWidth}px`, height: `${plan.paperHeight}px` }}
      >
        {visible.map((block) => (
          <FumeBlockView
            key={`${block.index}-${block.x}-${block.y}`}
            block={block}
            registerBlock={(index, element) => {
              blockRefs.current[index] = element;
            }}
            registerGlyph={(key, element) => {
              glyphRefs.current[key] = element;
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** 相机焦点：当前句（激活块）的中心。 */
interface FumeFocus {
  readonly worldX: number;
  readonly worldY: number;
  readonly lineHeightPx: number;
  readonly catchUpMs: number;
}

/**
 * 当前「句」的焦点（第十四轮第 3 条）。
 *
 * 改造前这里返回的是「当前块里**正在打印的那个字素**」的世界坐标（folia 原版是跟着打印
 * 前沿一格格推进的纪录片镜头）。本仓库的 DOM 版看不出字素级的推进，用户要的是
 * 「镜头中心跟着正亮着的那一句走」，所以改成**块中心**：
 * `worldX = block.x + block.width / 2`、`worldY = block.y + block.height / 2`。
 *
 * `lineHeightPx` 依旧是「一行文字占多高」（`block.lineHeightPx × 1.34`，与 `estimateRowCount`
 * 的行距同源）：取景倍率 `scale = targetLineHeight / lineHeightPx` 只看它，与焦点取在块内
 * 哪个点是两件事 —— 所以改成块中心**不会**改变镜头倍率，只改变取景中心。
 * `catchUpMs` 仍是本句时长，喂给弹簧强度（唱得久的句子镜头跟得更缓）。
 */
function resolveFocus(
  activeBlock: FumeBlock | undefined,
  viewBlock: FumeBlock | undefined,
): FumeFocus | undefined {
  const block = activeBlock ?? viewBlock;
  if (block === undefined) return undefined;
  return {
    worldX: block.x + block.width * 0.5,
    worldY: block.y + block.height * 0.5,
    lineHeightPx: block.lineHeightPx * 1.34,
    catchUpMs: block.lineDurationMs,
  };
}

/** 当前正在打印的字素在块内的 `wordIndex:glyphIndex` 键。 */
function resolveFrontKey(block: FumeBlock | undefined, ms: number): string | undefined {
  if (block === undefined) return undefined;
  for (const clump of block.words) {
    for (let index = 0; index < clump.glyphs.length; index += 1) {
      const glyph = clump.glyphs[index];
      if (glyph !== undefined && ms >= glyph.startMs && ms <= glyph.endMs) {
        return `${block.index}:${clump.wordIndex}:${index}`;
      }
    }
  }
  return undefined;
}

/** 逐字素打印：waiting / 前沿 / 打印中 / colour trail（第十五轮第 4 条：尾部淡向**常态白**）。 */
function paintActiveGlyphs(
  block: FumeBlock,
  ms: number,
  activeKey: string | undefined,
  palette: { primary: string; accent: string; ink: string },
  glowBoost: number,
  glyphRefs: { current: Record<string, HTMLSpanElement | null> },
  glowCache: Map<string, number>,
): void {
  const waitAlpha = block.hero ? WAIT_ALPHA_HERO : WAIT_ALPHA_BODY;
  const fullAlpha = block.hero ? 0.985 : 0.92;
  const trailDurationSec = clamp(
    (block.lineDurationMs / 1000) * (block.hero ? TRAIL_RATIO_HERO : TRAIL_RATIO_BODY),
    TRAIL_DURATION_MIN,
    TRAIL_DURATION_MAX,
  );
  for (const clump of block.words) {
    for (let index = 0; index < clump.glyphs.length; index += 1) {
      const glyph = clump.glyphs[index];
      if (glyph === undefined) continue;
      const key = `${block.index}:${clump.wordIndex}:${index}`;
      const element = glyphRefs.current[key];
      if (element === null || element === undefined) continue;
      const span = Math.max(glyph.endMs - glyph.startMs, 1);
      const raw = clamp(ms - glyph.startMs, 0, span) / span;
      if (ms < glyph.startMs) {
        element.style.opacity = waitAlpha.toFixed(3);
        // 第十五轮第 4 条：还没唱到的字素是常态白（原来是主题主色）。
        element.style.color = palette.ink;
        element.style.textShadow = 'none';
        continue;
      }
      const eased = easeOutCubic(clamp(raw + PRINT_LEAD, 0, 1));
      const isFront = ms <= glyph.endMs || activeKey === key;
      // 颜色：打印前沿固定亮 0.82，其余按 eased 从 waitAlpha 升到满亮度。
      element.style.opacity = (isFront ? PRINT_FRONT_ALPHA : mixNumber(waitAlpha, fullAlpha, eased)).toFixed(3);
      const trailSec = (ms - glyph.endMs) / 1000;
      let fill: string;
      if (trailSec <= 0) {
        // 第十五轮第 4 条：起笔从**常态白**混向这一坨的主题色（高亮时才出现主题色）。
        fill = mixColor(palette.ink, clump.color, ACTIVE_MIX_FLOOR + eased * ACTIVE_MIX_SPAN);
      } else {
        // 唱过之后：主题色按 `p^1.35` **逐渐**淡回常态白（用户第 4 条「颜色是逐渐淡去」）。
        const p = clamp(trailSec / trailDurationSec, 0, 1) ** TRAIL_EXPONENT;
        fill = mixColor(clump.color, palette.ink, TRAIL_MIX_FLOOR + p * TRAIL_MIX_SPAN);
      }
      element.style.color = fill;
      // 辉光：`(4 + fontPx × 0.22) × eased × boost`，颜色 `activeColor@(0.4 + eased × 0.44)`。
      const glow = (GLYPH_GLOW_BASE + block.fontPx * GLYPH_GLOW_PER_FONT) * eased * glowBoost;
      const cached = glowCache.get(key);
      if (cached === undefined || Math.abs(cached - glow) > 0.02) {
        glowCache.set(key, glow);
        element.style.textShadow =
          glow <= 0.05
            ? 'none'
            : `0 0 ${glow.toFixed(2)}px ${glowColor(clump.color, 0.4 + eased * 0.44)}`;
      }
    }
  }
}

/** 唱过的块：字素回到 inherit，亮度交给块级 opacity。 */
function paintPassedGlyphs(
  block: FumeBlock,
  glyphRefs: { current: Record<string, HTMLSpanElement | null> },
  glowCache: Map<string, number>,
): void {
  for (const clump of block.words) {
    for (let index = 0; index < clump.glyphs.length; index += 1) {
      const key = `${block.index}:${clump.wordIndex}:${index}`;
      const element = glyphRefs.current[key];
      if (element === null || element === undefined) continue;
      glowCache.delete(key);
      element.style.opacity = '1';
      element.style.color = 'inherit';
      element.style.textShadow = 'none';
    }
  }
}

/** 还没唱到的块：字素全部回到 inherit。 */
function paintWaitingGlyphs(
  block: FumeBlock,
  glyphRefs: { current: Record<string, HTMLSpanElement | null> },
): void {
  for (const clump of block.words) {
    for (let index = 0; index < clump.glyphs.length; index += 1) {
      const element = glyphRefs.current[`${block.index}:${clump.wordIndex}:${index}`];
      if (element === null || element === undefined) continue;
      element.style.opacity = '1';
      element.style.color = 'inherit';
      element.style.textShadow = 'none';
    }
  }
}
