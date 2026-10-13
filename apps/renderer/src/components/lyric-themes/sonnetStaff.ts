/**
 * 商籁的**五线谱**（照抄 folia `sonnet/sonnetStaffNotation.ts` + `sonnetStaffView.ts`，AGPL-3.0）。
 *
 * 上游是什么：歌词画面里画一条**五线谱**，谱上是 **La Folía** 主题（D 小调、3/4 拍）的 22 个音符；
 * 一根**播放头**每 **8 秒**走完一遍，被"演奏到"的音符会**脉冲**一下，并带符干、短音符带符尾、`C#5` 带升号 ✓。
 *
 * === 数据出处（照实记）===
 * 音符是 **La Folía**（公共领域主题 ✓），上游按 3/4 拍 LilyPond 谱抄写 ✓；
 * **我们沿用同一份旋律数据**（22 音 / 合计 24 拍 ✓）⇒ 在 `CREDITS.md` 里注明"数据来自该主题、由 folia 转录" ✓。
 * 其余（几何、动画、配色用法）都是**照抄做法、我们重写代码** ✓。
 *
 * 本文件是**纯函数层**：只出"数据 + 几何 + 逐帧参数"，不碰 Pixi ✓。
 */

/** 上游支持四个音高（同八度、D 小调音阶上的四个级进音 ✓）。 */
export const SONNET_STAFF_PITCHES = ['C#5', 'D5', 'E5', 'F5'] as const;
export type SonnetStaffPitch = (typeof SONNET_STAFF_PITCHES)[number];

export interface SonnetStaffNote {
  readonly pitch: SonnetStaffPitch;
  /** 五线谱上的纵向位置（数值越大越高 ✓；上游用 5/6/7/8 ✓）。 */
  readonly staffStep: number;
  /** 时值（拍 ✓）。 */
  readonly beats: number;
  readonly accidental?: 'sharp';
}

/**
 * **La Folía** 主题的 22 个音符（数据照抄上游转录 ✓，公共领域 ✓）。
 * 每项写作 `[pitch, staffStep, beats, sharp?]`，展开成对象 ✓（比 22 行对象短、也照样能逐条核 ✓）。
 */
const LA_FOLIA_RAW: readonly (readonly [SonnetStaffPitch, number, number, boolean?])[] = [
  ['D5', 6, 1],
  ['D5', 6, 1.5],
  ['E5', 7, 0.5],
  ['C#5', 5, 1, true],
  ['C#5', 5, 1, true],
  ['C#5', 5, 1, true],
  ['D5', 6, 1],
  ['D5', 6, 1.5],
  ['D5', 6, 0.5],
  ['E5', 7, 1],
  ['E5', 7, 1],
  ['E5', 7, 1],
  ['F5', 8, 1],
  ['F5', 8, 1.5],
  ['F5', 8, 0.5],
  ['E5', 7, 1],
  ['E5', 7, 1],
  ['E5', 7, 1],
  ['D5', 6, 1],
  ['D5', 6, 1.5],
  ['C#5', 5, 0.5, true],
  ['D5', 6, 3],
];

export const LA_FOLIA_STAFF_NOTES: readonly SonnetStaffNote[] = LA_FOLIA_RAW.map(
  ([pitch, staffStep, beats, sharp]) =>
    sharp === true ? { pitch, staffStep, beats, accidental: 'sharp' } : { pitch, staffStep, beats },
);

/** 合计拍数（上游同名常量 ✓；我们直接按数据求和，手算应为 **24** ✓）。 */
export const LA_FOLIA_TOTAL_BEATS = LA_FOLIA_STAFF_NOTES.reduce((total, note) => total + note.beats, 0);

/** 一个循环的秒数（8 秒走完 24 拍 ⇒ 每拍 1/3 秒 ✓）。 */
export const LA_FOLIA_CYCLE_SECONDS = 8;

/** 带"起始拍"的音符（纯函数、确定性 ✓）。 */
export interface SonnetStaffTimedNote extends SonnetStaffNote {
  readonly startBeat: number;
  readonly index: number;
}

export function resolveSonnetStaffTimedNotes(
  notes: readonly SonnetStaffNote[] = LA_FOLIA_STAFF_NOTES,
): readonly SonnetStaffTimedNote[] {
  const timed: SonnetStaffTimedNote[] = [];
  let cursor = 0;
  notes.forEach((note, index) => {
    timed.push({ ...note, startBeat: cursor, index });
    cursor += note.beats;
  });
  return timed;
}

const positiveModulo = (value: number, divisor: number): number =>
  ((value % divisor) + divisor) % divisor;

export interface SonnetStaffGeometryInput {
  readonly baseFontSize: number;
  /** 可用宽度（上游传的是画面宽度 ✓）。 */
  readonly width: number;
}

export interface SonnetStaffGeometry {
  /** `max(300, width × 0.6)` ✓。 */
  readonly staffWidth: number;
  /** `baseFontSize × 0.25` ✓ —— 谱线间距，后面几乎所有量都以它为基准 ✓。 */
  readonly lineSpacing: number;
  /** `lineSpacing × 4` ✓（5 条线 ⇒ 4 个间距 ✓）。 */
  readonly totalHeight: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
  /** `staffWidth × 0.92` ✓。 */
  readonly playableWidth: number;
  /** `playableWidth / 24` ✓（每拍横向宽度 ✓）。 */
  readonly beatWidth: number;
  /** 5 条谱线的 y 坐标 ✓（从 `−halfHeight` 起，步进 `lineSpacing` ✓）。 */
  readonly staffLineY: readonly number[];
  /** 7 条小节线的 x 坐标 ✓（`bar = 1..7` ⇒ `−playableWidth/2 + beatWidth × bar × 3` ✓）。 */
  readonly barLineX: readonly number[];
  /** 左右边饰（谱号位）的三条竖线：`{x, width}` ✓。 */
  readonly edgeBars: readonly { readonly x: number; readonly width: number }[];
}

export function resolveSonnetStaffGeometry(input: SonnetStaffGeometryInput): SonnetStaffGeometry {
  const staffWidth = Math.max(300, input.width * 0.6);
  const lineSpacing = input.baseFontSize * 0.25;
  const totalHeight = lineSpacing * 4;
  const halfWidth = staffWidth / 2;
  const halfHeight = totalHeight / 2;
  const playableWidth = staffWidth * 0.92;
  const beatWidth = playableWidth / LA_FOLIA_TOTAL_BEATS;

  const staffLineY = [0, 1, 2, 3, 4].map((index) => -halfHeight + index * lineSpacing);
  const barLineX = [1, 2, 3, 4, 5, 6, 7].map(
    (bar) => -playableWidth / 2 + beatWidth * bar * 3,
  );
  const edgeBars = [
    { x: -halfWidth + 10, width: 4 },
    { x: halfWidth - 10, width: 2 },
    { x: halfWidth - 4, width: 6 },
  ];

  return {
    staffWidth,
    lineSpacing,
    totalHeight,
    halfWidth,
    halfHeight,
    playableWidth,
    beatWidth,
    staffLineY,
    barLineX,
    edgeBars,
  };
}

export interface SonnetStaffNoteFrame {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly radiusX: number;
  readonly radiusY: number;
  readonly alpha: number;
  readonly isActive: boolean;
  readonly pulse: number;
  /** 符干朝下（`staffStep ≥ 6` ✓）。 */
  readonly stemDown: boolean;
  readonly stemX: number;
  /** 符干末端 y（`y ± lineSpacing × 3.1` ✓）。 */
  readonly stemEndY: number;
  /** 短音符才有符尾（`beats ≤ 0.5` ✓）。 */
  readonly hasFlag: boolean;
  /** 升号的横坐标（`x − radiusX × 2.3` ✓）；无升号时为 `null` ✓。 */
  readonly sharpX: number | null;
}

export interface SonnetStaffFrame {
  readonly cycleElapsed: number;
  readonly beatPosition: number;
  /** 播放头横坐标 ✓。 */
  readonly cursorX: number;
  readonly notes: readonly SonnetStaffNoteFrame[];
}

export interface SonnetStaffFrameInput {
  /** 当前时间（秒 ✓）。 */
  readonly time: number;
  /** 本镜开始时间（秒 ✓）——循环以它为起点 ✓。 */
  readonly shotStartTime: number;
  readonly geometry: SonnetStaffGeometry;
  readonly notes: readonly SonnetStaffTimedNote[];
}

/**
 * 逐帧参数（照抄 `updateAnimation` 的全部公式 ✓）。
 *
 * 关键三条：`cycleElapsed = positiveModulo(time − shotStartTime, 8)` ✓、
 * `beatPosition = (cycleElapsed / 8) × 24` ✓、
 * **`y = halfHeight − staffStep × lineSpacing × 0.5`** ✓（谱线位置由 `staffStep` 决定 ✓）。
 */
export function resolveSonnetStaffFrame(input: SonnetStaffFrameInput): SonnetStaffFrame {
  const { geometry: geo } = input;
  const cycleElapsed = positiveModulo(input.time - input.shotStartTime, LA_FOLIA_CYCLE_SECONDS);
  const beatPosition = (cycleElapsed / LA_FOLIA_CYCLE_SECONDS) * LA_FOLIA_TOTAL_BEATS;
  const cursorX = -geo.playableWidth / 2 + geo.beatWidth * beatPosition;

  const notes = input.notes.map((note) => {
    const isActive = beatPosition >= note.startBeat && beatPosition < note.startBeat + note.beats;
    const pulse = isActive ? (Math.sin(cycleElapsed * Math.PI * 5 + note.index * 0.4) + 1) / 2 : 0;
    const noteScale = 1 + pulse * 0.12;
    const radiusX = geo.lineSpacing * 0.42 * noteScale;
    const radiusY = geo.lineSpacing * 0.29 * noteScale;
    const x = -geo.playableWidth / 2 + geo.beatWidth * (note.startBeat + note.beats * 0.5);
    const y = geo.halfHeight - note.staffStep * geo.lineSpacing * 0.5;
    const alpha = isActive ? 0.78 + pulse * 0.16 : 0.28 + (note.index % 3) * 0.03;
    const stemDown = note.staffStep >= 6;
    const stemX = stemDown ? x - radiusX : x + radiusX;
    const stemEndY = stemDown ? y + geo.lineSpacing * 3.1 : y - geo.lineSpacing * 3.1;
    return {
      index: note.index,
      x,
      y,
      radiusX,
      radiusY,
      alpha,
      isActive,
      pulse,
      stemDown,
      stemX,
      stemEndY,
      hasFlag: note.beats <= 0.5,
      sharpX: note.accidental === 'sharp' ? x - radiusX * 2.3 : null,
    };
  });

  return { cycleElapsed, beatPosition, cursorX, notes };
}
