/**
 * 凝彩「字形运动」整层（**照抄上游 `tempera/temperaEnterStyles.ts` 与 `tempera/temperaMotion.ts` 的数值**）。
 *
 * 上游把它拆成两个文件（入场样式 / 运动求值），这里合成一份、分成两节，理由：
 * ① 两者互相依赖很紧（运动求值每帧都要问入场样式）；② 我们这边只有一个消费点。
 *
 * **纯函数 + 绝对时间**：上游开篇注释强调"每个值都由时钟与逐字常数推出，所以 seek 画出来的帧
 * 与连续播放完全一致"。这一点我们在实现里必须守住 —— 不要引入任何跨帧状态。
 *
 * 仍然**未接线**：等接进 `temperaFrame.ts` 时再替换它那份自写三次 in-out（见 `docs/PLAN.md` 第 122 轮）。
 */

import { clamp01, easeTemperaEnter, easeTemperaInOut, easeTemperaSoftBack } from './temperaEasing';

/* ============================ 第一节：入场样式 ============================ */

/**
 * 七种入场样式（照抄上游 `TEMPERA_ENTER_STYLES`）。
 *
 * 上游的设计意图（注释原意）：这些是**方向变体**，不是各玩各的花样 ——
 * "长途飞入""单轴拉伸"都试过，在确定性排版前读起来像**噱头**。
 * 所以每种样式都只用**布局已经给这一镜定好的距离**（`magnitude`），缩放一律**统一**（`uniform`）。
 * 一个词整体落地、相邻词各自不同，这种差异正是"拼贴不像一次性滑入"的来源。
 */
export const TEMPERA_ENTER_STYLES = [
  'slide',
  'from-left',
  'from-right',
  'from-above',
  'from-below',
  'swing',
  'stamp',
] as const;
export type TemperaEnterStyle = (typeof TEMPERA_ENTER_STYLES)[number];

export interface TemperaEnterInput {
  enterX: number;
  enterY: number;
  enterRotation: number;
  enterScale: number;
}

export interface TemperaEnterFrame {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  /** 没有值得拖尾的位移时为 0（`stamp` 是原地砸下，无处可拖）。 */
  echo: number;
}

/**
 * 方向变体的共用骨架（照抄上游 `directional`）：
 * `magnitude = hypot(enterX, enterY)` —— **距离来自布局、不来自方向**；
 * 方向先**归一化**再乘回去，所以那点斜向只是"改变来向"，不会把距离拉长。
 */
const directional = (
  input: TemperaEnterInput,
  travel: number,
  uniform: number,
  dirX: number,
  dirY: number,
  rotationScale: number,
): TemperaEnterFrame => {
  const magnitude = Math.hypot(input.enterX, input.enterY);
  const length = Math.hypot(dirX, dirY) || 1;
  return {
    x: (dirX / length) * magnitude * travel,
    y: (dirY / length) * magnitude * travel,
    rotation: input.enterRotation * rotationScale * travel,
    scaleX: uniform,
    scaleY: uniform,
    echo: travel,
  };
};

/**
 * 解某一样式在入场某点的位移/旋转/缩放（照抄上游 `resolveTemperaEnterFrame`）。
 *
 * `travel` 在窗口内从 1 走到 0（"还有多远"），`linear` 是**原始** 0→1 进度；
 * 需要自己那条曲线的样式**自己再缓动 `linear`**，而不是复用 `travel`。
 *
 * 收尾统一走 `easeTemperaSoftBack(linear)`（那条 `c = 1.42` 的回弹）：
 * `uniform = enterScale + (1 − enterScale) × settle` —— **回弹体现在"缩放从 enterScale 收到 1"**。
 */
export const resolveTemperaEnterFrame = (
  style: TemperaEnterStyle,
  input: TemperaEnterInput,
  travel: number,
  linear: number,
): TemperaEnterFrame => {
  const settle = easeTemperaSoftBack(linear);
  const uniform = input.enterScale + (1 - input.enterScale) * settle;
  switch (style) {
    case 'from-left':
      return directional(input, travel, uniform, -1, 0.12, 0.4);
    case 'from-right':
      return directional(input, travel, uniform, 1, -0.12, 0.4);
    case 'from-above':
      return directional(input, travel, uniform, 0.12, -1, 0.4);
    case 'from-below':
      return directional(input, travel, uniform, -0.12, 1, 0.4);
    case 'swing':
      // 走这一镜自己的来向，但字**绕自身中心**转进来。
      return {
        x: input.enterX * 0.6 * travel,
        y: input.enterY * 0.6 * travel,
        rotation: (input.enterRotation + Math.sign(input.enterRotation || 1) * 0.95) * travel,
        scaleX: uniform,
        scaleY: uniform,
        echo: travel * 0.8,
      };
    case 'stamp':
      // 唯一的"原地"样式：从过大**砸**到页面上。没有位移，所以也没有拖尾。
      return {
        x: 0,
        y: 0,
        rotation: input.enterRotation * 0.6 * travel,
        scaleX: 1 + travel * 0.7,
        scaleY: 1 + travel * 0.7,
        echo: 0,
      };
    case 'slide':
    default:
      // 这一镜自己的展开向量，直直进来。
      return {
        x: input.enterX * travel,
        y: input.enterY * travel,
        rotation: input.enterRotation * travel,
        scaleX: uniform,
        scaleY: uniform,
        echo: travel,
      };
  }
};

/* ============================ 第二节：运动求值 ============================ */

export interface TemperaGlyphMotionInput {
  startTime: number;
  settleTime: number;
  /** 这个字素唱完的时刻；驱动"当前字"那记小隆起。 */
  endTime: number;
  enterX: number;
  enterY: number;
  enterRotation: number;
  enterScale: number;
  rotation: number;
  enterStyle: TemperaEnterStyle;
  /** 唱完后的"释放"达到满幅的时刻；**被本行时长夹住**（行多久就开多久，不再多）。 */
  releaseTime: number;
  /** 本字形相对色块中心的偏移；释放按它把字距撑开。 */
  trackingX: number;
  trackingY: number;
}

export interface TemperaGlyphMotionFrame {
  visible: boolean;
  alpha: number;
  x: number;
  y: number;
  rotation: number;
  /** **分轴**：有几个入场样式只在一个轴上张开。 */
  scaleX: number;
  scaleY: number;
  /** 第一层运动回响的偏移与不透明度；两者都在 settle 之前消亡。 */
  echoX: number;
  echoY: number;
  echoAlpha: number;
}

/** 当前字的缩放隆起幅度。 */
export const TEMPERA_CURRENT_EMPHASIS = 0.05;
/** 唱完之后隆起消退所需时长。 */
export const TEMPERA_EMPHASIS_DECAY = 0.26;
/** 回响层的不透明度系数。 */
export const TEMPERA_ECHO_ALPHA = 0.5;
/**
 * **透明度与回响**允许覆盖的最长窗口（`1.35` 秒）。
 *
 * 上游注释原意：settle 窗口本身会被**拉伸到整行结束**（让色块到行尾都还在归位），
 * 但"淡入 + 拖尾"不能跟着拉那么长 —— 字必须**在移动过程中就可读**，
 * 而拖太久的回响会**糊成一片**、不像运动。这个上限正是 settle 窗口过去自带的那个上限，
 * 所以任何"本来就短于它"的入场，行为与从前完全一致。
 */
export const TEMPERA_MAX_REVEAL_WINDOW = 1.35;
/** 唱完的色块会变宽多少。**刻意很小**：这是字距（tracking），不是漂移（drift）。 */
export const TEMPERA_RELEASE_TRACKING = 0.055;

/**
 * 解一个字形此刻的运动（照抄上游 `resolveTemperaGlyphMotion`）。
 *
 * 几处**不能想当然**的地方：
 * · 位移/缩放用**被拉长的** settle 窗口；透明度与回响用 **`min(window, 1.35)`** 的短窗口
 *   —— 这是"长句读起来是一整段连续动作、字又一直可读"的关键；
 * · `alpha = inOut(clamp01(reveal × **2.4**))`：**先亮后到位**；
 * · 强调跟着**演唱窗口**走（起 `attack = min(0.12, 演唱时长 × 0.5)`、衰 `0.26` 秒），
 *   `sungWindow <= 0` 时**不脉冲**（否则并进词里的标点会自己弹一下）；
 * · 释放从 `max(endTime, settleTime)` 起算，刚性、由中心向外（`trackingX/Y × spread`），
 *   无漂移无旋转 —— 漂移会与"确定性排版"这件事自相矛盾；
 * · `motion = 0` 时把入场**拉回静止姿态**（`+ (1 − entrance) × (1 − amount)`），**不是**反向。
 */
export const resolveTemperaGlyphMotion = (
  glyph: TemperaGlyphMotionInput,
  time: number,
  motion: number,
): TemperaGlyphMotionFrame => {
  const window = Math.max(glyph.settleTime - glyph.startTime, 0.08);
  const linear = clamp01((time - glyph.startTime) / window);
  const travel = 1 - easeTemperaEnter(linear);
  const entrance = resolveTemperaEnterFrame(glyph.enterStyle, glyph, travel, linear);
  const reveal = clamp01((time - glyph.startTime) / Math.min(window, TEMPERA_MAX_REVEAL_WINDOW));
  const alpha = easeTemperaInOut(clamp01(reveal * 2.4));

  const sungWindow = glyph.endTime - glyph.startTime;
  const attack = Math.min(0.12, sungWindow * 0.5);
  const emphasis =
    sungWindow <= 0
      ? 0
      : easeTemperaInOut(clamp01((time - glyph.startTime) / Math.max(attack, 0.02))) *
        (1 - easeTemperaInOut(clamp01((time - glyph.endTime) / TEMPERA_EMPHASIS_DECAY)));

  const releaseStart = Math.max(glyph.endTime, glyph.settleTime);
  const release = easeTemperaInOut(
    clamp01((time - releaseStart) / Math.max(glyph.releaseTime - releaseStart, 0.001)),
  );
  const spread = release * clamp01(motion) * TEMPERA_RELEASE_TRACKING;
  const driftX = glyph.trackingX * spread;
  const driftY = glyph.trackingY * spread;

  const amount = clamp01(motion);
  const swell = emphasis * TEMPERA_CURRENT_EMPHASIS * amount;
  return {
    visible: time >= glyph.startTime,
    alpha,
    x: entrance.x * motion + driftX,
    y: entrance.y * motion + driftY,
    rotation: glyph.rotation + entrance.rotation * motion,
    scaleX: entrance.scaleX + (1 - entrance.scaleX) * (1 - amount) + swell,
    scaleY: entrance.scaleY + (1 - entrance.scaleY) * (1 - amount) + swell,
    echoX: entrance.x * motion,
    echoY: entrance.y * motion,
    echoAlpha: entrance.echo * (1 - easeTemperaEnter(reveal)) * TEMPERA_ECHO_ALPHA * amount,
  };
};
