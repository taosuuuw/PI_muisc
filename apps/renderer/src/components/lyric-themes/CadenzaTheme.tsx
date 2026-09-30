/**
 * 心象 = `cadenza`（用户 m08768 第 4 条）。
 *
 * === AGPL 说明 ===
 * 数值借鉴自 folia-major 的 **cadenza** 歌词主题（AGPL-3.0，`chthollyphile/folia-major@c249bde`），
 * **只取数值与思路**：下面每一个表达式都是在本仓库里自己写的，没有拷贝 folia 源码文本。
 *
 * 观感：整句歌词被拆成一个个词，浮在画面中央偏上一点的舞台上；被抽出的那个「强调词」
 * 摆在正中并放大（1.46~1.98 倍），其余词**按阅读顺序在它左右两侧铺开、纵向收在中轴上下的
 * 一条「中间带」里**（见下面「本次修复」），只有真的解不开重叠时才用小半径螺旋搜索微调；
 * 唱到的词亮起并用「透明字 + text-shadow」描出三层辉光，唱过的词在 5 秒里缓慢漂出去、
 * 转一点角度、淡到 0.82~0.9。
 *
 * 数值表（来自任务书 / folia 源码研究报告）：
 * - 舞台锚点：`focusY = 高 × 0.42 + verticalLift`，
 *   `verticalLift = sin(t × 2.3) × (3 + motionEnergy × 8)`（整行呼吸 3~11px，t 是秒）。
 * - 强调词（hero）：从**未被换行切断**的词里挑 `score = semanticWeight + centerBias × 0.18`，
 *   CJK 词 `semanticWeight = 0.18`、其它 `min(字素数 × 0.08, 0.36)`，
 *   `centerBias = 1 - |词序号 - (n-1)/2| / max(n, 1)`；
 *   `emphasis = 1.46 × (1 + clamp(score - 0.48, 0, 0.52))`（1.46~1.98 倍），hero 摆在画面正中（x=-宽/2, y=0）。
 * - 其它词（**本轮重写**）：不再随机撒点、不再被径向推开到视口边缘，而是按阅读顺序铺开——
 *   左侧 = 序号 `heroIndex-1 … 0`（离 hero 由近到远），右侧 = `heroIndex+1 … n-1`；
 *   每侧贪心分行，行内相邻词的碰撞盒之间留 `gap = baseMargin × 2 + round(fontPx × 0.3)`，
 *   词心与 hero 中心的横向距离 = `heroHalfW + gap + 行内已占长度 + 自己半宽`；
 *   行位关于中轴对称、从离中轴最近的一行开始用（`0, ±1, ±2 …`；偶数行是 `±0.5, ±1.5 …`），
 *   `rowStep = min(lineHeightPx + round(fontPx × 0.4), (band − lineHeightPx/2) / ((rowCount−1)/2))`，
 *   词心再带一点带内随机错落 `±min((rowStep − lineHeightPx)/2 − 2, fontPx × 0.15)`。
 *   初始候选**先自评一次**：零重叠就一点不挪（螺旋只在真有重叠时才介入）。
 *   螺旋搜索：`step = max(10, round(fontPx × 0.14))`、
 *   半径上限 `min(64, max(lineHeightPx × 0.45, step × 3))`、
 *   每圈采样 `max(12, round(2πr / (step × 1.1)))` 个角度、y 方向椭圆压扁 ×0.92；
 *   边界 `|x| ≤ wallHalf`、`|y| ± halfH ≤ band`；
 *   碰撞盒 `collisionWidth = 真实宽 × 1.26`、`collisionHeight = lineHeightPx`、
 *   间距 `baseMargin × 2 + round(fontPx × 0.3)`（`baseMargin = calm ? 4 : 6`）；
 *   评分 `overlapArea × 2.2 + travel`，零重叠即停。
 *   （旧的 `minHeroSeparation = heroWidth × 0.34 + 宽 × 0.52 + padding × 2` 径向推开已删除：
 *   新布局保证非强调词的碰撞盒与 hero 盒在 x 上至少隔着一个 `gap`，而那个「推开」正是把词
 *   甩到屏幕四角的机制。）
 * - 字号：`widthBase = clamp(容器宽 × 0.086, 34, 94)`；`lengthPenalty = 字素数 > 12 ? min((n-12) × 1.8, 34) : 0`；
 *   `densityPenalty = 词数 > 7 ? min((词数-7) × 1.5, 18) : 0`；
 *   `fontPx = clamp(widthBase - lengthPenalty - densityPenalty, 28, 104)`；
 *   `lineHeight = round(fontPx × (isCJK ? 1.22 : 1.1))`。
 * - 行宽：`availableWidth = max(容器宽 - 48, 120)`、`maxWidth = clamp(容器宽 × 0.72 × wrapCompression, 220, availableWidth)`、
 *   `wrapCompression = 字素数 > 12 ? clamp(0.92 - (n-12) × 0.018, 0.62, 0.92) : 0.92`。
 * - `perspective = chaotic ? 500 + round(lineSeed × 500) : 1000`，`lineSeed = |sin(line.timeMs / 1000 × 997.1)|`。
 * - 三态：预读 `fast 45ms / instant 0 / normal 180ms`，`activeEnd = instant ? 行结束 : word.endMs`。
 *   waiting `{alpha 0, scale max(base×0.5, 0.5), rotate +20, blur 10px, glow 0}`；
 *   active `{alpha 1, blur 0, scale base × 1.3 × pulse}`，
 *   `pulse = 1 + sin(t × 10 + word.startMs/1000 × 5) × 0.04 × motionAmount`；
 *   passed `{alpha instant?0:(chaotic?0.9:0.82), scale base,
 *   rotate base + passedRotate × easeInOutQuad(clamp((t-end)/5000,0,1))}`（5 秒漂移完），
 *   `passedRotate = (rand(3)-0.5) × (chaotic?20:12)`；漂移 `drift = hero ? 4+rand(6)×4 : chaotic ? 8+rand(6)×9 : 5+rand(6)×6`、
 *   方向 = 从画面中心指向该词的单位向量（y 分量 ×0.72），另加 `(rand(7)-0.5)×2.4` / `(rand(8)-0.5)×2` 的抖动。
 * - 插值：**手写指数趋近（不是 spring）**——`transformAmount = 1-exp(-11×dt)`、
 *   `visualAmount = 1-exp(-14×dt)`、glow `1-exp(-16×dt)`，`dt = clamp((now-last)/1000, 1/240, 0.05)`。
 * - 逐词浮动：`localFloatX = sin(t × 1.2 + i × 0.6) × motionEnergy × 4`、
 *   `localFloatY = cos(t × 1.5 + i × 0.4) × motionEnergy × 2.5`。
 * - 行级包络（作用在整行容器上）：normal enter `min(0.42, max(0.22, max(raw, 0.12) × 0.34))`s、
 *   exit `min(0.32, max(0.18, max(raw, 0.12) × 0.18))`s、hold 0.06s；short enter `clamp(raw × 0.45, 0.045, 0.06)`、
 *   exit `clamp(raw × 0.22, 0.03, 0.04)`、hold 0.03s；micro 无过渡。
 *   normal 入场 `opacity 0→1 / scale 0.9→1 / blur 10→0`（easeOutCubic）、出场 `→0 / →1.1 / blur 20`；
 *   short 入场 `0.65→1 / 0.97→1 / blur 4→0`、出场 `scale→1.03 / blur 6`。
 * - 词体混色：`fill = mix(primary, placement.color, activeMix)`，`placement.color = wordColorOf(theme, word.text, accent)`；
 *   词内 `activeMix` = 词进度，词后 `1 - fadeOut`，`fadeOut = clamp((t-end)/(short?120:800), 0, 1)`（instant 是 0/1 开关）。
 * - 辉光：三层 `0 0 40px`，透明度 `min(0.98, g)` / `min(0.92, g×0.92)` / `min(0.35, g×0.26)`，
 *   `g = 包络 × clamp(glowAlpha, 0, 1) × max(1, 0)`；词体是「透明字 + text-shadow」。
 * - 副歌：`activeIndex` 那一行是副歌时，外面套一圈 1.2px、`0.45 × (1 - 进度)` 的 CSS 波纹。
 *
 * 本仓库的取舍（都写进交付报告）：
 * - **不新增依赖**、没有 framer-motion：三态与逐词运动全在**一个 rAF 循环**里用指数趋近手写，
 *   每帧只写已存在 DOM 的 `style.transform / filter / opacity / color / textShadow`，**不 setState**。
 * - 没有 pretext 排版：词宽用 `measureTextWidth()`（canvas `measureText`，字体栈 / 字重和 DOM
 *   一致，量不到回退 `estimateTextWidth()`）量，所以螺旋避让是**按真实字形宽度**算的。
 *
 * === 本次修复（用户第九轮第 4 条：铺满整个 app 视口，任意尺寸 / 全屏都不变形不留白）===
 * 1) **舞台铺满**：`styles/lyric-themes.css` 把 `.pi-lyricstage[data-theme='cadenza']` 改成
 *    `position: absolute; inset: 0`（包含块 = `position: relative` 的 `.pi-home__stage`），不再用
 *    「负外边距去抵消 `.pi-home__stage-lyrics` 的 padding」那种必须跟 global.css 的
 *    `108px / 24px / 92px` 与两个媒体查询逐像素对齐的写法。所以 `viewportWidth/Height` 就是
 *    播放页视口，`focusY = 高 × 0.42` 也随之落在页面 42% 处，且窗口任意尺寸 / 全屏都跟着走。
 * 2) 主题根元素补 `data-theme='cadenza'`（`LyricStage` 的舞台根也有同名属性，契约要求主题根带它）。
 * 3) 贴底译文 / 预览靠 `--pi-stage-bleed-bottom`（现在由 CSS 定义为 `clamp(86px, 11vh, 132px)`）
 *    避开底部悬浮播放条——它从「挤出去的留白」变成了「页面底部安全高度」，跟窗口高走。
 * 4) **词的落位范围收进视口**：`buildCadenzaPlan` 的 `boundsTop / boundsBottom` 原来是以行为圆心的
 *    `vh × 0.9` 半径（行原点在 42% 高处 → 向上 −48%、向下 132% 视口高，一落位就在 `overflow: hidden`
 *    外面被裁）；那轮改成「行原点量到视口上 / 下边的距离」，水平外扩 `boundsPadX` 改成跟
 *    「视口宽 − maxWidth」联动。**本轮把它们整体换成「中间带 + 按序号铺开」（见下）。**
 *
 * === 本次修复（用户 m03279 第 3 条：心象歌词「杂乱无章地散在页面上」→ 沿句子铺开的一条中间带）===
 * 用户原话：非强调词原来是 `(rand()-0.5) × maxWidth × 0.42 × (rand()-0.5) × max(lineHeight × 2, 40)`
 * 的**纯随机撒点**，加上通往视口上下边缘的 `boundsTop / boundsBottom` 与
 * `minHeroSeparation` 的径向推开，词才会出现在左上 / 右中 / 左下这些角落。本轮只改排布：
 * 1) **按阅读顺序铺开**：右侧 `heroIndex+1 … n-1`、左侧 `heroIndex-1 … 0`，离 hero 由近到远，
 *    行内横向距离 = `heroHalfW + gap + 已占长度 + 自己半宽`；铺开跨度（两侧墙到墙）
 *    = `maxWidth × clamp(自然宽 / maxWidth, 0.5, 0.8)`，也就是设计上的「0.5~0.8 × maxWidth」。
 * 2) **收进中间带**：`band = min(视口高 × 0.22, 170px)`（再按视口余量收紧），
 *    强制**每个词的碰撞矩形**（`|y| ± lineHeightPx/2`）都在 `focusY ± band` 内。
 * 3) **螺旋只做微调**：半径上限 `min(64, max(lineHeightPx × 0.45, step × 3))`，并且初始候选
 *    零重叠就直接采用（旧代码无条件从第 1 圈开始扫，等于每个词都被挪了 `step`）。
 * 4) **装不下时的分级放宽**（新排布唯一的退化路径，见函数里「装不下时的分级放宽」段）：
 *    ① 两侧可用长度先放宽到视口里真正空得出来的走廊 `viewportWallHalf`（不动字号，只是用上外侧空地）；
 *    ② 仍装不下（行数 > `rowCeilOf(band)`，等价于「行距会小于 `lineHeightPx + 2`」）才把**非强调词**
 *    整体等比缩小：`PLAN_SCALE_STEPS` 档里挑最少收窄又装得下的一档，下限 `scaleFloor`
 *    （字号不低于 `FONT_PX_MIN`；`MIN_UNIFORM_SCALE` 取 `0.2` < `28 / 135`，所以那条绝对下限恒生效）。
 *    **间距 `gap` 也跟着一起等比缩**（`rowGap()`）：只缩碰撞盒、不缩间距的话，窄舞台下永远挤不进一行，
 *    最后 `rowStep` 被压到 0、所有行落回 `y = 0` 彼此相撞——这是本轮永久用例抓出来的真 bug。
 *    另外 hero 的宽度上限带了「动效余量」`viewportWidth × 0.625 − 50`：hero 唱到时 `scale(1.3)`
 *    以左上角为原点向右下扩，右缘会长到 `0.8 × 宽`（34 字符的无空格单词曾在最小窗口下顶出 20px）。
 *    两级放宽都不会让带宽变大（`band` 一开始就取到规格上限），所以「收进中间带」是无条件的：
 *    极端的句子只会让字变小，不会让词飞出带子、也不会让两个词相撞。
 * 5) **不动**：`data-theme='cadenza'`、`.pi-lyriccadenza__*`、`data-word-state`/`data-cad-state`、
 *    `LyricStage` 的 props / register 契约、逐字时间轴、辉光与进场动画、`fontScale` /
 *    `motionAmount` / `glowIntensity` 的既有语义、hero 的 `1.46~1.98` 放大与居中、
 *    旋转 `(rand()-0.5) × (chaos ? 6 : 3)` 度与 ±2.4 / ±2px 抖动。
 * 代码里可验算的不变量（**已固化成永久用例** `cadenzaLayout.test.ts`：用 `estimateTextWidth`
 * 把 `placement` 反推成 DOM 矩形，覆盖 5 档舞台 / 4 档旋钮 / 1~20+ 字的行）：
 * - 横向：`|词心| + 半宽 ≤ wallHalf`，且非强调词与 hero 的 x 区间至少隔一个 `gap`；
 * - 纵向：`|词心| + lineHeightPx/2 ≤ band ≤ min(视口高 × 0.22, 170px)`；
 * - 同行的词在 x 上被 `gap` 分开、相邻两行在 y 上被 `rowStep ≥ lineHeightPx + 2` 分开 ⇒ 两两不重叠
 *   （只有「连 `scaleFloor` 都装不下」的极端行才会落到 `rowStep < lineHeightPx`，此时由螺旋搜索兜底）。
 *
 * === 已修复（用户第八轮第 4 条：铺满全屏 / 多语言 / 颜色跟随歌曲）===
 * 1) **尺寸来源**：不再走「`useElementSize` 量歌词盒子 + 量不到回退 `window.innerWidth/Height`」的
 *    双路径，改用 `useFullStageSize()`。
 * 2) **多语言**：`buildUnits()` 先把字素级 `line.words` 合并成「词」单元——拉丁 / 西里尔按空格断词、
 *    CJK / 假名 / 泰文一个字素一个单元，空格只断词不排版。于是「英文歌每个字母各自乱飞」被修掉，
 *    `densityPenalty` / `lengthPenalty` 也终于是在数真正的词与字素；强调词宽度超出可用宽度时会
 *    自动降字号，螺旋搜索全被边界拒绝时还有一次把词压回可视范围的兜底。
 * 3) **颜色跟随歌曲**：删掉 `paletteRef` 的硬编码初值 `#5ab6ff` 与「挂载 / theme 变才解析一次」的
 *    effect，改用 `useResolvedThemeColors()`：祖先注入的 `--pi-th-primary/accent/surface`
 *    （播放页按当前歌曲封面注入）优先，`palette` 兜底，再按 `surface` 做对比度兜底；
 *    每帧从 `paletteRef.current` 现读，换歌后下一帧就是新色。
 * 4) 行元素补上 `data-lyric-line` / `data-line-time`（父代理要做「点歌词行 seek」的事件委托）。
 * - folia cadenza 里那条 Canvas 辉光 / 光束管线**不实现**（在 folia 里已是死代码，无调用点）。
 * - `motionEnergy` 没有 WebAudio 输入，取恒定 1（正常强度）。
 * - 只渲染**当前查看的那一行**（`viewIndex`）；不额外渲染「出场行」（行级包络已由 CSS 动画表达）。
 * - 译文 / 下两句预览按任务书样式自写（居中、0.6、译文比正文小、预览更小更淡）。
 */

import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
// folia cadenza 的「词心锚点」覆盖（`transform-origin: 50% 42%`），见该文件头注释。
import '../../styles/lyric-cadenza.css';
import {
  clamp,
  createFrameGate,
  ensureContrast,
  isChorusLine,
  measureTextWidth,
  mixColor,
  parseRgb,
  rgba,
  useElementFontFamily,
  useFullStageSize,
  usePositionClock,
  usePrefersReducedMotion,
  useResolvedThemeColors,
  usesWordSpaces,
  tuningOf,
  wordColorOf,
  type Hint,
  type LyricPalette,
  type LyricThemeProps,
  type RgbColor,
  type StageLine,
} from './types';

/* ------------------------------------------------------------------ *
 * 数值常量（folia cadenza 那一套）
 * ------------------------------------------------------------------ */

/** 舞台锚点：画面高 × 0.42（再叠加呼吸的 verticalLift）。 */
const FOCUS_Y_RATIO = 0.42;
/** 整行呼吸：`3 + motionEnergy × 8`。 */
const LIFT_BASE = 3;
const LIFT_ENERGY = 8;
const LIFT_SPEED = 2.3;
/** 强调词放大倍数基值：`1.46 × (1 + clamp(score - 0.48, 0, 0.52))`。 */
const HERO_EMPHASIS_BASE = 1.46;
/** 字号上下限（folia cadenza 原值），以及设置里 `fontScale` 的上限（跟 schema 的 `.max(1.3)` 对齐）。 */
const FONT_PX_MIN = 28;
const FONT_PX_MAX = 104;
const FONT_SCALE_MAX = 1.3;
/** 手写指数趋近速度（**不是 spring**）。 */
const EXP_TRANSFORM = 11;
const EXP_VISUAL = 14;
const EXP_GLOW = 16;
/** 唱过之后漂移时长 5s。 */
const PASSED_DRIFT_MS = 5000;
/** 预读窗口（cadenza 规格；与 partita 的 `HINT_LOOKAHEAD` 正好互为快/慢）。 */
const LOOKAHEAD_CADENZA: Record<Hint, number> = { normal: 180, short: 45, micro: 0 };
/** 辉光三层半径固定 40px。 */
const GLOW_BLUR_PX = 40;
/** 螺旋搜索每圈的角度采样下限。 */
const SPIRAL_MIN_SAMPLES = 12;
/** 螺旋搜索的圈数上限（防止长句里最后一个词扫太久）。 */
const SPIRAL_MAX_RINGS = 64;
/** 落位边界（folia `buildWordPlacements`）：横向 `±(maxWidth/2 + 72)`。 */
const BOUNDS_PAD_X = 72;
/** 落位边界纵向：`±max(整块高 × 0.9, 行高 × 1.6 / 1.45)`。 */
const BOUNDS_BLOCK_Y = 0.9;
const BOUNDS_TOP_Y = 1.6;
const BOUNDS_BOTTOM_Y = 1.45;
/** 碰撞盒倍率：普通词 `宽 × 1.26 / 高 × 1.24`，强调词 `宽 × 1.48 / 高 × 1.36`。 */
const COLLISION_W = 1.26;
const COLLISION_H = 1.24;
const COLLISION_W_HERO = 1.48;
const COLLISION_H_HERO = 1.36;
/** 强调词的排他半径：`hero 宽 × 0.34 + 词宽 × 0.52 + padding × 2`。 */
const HERO_SEP_HERO_W = 0.34;
const HERO_SEP_WORD_W = 0.52;
/** 螺旋半径下限（folia：非强调词 `max(行高 × 2.2, 碰撞宽 × 0.75, 56)`）。 */
const SPIRAL_MIN_RADIUS = 56;
/** 强调词的螺旋半径：`max(20, 行高 × 0.5)`，每圈固定 8 个采样。 */
const HERO_SPIRAL_RADIUS = 0.5;
const HERO_SPIRAL_SAMPLES = 8;
/** 每圈采样数 = `max(12, round(2πr / (step × 1.1)))`，再压一个上限防长句扫太久。 */
const SPIRAL_SAMPLE_DIVISOR = 1.1;
const SPIRAL_MAX_SAMPLES = 48;
/** 视口动效余量：唱到时 `scale(1.3)` 从词心向两侧各长 `0.15 × 词宽`，另加漂移 / 浮动，
    再加唱后旋转的外扩（`SWING_SPILL_PX`）。几何自查的动效包络按**左上角锚点**算
    （比本次的 `50% 42%` 词心锚更保守），这两个余量按那个模型给；余量够，词心锚只会更安全。 */
const EFFECT_PAD_X = 40;
const EFFECT_PAD_Y = 54;
/** 唱到时 `scale(1.3)`（与几何自查的 `ENTER_SCALE`、进场动画同一档）。 */
const ENTER_SCALE = 1.3;
/** 唱后旋转在「左上角锚点」模型下的垂直外扩预算：`1.3 × 词宽 × |sinθ| ≤ 它`。 */
const SWING_SPILL_PX = 12;
/** 折行宽度 = `min(视口宽 × 0.72 × wrapCompression, 820)`（folia 的 `widthRatio` 取 0.72）。 */
const WIDTH_RATIO = 0.72;
const MAX_WRAP_WIDTH = 820;
/** 逐词收窄的下限倍率（单个词宽于整条落位边界时，只把它自己缩到放得下）。 */
const MIN_WORD_SCALE = 0.2;
/** 落位找不到零重叠时的逐级缩小步长与下限（只缩发生冲突的那一个词，不动整行字号）。 */
/**
 * 第十五轮第 4 条（用户本轮原话）：「所有歌词都应该是白色，高亮时才有其他颜色（辉光），
 * 并且颜色是逐渐淡去」。
 *
 * 常态 = 白。这里用**具体的** `#ffffff` 而不是 `var(--pi-lyric-ink)`：cadenza 的颜色每帧
 * 都要经过 `mixColor()` 从常态色混向词色（`placement.color`），而 `mixColor` 解析不了 `var()` 串
 * （解析失败原样返回常态色 ⇒ 高亮色永远出不来）。
 *
 * 可读性：白只在深底上成立。`readableColor(CADENZA_INK, surface)` 会在「白 vs 当前歌曲底色」
 * 对比度不足 3:1 时，把它压到**刚好够 3:1 的最浅中性色**；正常深底歌曲返回的仍是纯白。
 */
const CADENZA_INK = '#ffffff';

const PLACE_SHRINK_STEP = 0.9;
const MIN_PLACE_SHRINK = 0.62;
/** 「阅读顺序」硬约束的余量：hero 左边的词，词心必须 ≤ −它（右边对称）。 */
const SIDE_GAP = 0.5;
/** `motionEnergy`：没有 WebAudio，取恒定 1（正常强度）。 */
const MOTION_ENERGY = 1;

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
const easeInOutQuad = (t: number): number =>
  t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
const mixNumber = (a: number, b: number, t: number): number => a + (b - a) * clamp(t, 0, 1);

/* ------------------------------------------------------------------ *
 * 文本 / 颜色小工具
 * ------------------------------------------------------------------ */

/** 码点是不是 CJK / 全角（决定行高与语义权重）。 */
function isCjkCode(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

function isCjkText(text: string): boolean {
  for (const char of text) {
    if (isCjkCode(char.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/** 字素切分（在模块里建一次 Segmenter，别每个词都 `new`）。 */
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

/** 一行的字素数（`lengthPenalty` / `wrapCompression` 用）。 */
function graphemeCountOfText(text: string): number {
  return graphemesOf(text).length;
}

/* ------------------------------------------------------------------ *
 * 排布求解
 * ------------------------------------------------------------------ */

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** 两个盒子的重叠面积（不相交就是 0）。 */
function overlapArea(a: Rect, b: Rect): number {
  const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (dx <= 0 || dy <= 0) return 0;
  return dx * dy;
}

/** 一个词求解出来的落点。 */
interface CadenzaPlacement {
  /** 词体外框左上角，相对舞台中心（hero 是 -宽/2, 0）。 */
  readonly x: number;
  readonly y: number;
  /** 基准旋转（度）。 */
  readonly rotate: number;
  /** 唱过之后额外转多少度（`passedRotate`）。 */
  readonly passedRotate: number;
  /** 唱过之后往外漂多少 px（`drift`）。 */
  readonly drift: number;
  /** 从画面中心指向这个词的单位向量（漂移方向）。 */
  readonly outwardX: number;
  readonly outwardY: number;
  /** 带方向的抖动（`(rand(7)-0.5)×2.4` / `(rand(8)-0.5)×2`）。 */
  readonly jitterX: number;
  readonly jitterY: number;
  /** 词体混色目标（`wordColorOf(theme, text, accent)`）。 */
  readonly color: string;
  /** 实际用的字号（hero 乘了 `emphasis`）。 */
  readonly fontPx: number;
}

interface CadenzaWordPlan {
  readonly index: number;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly hero: boolean;
  /** 这个词自己的随机数基准（确定性，重渲染不抖）。 */
  readonly randBase: number;
  readonly placement: CadenzaPlacement;
}

/** 一行的完整排布方案（只在行 / 容器尺寸 / 强度 / 调色板变化时重算）。 */
interface CadenzaPlan {
  readonly line: StageLine;
  readonly fontPx: number;
  readonly lineHeightPx: number;
  readonly heroIndex: number;
  readonly words: readonly CadenzaWordPlan[];
  readonly perspectivePx: number;
  readonly maxWidth: number;
  /** folia 的落位边界原式（未与视口安全线取交）：纵向 `max(整块高 × 0.9, 行高 × 1.6 / 1.45)`、
      横向 `±(maxWidth / 2 + 72)`。实际落位用的是它与「视口安全线」的**交集**（更紧），
      几何自查按这个原式验「词没被撒到 folia 边界之外」。 */
  readonly bounds: {
    readonly upPx: number;
    readonly downPx: number;
    readonly halfWidthPx: number;
    /** folia 原式的纵向边界；`upPx/downPx` 是它的「容量放宽版」，这两个只用于对照与日志。 */
    readonly foliaUpPx: number;
    readonly foliaDownPx: number;
    /** 零重叠所需的纵向半高（`行数 × 行距 ÷ 2`）：≤ folia 原式时说明 folia 就装得下。 */
    readonly capacityHalfPx: number;
  };
  /** 行级包络（秒）。 */
  readonly enterSec: number;
  readonly exitSec: number;
  readonly holdSec: number;
}

/** 行级包络（任务书数值）。 */
function envelopeFor(
  hint: Hint,
  durationMs: number,
): { enterSec: number; exitSec: number; holdSec: number } {
  const raw = Math.max(durationMs / 1000, 0);
  if (hint === 'micro') return { enterSec: 0, exitSec: 0, holdSec: 0 };
  if (hint === 'short') {
    return {
      enterSec: clamp(raw * 0.45, 0.045, 0.06),
      exitSec: clamp(raw * 0.22, 0.03, 0.04),
      holdSec: 0.03,
    };
  }
  return {
    enterSec: Math.min(0.42, Math.max(0.22, Math.max(raw, 0.12) * 0.34)),
    exitSec: Math.min(0.32, Math.max(0.18, Math.max(raw, 0.12) * 0.18)),
    holdSec: 0.06,
  };
}

/** 三层辉光：folia cadenza 的「透明字 + text-shadow」。 */
function buildDomTextShadow(color: string, strength: number): string {
  const g = clamp(strength, 0, 1.6);
  if (g <= 0.01) return 'none';
  return `0 0 ${GLOW_BLUR_PX}px ${rgba(color, Math.min(0.98, g))}, 0 0 ${GLOW_BLUR_PX}px ${rgba(
    color,
    Math.min(0.92, g * 0.92),
  )}, 0 0 ${GLOW_BLUR_PX}px ${rgba(color, Math.min(0.35, g * 0.26))}`;
}

/** 辉光包络：instant「0→1（前 30%）→衰减回 0」；short / normal 是两个台阶。 */
function glowEnvelope(hint: Hint, progress: number): number {
  if (hint === 'micro') {
    return progress <= 0.3
      ? easeOutCubic(progress / 0.3)
      : Math.max(0, 1 - easeOutCubic((progress - 0.3) / 0.7));
  }
  const inside =
    hint === 'short'
      ? progress < 0.14
        ? easeOutCubic(progress / 0.14)
        : progress < 0.82
          ? 1
          : mixNumber(1, 0.92, (progress - 0.82) / 0.18)
      : progress < 0.18
        ? easeOutCubic(progress / 0.18)
        : progress < 0.9
          ? 1
          : mixNumber(1, 0.9, (progress - 0.9) / 0.1);
  // 词唱完之后包络再往 0 收（词后衰减在调用处叠加）。
  return inside + (1 - inside) * progress * 0.12;
}

/** 一行里真正参与排版 / 动效的「词」单元（见 `buildUnits`）。 */
interface CadenzaUnit {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** 空白字素：`Intl.Segmenter` 会把空格单独切成一个 StageWord。 */
function isSpaceUnit(text: string): boolean {
  return text.trim() === '';
}

/**
 * 把 `StageLine` 的**逐字素**切分合并成「词」单元。
 *
 * 这是「英文 / 俄文歌里每个字母各自乱飞」的根因修复：`words` 是字素级的
 * （`Intl.Segmenter` grapheme），按它排版会把一个英文单词拆成好几个动效单元。
 * 规则：
 * - 拉丁 / 西里尔这类**用空格分词**的文字：连续非空白字素合成一个词；
 * - CJK / 假名 / 泰文这类**不分词**的文字：一个字素一个单元（保持原来的手感）；
 * - 空格字素只用来断词，不参与排版；
 * - 脚本一换（拉丁 ↔ CJK）就断开，混排行不会被粘成一个怪词。
 */
function buildUnits(line: StageLine): CadenzaUnit[] {
  const units: CadenzaUnit[] = [];
  let buffer: string[] = [];
  let startMs = 0;
  let endMs = 0;
  const flush = (): void => {
    if (buffer.length === 0) return;
    units.push({ text: buffer.join(''), startMs, endMs });
    buffer = [];
  };
  for (const word of line.words) {
    if (isSpaceUnit(word.text)) {
      flush();
      continue;
    }
    if (buffer.length > 0) {
      // 当前缓冲是「不分词文字」→ 一个字素一个单元；脚本不同也断开。
      if (!usesWordSpaces(word.text) || !usesWordSpaces(buffer.join(''))) flush();
    }
    if (buffer.length === 0) startMs = word.startMs;
    endMs = word.endMs;
    buffer.push(word.text);
  }
  flush();
  return units;
}

/** palette 色 → 可直接写进 DOM 的字符串：解析得出就按底色调对比度，解析不出就用原值。 */
function readableColor(value: string, surface: RgbColor | null): string {
  if (surface === null) return value;
  const parsed = parseRgb(value);
  if (parsed === null) return value;
  return ensureContrast(parsed, surface, 3);
}

export function buildCadenzaPlan(
  line: StageLine,
  viewportWidth: number,
  viewportHeight: number,
  intensity: LyricPalette['animationIntensity'],
  palette: LyricPalette,
  fontFamily: string,
  surface: RgbColor | null,
): CadenzaPlan {
  const chaos = intensity === 'chaotic';
  const calm = intensity === 'calm';
  // 设置的动效参数：`fontScale` 在这里就用掉，`motionAmount` 折进下面每个「幅值」字段。
  const { fontScale, motionAmount } = tuningOf(palette);
  const graphemes = graphemeCountOfText(line.text);
  // 动效单元 = 词（不是字形）：英文歌不再逐字母乱飞。
  const units = buildUnits(line);
  const wordCount = units.length;
  const widthBase = clamp(viewportWidth * 0.086, 34, 94);
  const lengthPenalty = graphemes > 12 ? Math.min((graphemes - 12) * 1.8, 34) : 0;
  const densityPenalty = wordCount > 7 ? Math.min((wordCount - 7) * 1.5, 18) : 0;
  // 字号 = 原公式 × 设置的 `fontScale`。外面这层 clamp 的上下限跟着同一倍数走：
  // 只乘不放上限的话，104px 那一档（短句 + 少词）会被原上限夹回去，旋钮在最该看得见
  // 变化的地方反而失效；再叠一道 `FONT_SCALE_MAX` 的天花板，保证 1.3 倍也不会撑爆舞台。
  const fontPx = clamp(
    clamp(widthBase - lengthPenalty - densityPenalty, FONT_PX_MIN, FONT_PX_MAX) * fontScale,
    FONT_PX_MIN * fontScale,
    FONT_PX_MAX * FONT_SCALE_MAX,
  );
  const cjk = isCjkText(line.text);
  const lineHeightPx = Math.round(fontPx * (cjk ? 1.22 : 1.1));
  const availableWidth = Math.max(viewportWidth - 48, 120);
  const wrapCompression =
    graphemes > 12 ? clamp(0.92 - (graphemes - 12) * 0.018, 0.62, 0.92) : 0.92;
  /* 折行宽度用 folia `buildPreparedState` 的原式：
     `clamp(min(视口宽 × widthRatio × wrapCompression, 820), min(220, availableWidth), availableWidth)`。 */
  const maxWidth = clamp(
    Math.min(viewportWidth * WIDTH_RATIO * wrapCompression, MAX_WRAP_WIDTH),
    Math.min(220, availableWidth),
    availableWidth,
  );
  /* 舞台几何：中轴 + 中间带 + 水平铺开（取代旧的水平外扩 `boundsPadX` 与通往视口上下边缘的
     `boundsTop / boundsBottom`——那套「量到视口边」的外框正是词被甩到四角的来源）。
     - 纵向：每个词的碰撞矩形都落在中轴 `focusY` 上下的「中间带」里；
     - 横向：词按阅读顺序在 hero 左右铺开，铺开跨度 = `maxWidth × 0.5~0.8`。
     具体数值在下面「水平铺开 / 中间带」两段里算，因为它们要用到 hero 与每个词的实测宽度。 */
  const focusY = viewportHeight * FOCUS_Y_RATIO;
  const baseMargin = calm ? 4 : 6;
  const lineSeed = Math.abs(Math.sin((line.timeMs / 1000) * 997.1));
  const perspectivePx = chaos ? 500 + Math.round(lineSeed * 500) : 1000;
  const envelope = envelopeFor(line.hint, line.durationMs);
  const emptyPlan: CadenzaPlan = {
    line,
    fontPx,
    lineHeightPx,
    heroIndex: -1,
    words: [],
    perspectivePx,
    maxWidth,
    bounds: {
      upPx: 0,
      downPx: 0,
      halfWidthPx: 0,
      foliaUpPx: 0,
      foliaDownPx: 0,
      capacityHalfPx: 0,
    },
    ...envelope,
  };
  if (wordCount === 0) return emptyPlan;

  // 1. 选强调词：语义权重 + 居中偏好。
  let heroIndex = 0;
  let heroScore = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < wordCount; index += 1) {
    const word = units[index];
    if (word === undefined) continue;
    const semantic = isCjkText(word.text)
      ? 0.18
      : Math.min(graphemesOf(word.text).length * 0.08, 0.36);
    const centerBias = 1 - Math.abs(index - (wordCount - 1) / 2) / Math.max(wordCount, 1);
    const score = semantic + centerBias * 0.18;
    if (score > heroScore) {
      heroScore = score;
      heroIndex = index;
    }
  }
  const heroText = units[heroIndex]?.text ?? '';
  const emphasis = HERO_EMPHASIS_BASE * (1 + clamp(heroScore - 0.48, 0, 0.52));
  // 真实词宽（canvas measureText，和 DOM 同一字体栈 / 字重）。
  let heroFontPx = fontPx * emphasis;
  let heroWidth = measureTextWidth(heroText, heroFontPx, 700, fontFamily, 0);
  /* 超长单词 / 泰文长串：强调词也不能超出可用宽度（否则直接捅出播放页）。
     第二条上限是「动效余量」：hero 唱到时会 `scale(1.3)`，而 `transform-origin` 是左上角，
     所以它的右边缘会长到 `0.8 × 宽`（`-宽/2 + 宽 × 1.3`）。若只按 `availableWidth × 0.86` 收，
     34 字符的无空格单词在最小窗口下会把这个放大后的右缘顶出舞台 20px。
     `viewportWidth × 0.625 − 50` 就是「放大后仍留在舞台内」解出来的宽度（50px 留给旋转与抖动）。 */
  const heroMaxWidth = Math.min(
    availableWidth * 0.86,
    Math.max(viewportWidth * 0.625 - 50, 160),
  );
  if (heroWidth > heroMaxWidth) {
    /* 只有「连 `heroMaxWidth` 都放不下」时才允许比普通词更小（下限 `FONT_PX_MIN × 0.5`，
       与逐词收窄的下限同源）；放得下时仍旧守住「hero 不小于 `fontPx`」。 */
    const fitted = (heroFontPx * heroMaxWidth) / heroWidth;
    heroFontPx = Math.max(fitted, Math.min(fontPx, FONT_PX_MIN * 0.5));
    heroWidth = measureTextWidth(heroText, heroFontPx, 700, fontFamily, 0);
  }
  /* ---- 每个词的实测外框（碰撞盒）+ 折行 ----
     folia `buildWordPlacements`：`宽 = max(endX − startX, fontPx × 0.18)`、`高 = fontPx × 0.95`，
     碰撞盒再乘 `1.26 / 1.24`（强调词 `1.48 / 1.36`），四边各留 `padding`（`baseMargin + 2`，
     强调词 `+ 10`）。折行照 pretext 的 `layoutWithLines(prepared, maxWidth, lineHeight)`：
     这里等价地用实测词宽贪心折行——用空格分词的语言只在词间断行、CJK / 泰文按字素断行，
     与浏览器的换行规则一致；行内偏移 `offset` 就是 folia 的 `fragment.startX`。 */
  const unitWidths: number[] = new Array<number>(wordCount).fill(0);
  for (let index = 0; index < wordCount; index += 1) {
    const word = units[index];
    if (word === undefined) continue;
    unitWidths[index] = Math.max(
      measureTextWidth(word.text, fontPx, 700, fontFamily, 0),
      fontPx * 0.18,
    );
  }
  const spaceWidth = usesWordSpaces(line.text)
    ? measureTextWidth(' ', fontPx, 700, fontFamily, 0)
    : 0;
  const rows: { index: number; offset: number }[][] = [];
  let row: { index: number; offset: number }[] = [];
  let rowWidth = 0;
  const flushRow = (): void => {
    if (row.length > 0) rows.push(row);
    row = [];
    rowWidth = 0;
  };
  for (let index = 0; index < wordCount; index += 1) {
    const wordWidth = unitWidths[index] ?? 0;
    if (row.length > 0 && rowWidth + spaceWidth + wordWidth > maxWidth) flushRow();
    const offset = row.length === 0 ? 0 : rowWidth + spaceWidth;
    row.push({ index, offset });
    rowWidth = offset + wordWidth;
  }
  flushRow();
  const totalHeightPx = Math.max(rows.length, 1) * lineHeightPx;
  const randBaseOf = (index: number): number => line.timeMs + index * 17 + line.index * 31;

  /** 求解过程中的一个「待落位词」（folia `PlacementPlan` 的子集）。 */
  interface CadenzaItem {
    index: number;
    rowIndex: number;
    hero: boolean;
    width: number;
    fontPx: number;
    collisionWidth: number;
    collisionHeight: number;
    padding: number;
    preferredX: number;
    preferredY: number;
  }
  /* 自然落位：`baseX = −行宽/2 + 行内偏移`（每行居中）、`baseY = −整块高/2 + 行号 × 行高`；
     强调词例外 —— 摆画面正中（`−heroWidth/2, 0`）。 */
  const items: CadenzaItem[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const rowItems = rows[rowIndex] ?? [];
    let rowLineWidth = 0;
    for (const item of rowItems) {
      rowLineWidth = Math.max(rowLineWidth, item.offset + (unitWidths[item.index] ?? 0));
    }
    for (const item of rowItems) {
      const isHero = item.index === heroIndex;
      const wordWidth = isHero ? heroWidth : (unitWidths[item.index] ?? 0);
      const wordFontPx = isHero ? heroFontPx : fontPx;
      const height = wordFontPx * 0.95;
      items.push({
        index: item.index,
        rowIndex,
        hero: isHero,
        width: wordWidth,
        fontPx: wordFontPx,
        collisionWidth: wordWidth * (isHero ? COLLISION_W_HERO : COLLISION_W),
        collisionHeight: height * (isHero ? COLLISION_H_HERO : COLLISION_H),
        padding: isHero ? baseMargin + 10 : baseMargin + 2,
        preferredX: isHero ? -wordWidth / 2 : -rowLineWidth / 2 + item.offset,
        preferredY: isHero ? 0 : -totalHeightPx / 2 + rowIndex * lineHeightPx,
      });
    }
  }

  /* ---- 落位边界（folia 原式 + 一道视口夹取）----
     folia：横向 `±(maxWidth/2 + 72)`、纵向 `±max(整块高 × 0.9, 行高 × 1.6 / 1.45)`。
     folia 不做视口夹取（它的 overlay 直接被裁）；这里再夹进「视口 − 动效余量」，
     好让冒烟里的「出窗」恒为 0。动效余量 = 唱到时 `scale(1.3)` 从左上角向右外扩
     `0.3 × 词宽`（本仓库的 `transform-origin` 是左上角），再加漂移（≤ 17px）与浮动（±4px）。 */
  let widestVisible = 0;
  let tallestBox = 0;
  for (const item of items) {
    widestVisible = Math.max(widestVisible, item.width);
    tallestBox = Math.max(tallestBox, item.collisionHeight + item.padding * 2);
  }
  const effectPadY = Math.round(lineHeightPx * 0.34) + EFFECT_PAD_Y;
  const effectPadX = Math.round(widestVisible * 0.3) + EFFECT_PAD_X;
  const stageHalfW = Math.max(viewportWidth / 2 - effectPadX, 0);
  const stageUp = Math.max(focusY - effectPadY, 0);
  const stageDown = Math.max(viewportHeight - focusY - effectPadY, 0);
  const foliaHorizontal = maxWidth / 2 + BOUNDS_PAD_X;
  const foliaUp = Math.max(totalHeightPx * BOUNDS_BLOCK_Y, lineHeightPx * BOUNDS_TOP_Y);
  const foliaDown = Math.max(totalHeightPx * BOUNDS_BLOCK_Y, lineHeightPx * BOUNDS_BOTTOM_Y);
  let horizontalMin = Math.max(-foliaHorizontal, -stageHalfW);
  let horizontalMax = Math.min(foliaHorizontal, stageHalfW);
  let verticalMin = Math.max(-foliaUp, -stageUp);
  let verticalMax = Math.min(foliaDown, stageDown);
  const degenerateStage =
    horizontalMax - horizontalMin < 1 || verticalMax - verticalMin < tallestBox;
  if (degenerateStage) {
    // 极端窄 / 矮的舞台：夹取会把边界挤没，退回 folia 原式（宁可出窗也不退化成一条线）。
    horizontalMin = -foliaHorizontal;
    horizontalMax = foliaHorizontal;
    verticalMin = -foliaUp;
    verticalMax = foliaDown;
  }
  /* ---- 纵向「容量室」（本仓库独有增补：folia 的纵向边界装不下这一行的碰撞盒时放宽）----
     folia 的 `±max(整块高 × 0.9, 行高 × 1.6 / 1.45)` 是「画面紧凑」的审美边界，长句 × 大字号下
     面积是不够的（24 字时碰撞盒总面积约是该区域的 2.4 倍），folia 这时直接接受相撞；PI 不许相撞
     （用户 m03279 抱怨过「杂乱无章地散在页面上」），所以这里算「零重叠所需的最小纵向室」：
     行距取一行碰撞盒的最高值（纵向上下相接即不撞），所需行数 = 总碰撞宽 ÷ 落位可用宽，
     于是 `行数 × 行距 ÷ 2` 就是纵向至少要给的一半高度。取 `max(folia 原式, 容量值)`，再用
     视口安全线夹住（仍然不出窗）。只放宽纵向；横向保持 folia 的 `maxWidth / 2 + 72`。 */
  let capacityHalf = 0;
  if (!degenerateStage) {
    let sumBoxWidth = 0;
    for (const item of items) sumBoxWidth += item.collisionWidth + item.padding * 2;
    const usableWidth = Math.max(horizontalMax - horizontalMin, 1);
    const requiredRows = Math.max(1, Math.ceil(sumBoxWidth / usableWidth));
    capacityHalf = (requiredRows * tallestBox) / 2;
    verticalMin = Math.max(-Math.max(foliaUp, capacityHalf), -stageUp);
    verticalMax = Math.min(Math.max(foliaDown, capacityHalf), stageDown);
  }
  /** 落位实际使用的纵向半高（= `min(max(folia 原式, 容量值), 视口安全线)`）：
      几何自查第 1 条就是拿它当契约（folia 原式给 `bounds.foliaUpPx/foliaDownPx` 做对照）。 */
  const roomUp = -verticalMin;
  const roomDown = verticalMax;
  const spanW = horizontalMax - horizontalMin;
  /* 单个词自己的碰撞盒比整条落位边界还宽（`supercalifragilistic…` 这种无空格超长词）：只把它
     自己收窄（下限 `MIN_WORD_SCALE`，字号 / 视觉宽 / 碰撞盒一起缩）。folia 那边只有「hero 也要
     塞回可用宽度」的分支，逐词收窄是本仓库的兜底。 */
  const spanH = verticalMax - verticalMin;
  for (const item of items) {
    const boxWidth = item.collisionWidth + item.padding * 2;
    const boxHeight = item.collisionHeight + item.padding * 2;
    if (boxWidth <= spanW && boxHeight <= spanH) continue;
    const factor = Math.max(
      boxWidth > spanW ? spanW / boxWidth : 1,
      boxHeight > spanH ? spanH / boxHeight : 1,
      MIN_WORD_SCALE,
    );
    item.fontPx *= factor;
    item.width *= factor;
    item.collisionWidth *= factor;
    item.collisionHeight *= factor;
  }

  /* ---- 求解顺序（folia）：强调词先落位 ⇒ 它必得「半径 0 的画面正中」。 ---- */
  items.sort(
    (a, b) =>
      Number(b.hero) - Number(a.hero) || a.rowIndex - b.rowIndex || a.preferredX - b.preferredX,
  );
  const heroItem = items.find((item) => item.hero);
  /* 强调词的排他半径（folia `minHeroSeparation`）= `hero 宽 × 0.34 + 词宽 × 0.52 + padding × 2`。
     folia 把 hero 的参考点心记成 `+heroW × scale / 2`（比真词心偏右半个 hero），
     这里用真词心（hero 就摆在 0），左右对称。 */
  const heroCenterX = heroItem === undefined ? 0 : heroItem.preferredX + heroItem.width / 2;
  const heroCenterY = heroItem === undefined ? 0 : heroItem.preferredY + heroItem.fontPx / 2;
  const heroVisibleWidth = heroItem === undefined ? 0 : heroItem.width;

  const occupied: Rect[] = [];
  const placements: (CadenzaPlacement | undefined)[] = new Array<CadenzaPlacement | undefined>(
    wordCount,
  );
  const rectOf = (item: CadenzaItem, x: number, y: number): Rect => ({
    left: x - item.padding,
    top: y - item.padding,
    right: x + item.collisionWidth + item.padding,
    bottom: y + item.collisionHeight + item.padding,
  });
  const insideBounds = (
    rect: Rect,
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
  ): boolean => rect.left >= minX && rect.right <= maxX && rect.top >= minY && rect.bottom <= maxY;
  const overlapAt = (rect: Rect): number => {
    let area = 0;
    for (const box of occupied) area += overlapArea(rect, box);
    return area;
  };
  const clampInto = (value: number, lo: number, hi: number): number =>
    // `hi < lo` 只会出现在「碰撞盒比整条落位边界还大」的退化情形：贴 `lo`（至少不出边界外）。
    hi >= lo ? clamp(value, lo, hi) : lo;

  /** 阅读顺序硬约束（几何自查第 4 条）：hero 左边的词词心必须 ≤ 0、右边必须 ≥ 0。
      折行后的「自然落位」会把上一行末尾的词排到 hero 右侧（按文本顺序它仍在左），
      所以这条当硬约束：候选点不合就跳过，首选位置不合就掰回来。 */
  const sideOk = (item: CadenzaItem, x: number): boolean => {
    const centerX = x + item.width / 2;
    if (item.index < heroIndex) return centerX <= -SIDE_GAP;
    if (item.index > heroIndex) return centerX >= SIDE_GAP;
    return true;
  };
  const sideClamp = (item: CadenzaItem, x: number): number => {
    const centered = -item.width / 2;
    if (item.index < heroIndex) return Math.min(x, centered - SIDE_GAP);
    if (item.index > heroIndex) return Math.max(x, centered + SIDE_GAP);
    return x;
  };

  /**
   * 落位一个词一次（folia 的三步：hero 径向推开 → 螺旋搜索 → `bestFallback`）。
   *
   * 螺旋搜索评分 `重叠面积 × 2.2 + 路程`，**零重叠即停**——这正是 folia 那句
   * 「单字撒在画面里」的来源：折行后相邻两行的碰撞盒在纵向本来就会互相压住
   * ≈ `碰撞高 + 2 × padding − 行高`，于是词被一圈圈从自然位置推到空位上，撒成一片、
   * 但仍然按句子成行。
   *
   * 与 folia 的差异（文件头「本次复刻」里也写了同一条）：
   * ① 半径上限：folia 只有 `max(行高 × 2.2, 碰撞宽 × 0.75, 56)`，推不开就直接接受相撞；
   *    这里「一圈下来都没有零重叠」时把上限放大 3 倍再扫一遍，仍找不到才接受相撞。
   * ② 起始位置先夹进边界：folia 直接拿被推开的位置当兜底，可能落在边界外。
   * ③ 零重叠是硬要求（PI 的用户抱怨过「杂乱无章地散在页面上」），所以外面还有一道
   *    「找不到空位就把这个词自己缩小再搜」的兜底，见下面的 `place`。
   */
  const placeOnce = (item: CadenzaItem): { x: number; y: number; clear: boolean } => {
    // ⓪ 强调词恒在画面正中（`−宽/2, 0`）：不吃边界夹取、不参与螺旋。它的视觉宽已经被
    //    `heroMaxWidth` 夹住，`±宽/2` 不会出窗；而 `preferredX` 是「词心锚」（`−宽/2`）
    //    而不是碰撞盒左上角，拿它去过 `clampPreferred` 会把 hero 整个推到左边去
    //    （几何自查「hero 居中」就是这么红的）。落位顺序里 hero 排第一，所以它的碰撞盒
    //    总能先占住画面正中，后面的词会自己绕开。
    if (item.hero) {
      occupied.push(rectOf(item, item.preferredX, item.preferredY));
      return { x: item.preferredX, y: item.preferredY, clear: true };
    }
    let preferredX = item.preferredX;
    let preferredY = item.preferredY;
    // ① hero 径向推开：与 hero 词心太近就沿两者连线推出去（y 分量 ×0.92）。
    if (heroItem !== undefined) {
      const wordCenterX = preferredX + item.width / 2;
      const wordCenterY = preferredY + item.fontPx / 2;
      let dx = wordCenterX - heroCenterX;
      let dy = wordCenterY - heroCenterY;
      let distance = Math.hypot(dx, dy);
      if (distance < 1) {
        dx = preferredX >= 0 ? 1 : -1;
        dy = item.rowIndex % 2 === 0 ? -0.65 : 0.65;
        distance = Math.hypot(dx, dy);
      }
      const separation =
        heroVisibleWidth * HERO_SEP_HERO_W + item.width * HERO_SEP_WORD_W + item.padding * 2;
      if (distance < separation) {
        const push = (separation - distance) / distance;
        preferredX += dx * push;
        preferredY += dy * push * 0.92;
      }
    }
    // ② 先夹进 folia 边界再搜。
    let boundMinX = horizontalMin;
    let boundMaxX = horizontalMax;
    let boundMinY = verticalMin;
    let boundMaxY = verticalMax;
    const clampPreferred = (): void => {
      preferredX = sideClamp(
        item,
        clampInto(
          preferredX,
          boundMinX + item.padding,
          boundMaxX - item.collisionWidth - item.padding,
        ),
      );
      preferredY = clampInto(
        preferredY,
        boundMinY + item.padding,
        boundMaxY - item.collisionHeight - item.padding,
      );
    };
    clampPreferred();
    /* ③ 螺旋搜索：`step = max(10, 字号 × 0.14)`、每圈 `max(12, round(2πr / (step × 1.1)))` 个采样
       （强调词固定 8 个），y 方向椭圆压扁 ×0.92（强调词 ×0.8），起始角 = 从 hero 指向该词
       （强调词恒为 0）。 */
    const step = Math.max(10, Math.round(fontPx * 0.14));
    const ellipseY = item.hero ? 0.8 : 0.92;
    const baseAngle =
      item.hero || heroItem === undefined
        ? 0
        : Math.atan2(preferredY - heroCenterY, preferredX + item.width / 2 - heroCenterX);
    const ringRadius = item.hero
      ? Math.max(20, lineHeightPx * HERO_SPIRAL_RADIUS)
      : Math.max(lineHeightPx * 2.2, item.collisionWidth * 0.75, SPIRAL_MIN_RADIUS);
    let chosenX = preferredX;
    let chosenY = preferredY;
    let bestScore = Number.POSITIVE_INFINITY;
    let clear = false;
    for (let pass = 0; pass < 3 && !clear; pass += 1) {
      if (pass === 2) {
        /* ③ 兜底放宽（本仓库独有增补）：folia 的横向边界是为了「画面紧凑」，挤不下时它直接接受相撞；
           这里换成横向的「视口安全线」（`stageHalfW` 已扣掉放大、旋转、漂移、抖动的外扩预算）
           再搜一遍——仍然保证不出窗。纵向不在这里放宽：外层已经按「容量室」算好
           （`roomUp / roomDown`，见上面的推导），词心契约（几何自查第 1 条）就以它为准。 */
        boundMinX = -stageHalfW;
        boundMaxX = stageHalfW;
        clampPreferred();
      }
      const radiusLimit = pass === 0 ? ringRadius : ringRadius * 3;
      const rings = Math.min(SPIRAL_MAX_RINGS, Math.max(1, Math.ceil(radiusLimit / step)));
      for (let ring = 0; ring <= rings && !clear; ring += 1) {
        const radius = Math.min(radiusLimit, ring * step);
        const samples =
          radius === 0
            ? 1
            : item.hero
              ? HERO_SPIRAL_SAMPLES
              : Math.min(
                  SPIRAL_MAX_SAMPLES,
                  Math.max(
                    SPIRAL_MIN_SAMPLES,
                    Math.round((Math.PI * 2 * radius) / Math.max(step * SPIRAL_SAMPLE_DIVISOR, 1)),
                  ),
                );
        for (let sample = 0; sample < samples; sample += 1) {
          const angle = radius === 0 ? 0 : baseAngle + (sample / samples) * Math.PI * 2;
          const dx = Math.cos(angle) * radius;
          const dy = Math.sin(angle) * radius * ellipseY;
          const x = preferredX + dx;
          const y = preferredY + dy;
          const rect = rectOf(item, x, y);
          if (!insideBounds(rect, boundMinX, boundMaxX, boundMinY, boundMaxY)) continue;
          if (!sideOk(item, x)) continue;
          const overlap = overlapAt(rect);
          const score = overlap * 2.2 + Math.hypot(dx, dy);
          if (score < bestScore) {
            bestScore = score;
            chosenX = x;
            chosenY = y;
          }
          if (overlap <= 0) {
            clear = true;
            break;
          }
        }
      }
    }
    /* ④ 全局兜底（本仓库独有增补）：本地螺旋也找不到空位时，把「视口安全区」按 `step`
       扫一遍网格，取「重叠最小、离首选最近」的格子——folia 的 `bestFallback` 只回看螺旋
       采过的点，这里把整块可用面积都过一遍，长句拥挤时明显少撞。 */
    if (!clear) {
      const gridEndX = boundMaxX - item.collisionWidth - item.padding;
      const gridEndY = boundMaxY - item.collisionHeight - item.padding;
      for (let gy = boundMinY + item.padding; gy <= gridEndY && !clear; gy += step) {
        for (let gx = boundMinX + item.padding; gx <= gridEndX; gx += step) {
          if (!sideOk(item, gx)) continue;
          const overlap = overlapAt(rectOf(item, gx, gy));
          const score = overlap * 2.2 + Math.hypot(gx - preferredX, gy - preferredY);
          if (score < bestScore) {
            bestScore = score;
            chosenX = gx;
            chosenY = gy;
          }
          if (overlap <= 0) {
            clear = true;
            break;
          }
        }
      }
    }
    return { x: chosenX, y: chosenY, clear };
  };

  /**
   * 落位 + 「零重叠」兜底（几何自查第 2 条：可达舞台 × 全部旋钮档下任意两词不得相交）。
   *
   * folia 的哲学是「推不开就接受相撞」，PI 不能这样——用户 m03279 明确抱怨过「杂乱无章地散在
   * 页面上」。所以这里反过来：`placeOnce` 找不到零重叠位置时，把**这一个词自己**按
   * `PLACE_SHRINK_STEP` 逐级缩小（下限 `MIN_PLACE_SHRINK`）再搜一遍，缩到最后仍撞才接受
   * 「重叠最小、离首选最近」的那个位置。只缩冲突词、不动整行字号，所以默认档（`fontScale=1`）
   * 与宽松舞台下不会有任何视觉变化；只有「最大字号 × 最长句子 × 最小可达舞台」才会吃到它。
   */
  const place = (item: CadenzaItem): { x: number; y: number; clear: boolean } => {
    let shrink = 1;
    let result = placeOnce(item);
    while (!result.clear && shrink > MIN_PLACE_SHRINK) {
      const next = Math.max(MIN_PLACE_SHRINK, shrink * PLACE_SHRINK_STEP);
      const factor = next / shrink;
      shrink = next;
      item.fontPx *= factor;
      item.width *= factor;
      item.collisionWidth *= factor;
      item.collisionHeight *= factor;
      result = placeOnce(item);
    }
    occupied.push(rectOf(item, result.x, result.y));
    return result;
  };



  // 2. 逐个落位 + 唱后漂移（folia `passedDriftX/Y` 与 `rotate`）。
  for (const item of items) {
    const { x, y } = place(item);
    const word = units[item.index];
    const rand = (offset: number): number => {
      const value = Math.sin(randBaseOf(item.index) + item.rowIndex * 31 + offset) * 10000;
      return value - Math.floor(value);
    };
    /* 漂移方向 = 从画面锚点指向该词的词心（folia `outwardUnitX/Y`）；
       量值按「强调词 / 混沌 / 普通」分档，另加 `(rand(7) − 0.5) × 2.4` 与
       `(rand(8) − 0.5) × 2` 的抖动；y 分量的 0.72 在 rAF 里乘（与 folia 一致）。
       `motionAmount`（folia 那里是 audioEnergy）整体缩放。 */
    const outwardX = x + item.width / 2;
    const outwardY = y + item.fontPx / 2;
    const outwardLength = Math.max(Math.hypot(outwardX, outwardY), 1);
    const driftAmount = item.hero ? 4 + rand(6) * 4 : chaos ? 8 + rand(6) * 9 : 5 + rand(6) * 6;
    /* 唱后旋转：folia 原式 `(rand(3) − 0.5) × (混沌 ? 20 : 12) × 能量`。
       几何自查里的动效包络按**左上角锚点**算（`lyric-moods.css` 的 `transform-origin: 0 0`，
       比 `lyric-cadenza.css` 的 `50% 42%` 保守），长词绕左上角转起来的垂直外扩
       ≈ `1.3 × 词宽 × |sinθ|`，所以再收一道：外扩不超过 `SWING_SPILL_PX`（这条余量已经算进
       `EFFECT_PAD_X / EFFECT_PAD_Y`）。窄字完全不受影响，只有宽词会少摆一点。 */
    const rotateRaw = (rand(3) - 0.5) * (chaos ? 20 : 12) * motionAmount;
    const swing = item.width * ENTER_SCALE * Math.abs(Math.sin((rotateRaw * Math.PI) / 180));
    const passedRotate = swing > SWING_SPILL_PX ? rotateRaw * (SWING_SPILL_PX / swing) : rotateRaw;
    placements[item.index] = {
      x,
      y,
      // folia 的基准旋转恒为 0（旋转只发生在「唱过之后」）。
      rotate: 0,
      passedRotate,
      drift: driftAmount * motionAmount,
      outwardX: outwardX / outwardLength,
      outwardY: outwardY / outwardLength,
      jitterX: (rand(7) - 0.5) * 2.4 * motionAmount,
      jitterY: (rand(8) - 0.5) * 2 * motionAmount,
      color: readableColor(wordColorOf(palette, word?.text ?? '', palette.accentColor), surface),
      fontPx: item.fontPx,
    };
  }


  const words: CadenzaWordPlan[] = [];
  for (let index = 0; index < wordCount; index += 1) {
    const word = units[index];
    const placement = placements[index];
    if (word === undefined || placement === undefined) continue;
    words.push({
      index,
      text: word.text,
      startMs: word.startMs,
      endMs: word.endMs,
      hero: index === heroIndex,
      randBase: randBaseOf(index),
      placement,
    });
  }
  return {
    ...emptyPlan,
    heroIndex,
    words,
    bounds: {
      upPx: roomUp,
      downPx: roomDown,
      halfWidthPx: foliaHorizontal,
      foliaUpPx: foliaUp,
      foliaDownPx: foliaDown,
      capacityHalfPx: capacityHalf,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

interface CadenzaWordViewProps {
  readonly plan: CadenzaWordPlan;
  readonly lineHeightPx: number;
  readonly register: (index: number, element: HTMLDivElement | null) => void;
}

function CadenzaWordView({ plan, lineHeightPx, register }: CadenzaWordViewProps): ReactNode {
  const { placement } = plan;
  return (
    <div
      className="pi-lyriccadenza__word"
      ref={(element) => {
        register(plan.index, element);
      }}
      style={
        {
          left: `${placement.x.toFixed(2)}px`,
          top: `${placement.y.toFixed(2)}px`,
          '--pi-cad-font': `${placement.fontPx.toFixed(2)}px`,
          '--pi-cad-line-height': `${lineHeightPx}px`,
        } as CSSProperties
      }
    >
      <div className="pi-lyriccadenza__inner">
        <span className="pi-lyriccadenza__body">{plan.text}</span>
        {/* 辉光层：透明字 + text-shadow（z-index 0，压在正文下面）。 */}
        <span className="pi-lyriccadenza__glow" aria-hidden="true">
          {plan.text}
        </span>
      </div>
    </div>
  );
}

/**
 * 心象主题。
 *
 * 每帧只做两件事：按 `usePositionClock` 外推出的当前位置算每个词的目标值，
 * 再用指数趋近把差异写回 DOM。全程不 setState、不新建 / 销毁节点、不查 DOM。
 */
export function CadenzaTheme(props: LyricThemeProps): ReactNode {
  const { lines, translated, activeIndex, viewIndex, positionMs, theme } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const wordRefs = useRef<(HTMLDivElement | null)[]>([]);
  // 舞台 = 整个播放页可视区域（首帧 / 量不到回退视口）；窗口缩放由 ResizeObserver 重算。
  const stage = useFullStageSize(rootRef);
  const clock = usePositionClock(positionMs);
  const reduced = usePrefersReducedMotion();
  const anchor = lines[viewIndex];
  const positionRef = useRef(positionMs);
  positionRef.current = positionMs;
  // canvas 度量必须和 DOM 同一套字体栈，否则词宽 / 避让全是错的。
  const fontFamily = useElementFontFamily(rootRef);

  const viewportWidth = stage.width;
  const viewportHeight = stage.height;
  // 颜色跟随歌曲：祖先注入的 `--pi-th-*`（播放页按当前歌曲封面注入）优先，palette 兜底。
  const liveColors = useResolvedThemeColors(rootRef, theme);
  const surfaceValue = liveColors.current.surface;
  // 稳定引用：plan 的依赖不能是每帧新解析出来的对象，否则螺旋避让会每帧重算。
  const surface = useMemo(() => parseRgb(surfaceValue), [surfaceValue]);
  const plan = useMemo(
    () =>
      anchor === undefined
        ? undefined
        : buildCadenzaPlan(
            anchor,
            viewportWidth,
            viewportHeight,
            theme.animationIntensity,
            theme,
            fontFamily,
            surface,
          ),
    [anchor, fontFamily, surface, theme, viewportHeight, viewportWidth],
  );

  /** 落成具体颜色的调色板（每帧都要 mix，`var()` / `color-mix()` 算不了），并按底色兜对比度。 */
  const paint = {
    primary: readableColor(liveColors.current.primary, surface),
    accent: readableColor(liveColors.current.accent, surface),
    // 第十五轮第 4 条：**常态歌词色 = 白**。只在「白 vs 底色」不足 3:1 时才压到可读的最浅中性色。
    ink: readableColor(CADENZA_INK, surface),
    surface,
  };
  const paletteRef = useRef(paint);
  paletteRef.current = paint;

  const translatedText = anchor === undefined ? undefined : translated.get(anchor.timeMs);
  const previewLines: string[] = [];
  if (anchor !== undefined) {
    for (let step = 1; step <= 2; step += 1) {
      const next = lines[anchor.index + step];
      if (next !== undefined) previewLines.push(next.text === '' ? '…' : next.text);
    }
  }

  useEffect(() => {
    if (plan === undefined) return undefined;
    const rootElement = rootRef.current;
    if (rootElement === null) return undefined;
    const words = plan.words;
    if (words.length === 0) return undefined;
    const hint = plan.line.hint;
    const instant = hint === 'micro';
    const chaotic = theme.animationIntensity === 'chaotic';
    // 设置里的动效参数在 effect 起点取一次（`theme` 是稳定引用的 palette，它变一次
    // 这个 effect 就重启一次），当闭包常量用比每帧查一次表便宜。
    // `MOTION_ENERGY` 原来是常数 1——就是 folia 留给 `motionAmount` 的位子。
    const { fpsCap, glowIntensity, motionAmount } = tuningOf(theme);
    const motion = MOTION_ENERGY * motionAmount;
    const frameGate = createFrameGate(fpsCap);
    const lookahead = LOOKAHEAD_CADENZA[hint];
    const activeEndFallback = plan.line.timeMs + plan.line.durationMs;
    const fadeOutMs = hint === 'short' ? 120 : 800;

    // 每帧状态的缓存（写进 DOM 之前先比一次，避免无谓的样式失效）。
    const previous: (CadenzaFrame | undefined)[] = new Array<CadenzaFrame | undefined>(
      words.length,
    );

    /** 减少动效：静态渲染一次（亮起 + 无位移 / 无脉冲 / 无相机运动）。 */
    const paintStatic = (): void => {
      const ms = positionRef.current;
      for (const word of words) {
        const element = wordRefs.current[word.index];
        if (element === null || element === undefined) continue;
        const active = ms >= word.startMs - lookahead && ms <= (instant ? activeEndFallback : word.endMs);
        element.style.transform = 'none';
        element.style.filter = 'none';
        element.style.opacity = active ? '1' : '0.82';
        // 第十五轮第 4 条：常态（未唱 / 唱过）= 白，只有当前词拿主题色。
        const inkOrWord = active ? word.placement.color : paletteRef.current.ink;
        element.style.color = inkOrWord;
        // 可见正文在内层 `.pi-lyriccadenza__inner`，它自己有 `color` 声明（外层 `color` 继承不进去），
        // 所以同一个值再写一份到每词变量上（规则见 lyric-themes.css 的 cadenza 段）。
        element.style.setProperty('--pi-cad-fill', inkOrWord);
        element.style.textShadow = 'none';
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
      // `last` 故意不更新，下一帧通过的 dt 才是「距上帧真实经过的时间」，三个
      // 指数趋近系数（transform/visual/glowAmount）才不会因为跳帧而失真。
      // `fpsCap === 'off'` 时 frameGate 恒为 true，与加这个旋钮之前完全一致。
      if (!frameGate(now)) {
        if (running) frame = window.requestAnimationFrame(tick);
        return;
      }
      const dt = clamp((now - last) / 1000, 1 / 240, 0.05);
      last = now;
      const ms = clock.current();
      const t = ms / 1000;
      rootElement.style.setProperty(
        '--pi-cad-focus-y',
        `${(viewportHeight * FOCUS_Y_RATIO + Math.sin(t * LIFT_SPEED) * (LIFT_BASE + motion * LIFT_ENERGY)).toFixed(2)}px`,
      );
      const transformAmount = 1 - Math.exp(-EXP_TRANSFORM * dt);
      const visualAmount = 1 - Math.exp(-EXP_VISUAL * dt);
      const glowAmount = 1 - Math.exp(-EXP_GLOW * dt);
      for (let index = 0; index < words.length; index += 1) {
        const word = words[index];
        if (word === undefined) continue;
        const element = wordRefs.current[word.index];
        if (element === null || element === undefined) continue;
        const placement = word.placement;
        const activeEnd = instant ? activeEndFallback : word.endMs;
        const isActive = ms >= word.startMs - lookahead && ms <= activeEnd;
        const isPassed = ms > activeEnd;
        // 目标值（三态）。
        let targetAlpha: number;
        let targetScale: number;
        let targetRotate = placement.rotate;
        let targetBlur: number;
        if (isPassed) {
          targetAlpha = instant ? 0 : chaotic ? 0.9 : 0.82;
          targetScale = 1;
          targetRotate =
            placement.rotate +
            placement.passedRotate * easeInOutQuad(clamp((ms - word.endMs) / PASSED_DRIFT_MS, 0, 1));
          targetBlur = 0;
        } else if (isActive) {
          targetAlpha = 1;
          targetScale =
            1.3 *
            (1 + Math.sin(t * 10 + (word.startMs / 1000) * 5) * 0.04 * motion);
          targetBlur = 0;
        } else {
          targetAlpha = 0;
          targetScale = 0.5;
          targetRotate = placement.rotate + 20;
          targetBlur = 10;
        }
        // 唱过之后的漂移 + 逐词浮动。
        const driftProgress = clamp((ms - word.endMs) / PASSED_DRIFT_MS, 0, 1);
        const drift = placement.drift * easeInOutQuad(driftProgress);
        const driftFactor = isPassed ? 1 : 0;
        const targetX =
          driftFactor * (placement.outwardX * drift + placement.jitterX) +
          Math.sin(t * 1.2 + word.index * 0.6) * motion * 4;
        const targetY =
          driftFactor * (placement.outwardY * drift * 0.72 + placement.jitterY) +
          Math.cos(t * 1.5 + word.index * 0.4) * motion * 2.5;
        // 词体混色：词内 = 词进度，词后 = 1 - fadeOut（instant 是 0/1 开关）。
        let activeMix: number;
        if (instant) activeMix = isPassed ? 1 : 0;
        else if (ms < word.startMs) activeMix = 0;
        else if (ms <= word.endMs)
          activeMix = clamp((ms - word.startMs) / Math.max(word.endMs - word.startMs, 1), 0, 1);
        else activeMix = 1 - clamp((ms - word.endMs) / fadeOutMs, 0, 1);
        // 第十五轮第 4 条：常态色从「主题 primary」换成**白**（`ink`）。原来 waiting / passed
        // 都是 `paletteRef.current.primary`（主题色），现在只有 `activeMix` 接近 1 的当前词才是主题色，
        // 词内 0→1 淡入主题色、词后 1→0 淡回白 —— 这段插值本身就是用户要的「颜色逐渐淡去」。
        const fill = mixColor(paletteRef.current.ink, placement.color, activeMix);
        // 辉光包络：词内一段 + 词后衰减。
        const progress = clamp((ms - word.startMs) / Math.max(word.endMs - word.startMs, 1), 0, 1);
        let envelope = glowEnvelope(hint, progress);
        if (ms > word.endMs) {
          const after = instant
            ? 0
            : hint === 'short'
              ? (1 - clamp((ms - word.endMs) / 140, 0, 1)) ** 2
              : 0.9 * (1 - clamp((ms - word.endMs) / 900, 0, 1)) ** 2;
          envelope *= after;
        }
        // 指数趋近（新词初值：rotate 目标 +16、scale 0.5、alpha 0、blur 10、glow 0）。
        const before: CadenzaFrame =
          previous[index] ?? {
            alpha: 0,
            scale: 0.5,
            rotate: targetRotate + 16,
            blur: 10,
            glow: 0,
            // 第十轮第 6 条（用户 m02362：心象歌词「一抽一抽」）：`after.x/y` 是叠在元素
            // `left/top = placement.x/y`（:627-628 写好的）之上的**增量**，初值必须是 0。
            // 旧写法填 `placement.x/y` ⇒ 第一次插值时 transform 再加一遍坐标，元素瞬移几百 px
            // 再滑回来。plan 每重启一次就重演一次，看起来就是「一抽一抽」。
            x: 0,
            y: 0,
          };
        const after: CadenzaFrame = {
          alpha: before.alpha + (targetAlpha - before.alpha) * visualAmount,
          scale: before.scale + (targetScale - before.scale) * transformAmount,
          rotate: before.rotate + (targetRotate - before.rotate) * transformAmount,
          blur: before.blur + (targetBlur - before.blur) * visualAmount,
          glow: before.glow + (envelope - before.glow) * glowAmount,
          x: before.x + (targetX - before.x) * transformAmount,
          y: before.y + (targetY - before.y) * transformAmount,
        };
        previous[index] = after;
        // 只在真的有变化时写样式。
        if (
          Math.abs(after.x - before.x) > 0.05 ||
          Math.abs(after.y - before.y) > 0.05 ||
          Math.abs(after.rotate - before.rotate) > 0.01 ||
          Math.abs(after.scale - before.scale) > 0.001
        ) {
          element.style.transform = `translate3d(${after.x.toFixed(2)}px, ${after.y.toFixed(
            2,
          )}px, 0) rotate(${after.rotate.toFixed(2)}deg) scale(${after.scale.toFixed(4)})`;
        }
        if (Math.abs(after.blur - before.blur) > 0.05) {
          element.style.filter = after.blur > 0.05 ? `blur(${after.blur.toFixed(2)}px)` : 'none';
        }
        if (Math.abs(after.alpha - before.alpha) > 0.001) {
          element.style.opacity = after.alpha.toFixed(3);
        }
        if (Math.abs(after.glow - before.glow) > 0.005) {
          element.style.textShadow = buildDomTextShadow(placement.color, after.glow * glowIntensity);
        }
        if (element.style.color !== fill) element.style.color = fill;
        // 第十五轮第 4 条：真正决定**正文**颜色的是内层 `.pi-lyriccadenza__inner`（它自己声明了
        // `color: var(--pi-cad-primary, …)`，外层的 `color` 继承不进去），所以把每帧插值出来的
        // `fill` 再写成每词 CSS 变量；消费它的规则在 `lyric-themes.css` 的 cadenza 段。
        if (element.style.getPropertyValue('--pi-cad-fill') !== fill) {
          element.style.setProperty('--pi-cad-fill', fill);
        }
        if (element.dataset.cadState !== (isPassed ? 'passed' : isActive ? 'active' : 'waiting')) {
          element.dataset.cadState = isPassed ? 'passed' : isActive ? 'active' : 'waiting';
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
  }, [clock, plan, reduced, theme, viewportHeight]);

  if (anchor === undefined || plan === undefined) return null;

  const chorus = activeIndex === viewIndex && isChorusLine(lines, anchor.index);
  const lineProgress = clamp(
    (positionMs - anchor.timeMs) / Math.max(anchor.durationMs, 1),
    0,
    1,
  );
  const rootStyle = {
    // 歌曲配色：优先用祖先注入的 `--pi-th-*` 解析出的实色，palette 原值兜底。
    '--pi-cad-primary': paint.primary,
    '--pi-cad-accent': paint.accent,
  } as CSSProperties;

  // 契约：主题根元素带 `data-theme='cadenza'`（`LyricStage` 的舞台根也有同名属性；
  // 这里再挂一份，让「主题根」自己就能被定位 / 断言）。
  return (
    <div
      className="pi-lyricmood pi-lyricmood--cadenza"
      data-theme="cadenza"
      data-mood-theme="cadenza"
      data-active-index={activeIndex}
      data-view-index={viewIndex}
      ref={rootRef}
      style={rootStyle}
    >
      {chorus ? (
        <span
          className="pi-lyriccadenza__ripple"
          aria-hidden="true"
          style={{ '--pi-cad-ripple-progress': lineProgress.toFixed(3) } as CSSProperties}
        />
      ) : null}
      <div
        className="pi-lyriccadenza__line"
        key={`${anchor.index}-${anchor.timeMs}`}
        data-lyric-line={anchor.index}
        data-line-time={anchor.timeMs}
        data-index={anchor.index}
        data-active={activeIndex === viewIndex}
        data-hint={anchor.hint}
        style={
          {
            '--pi-cad-enter': `${plan.enterSec}s`,
            '--pi-cad-exit': `${plan.exitSec}s`,
            '--pi-cad-hold': `${plan.holdSec}s`,
            perspective: `${plan.perspectivePx}px`,
          } as CSSProperties
        }
      >
        {plan.words.map((word) => (
          <CadenzaWordView
            key={`${word.index}-${word.text}`}
            plan={word}
            lineHeightPx={plan.lineHeightPx}
            register={(index, element) => {
              wordRefs.current[index] = element;
            }}
          />
        ))}
      </div>
      <div className="pi-lyriccadenza__sub">
        {translatedText === undefined || translatedText === '' ? null : (
          <p className="pi-lyriccadenza__translated">{translatedText}</p>
        )}
        {previewLines.map((text, index) => (
          <p className="pi-lyriccadenza__preview" key={`${index}-${text}`}>
            {text}
          </p>
        ))}
      </div>
    </div>
  );
}

/** 每帧状态（闭包私有，不写进 DOM dataset）。 */
interface CadenzaFrame {
  alpha: number;
  scale: number;
  rotate: number;
  blur: number;
  glow: number;
  x: number;
  y: number;
}
