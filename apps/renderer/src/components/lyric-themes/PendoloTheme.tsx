/**
 * 时计 = `pendolo`（用户 m08768 第 4 条）。
 *
 * === AGPL 说明 ===
 * 数值借鉴自 folia-major 的 **pendolo** 歌词主题（AGPL-3.0，`chthollyphile/folia-major@c249bde`），
 * **只取数值与思路**：下面每个表达式都是在本仓库里自己写的，没有拷贝 folia 源码文本。
 *
 * 观感：左边半个线框机械钟表盘（Canvas 2D 画的），歌词贴着右侧弧线一圈槽位推过去，
 * 擒纵轮咬着弹簧一格格走；副歌那一句外面有一圈很淡的光晕。
 *
 * 数值表（来自任务书 / folia 源码研究报告）：
 * - 弧线：`centerX = 容器宽 × 0.0`、`centerY = 容器高 × 0.5`、`baseRadius = min(宽, 高) × 0.42`、
 *   歌词环半径 `= baseRadius + min(宽, 高) × 0.06`、`angleStep = 100° / 8`、当前行钉在 0°；
 *   `x = cx + R·cos(a)`、`y = cy + R·sin(a)`；
 *   `alpha = max(0.12, cos(a × 0.75)^2.5 × (1 - |距离| × 0.18))`；
 *   `scale = 当前行 1.25，否则 max(0.7, 1 - |距离| × 0.08)`；弧线边缘淡出 `opacity ×= min(1, (110 - |角度|)/28)`。
 * - 擒纵弹簧：目标 = 当前行下标，`stiffness = 180 × 2.0`、`damping = 18 + 4/2.0`、`mass 0.8`
 *   （自己写的 rAF 弹簧）；歌词环按 `wheelRotationDeg = -(弹簧值 - 目标) × angleStep` 旋转，
 *   子元素反向补偿旋转（净效果：文字始终水平）。
 * - 字号：焦点行 `round(28px)`、非焦点 `round(22px)`、译文 16 / 12px、行高 ×1.2；
 *   焦点色 = `mix(primary, accent, 副歌 0.58 : 0.32)`；副歌光晕 `inset -0.7em -1.1em`、
 *   `radial-gradient(circle at 42% 50%, accent α0.14 0%, α0.035 55%, transparent 82%)`、`blur(10px)`、
 *   `scale 1.012 / 1.026 / 1.045`（0.52 / 0.42 / 0.3s）；进度小圆点 0.42em、
 *   `box-shadow 0 0 7px accent@0.58`。
 * - 表盘（Canvas 2D，DPR 缩放，边界 `R × 1.4 + 16`）：5 圈引导环 0.3 / 0.6 / 0.85 / 1.15 / 1.4 R
 *   （**第十三轮：0.85R 加粗到 1.6px / `primary@0.30`**，参考图实测它是整张图最实的一圈）；
 *   60 个刻度每 6°（在 1.15R，每 5 个长刻度 12px / 1.5px `accent@0.35`，其余 6px / 1px `primary@0.15`）；
 *   主擒纵轮 36 齿（参考图实测齿周期 10°）、**齿根 R + 3 / 齿顶 R + 15（齿深 12）**、随歌词棘轮转动，
 *   描边 `accent@0.58` 宽 2.2、填充 `accent@0.08`；
 *   内部辐条轮（6 根辐条 + 轮辋上的孔 0.22 × (rim - hub)）；**内接正方形构造线**（顶点 -10.9° + 90k、
 *   弦距 R·cos45°）；扭索纹 48 条射线 0.62–0.83 R；**左下角 3 只小齿轮**（见 `SMALL_GEARS`，
 *   第十四轮起改成会转的、挪到 `drawMovingParts`，见文件末「小齿轮」那条）；
 *   12 颗铆钉 r2.2 在 0.96R；太阳小齿轮 12 齿（**齿顶 0.225R / 齿深 0.025R**）反向转；平衡摆轮在
 *   `(+0.2R, -0.75R)`、半径 0.28R、20 齿、**4.5 圈淡红游丝（accent，0.14br → 0.8br）**、
 *   **轮心的五角星（外接 0.058R、内 0.57×）与星心小圆 0.018R**，相位 `phase += dt × (2.8 + bass × 3.5)`
 *   （**没有音频，用恒定 2.8**），摆动 `sin(phase) × 0.15`；**指向当前句的长箭头**（尾 0.8R →
 *   尖 `ringRadius - 0.026R`，箭头长 0.026R / 半宽 0.012R，画在齿轮之上）；可选把专辑封面裁圆嵌在
 *   0.88R、`globalAlpha 0.42`；可选中心 `radial-gradient` 用 `backgroundColor` α0.72 → 0.52 → 0.20
 *   → 0（1.65R 内）。
 *
 * 本仓库的取舍（都写进交付报告）：
 * - **可见槽位从 17 降到 11（±5 档）**：冒烟脚本 `apps/desktop/src/main/index.ts` 的轨道检查要求
 *   `[data-lyric-line]` ≤ 12；±5 档（±62.5°）之外本来就被 alpha / 边缘淡出压到几乎看不见。
 * - **省掉的机械件**：每秒推进一齿的秒轮积分器、中间惰轮——都不画（任务书允许）。
 *   第十三轮把左下角那 3 只齿轮补上了（`SMALL_GEARS` + `smallGear()`）：参考图那块是整片齿轮组，
 *   只有细线圆的话左边整块看着是空的。
 * - 封面：**不跨组件抓 `.pi-home__cover`**（播放页那张是 56×56 的小缩略图）。只认 `coverUrl` prop，
 *   拿不到就空着——线框表盘本身就是完整的一套。
 * - 焦点色/光晕用 CSS `color-mix()` 写（不用 Canvas），弹簧与表盘才是 Canvas。
 * - 「bass」没有音频输入，平衡摆轮用恒定角速度 2.8 rad/s。
 * - 表盘的静态部分（环 / 刻度 / 扭索纹 / 铆钉）先画进离屏 canvas，每帧只重画会动的齿轮与摆轮。
 * - **舞台铺满整个播放页（第十轮第 4 条）**：`lyric-themes.css` 给 `.pi-lyricstage[data-theme='pendolo']`
 *   补上了和 `fume` / `cadenza` / `partita` 同一套 `position: absolute; inset: 0`，主题根拿到的
 *   是整个播放页，不再是中间那张 560px 的卡片。「表盘偏小」的真因是容器被 `max-width` 与
 *   `padding: 108px 24px 92px` 卡住，几何公式（`centerX = 宽 × 0`、`R = min(宽,高) × 0.42`）本身没错：
 *   铺满后 1518×1018 给出 R ≈ 427.6，和参考图实测的 425.5（齿根 `R - 2`）吻合。
 * - **字号跟窗口短边走**：焦点 28 / 非焦点 22 / 译文 16 / 12 那四个写死的 px 改成
 *   `clamp(28px, 3.5vmin, 56px)` 等四档，28 : 22 : 16 : 12 的比例原样保留。依据是参考图实测：
 *   1518×1018 下焦点句 x-height 23px、em ≈ 45px（屏幕上渲染后的尺寸，已含主题自带的 scale 1.25）
 *   = 短边 4.4%，除以 1.25 得 3.5vmin；非焦点句实测小约 1.7 倍，正好是 `(22 × 0.92) : (28 × 1.25)`。
 * - **每帧只清 / 贴表盘的外接矩形**（`1.7R + 8`）而不是整张 canvas：铺满整页后 canvas 到窗口尺寸
 *   （1518×1018 @DPR2 ≈ 6.2M 像素），整张 clear + drawImage 就是每帧搬 6.2M 像素。所有绘制都落在
 *   1.65R（中心径向渐变）以内，圆外本来就是空的，所以两者逐像素同结果；那个方框在 1518×1018 上
 *   只占整张的 48%，窗口越宽省得越多（表盘只占左边 `1.7R` 那一竖条）。
 * - **用户第十四轮第 7 条：四个滑杆 + 表盘封面开关**（字段已在 `packages/shared` / `packages/ipc`，
 *   参考图 5 的读数 42% / 100° / 2.0x / 1.25x 与原实现一致，所以默认值必须逐像素复现改造前）：
 *   · **轮盘半径**：`radius = min(宽, 高) × pendoloDialRadius / 100`（42% = 原来的 `× 0.42`）；
 *   · **弧度角度**：先量了改造前的实际张角——就是 **100°**（`angleStep = 100° / 8 = 12.5°`，
 *     11 个槽位铺开 ±5 档 = ±62.5°）。所以设置值直接当分子用：`angleStep = pendoloArcAngle / 8`，
 *     100° 时 12.5° 与原实现逐位相同。弧线边缘淡出的 `(110 - |角度|) / 28` 同样按
 *     `arcAngle / 100` 等比缩放（张角拉到 160° 时 ±100° 处不再淡出，符合「铺得更开」的直觉）；
 *   · **擒纵咬合力**：`stiffness = 180 × F`、`damping = 18 + 4 / F`（F = 2 即原来的 `180 × 2.0`
 *     与 `18 + 4 / 2.0`），另外乘进三只小齿轮的角速度；不碰 `motionAmount` / 摆轮语义；
 *   · **聚焦句缩放**：`scale = pendoloFocusScale`（1.25 = 原来写死的 `1.25`）；
 *   · **封面开关**：`false` 时不画 0.88R 那张圆封面（表盘中心留空，歌词与齿轮照旧），
 *     并且根本不去加载封面图。
 * - **小齿轮改成会转的**：三只齿轮从静态离屏层搬进 `drawMovingParts`，放在中心径向渐变**之后**
 *   画。原来它们在静态层、之后被渐变蒙了一层 `surface@0.13~0.2`，真机上很淡——这是本轮特意
 *   修掉的。代价只有一句：这三只齿轮比改造前亮 surface@0.13~0.2，其余图元逐像素不变。
 *   角速度 `ωᵢ = ±0.6 × F × 22 / 齿数`（rad/s，`F` = 咬合力）：因为两轮啮合要线速度 `ω·r` 相等，
 *   而齿顶圆半径 ∝ 齿数，所以**角速度与齿数成反比**；方向按 `SMALL_GEARS` 下标交替
 *   （A 22 齿与 B 16 齿相邻、圆心距 0.389R < 齿顶和 0.441R，确实咬得上，交替方向就是啮合方向；
 *   C 24 齿离最近的一只也有 0.44R > 齿顶和，够不着，方向任意）。脏矩形不用改：
 *   小齿轮最外一圈是 `0.789R + 0.275R = 1.064R`，仍在既有的 `1.65R` 包络内。
 *   用 rAF 的墙钟时间推进（和平衡摆轮同一个时间源），不是 `positionMs`——暂停/跳转时齿轮不会
 *   倒抽回去，这符合「钟表一直在走」的观感；`prefers-reduced-motion` 下仍然只画静止一帧。
 */

import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import {
  HINT_LOOKAHEAD,
  createFrameGate,
  isChorusLine,
  lineProgressOf,
  rgba,
  resolveCssColor,
  tuningOf,
  useElementSize,
  usePrefersReducedMotion,
  wordStatesFor,
  type LyricThemeProps,
  type StageLine,
  type WordState,
} from './types';

/**
 * 歌词弧的张角 ÷ 它 = 每档的角步长：`angleStep = pendoloArcAngle / 8`。
 * 改造前写死的就是 `100° / 8 = 12.5°`（11 个槽位 = ±5 档 = ±62.5°），所以设置里的
 * 「弧度角度」默认 100 与它逐位相同——量出来的结论是**当前实现实际用的就是 100°**。
 */
const ARC_SLOT_DIVISOR = 8;
/** 边缘淡出的「满亮角度 / 过渡宽度」（度），基准是改造前的 `(110 - |角度|) / 28`。 */
const ARC_FADE_FULL_DEG = 110;
const ARC_FADE_SPAN_DEG = 28;
/**
 * 可见槽位：任务书是 17 个（±8 档），但冒烟脚本要求每套主题的 `[data-lyric-line]` ≤ 12，
 * 所以收到 ±5 档 = 11 行；±62.5° 以外本来就被 alpha 压到几乎看不见。
 */
const SLOT_RADIUS = 5;
/**
 * 擒纵弹簧的基准刚度 / 阻尼，都要乘设置里的「擒纵咬合力」`F`：
 * `stiffness = SPRING_STIFFNESS × F`、`damping = 18 + 4 / F`。
 * `F = 2`（默认）= 改造前的 `180 × 2.0` 与 `18 + 4 / 2.0`。
 */
const SPRING_STIFFNESS = 180;
const SPRING_DAMPING_BASE = 18;
const SPRING_DAMPING_FORCE = 4;
const SPRING_MASS = 0.8;
/** 平衡摆轮没有音频可用，就用恒定角速度（rad/s）。 */
const BALANCE_SPEED = 2.8;
/**
 * 左下角小齿轮的基准齿数：啮合的两轮线速度 `ω·r` 必须相等，而齿顶圆半径 ∝ 齿数，
 * 所以角速度天然与齿数成反比（`ωᵢ ∝ 基准齿数 / 齿数`）。取 22 齿（齿轮 A）当基准。
 *
 * 第十五轮第 7 条（用户本轮原话）：「时计歌词动效，歌词转动时小齿轮才转动而不是一直都在转」。
 * 改造前这里还有一支 `SMALL_GEAR_BASE_SPEED = 0.6`（rad/s）的**匀速**角速度基准，
 * 齿轮转角 = `elapsed(墙钟秒) × ω`：歌词环转不转它都在转。按用户要求删掉这一支，
 * 改成「转角由歌词环的**累计转动量**推」—— 环停住 ⇒ 行程不再增加 ⇒ 齿轮完全静止。
 */
const SMALL_GEAR_REF_TEETH = 22;
/**
 * 歌词环走 **1 档**（换一句，约 0.218 rad = 12.5°）⇒ 小齿轮推进几档。
 *
 * **用户第 11 轮第 3 条**（原话：「时计里的齿轮转动时是**一句歌词转过一个槽**而不是一下子转
 * 非常多」）：取 **1** —— 一句歌词正好推进一档。
 *
 * 旧值 6 的来历（第十五轮第 7 条）：那时「行程」是**每帧角度变化的绝对值**累加，弹簧换句时
 * 来回摆一次就被记成 2~4 档，再乘 6 ⇒ 一句能转半圈、几十句下来转好几圈（主人说的「非常多」）。
 * 现在行程改吃**环的净转角**（= 走过的槽数 × 每档角度），倍率 1 ⇒ 一句一档，与环同步。
 */
export const PENDOLO_GEAR_TRAVEL_RATIO = 1;
/** 环「这一帧动没动」的阈值（rad/帧）：≤ 它就算停住 —— 同时是 `data-gears` 的判据。 */
export const PENDOLO_GEAR_MOVE_EPSILON_RAD = 1e-4;

/** 第十五轮第 7 条：小齿轮推进量的纯函数结果（便于单测）。 */
export interface PendoloGearDrive {
  /** 累计行程（rad，只增不减）。 */
  readonly travelRad: number;
  /** 这一帧齿轮是否在推进 —— 直接写进 DOM 的 `data-gears="moving" | "idle"`。 */
  readonly moving: boolean;
}

/**
 * 给定上一帧的累计行程 `travelRad` 与「歌词环这一帧净转了多少」`ringDeltaRad`，
 * 返回新的行程与 `moving` 标记。纯函数、无副作用，`PendoloTheme` 每帧调一次。
 *
 * **用户第 11 轮第 3 条**：这里收的是**净**转角（不是绝对值）—— 一句歌词推进一档，
 * 环回摆时齿轮跟着微微退回一点（真表的「咬合回弹」），但**不会**把摆动量一份份累加成好几档。
 * `moving` 用 `|Δ|` 判：回摆那几帧也算「在转」，环停住才 idle（第十五轮第 7 条的要求不变）。
 */
export function pendoloGearDrive(
  travelRad: number,
  ringDeltaRad: number,
  epsilon = PENDOLO_GEAR_MOVE_EPSILON_RAD,
): PendoloGearDrive {
  const step = ringDeltaRad;
  return { travelRad: travelRad + step, moving: Math.abs(step) > epsilon };
}

interface DialGeometry {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly cx: number;
  readonly cy: number;
  /** `baseRadius = min(宽, 高) × 0.42`。 */
  readonly radius: number;
}

interface DialColors {
  readonly primary: string;
  readonly accent: string;
  readonly surface: string;
}

/** 梯形齿齿轮：每齿 4 个点（齿根 → 齿顶 → 齿顶 → 齿根）。 */
function gearPath(
  ctx: CanvasRenderingContext2D,
  radius: number,
  teeth: number,
  depth: number,
): void {
  const step = (Math.PI * 2) / teeth;
  ctx.beginPath();
  for (let i = 0; i < teeth; i += 1) {
    const base = i * step;
    const points: readonly (readonly [number, number])[] = [
      [base, radius - depth],
      [base + step * 0.12, radius],
      [base + step * 0.38, radius],
      [base + step * 0.5, radius - depth],
    ];
    for (const [angle, r] of points) {
      ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
    }
  }
  ctx.closePath();
}

/** 左下角小齿轮组的参数（长度单位一律 = 表盘半径 R，数值按参考图实测换算）。 */
interface SmallGearSpec {
  /** 圆心相对表盘中心的偏移（单位 R）。 */
  readonly x: number;
  readonly y: number;
  readonly teeth: number;
  /** 齿顶圆 / 齿根圆（单位 R）。 */
  readonly tip: number;
  readonly root: number;
  readonly hub: number;
  readonly holes: number;
  readonly holeR: number;
  readonly holeRing: number;
  readonly spokes: number;
  readonly alpha: number;
  readonly tone: 'primary' | 'accent';
}

/**
 * 参考图左下角那组齿轮（带孔洞与辐条的小机械）。实测基准：表盘中心 (0, 501)、R ≈ 422。
 * - 大灰轮：圆心 (102,818) = (0.242R, 0.751R)，齿顶 116 = 0.275R、齿根 100 = 0.237R（22 齿），
 *   轮毂 44 = 0.104R，6 个孔 r ≈ 15 = 0.036R 落在 0.166R，8 根辐条；
 * - 红轮：圆心 (266,832) = (0.630R, 0.784R)，齿顶 70 = 0.166R、齿根 58 = 0.137R（16 齿），
 *   轮毂 0.05R，4 个孔 r ≈ 10 = 0.024R 落在 0.082R；
 * - 中灰轮：圆心 (186,652) = (0.441R, 0.358R)，齿顶 47 = 0.111R、齿根 40 = 0.095R（24 齿）。
 */
const SMALL_GEARS: readonly SmallGearSpec[] = [
  {
    x: 0.242,
    y: 0.751,
    teeth: 22,
    tip: 0.275,
    root: 0.237,
    hub: 0.104,
    holes: 6,
    holeR: 0.036,
    holeRing: 0.166,
    spokes: 8,
    alpha: 0.42,
    tone: 'primary',
  },
  {
    x: 0.63,
    y: 0.784,
    teeth: 16,
    tip: 0.166,
    root: 0.137,
    hub: 0.05,
    holes: 4,
    holeR: 0.024,
    holeRing: 0.082,
    spokes: 4,
    alpha: 0.5,
    tone: 'accent',
  },
  {
    x: 0.441,
    y: 0.358,
    teeth: 24,
    tip: 0.111,
    root: 0.095,
    hub: 0.03,
    holes: 0,
    holeR: 0,
    holeRing: 0,
    spokes: 0,
    alpha: 0.36,
    tone: 'primary',
  },
];

/**
 * 画一只小齿轮：齿圈 + 齿根圆 + 辐条 +（一圈孔洞）+ 轮毂。
 *
 * `rotation` 是这只齿轮自己的转角（rad）：轮辋、齿根圆、轮毂都是正圆，转不转看不出来，
 * 能看出「在转」的正是齿、辐条与孔洞，所以整只一起 `rotate`。
 */
function smallGear(
  ctx: CanvasRenderingContext2D,
  gear: SmallGearSpec,
  radius: number,
  color: string,
  rotation: number,
): void {
  ctx.save();
  ctx.translate(gear.x * radius, gear.y * radius);
  ctx.rotate(rotation);
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = rgba(color, gear.alpha);
  gearPath(ctx, gear.tip * radius, gear.teeth, (gear.tip - gear.root) * radius);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, gear.root * radius, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.stroke();
  for (let i = 0; i < gear.spokes; i += 1) {
    const angle = (i * Math.PI * 2) / gear.spokes;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * gear.hub * radius, Math.sin(angle) * gear.hub * radius);
    ctx.lineTo(Math.cos(angle) * gear.root * radius, Math.sin(angle) * gear.root * radius);
    ctx.stroke();
  }
  for (let i = 0; i < gear.holes; i += 1) {
    const angle = (i * Math.PI * 2) / gear.holes + Math.PI / 6;
    ctx.beginPath();
    ctx.arc(
      Math.cos(angle) * gear.holeRing * radius,
      Math.sin(angle) * gear.holeRing * radius,
      gear.holeR * radius,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(0, 0, gear.hub * radius, 0, Math.PI * 2);
  ctx.lineWidth = 1.3;
  ctx.stroke();
  ctx.restore();
}

/** 表盘的静态部分（尺寸变了才重画一次）。 */
function drawStaticFace(
  ctx: CanvasRenderingContext2D,
  geom: DialGeometry,
  colors: DialColors,
): void {
  const { radius } = geom;
  ctx.setTransform(geom.dpr, 0, 0, geom.dpr, 0, 0);
  ctx.clearRect(0, 0, geom.width, geom.height);
  ctx.translate(geom.cx, geom.cy);
  ctx.lineCap = 'butt';

  // 5 圈引导环 0.3 / 0.6 / 0.85 / 1.15 / 1.4 R。参考图里 0.85R 那一圈是整张图上最实的一条线
  // （实测整圈都能压到 lum < 190；0.3R / 0.6R 只在半径扫描里各剩一点影子），所以单独加粗。
  for (const factor of [0.3, 0.6, 0.85, 1.15, 1.4]) {
    const hero = factor === 0.85;
    ctx.beginPath();
    ctx.arc(0, 0, radius * factor, 0, Math.PI * 2);
    ctx.lineWidth = hero ? 1.6 : 1;
    ctx.strokeStyle = rgba(colors.primary, hero ? 0.3 : factor >= 1.15 ? 0.16 : 0.14);
    ctx.stroke();
  }

  // 内接正方形构造线：4 条弦，顶点在 -10.9° + 90k（弦距圆心 R·cos45°）。参考图实测一条长弦
  // (0,150)-(344,383) 距圆心 290.6px（R/√2 = 298.4，差 2.7%）、端点落在圆上 349.1° / 79.1°，
  // 另一条实测线 (60,466)-(172,400) 正好过圆心（那是辐条轮的辐条）。弦 + 辐条＝表盘内部的交叉辅助线。
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = rgba(colors.primary, 0.22);
  ctx.beginPath();
  for (let i = 0; i <= 4; i += 1) {
    const angle = ((-10.9 + i * 90) * Math.PI) / 180;
    const x = Math.cos(angle) * radius * 0.99;
    const y = Math.sin(angle) * radius * 0.99;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();

  // 左下角齿轮组（参考图里带孔洞与辐条的那几只）**不在这里画了**：第十四轮第 7 条要求它们
  // 随播放时间转，所以搬到了 `drawMovingParts` 里、且落在中心径向渐变之后（详见文件头与
  // `drawMovingParts` 里的注释）。留在这儿会被渐变蒙淡，或者和会转的那份重影。

  // 60 个刻度（每 6°），每 5 个是长刻度
  for (let i = 0; i < 60; i += 1) {
    const angle = (i * 6 * Math.PI) / 180;
    const long = i % 5 === 0;
    const outer = radius * 1.15;
    const inner = outer - (long ? 12 : 6);
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
    ctx.lineWidth = long ? 1.5 : 1;
    ctx.strokeStyle = long ? rgba(colors.accent, 0.35) : rgba(colors.primary, 0.15);
    ctx.stroke();
  }

  // 扭索纹：48 条射线 0.62–0.83 R
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(colors.primary, 0.08);
  for (let i = 0; i < 48; i += 1) {
    const angle = (i * Math.PI * 2) / 48;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * radius * 0.62, Math.sin(angle) * radius * 0.62);
    ctx.lineTo(Math.cos(angle) * radius * 0.83, Math.sin(angle) * radius * 0.83);
    ctx.stroke();
  }

  // 12 颗铆钉 r2.2 在 0.96R
  for (let i = 0; i < 12; i += 1) {
    const angle = (i * Math.PI * 2) / 12;
    ctx.beginPath();
    ctx.arc(Math.cos(angle) * radius * 0.96, Math.sin(angle) * radius * 0.96, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = rgba(colors.accent, 0.4);
    ctx.fill();
  }
}

/**
 * 每帧部分：中心渐变 + 左下角小齿轮组 + 辐条轮 + 擒纵轮 + 太阳小齿轮 + 平衡摆轮
 * +（可选）封面 + 指向当前句的长箭头。
 *
 * `elapsed` 是 rAF 墙钟时间（秒），**现在只推平衡摆轮的相位**（它一直转，用户没要求改）；
 * 三只小齿轮的转角改由 `gearTravel`（歌词环的**累计转动量**，见 `pendoloGearDrive`）推 ——
 * 第十五轮第 7 条：环转时齿轮才转，环停住齿轮就是一模一样的一帧。
 * `coverOnDial` = 表盘封面开关。
 */
function drawMovingParts(
  ctx: CanvasRenderingContext2D,
  geom: DialGeometry,
  colors: DialColors,
  rotationRad: number,
  elapsed: number,
  cover: HTMLImageElement | null,
  gearTravel: number,
  coverOnDial: boolean,
): void {
  const { radius } = geom;
  const phase = elapsed * BALANCE_SPEED;
  ctx.setTransform(geom.dpr, 0, 0, geom.dpr, 0, 0);
  ctx.translate(geom.cx, geom.cy);

  // 中心径向渐变（backgroundColor α0.72 → 0.52 → 0.20 → 0，1.65R 内）
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * 1.65);
  glow.addColorStop(0, rgba(colors.surface, 0.72));
  glow.addColorStop(0.45, rgba(colors.surface, 0.52));
  glow.addColorStop(0.75, rgba(colors.surface, 0.2));
  glow.addColorStop(1, rgba(colors.surface, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, radius * 1.65, 0, Math.PI * 2);
  ctx.fill();

  // 左下角三只小齿轮：**必须画在中心径向渐变之后**（改造前它们躺在静态离屏层里、随后被这层
  // `surface@0.13~0.2` 蒙住，真机上很淡）。转角与齿数成反比（啮合两轮的线速度 `ω·r` 相等），
  // 方向按下标交替：A(22 齿) 与 B(16 齿) 相邻且齿顶圆相交（圆心距 0.389R < 0.275R + 0.166R），
  // 交替方向就是真的啮合方向；C(24 齿) 离谁都够不着，方向随下标即可。
  // 第十五轮第 7 条：转角不再吃墙钟 `elapsed`，只吃 `gearTravel`（歌词环累计转动量）——
  // 环不动时 `gearTravel` 是常数（不是 0，是「停在某个相位」），画出来就是完全静止的齿轮。
  SMALL_GEARS.forEach((gear, index) => {
    const direction = index % 2 === 0 ? -1 : 1;
    const angle =
      direction * gearTravel * PENDOLO_GEAR_TRAVEL_RATIO * (SMALL_GEAR_REF_TEETH / gear.teeth);
    smallGear(ctx, gear, radius, gear.tone === 'accent' ? colors.accent : colors.primary, angle);
  });

  // 内部辐条轮：轮辋 0.72R + 轮毂 0.16R + 6 根辐条 + 轮辋上的孔
  ctx.save();
  ctx.rotate(rotationRad * 0.6);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = rgba(colors.primary, 0.5);
  const rim = radius * 0.72;
  const hub = radius * 0.16;
  ctx.beginPath();
  ctx.arc(0, 0, rim, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, hub, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 6; i += 1) {
    const angle = (i * Math.PI * 2) / 6;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * hub, Math.sin(angle) * hub);
    ctx.lineTo(Math.cos(angle) * rim, Math.sin(angle) * rim);
    ctx.stroke();
  }
  ctx.strokeStyle = rgba(colors.accent, 0.22);
  for (let i = 0; i < 6; i += 1) {
    const angle = (i * Math.PI * 2) / 6 + Math.PI / 6;
    ctx.beginPath();
    ctx.arc(
      Math.cos(angle) * radius * 0.6,
      Math.sin(angle) * radius * 0.6,
      0.22 * (rim - hub),
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  }
  ctx.restore();

  // 主擒纵轮：36 齿（参考图实测齿周期正好 10°/齿）、齿根 R + 3、齿顶 R + 15 ⇒ 齿深 12，随歌词棘轮转
  ctx.save();
  ctx.rotate(rotationRad);
  gearPath(ctx, radius + 15, 36, 12);
  ctx.fillStyle = rgba(colors.accent, 0.08);
  ctx.fill();
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = rgba(colors.accent, 0.58);
  ctx.stroke();
  ctx.restore();

  // 太阳小齿轮：12 齿、齿顶 0.225R、齿根 0.20R（参考图实测齿顶 ≈ 95px、齿距 ≈ 46px ⇒ 12 齿），反向转
  ctx.save();
  ctx.rotate(-rotationRad * 2);
  gearPath(ctx, radius * 0.225, 12, radius * 0.025);
  ctx.lineWidth = 2;
  ctx.strokeStyle = rgba(colors.accent, 0.5);
  ctx.stroke();
  ctx.restore();

  // 平衡摆轮：在 (+0.2R, -0.75R)、半径 0.28R、20 齿。参考图实测齿顶 118–121px、齿根 108–111px，
  // 与 `br` / `depth = 0.08br` 同量级，所以这几行不动。
  const bx = radius * 0.2;
  const by = -radius * 0.75;
  const br = radius * 0.28;
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(Math.sin(phase) * 0.15);
  ctx.beginPath();
  ctx.arc(0, 0, br, 0, Math.PI * 2);
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = rgba(colors.accent, 0.42);
  ctx.stroke();
  gearPath(ctx, br, 20, br * 0.08);
  ctx.stroke();
  // 游丝：参考图里是一圈圈淡红细线（实测最外圈半径 94px ≈ 0.8br），所以改成 accent 色、4.5 圈、
  // 0.14br → 0.8br —— 比原来那根 primary 深色 3.5 圈更贴参考图，也不再抢平衡摆轮的戏。
  ctx.beginPath();
  const turns = 4.5;
  const steps = 260;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const angle = t * turns * Math.PI * 2;
    const r = br * (0.14 + t * 0.66);
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(colors.accent, 0.4);
  ctx.stroke();
  // 五角星（尖朝上 = Canvas 的 -90° 起始）：参考图实测外接半径 25.5px = 0.058R、内半径 14.5px
  // = 0.57 × 外接半径（比标准五角星胖），星心另有一个小圆 r ≈ 7.5px = 0.018R。
  const starOuter = radius * 0.058;
  const starInner = starOuter * 0.57;
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? starOuter : starInner;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = rgba(colors.accent, 0.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.018, 0, Math.PI * 2);
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();

  // 可选封面：裁圆嵌在 0.88R、globalAlpha 0.42。设置里关掉（`pendoloCoverOnDial === false`）
  // 就整块不画——表盘中心留空，后面的箭头与歌词槽位照旧（封面在箭头之下，顺序不变）。
  if (coverOnDial && cover !== null && cover.complete && cover.naturalWidth > 0) {
    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.88, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(cover, -radius * 0.88, -radius * 0.88, radius * 1.76, radius * 1.76);
    ctx.restore();
  }

  // 指向当前句的长箭头（最后画，压在齿轮齿上）：0° 槽位的中心线就是 y = cy。
  // 参考图实测：轴 343 → 469、约 3px 粗；箭头 470 → 480、宽 10px；0° 槽位 x = cx + ringRadius = 491。
  // 换算成 R：尾 0.8R，尖 = ringRadius - 0.026R，箭头长 0.026R、半宽 0.012R。
  const ringRadius = radius + Math.min(geom.width, geom.height) * 0.06;
  const arrowTip = ringRadius - radius * 0.026;
  const arrowHead = radius * 0.026;
  const arrowHalf = radius * 0.012;
  ctx.save();
  ctx.strokeStyle = rgba(colors.accent, 0.6);
  ctx.fillStyle = rgba(colors.accent, 0.6);
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(radius * 0.8, 0);
  ctx.lineTo(arrowTip - arrowHead, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(arrowTip, 0);
  ctx.lineTo(arrowTip - arrowHead, -arrowHalf);
  ctx.lineTo(arrowTip - arrowHead, arrowHalf);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

interface PendoloSlotProps {
  readonly line: StageLine;
  readonly states: readonly WordState[];
  readonly active: boolean;
  readonly focus: boolean;
  readonly chorus: boolean;
  readonly progress: number;
  readonly register: (index: number, element: HTMLElement | null) => void;
}

function PendoloSlot({
  line,
  states,
  active,
  focus,
  chorus,
  progress,
  register,
}: PendoloSlotProps): ReactNode {
  return (
    <div
      className="pi-lyricpendolo__slot"
      data-lyric-line
      data-index={line.index}
      data-active={active}
      data-hint={line.hint}
      data-lyric-focus={focus}
      data-chorus={chorus}
      ref={(element) => {
        register(line.index, element);
      }}
    >
      {chorus ? <span className="pi-lyricpendolo__halo" aria-hidden="true" /> : null}
      <span className="pi-lyricpendolo__text">
        {line.words.map((word, index) => (
          <span
            key={`${index}-${word.text}`}
            className="pi-lyricstage__word pi-lyricpendolo__word"
            data-word-state={states[index] ?? 'passed'}
          >
            {word.text}
          </span>
        ))}
      </span>
      {focus ? (
        <span
          className="pi-lyricpendolo__dot"
          aria-hidden="true"
          style={{ '--pi-pendolo-progress': progress.toFixed(3) } as CSSProperties}
        />
      ) : null}
    </div>
  );
}

/**
 * 时计主题。
 *
 * 调度：一个 rAF 循环同时干三件事——推进擒纵弹簧、按弹簧值摆放 11 个槽位、重画表盘。
 * 每帧只写 DOM / Canvas，不 setState。
 */
export function PendoloTheme(props: LyricThemeProps): ReactNode {
  const { lines, activeIndex, viewIndex, positionMs, theme, coverUrl } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const slotRefs = useRef<(HTMLElement | null)[]>([]);
  const colorsRef = useRef<DialColors>({
    primary: '#5ab6ff',
    accent: '#5ab6ff',
    surface: '#161b24',
  });
  const coverRef = useRef<HTMLImageElement | null>(null);
  const springRef = useRef({ value: viewIndex, velocity: 0 });
  const targetRef = useRef(viewIndex);
  targetRef.current = viewIndex;
  const size = useElementSize(rootRef);
  const reduced = usePrefersReducedMotion();
  const anchor = lines[viewIndex];
  const slotLines = useMemo(() => {
    const out: StageLine[] = [];
    for (let offset = -SLOT_RADIUS; offset <= SLOT_RADIUS; offset += 1) {
      const line = lines[viewIndex + offset];
      if (line !== undefined) out.push(line);
    }
    return out;
  }, [lines, viewIndex]);
  const chorusFlags = useMemo(
    () => lines.map((_line, index) => isChorusLine(lines, index)),
    [lines],
  );
  const intensity =
    theme.animationIntensity === 'chaotic' ? 2 : theme.animationIntensity === 'moderate' ? 1.4 : 1;
  // 设置的动效参数：字号走 CSS 变量（这套主题的字号全在 `lyric-themes.css` 里），
  // 幅度缩摆轮摆动的角度，帧率上限进下面的 rAF。
  // 第十四轮第 7 条新增的五个：轮盘半径 / 弧度张角 / 擒纵咬合力 / 聚焦句缩放 / 表盘封面开关。
  // 都在下面那个 effect 里被闭包捕获 → 依赖变化即重启循环（组件顶部只取一次）。
  const {
    pendoloDialRadius,
    pendoloArcAngle,
    pendoloEscapeForce,
    pendoloFocusScale,
    pendoloCoverOnDial,
    fontScale,
    fpsCap,
    motionAmount,
  } = tuningOf(theme);

  // 配色得落成具体颜色才能喂给 Canvas（`var()` / `color-mix()` 画不出来）。
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    colorsRef.current = {
      primary: resolveCssColor(root, theme.primaryColor),
      accent: resolveCssColor(root, theme.accentColor),
      surface: resolveCssColor(root, theme.backgroundColor),
    };
  }, [theme]);

  // 封面：只用传进来的 URL，绝不跨组件去 DOM 里抓播放页的那张小缩略图。
  // 表盘封面关掉时连图都不加载（省一次网络 / 解码）。
  useEffect(() => {
    if (pendoloCoverOnDial !== true || coverUrl === undefined || coverUrl === '') {
      coverRef.current = null;
      return;
    }
    const image = new Image();
    image.decoding = 'async';
    image.src = coverUrl;
    coverRef.current = image;
    return () => {
      coverRef.current = null;
    };
  }, [coverUrl, pendoloCoverOnDial]);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (root === null || canvas === null) return undefined;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return undefined;
    const width = size.width > 0 ? size.width : root.clientWidth;
    const height = size.height > 0 ? size.height : root.clientHeight;
    if (width <= 0 || height <= 0) return undefined;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const geom: DialGeometry = {
      width,
      height,
      dpr,
      cx: width * 0.0,
      cy: height * 0.5,
      // 「轮盘半径」= 占舞台短边的百分比（默认 42 = 改造前写死的 0.42）。
      radius: Math.min(width, height) * (pendoloDialRadius / 100),
    };
    const ringRadius = geom.radius + Math.min(width, height) * 0.06;
    // 「弧度角度」换算：每档张角 = 设置值 / 8（默认 100 / 8 = 12.5°，与改造前逐位相同）。
    // 边缘淡出同样按 `arcAngle / 100` 等比缩放，所以 100° 时 `(110 - |角度|) / 28` 原样。
    const angleStepDeg = pendoloArcAngle / ARC_SLOT_DIVISOR;
    const fadeScale = pendoloArcAngle / 100;
    // 擒纵弹簧：咬合力 F 同时加大刚度与阻尼（F = 2 = 改造前的 180 × 2.0 / 18 + 4 / 2.0）。
    const springStiffness = SPRING_STIFFNESS * pendoloEscapeForce;
    const springDamping = SPRING_DAMPING_BASE + SPRING_DAMPING_FORCE / pendoloEscapeForce;
    const offscreen = document.createElement('canvas');
    offscreen.width = canvas.width;
    offscreen.height = canvas.height;
    const offscreenCtx = offscreen.getContext('2d');
    if (offscreenCtx !== null) drawStaticFace(offscreenCtx, geom, colorsRef.current);

    // 每帧要清 / 贴的那块像素（见文件头「每帧只清 / 贴表盘的外接矩形」）：
    // 所有绘制都在 |r| ≤ 1.65R 以内（左下角小齿轮最外一圈 0.789R + 0.275R = 1.064R），
    // 所以这个小方框之外恒为空，按它清 + 贴与「整张清 + 整张贴」逐像素等价，
    // 但每帧少搬一半以上的像素（窗口越宽越省）。
    const blitBound = geom.radius * 1.7 + 8;
    const blitX = Math.max(0, Math.floor((geom.cx - blitBound) * dpr));
    const blitY = Math.max(0, Math.floor((geom.cy - blitBound) * dpr));
    const blitW = Math.max(
      1,
      Math.min(canvas.width, Math.ceil((geom.cx + blitBound) * dpr)) - blitX,
    );
    const blitH = Math.max(
      1,
      Math.min(canvas.height, Math.ceil((geom.cy + blitBound) * dpr)) - blitY,
    );

    const placeSlots = (spring: number, anchorIndex: number): void => {
      for (const line of slotLines) {
        const element = slotRefs.current[line.index];
        if (element === null || element === undefined) continue;
        const distance = line.index - spring;
        const angleDeg = distance * angleStepDeg;
        const angleRad = (angleDeg * Math.PI) / 180;
        const alpha =
          Math.max(
            0.12,
            Math.max(0, Math.cos(angleRad * 0.75)) ** 2.5 * (1 - Math.abs(distance) * 0.18),
          ) *
          Math.min(
            1,
            (ARC_FADE_FULL_DEG * fadeScale - Math.abs(angleDeg)) / (ARC_FADE_SPAN_DEG * fadeScale),
          );
        // 焦点句缩放 = 设置里的「聚焦句缩放」（默认 1.25 = 改造前写死的 1.25）。
        const scale =
          line.index === anchorIndex
            ? pendoloFocusScale
            : Math.max(0.7, 1 - Math.abs(distance) * 0.08);
        const x = geom.cx + ringRadius * Math.cos(angleRad);
        const y = geom.cy + ringRadius * Math.sin(angleRad);
        element.style.opacity = alpha.toFixed(3);
        element.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) translateY(-50%) scale(${scale.toFixed(3)})`;
      }
    };

    // 减少动效：弹簧直接到位、摆轮不动、齿轮也不转（行程 = 0），只画一帧。
    if (reduced) {
      springRef.current.value = targetRef.current;
      springRef.current.velocity = 0;
      // 第十五轮第 7 条：齿轮不转 ⇒ `data-gears` 恒为 idle（探针在减少动效下应读到 idle）。
      canvas.dataset.gears = 'idle';
      root.dataset.gears = 'idle';
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(blitX, blitY, blitW, blitH);
      ctx.drawImage(offscreen, blitX, blitY, blitW, blitH, blitX, blitY, blitW, blitH);
      drawMovingParts(
        ctx,
        geom,
        colorsRef.current,
        (springRef.current.value - targetRef.current) * (Math.PI / 180) * angleStepDeg,
        0,
        coverRef.current,
        0,
        pendoloCoverOnDial,
      );
      placeSlots(springRef.current.value, targetRef.current);
      return undefined;
    }

    let frame = 0;
    let last = performance.now();
    // 第十五轮第 7 条：小齿轮的累计行程 / 上一帧的环转角 / 上一帧写进 DOM 的标记。
    let gearTravel = 0;
    let lastRotation: number | null = null;
    let gearMoving = false;
    // 帧率上限：`off` 时恒为 true，与加这个旋钮之前完全一致。
    const frameGate = createFrameGate(fpsCap);
    const tick = (now: number): void => {
      // 这一帧不许画就整帧跳过（含 Canvas 重绘），只把 rAF 链接下去。`last` 故意不更新，
      // 下一次通过的 dt 才是「距上帧真实经过的时间」，弹簧积分不会因为跳帧而失真。
      if (!frameGate(now)) {
        frame = window.requestAnimationFrame(tick);
        return;
      }
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      const spring = springRef.current;
      const target = targetRef.current;
      // 咬合力 F 同时进刚度与阻尼：F = 2 时就是改造前的 180 × 2.0 / 18 + 4 / 2.0。
      const force =
        -springStiffness * intensity * (spring.value - target) - springDamping * spring.velocity;
      spring.velocity += (force / SPRING_MASS) * dt;
      spring.value += spring.velocity * dt;
      // 摆轮摆角乘设置的 `motionAmount`：motionAmount = 1 时与原来逐位相同，
      // 调小 → 擒纵几乎不摆（字槽仍按弹簧分布在弧上），调大 → 甩得更狠。
      const rotationRad =
        ((-(spring.value - target) * angleStepDeg * Math.PI) / 180) * motionAmount;

      // **用户第 11 轮第 3 条**：小齿轮的行程改吃**环的净转角**（= 走过的槽数 × 每档角度），
      // 一句歌词正好推进一档（见 `PENDOLO_GEAR_TRAVEL_RATIO`）。旧写法累加的是「每一帧角度
      // 变化的绝对值」，弹簧换句时来回摆一次就被记成 2~4 档、再乘 6 ⇒ 一句能转半圈。
      // 第一帧只记基准、不累积（`lastRotation === null`），免得弹簧初值造成一次假推进。
      const slotTravelRad = (spring.value * angleStepDeg * Math.PI) / 180;
      if (lastRotation === null) {
        lastRotation = slotTravelRad;
      } else {
        const drive = pendoloGearDrive(gearTravel, slotTravelRad - lastRotation);
        lastRotation = slotTravelRad;
        gearTravel = drive.travelRad;
        /*
         * 探针接缝（**用户第 11 轮第 3 条**）：把累计行程写到 `data-gear-travel`。
         * 只在**千分之一 rad**（≈0.06°）真的变了才写 —— 与 `data-gears` 同一个纪律：
         * 每帧都写属性会让样式失效，而 0.001 rad 这一档已经远细于判据要看的「一档 12.5°」。
         */
        const travelText = gearTravel.toFixed(3);
        if (root.dataset.gearTravel !== travelText) root.dataset.gearTravel = travelText;
        if (drive.moving !== gearMoving) {
          gearMoving = drive.moving;
          const marker = drive.moving ? 'moving' : 'idle';
          canvas.dataset.gears = marker;
          root.dataset.gears = marker;
        }
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(blitX, blitY, blitW, blitH);
      ctx.drawImage(offscreen, blitX, blitY, blitW, blitH, blitX, blitY, blitW, blitH);
      // 第 5 个实参是 rAF 墙钟秒数，**现在只推平衡摆轮的相位**；
      // 小齿轮的转角由第 7 个实参 `gearTravel`（歌词环累计转动量）推（第十五轮第 7 条）。
      drawMovingParts(
        ctx,
        geom,
        colorsRef.current,
        rotationRad,
        now / 1000,
        coverRef.current,
        gearTravel,
        pendoloCoverOnDial,
      );
      placeSlots(spring.value, target);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [
    size.width,
    size.height,
    reduced,
    intensity,
    slotLines,
    fpsCap,
    motionAmount,
    pendoloDialRadius,
    pendoloArcAngle,
    pendoloEscapeForce,
    pendoloFocusScale,
    pendoloCoverOnDial,
  ]);

  if (anchor === undefined) return null;

  const anchorProgress = lineProgressOf(anchor, positionMs);

  return (
    <div
      className="pi-lyricpendolo"
      ref={rootRef}
      // 这套主题的字号全写在 `lyric-themes.css` 的 `__slot` 上，
      // 所以 `fontScale` 只能以变量形式下去，由那边的 `calc()` 乘进每一个 font-size。
      style={{ '--pi-pendolo-font-scale': fontScale.toFixed(3) } as CSSProperties}
      // 第十五轮第 7 条：`data-gears` 的初值（rAF 里只在标记翻转时才改写）。
      data-gears="idle"
      /*
       * **用户第 11 轮第 3 条**的探针接缝：小齿轮的累计行程（rad，字符串形式）。
       * 齿轮是画在 canvas 上的、DOM 里没有别的抓手，而这一条要判的正是「一句歌词走几档」，
       * 所以把一个纯数字暴露出来（rAF 里每千分之一 rad 变一次才写，见那边的注释）。
       */
      data-gear-travel="0"
    >
      <canvas
        className="pi-lyricpendolo__dial"
        ref={canvasRef}
        aria-hidden="true"
        data-gears="idle"
      />
      <div className="pi-lyricpendolo__ring">
        {slotLines.map((line) => (
          <PendoloSlot
            key={`${line.index}-${line.timeMs}`}
            line={line}
            states={wordStatesFor(line, positionMs, HINT_LOOKAHEAD[line.hint])}
            active={line.index === activeIndex}
            focus={line.index === viewIndex}
            chorus={chorusFlags[line.index] === true}
            progress={line.index === viewIndex ? anchorProgress : 0}
            register={(index, element) => {
              slotRefs.current[index] = element;
            }}
          />
        ))}
      </div>
    </div>
  );
}
