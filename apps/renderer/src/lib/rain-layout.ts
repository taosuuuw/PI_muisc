import { hashSeed, mulberry32 } from './cover-palette';

/**
 * 「雨窗」的**纯几何**（播放页玻璃上的那场雨）。
 *
 * 这一版把雨分成两套完全不同的东西：
 * - **附着在玻璃上的水珠**（`beads`）——数量多、几乎不动，画在 canvas 上；其中较大的
 *   一批会进入静态折射图（`lenses`），透过水珠看得到真实页面；
 * - **会滑落的水珠**（`dynamicDrops`）——数量少，每颗有自己的积聚、释放、加速、停顿、
 *   合并和重来节奏；真正的运动由 `rain-simulation.ts` 按时间推进，不靠匀速 CSS 循环。
 *
 * 随机量一次算定：`mulberry32(hashSeed(songId, salt))`，同一首歌每次进来都是同一场雨。
 * 位置用百分比、尺寸用 CSS px；组件再按实际窗口翻译。
 *
 * 这里不 import React、不碰 DOM，可以直接跑单元测试（`rain-layout.test.ts` /
 * `rain-simulation.test.ts`）。
 */

/** 水珠外轮廓参数：canvas 用它画不规则团块，DOM 用它生成椭圆/压扁。 */
export interface RainShape {
  /** 纵向压扁系数，0.7 = 扁、1.35 = 长。 */
  squash: number;
  /** 旋转角（度）。 */
  tiltDeg: number;
  /** 轮廓半径的相对扰动 0~0.14；0 = 接近圆。 */
  wobble: number;
  /** 扰动相位，避免所有水珠同一个方向鼓包。 */
  wobblePhase: number;
  /** DOM 水珠的圆角；只有动态水珠使用，静态 canvas 仍按团块画。 */
  borderRadius?: string;
}

/** 画在 canvas 上的一颗附着水珠。 */
export interface RainBead {
  /** 稳定 id：动态水珠合并掉它时按 id 记账，重绘时据此跳过。 */
  id: number;
  /** 横向位置 0~100（%）。 */
  leftPercent: number;
  /** 纵向位置 0~100（%）。 */
  topPercent: number;
  /** 直径 px。 */
  sizePx: number;
  /** 强度 0~1：越大暗边越实、高光越清楚。 */
  opacity: number;
  shape: RainShape;
  /**
   * 旧布局用来标记“积聚伙伴”的提示位。
   *
   * 碰撞资格现在统一由可见几何决定：所有静态珠（包括大透镜珠）都能被真实接触吸收。
   * 这个字段保留给布局/历史测试读取，不再参与碰撞筛选。
   */
  mergeable: boolean;
}

/** 水痕上挂着的一颗小水珠（位置用水痕的 t 表示，0 = 起点、1 = 末端）。 */
export interface RainChainBead {
  at: number;
  sizePx: number;
  opacity: number;
}

/**
 * 一条**残留水痕**：细、短、略弯，越往下越淡。
 *
 * 和上一版拉开差距的地方：上一版是几十条笔直的亮线，看起来像玻璃划痕；这里每条的
 * 弯曲方向、长度、透明度都不同，而且整体很淡，只是「水曾经走过」的证据，不是雨丝。
 */
export interface RainTrail {
  id: number;
  leftPercent: number;
  topPercent: number;
  /** 长度 px（会乘窗口缩放系数）。 */
  lengthPx: number;
  /** 线宽 px。 */
  widthPx: number;
  /** 线本身的不透明度（0.05~0.18，刻意压得很低）。 */
  opacity: number;
  /** 末端相对起点的横向偏移 px。 */
  curvePx: number;
  /** 沿路径左右摆动的幅度 px，和 curvePx 一起做出不笔直的 S 形。 */
  wavePx: number;
  wavePhase: number;
  beads: readonly RainChainBead[];
}

/** 一个钉点：滑到 `at`（0~1 的行程比例）时停 `seconds` 秒。 */
export interface RainPause {
  at: number;
  seconds: number;
}

/**
 * 动态水珠的一轮生命周期参数。
 *
 * 一颗水珠会按 `cycles` 轮流使用几套参数；每轮都从新的位置、以新的尺寸和节奏再来一次，
 * 所以不会出现「固定几颗按同一个周期循环」的机械感。
 */
export interface RainDynamicCycle {
  startLeftPercent: number;
  startTopPercent: number;
  /** 积聚完成后的直径 px（释放后还会因合并变大）。 */
  baseSizePx: number;
  /** 从很小长到 baseSize 需要多久（秒）。 */
  attachSeconds: number;
  /** 初始已经积聚了多久；让第一帧就有「快挂不住了」的水珠。 */
  initialAttachSeconds: number;
  /** 横向允许范围（百分比），保证滑动水珠不去歌词正中间。 */
  band: readonly [number, number];
  /** 整段行程的横向漂移（百分比）。 */
  driftPercent: number;
  /** 左右摆动幅度（百分比）与波数。 */
  wobblePercent: number;
  wobbleWaves: number;
  wobblePhase: number;
  /** 由快到慢再到快的钉点（至少一个）。 */
  pauses: readonly RainPause[];
  /** 重力加速度 px/s²。 */
  gravity: number;
  /** 空气/玻璃阻力系数，越大越快到达终端速度。 */
  drag: number;
  /** 刚脱离玻璃时的初速度 px/s。 */
  releaseSpeed: number;
  /** 终端速度上限 px/s。 */
  maxSpeed: number;
  /** 身后湿痕的基础长度 px；运行时再按速度和窗口放大到约 180~450。 */
  trailLengthPx: number;
  /** 水珠离开后残留湿痕从清楚到完全消失的秒数（约 5~8 秒）。 */
  trailFadeSeconds: number;
  shape: RainShape;
}

/** 一颗会动的水珠。 */
export interface RainDynamicDrop {
  id: number;
  cycles: readonly RainDynamicCycle[];
  /** 一轮滑完、淡出后隔多久在新位置重新积聚。 */
  respawnSeconds: number;
}

/**
 * 静态大水珠的折射参数。
 *
 * 它们不是另一批水珠，而是 `beads` 里尺寸过线的那一批：canvas 画本体，位移图负责
 * 弯折它们脚下的真实背景，两者用同一个 id/位置，不会错位。
 */
export interface RainLens {
  beadId: number;
  leftPercent: number;
  topPercent: number;
  sizePx: number;
  opacity: number;
  shape: RainShape;
  /** 这颗透镜在滤镜 scale=44 时希望产生的最大像素位移。 */
  targetOffsetPx: number;
}

export interface RainLayout {
  readonly beads: readonly RainBead[];
  readonly trails: readonly RainTrail[];
  readonly dynamicDrops: readonly RainDynamicDrop[];
  readonly lenses: readonly RainLens[];
}

/** 单独的水珠盐：以后别处的 `hashSeed(songId, …)` 换盐也不会把这场的几何带歪。 */
const RAIN_SALT = 0x7a15;

/**
 * 密度。上一版 420 颗细珠全是均匀白点，远看像雪；这一版用「团簇 + 散珠 + 中珠 + 大透镜」
 * 做出湿斑，数量仍够铺满，但团簇之间会留出干的缝隙。
 */
export const RAIN_CLUSTER_COUNT = 30;
export const RAIN_SCATTER_BEAD_COUNT = 180;
export const RAIN_MEDIUM_BEAD_COUNT = 130;
export const RAIN_LARGE_BEAD_COUNT = 40;
export const RAIN_TRAIL_COUNT = 26;
export const RAIN_DYNAMIC_DROP_COUNT = 9;
export const RAIN_DYNAMIC_CYCLES = 3;

/** 光学大珠门槛：过线且不在歌词中心就进静态折射图；是否会被吃由碰撞几何另算。 */
export const RAIN_LENS_MIN_SIZE_PX = 6.5;

/** [min, max) 之间的随机数，保留 `digits` 位小数（避免长串浮点进 DOM）。 */
function between(random: () => number, min: number, max: number, digits = 2): number {
  const value = min + random() * (max - min);
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** 让水珠轮廓不总是正圆：纵向压扁 + 一点不规则扰动。 */
function makeShape(random: () => number, teardrop = false): RainShape {
  return {
    // 泪滴主要靠纵向压扁：上窄下宽、挂在玻璃上被重力轻轻拉长。
    squash: between(random, teardrop ? 0.9 : 0.72, teardrop ? 1.35 : 1.4, 2),
    tiltDeg: between(random, -55, 55, 1),
    wobble: between(random, 0.015, 0.105, 3),
    wobblePhase: between(random, 0, Math.PI * 2, 3),
  };
}

/**
 * 动态水珠的可见轮廓。
 *
 * 比静态泪滴更克制：只做“上略窄、下略宽”的软蛋形，四角仍在 45~55% 附近。
 * 这样它不再是一个标准圆珠，但轮廓不会缩到折射 feImage 框里面太多，避免
 * 「本体边缘和透镜边缘分家」。
 */
function makeDynamicShape(random: () => number): RainShape {
  const shape = makeShape(random, true);
  const horizontal = [
    between(random, 46, 49),
    between(random, 46, 49),
    between(random, 50, 53),
    between(random, 50, 53),
  ];
  const vertical = [
    // 上缘略收、下缘略鼓；仍落在透镜框内，不把 feImage 甩在轮廓外。
    between(random, 43, 47),
    between(random, 43, 47),
    between(random, 52, 56),
    between(random, 52, 56),
  ];
  return {
    ...shape,
    borderRadius: `${horizontal.map((value) => `${Math.round(value)}%`).join(' ')} / ${vertical
      .map((value) => `${Math.round(value)}%`)
      .join(' ')}`,
  };
}

/**
 * 歌词区域的旧大珠禁区。
 *
 * 现在只用于约束动态滑落带，避免大体量滑滴穿过歌词；静态珠允许在中心自然出现，
 * 不再用这个椭圆把中心掏空。
 */
export function isLyricCenter(leftPercent: number, topPercent: number): boolean {
  const dx = (leftPercent - 50) / 24;
  const dy = (topPercent - 50) / 28;
  return dx * dx + dy * dy < 1;
}

/** 把位置限制在窗口内，留一点边缘余量。 */
function clampPercent(value: number, min = 0.5, max = 99.5): number {
  return Math.min(max, Math.max(min, value));
}

/** 按歌曲 id 铺一场固定的雨。 */
export function buildRainLayout(seed: number): RainLayout {
  // `| 0`：歌 id 是递增整数，先收成 32 位有符号再搅，避免溢出成不同的浮点。
  const random = mulberry32(hashSeed(seed | 0, RAIN_SALT));

  const beads: RainBead[] = [];
  const pushBead = (
    sizePx: number,
    opacity: number,
    mergeable: boolean,
    leftPercent: number,
    topPercent: number,
    shape?: RainShape,
  ): void => {
    beads.push({
      id: beads.length,
      leftPercent: clampPercent(leftPercent),
      topPercent: clampPercent(topPercent),
      sizePx,
      opacity,
      shape: shape ?? makeShape(random),
      mergeable,
    });
  };

  /*
   * 1. 团簇：湿玻璃不是均匀撒盐。先选 30 个湿斑中心，在中心附近撒小水珠，珠与珠之间
   *    会重叠成一片；团簇之外再补散珠，保留「干的地方」。
   */
  for (let cluster = 0; cluster < RAIN_CLUSTER_COUNT; cluster += 1) {
    const centerX = between(random, 1, 99);
    const centerY = between(random, 1, 99);
    // 中心不再掏空：全视野都有水，靠 __wet mask 和覆盖率控制可读性。
    const count = 7 + Math.floor(random() * 9);
    const spreadX = between(random, 1.4, 6.2);
    const spreadY = between(random, 1.6, 6.8);
    for (let index = 0; index < count; index += 1) {
      const angle = between(random, 0, Math.PI * 2, 3);
      const radius = Math.sqrt(random());
      const left = centerX + Math.cos(angle) * spreadX * radius;
      const top = centerY + Math.sin(angle) * spreadY * radius;
      const roll = random();
      const size =
        roll < 0.14
          ? between(random, 1.4, 3.2, 1)
          : roll < 0.84
            ? between(random, 6, 14, 1)
            : between(random, 14, 22, 1);
      pushBead(size, between(random, 0.46, 0.9, 2), false, left, top, makeShape(random, true));
    }
  }

  // 2. 散珠：填团簇之间的缝；主体是 6~12px，少量 12~20px。
  for (let index = 0; index < RAIN_SCATTER_BEAD_COUNT; index += 1) {
    const central = random() < 0.34;
    const left = central ? between(random, 28, 72) : between(random, 0.5, 99.5);
    const top = central ? between(random, 24, 76) : between(random, 0.5, 99.5);
    const roll = random();
    const size =
      roll < 0.12
        ? between(random, 1.2, 3, 1)
        : roll < 0.7
          ? between(random, 6, 12, 1)
          : between(random, 12, 20, 1);
    pushBead(size, between(random, 0.42, 0.86, 2), false, left, top, makeShape(random, true));
  }

  // 3. 中等水珠：是「湿玻璃」的主力，6~30px，中心同样允许。
  for (let index = 0; index < RAIN_MEDIUM_BEAD_COUNT; index += 1) {
    const left = between(random, 1, 99);
    const top = between(random, 1, 99);
    const roll = random();
    const size =
      roll < 0.55
        ? between(random, 8, 16, 1)
        : roll < 0.85
          ? between(random, 16, 22, 1)
          : between(random, 22, 30, 1);
    pushBead(
      size,
      between(random, 0.5, 0.9, 2),
      random() < 0.18,
      left,
      top,
      makeShape(random, true),
    );
  }

  /*
   * 4. 静态大珠：全视野分布，中心也有少量自然大珠；不再保留空白椭圆。
   */
  for (let index = 0; index < RAIN_LARGE_BEAD_COUNT; index += 1) {
    const left = between(random, 2, 98);
    const top = between(random, 2, 98);
    pushBead(
      between(random, 22, 38, 1),
      between(random, 0.62, 0.95, 2),
      false,
      left,
      top,
      makeShape(random, true),
    );
  }

  // 5. 动态水珠：3 轮参数，每轮位置/尺寸/节奏都不同；左右两侧起步，路径不穿过歌词中心。
  const dynamicDrops: RainDynamicDrop[] = [];
  for (let index = 0; index < RAIN_DYNAMIC_DROP_COUNT; index += 1) {
    const cycles: RainDynamicCycle[] = [];
    for (let cycleIndex = 0; cycleIndex < RAIN_DYNAMIC_CYCLES; cycleIndex += 1) {
      const leftSide = random() < 0.5;
      const startLeftPercent = leftSide ? between(random, 3, 25) : between(random, 75, 97);
      // 带子止于歌词列外侧（1478px 下约 31%~69% 是歌词）；大透镜/滑动折射不越过它。
      // 26 / 74 是歌词椭圆在 y=50% 处的边界；再往里就会被判定为“中心”。
      const band: readonly [number, number] = leftSide ? [1, 26] : [74, 99];
      const baseSizePx = between(random, 10.5, 24.5, 1);
      const attachSeconds = between(random, 9, 20, 2);
      const pauseCount = 1 + Math.floor(random() * 3);
      const pauses: RainPause[] = [];
      let previousAt = 0.08;
      for (let pause = 0; pause < pauseCount; pause += 1) {
        const at = Math.min(0.9, previousAt + between(random, 0.12, 0.28));
        previousAt = at;
        pauses.push({ at: Math.round(at * 100) / 100, seconds: between(random, 0.28, 1.35, 2) });
      }
      // 重力路径总体竖直：横向漂移和摆动都收小，只留不规则的小偏折。
      const driftMax = Math.min(
        3.2,
        Math.max(1.1, Math.min(startLeftPercent - band[0], band[1] - startLeftPercent)),
      );
      const driftPercent = between(random, -driftMax, driftMax, 2);
      cycles.push({
        startLeftPercent,
        startTopPercent: between(random, 2, 54, 2),
        baseSizePx,
        attachSeconds,
        initialAttachSeconds:
          cycleIndex === 0
            ? between(random, 0.25, 0.94, 3) * attachSeconds
            : between(random, 0, 0.35, 3) * attachSeconds,
        band,
        driftPercent,
        wobblePercent: between(random, 0.08, 0.42, 2),
        wobbleWaves: between(random, 0.9, 2.2, 2),
        wobblePhase: between(random, 0, Math.PI * 2, 3),
        pauses,
        gravity: between(random, 92, 186, 1),
        drag: between(random, 0.22, 0.88, 2),
        releaseSpeed: between(random, 2.2, 10.5, 2),
        maxSpeed: between(random, 96, 174, 1),
        trailLengthPx: between(random, 180, 330, 0),
        trailFadeSeconds: between(random, 5.2, 7.8, 2),
        shape: makeDynamicShape(random),
      });
    }
    dynamicDrops.push({
      id: index,
      cycles,
      respawnSeconds: between(random, 1.6, 4.5, 2),
    });
  }

  /*
   * 6. 每颗动态水珠的「积聚伙伴」：起始点周围放几颗小珠，真实接触时会被吸掉；
   *    再沿第一段路径放两三颗，滑落时会看到「沿途合并、变大、加速」。
   *    mergeable 只是布局提示；碰撞资格和光学选珠已经解耦。
   */
  for (const drop of dynamicDrops) {
    const first = drop.cycles[0];
    if (!first) continue;
    const companionCount = 3;
    for (let index = 0; index < companionCount; index += 1) {
      const angle = between(random, 0, Math.PI * 2, 3);
      const distance = between(random, 1.2, 4.2);
      pushBead(
        between(random, 1.6, 4.6, 1),
        between(random, 0.28, 0.62, 2),
        true,
        first.startLeftPercent + Math.cos(angle) * distance,
        first.startTopPercent + Math.sin(angle) * distance * 0.7,
        makeShape(random),
      );
    }
    for (let index = 0; index < 2; index += 1) {
      const at = between(random, 0.28, 0.72);
      const x =
        first.startLeftPercent +
        first.driftPercent * at +
        first.wobblePercent * Math.sin(at * Math.PI * 2 * first.wobbleWaves + first.wobblePhase);
      const y = first.startTopPercent + at * 42;
      pushBead(
        between(random, 2, 5.5, 1),
        between(random, 0.3, 0.66, 2),
        true,
        x,
        y,
        makeShape(random),
      );
    }
  }

  // 7. 静态残留水痕：短、弯、淡；不是雨丝。
  const trails: RainTrail[] = [];
  for (let index = 0; index < RAIN_TRAIL_COUNT; index += 1) {
    const count = 1 + Math.floor(random() * 3);
    const chain: RainChainBead[] = [];
    for (let step = 0; step < count; step += 1) {
      const at = count === 1 ? between(random, 0.4, 0.92, 2) : 0.16 + (step / (count - 1)) * 0.76;
      chain.push({
        at: Math.round(at * 100) / 100,
        sizePx: between(random, 1.2, 3.6, 1),
        opacity: between(random, 0.25, 0.6, 2),
      });
    }
    trails.push({
      id: index,
      leftPercent: between(random, 1, 99, 2),
      // 起点不贴顶：水痕是「已经流到一半」的样子。
      topPercent: between(random, 3, 78, 2),
      lengthPx: between(random, 24, 132, 1),
      widthPx: between(random, 0.55, 1.65, 2),
      opacity: between(random, 0.055, 0.17, 3),
      curvePx: between(random, -15, 15, 1),
      wavePx: between(random, 1.5, 9, 1),
      wavePhase: between(random, 0, Math.PI * 2, 3),
      beads: chain,
    });
  }

  // 8. 静态透镜 = 过线的大珠；不另抽位置，保证本体重合。
  const lenses: RainLens[] = [];
  for (const bead of beads) {
    // 光学选珠只看尺寸，不看碰撞资格；共享静态场实际覆盖全部珠。
    if (bead.sizePx < RAIN_LENS_MIN_SIZE_PX) continue;
    lenses.push({
      beadId: bead.id,
      leftPercent: bead.leftPercent,
      topPercent: bead.topPercent,
      sizePx: bead.sizePx,
      opacity: bead.opacity,
      shape: bead.shape,
      targetOffsetPx: Math.min(14, Math.max(3, bead.sizePx * 0.4)),
    });
  }

  return { beads, trails, dynamicDrops, lenses };
}

/**
 * 动态水珠的**可见轮廓 = 折射透镜框**。
 *
 * 这是本轮修「水滴外形与透镜尺寸对不上」的关键：之前 DOM 本体用 `2r`、透镜用
 * `min(1.72r, 2r-1)`，滑落时本体还会被拉长，而透镜不跟；两套几何各算各的，肉眼就是
 * 「水珠有一圈边、折射却缩在里面」。
 *
 * 现在两边都从这一个函数拿数：
 * - DOM 元素固定为 `baseDiameter`，再用 `scaleX / scaleY` 缩放；
 * - 透镜 `feImage` 的 `width / height` 直接用 `width / height`；
 * - 所以折射椭圆和可见水珠椭圆逐帧同大小、同压扁。
 *
 * `stretch` 是滑落时的纵向拉长（最多 22%），横向相应收窄 32%。
 */
export interface RainDropMetrics {
  /** 当前可见水珠的横向直径 px。 */
  width: number;
  /** 当前可见水珠的纵向直径 px。 */
  height: number;
  /** DOM 相对 `baseDiameter` 的横向缩放。 */
  scaleX: number;
  /** DOM 相对 `baseDiameter` 的纵向缩放。 */
  scaleY: number;
}

/**
 * 动态透镜半批次预测的前置位移（px）。
 *
 * 背景：动态透镜按 45fps 整批写 `feImage`，本体每 rAF 移动。批次间隔 22.2ms，
 * 最大速度约 174px/s 时，本体一个批次会走约 3.9px；透镜不预测就会最多滞后 3.9px。
 * 把透镜按“半个批次”向前放，滞后/超前各约 1.94px，最大分离减半，且**不增加刷新次数**。
 *
 * 纯函数，测试锁住“速度越快预测越多、但不超过上限；停顿/反向不会预测”。
 */
export function lensLeadPx(
  speedPxPerSec: number,
  batchIntervalMs: number,
  maxLeadPx: number,
): number {
  const speed = Number.isFinite(speedPxPerSec) ? Math.max(0, speedPxPerSec) : 0;
  const interval = Number.isFinite(batchIntervalMs) ? Math.max(0, batchIntervalMs) : 0;
  const maxLead = Number.isFinite(maxLeadPx) ? Math.max(0, maxLeadPx) : 0;
  return Math.min(maxLead, speed * (interval / 2000));
}

export function dynamicDropMetrics(
  baseDiameter: number,
  radius: number,
  speed: number,
  shapeSquash: number,
): RainDropMetrics {
  const base = Number.isFinite(baseDiameter) ? Math.max(0.1, baseDiameter) : 0.1;
  const safeRadius = Number.isFinite(radius) ? Math.max(0.1, radius) : 0.1;
  const safeSpeed = Number.isFinite(speed) ? Math.max(0, speed) : 0;
  const squeeze = Number.isFinite(shapeSquash) ? shapeSquash : 1;
  const grow = (safeRadius * 2) / base;
  const stretch = Math.min(0.22, safeSpeed / 900);
  const squash = Math.min(1.6, Math.max(0.6, squeeze));
  const scaleX = grow * (1 - stretch * 0.32);
  const scaleY = grow * (1 + stretch) * squash;
  return {
    width: base * scaleX,
    height: base * scaleY,
    scaleX,
    scaleY,
  };
}

/**
 * 大屏上水珠跟着放大一点，小窗上收一点，免得 4K 上细成看不见的尘点。
 * canvas / 折射图 / 仿真都用这同一个系数，三者不会在尺寸上分家。
 */
export function rainSizeScale(width: number): number {
  return Math.min(1.3, Math.max(0.85, width / 1440));
}
