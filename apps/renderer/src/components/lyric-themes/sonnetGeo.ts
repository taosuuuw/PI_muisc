/**
 * 商籁（sonnet）重镜头的**几何图形语汇**：`type-impact` / `fragment-collage` 底下那些大图形。
 *
 * 数值照抄 folia 的 `sonnetShotMg.ts`。原版的档位空间是 **100 档**：
 * `0~17` 是基础几何（日芒圆 / 嵌套菱形 / 六边形网格 / 有机分子 / 电子轨道 / 行星环 / 线框山脉 /
 * 雷达 / HUD 框 / 等距方块 / 星座 / 月相 / 几何莲花 / 生命之种 / 四种棱柱体块…），
 * `24~35` 是 12 种**主题图形**（山茶、郁金香田、野花、蕨、银杏、爬藤、温室、宝塔、城市立面、
 * 梯田、山湖、海岸悬崖 —— 在 `sonnetThemedShotMg.ts` 里，`SONNET_THEMED_GEO_VARIANT_START = 24`）。
 *
 * **基础档 0~17 全搬**（日芒圆 / 嵌套菱形 / 六边形网格 / 苯环簇 / 电子轨道 / 带环行星 / 线框山脉 /
 * 雷达 / HUD 装饰框 / 等距立方体 / 星座网络 / 月相 / 几何莲 / 生命之种 /
 * 半透明碑体 / 漂浮三角柱 / 多面六棱柱 / 梯形棱柱），
 * 其余档返回 `null`：调用方会退回我们自拟的那几档，等后续轮次补齐。**这里不假装已经齐了。**
 * （第 3 档的另两个分子子档位、第 18 档往后的"附加档"与 12 种主题图形都还没搬。）
 *
 * 三处照原版保留：
 * 1. 尺度一律取 `radius = min(宽, 高)`，图形以**画面中心**为原点（原版是镜头容器的原点）；
 * 2. **整体旋转**：白名单档位保持正立（`6,8,9,14,15,16,17,20,22,23` 与主题档），
 *    第 8 档按 90° 整数倍转，其余档转 `(seed × 13) % 360` 度；
 * 3. 有机分子的子档位 = `floor(seed / 100) % 3`（与主档位互不干扰）。
 */

import { circlePolygon, rectPolygon, sonnetShape, type SonnetShapeSpec } from './sonnetDecoration';

export interface SonnetGeoViewport {
  readonly width: number;
  readonly height: number;
}

/** 档位空间的总数（照抄 `SONNET_GEO_VARIANT_COUNT`）。 */
export const SONNET_GEO_VARIANT_COUNT = 100;
/** 主题图形从这一档开始（照抄 `SONNET_THEMED_GEO_VARIANT_START`）。 */
export const SONNET_THEMED_GEO_VARIANT_START = 24;
/** 主题图形里**已搬**的档数：**整套十二档都齐了**（花木 24~26 + 植物 27~29 + 建筑 30~32 + 风景 33~35）。 */
export const SONNET_THEMED_PORTED_COUNT = 12;
/** 这些档位**保持正立**（照抄 `sonnetShotMg.ts` 的白名单）。 */
export const SONNET_GEO_UPRIGHT_VARIANTS: readonly number[] = [6, 8, 9, 14, 15, 16, 17, 20, 22, 23];

export const resolveSonnetGeoVariant = (seed: number): number =>
  ((Math.trunc(seed) % SONNET_GEO_VARIANT_COUNT) + SONNET_GEO_VARIANT_COUNT) % SONNET_GEO_VARIANT_COUNT;

/** 子档位：`floor(seed / 100) % count`（照抄 `resolveSonnetGeoSubVariant`）。 */
const sonnetGeoSubVariant = (seed: number, count: number): number => {
  const cycle = Math.floor(Math.trunc(seed) / SONNET_GEO_VARIANT_COUNT);
  return ((cycle % count) + count) % count;
};

export const resolveSonnetMoleculeVariant = (seed: number): number => sonnetGeoSubVariant(seed, 3);
export const resolveSonnetHudRotationQuarterTurns = (seed: number): number => sonnetGeoSubVariant(seed, 4);

/**
 * 整个几何层的旋转量（弧度）。
 *
 * 白名单档位保持正立，其中第 8 档（HUD 框）按 90° 整数倍转；其余档转 `(seed × 13) % 360` 度。
 * 原版把这行写在 `geo.rotation = …` 上，我们把它算成角度交给多边形的绕心旋转。
 */
export function resolveSonnetGeoRotation(variant: number, seed: number): number {
  const upright =
    SONNET_GEO_UPRIGHT_VARIANTS.includes(variant) || variant >= SONNET_THEMED_GEO_VARIANT_START;
  if (!upright) return (((Math.trunc(seed) * 13) % 360) * Math.PI) / 180;
  if (variant === 8) return resolveSonnetHudRotationQuarterTurns(seed) * (Math.PI / 2);
  return 0;
}

/* ------------------------------------------------------------------ *
 * 画法小工具
 * ------------------------------------------------------------------ */

/** 绕点旋转一串顶点（`polygon` 是扁平的 x,y 序列）。 */
function rotatePolygon(
  polygon: readonly number[],
  cx: number,
  cy: number,
  angle: number,
): number[] {
  if (angle === 0) return [...polygon];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const out: number[] = [];
  for (let index = 0; index < polygon.length; index += 2) {
    const x = (polygon[index] ?? 0) - cx;
    const y = (polygon[index + 1] ?? 0) - cy;
    out.push(cx + x * cos - y * sin, cy + x * sin + y * cos);
  }
  return out;
}

/**
 * 正六边形顶点（照抄 folia 的取点法：`x + r·sin(j·π/3)`、`y − r·cos(j·π/3)`，从正上方起）。
 * 最后一点回到起点，所以描边是**闭合**的 —— 原版也是 `moveTo` 之后 `lineTo` 六次回到原点。
 */
function hexagonPolygon(
  cx: number,
  cy: number,
  radius: number,
  rotationOffset = 0,
): number[] {
  const points: number[] = [];
  for (let step = 0; step <= 6; step += 1) {
    const angle = (step * Math.PI) / 3 + rotationOffset;
    points.push(cx + radius * Math.sin(angle), cy - radius * Math.cos(angle));
  }
  return points;
}

/* ------------------------------------------------------------------ *
 * 0~3 档（已搬）
 * ------------------------------------------------------------------ */

/** 第 0 档：**巨大圆框 + 日芒**（两圈同心圆 + 32 根长短相间的射线）。 */
function drawSunburst(
  shapes: SonnetShapeSpec[],
  cx: number,
  cy: number,
  radius: number,
): void {
  shapes.push(
    sonnetShape('geo-ring', circlePolygon(cx, cy, radius * 0.6, 64), {
      strokeTone: 1,
      strokeWidth: 6,
      strokeAlpha: 0.8,
    }),
    sonnetShape('geo-ring-inner', circlePolygon(cx, cy, radius * 0.58, 64), {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.4,
      delay: 0.03,
    }),
  );
  for (let index = 0; index < 32; index += 1) {
    const angle = (index / 32) * Math.PI * 2;
    const inner = radius * (0.3 + (index % 3) * 0.05);
    const outer = radius * 0.55;
    shapes.push(
      sonnetShape(
        `geo-ray-${index}`,
        [
          cx + Math.cos(angle) * inner,
          cy + Math.sin(angle) * inner,
          cx + Math.cos(angle) * outer,
          cy + Math.sin(angle) * outer,
        ],
        {
          strokeTone: 1,
          strokeWidth: 1,
          // 照抄：`0.2 + (i % 2) * 0.1` —— 隔一根亮一档。
          strokeAlpha: 0.2 + (index % 2) * 0.1,
          delay: 0.01 * (index % 6),
        },
      ),
    );
  }
}

/** 第 1 档：**嵌套菱形**（三层菱形 + 十字准线）。 */
function drawNestedDiamonds(
  shapes: SonnetShapeSpec[],
  cx: number,
  cy: number,
  radius: number,
): void {
  const r = radius * 0.7;
  const diamond = (reach: number): number[] => [
    cx,
    cy - reach,
    cx + reach,
    cy,
    cx,
    cy + reach,
    cx - reach,
    cy,
    cx,
    cy - reach,
  ];
  shapes.push(
    sonnetShape('geo-diamond', diamond(r), { strokeTone: 1, strokeWidth: 6, strokeAlpha: 0.8 }),
    sonnetShape('geo-diamond-inner', diamond(r * 0.96), {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.4,
      delay: 0.03,
    }),
    sonnetShape('geo-diamond-core', diamond(r * 0.4), {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.6,
      delay: 0.06,
    }),
    sonnetShape('geo-cross-h', [cx - r, cy, cx + r, cy], {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.3,
      delay: 0.09,
    }),
    sonnetShape('geo-cross-v', [cx, cy - r, cx, cy + r], {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.3,
      delay: 0.09,
    }),
  );
}

/** 第 2 档：**工艺六边形网格**（三层同心六边形 + 六根辐条）。 */
function drawHexagonGrid(
  shapes: SonnetShapeSpec[],
  cx: number,
  cy: number,
  radius: number,
): void {
  shapes.push(
    sonnetShape('geo-hex', hexagonPolygon(cx, cy, radius * 0.6), {
      strokeTone: 1,
      strokeWidth: 6,
      strokeAlpha: 0.8,
    }),
    sonnetShape('geo-hex-inner', hexagonPolygon(cx, cy, radius * 0.57), {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.4,
      delay: 0.03,
    }),
    sonnetShape('geo-hex-core', hexagonPolygon(cx, cy, radius * 0.25), {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.5,
      delay: 0.06,
    }),
  );
  for (let index = 0; index < 6; index += 1) {
    // 照抄：辐条指向**顶点**（`j·π/3 − π/6`），从内核 0.25r 连到 0.57r。
    const angle = (index * Math.PI) / 3 - Math.PI / 6;
    shapes.push(
      sonnetShape(
        `geo-spoke-${index}`,
        [
          cx + Math.cos(angle) * radius * 0.25,
          cy + Math.sin(angle) * radius * 0.25,
          cx + Math.cos(angle) * radius * 0.57,
          cy + Math.sin(angle) * radius * 0.57,
        ],
        { strokeTone: 1, strokeWidth: 2, strokeAlpha: 0.4, delay: 0.03 * index },
      ),
    );
  }
}

/** 一个苯环（外圈六边形 + 隔一边的双键短线）。 */
function benzeneShapes(
  idPrefix: string,
  cx: number,
  cy: number,
  radius: number,
  rotationOffset: number,
): SonnetShapeSpec[] {
  const shapes: SonnetShapeSpec[] = [
    sonnetShape(idPrefix, hexagonPolygon(cx, cy, radius, rotationOffset), {
      strokeTone: 1,
      strokeWidth: 3,
      strokeAlpha: 0.8,
    }),
  ];
  for (let index = 0; index < 6; index += 2) {
    const inner = radius * 0.82;
    shapes.push(
      sonnetShape(
        `${idPrefix}-bond-${index / 2}`,
        [
          cx + inner * Math.sin((index * Math.PI) / 3 + rotationOffset),
          cy - inner * Math.cos((index * Math.PI) / 3 + rotationOffset),
          cx + inner * Math.sin(((index + 1) * Math.PI) / 3 + rotationOffset),
          cy - inner * Math.cos(((index + 1) * Math.PI) / 3 + rotationOffset),
        ],
        { strokeTone: 1, strokeWidth: 2, strokeAlpha: 0.5, delay: 0.02 * (index / 2) },
      ),
    );
  }
  return shapes;
}

/** 第 3 档（子档 0）：**苯环簇** —— 三个稠合苯环 + 一条结构线。 */
function drawBenzeneCluster(
  shapes: SonnetShapeSpec[],
  cx: number,
  cy: number,
  radius: number,
): void {
  const hexRadius = radius * 0.22;
  const ring = hexRadius * 1.2;
  shapes.push(...benzeneShapes('geo-benzene-0', cx, cy, ring, 0));
  // 右侧稠合环 / 左上稠合环：位移照抄（`sin(π/3)·rMain·2` 与 30°/60° 方向）。
  const fused = Math.sin(Math.PI / 3) * ring * 2;
  shapes.push(...benzeneShapes('geo-benzene-1', cx + fused, cy, ring, 0));
  shapes.push(
    ...benzeneShapes(
      'geo-benzene-2',
      cx - Math.sin(Math.PI / 6) * fused,
      cy - Math.cos(Math.PI / 6) * fused,
      ring,
      0,
    ),
  );
  shapes.push(
    sonnetShape(
      'geo-benzene-stem',
      [cx, cy + ring, cx, cy + ring + radius * 0.2, cx + radius * 0.15, cy + ring + radius * 0.35],
      { strokeTone: 1, strokeWidth: 2, strokeAlpha: 0.6, delay: 0.08 },
    ),
  );
}

/** 椭圆（可绕心旋转）：末点回到起点，闭合描边。 */
function ellipsePolygon(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotation: number,
  segments: number,
): number[] {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const points: number[] = [];
  for (let step = 0; step <= segments; step += 1) {
    const t = (step * Math.PI * 2) / segments;
    const ex = Math.cos(t) * rx;
    const ey = Math.sin(t) * ry;
    points.push(cx + ex * cos - ey * sin, cy + ex * sin + ey * cos);
  }
  return points;
}

/** 二次贝塞尔折线（原版用 `quadraticCurveTo`，我们采样成折线）。 */
function quadraticPolyline(
  x0: number,
  y0: number,
  cxp: number,
  cyp: number,
  x1: number,
  y1: number,
  samples: number,
  cx: number,
  cy: number,
): number[] {
  const points: number[] = [];
  for (let step = 0; step <= samples; step += 1) {
    const t = step / samples;
    const inv = 1 - t;
    points.push(
      cx + inv * inv * (x0 - cx) + 2 * inv * t * (cxp - cx) + t * t * (x1 - cx),
      cy + inv * inv * (y0 - cy) + 2 * inv * t * (cyp - cy) + t * t * (y1 - cy),
    );
  }
  return points;
}

/** 第 4 档：**原子电子轨道**（三个交叠椭圆 + 一个很小的核）。 */
function drawElectronOrbitals(
  shapes: SonnetShapeSpec[],
  cx: number,
  cy: number,
  radius: number,
): void {
  const ellR = radius * 0.7;
  for (let index = 0; index < 3; index += 1) {
    // 照抄：把半径 `0.7r` 的圆压扁成 `0.18` 倍高，再整体转 `i·π/3`。
    shapes.push(
      sonnetShape(
        `geo-orbital-${index}`,
        ellipsePolygon(cx, cy, ellR, ellR * 0.18, (index * Math.PI) / 3, 60),
        { strokeTone: 1, strokeWidth: 1, strokeAlpha: 0.3, delay: 0.04 * index },
      ),
    );
  }
  shapes.push(
    sonnetShape('geo-nucleus', circlePolygon(cx, cy, radius * 0.05, 24), {
      fillTone: 1,
      fillAlpha: 0.8,
      strokeTone: -1,
      delay: 0.1,
    }),
  );
}

/** 第 5 档：**带环行星与轨道**（星球 + 两道纹路 + 三个倾斜环 + 远处轨道与卫星）。 */
function drawRingedPlanet(
  shapes: SonnetShapeSpec[],
  cx: number,
  cy: number,
  radius: number,
): void {
  const planetR = radius * 0.25;
  shapes.push(
    sonnetShape('geo-planet', circlePolygon(cx, cy, planetR, 64), {
      fillTone: 1,
      fillAlpha: 0.15,
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.8,
    }),
    sonnetShape(
      'geo-planet-band-1',
      quadraticPolyline(-planetR * 0.7, -planetR * 0.5, 0, -planetR * 0.2, planetR * 0.7, -planetR * 0.5, 18, cx, cy),
      { strokeTone: 1, strokeWidth: 1, strokeAlpha: 0.4, delay: 0.04 },
    ),
    sonnetShape(
      'geo-planet-band-2',
      quadraticPolyline(-planetR * 0.9, 0, 0, planetR * 0.3, planetR * 0.9, 0, 18, cx, cy),
      { strokeTone: 1, strokeWidth: 1, strokeAlpha: 0.4, delay: 0.06 },
    ),
  );
  const ringRx = radius * 0.6;
  const ringRy = radius * 0.15;
  const tilt = Math.PI / 6;
  const rings: readonly (readonly [number, number, number, number])[] = [
    [ringRx, ringRy, 4, 0.5],
    [ringRx * 1.1, ringRy * 1.15, 1, 0.3],
    [ringRx * 1.25, ringRy * 1.3, 2, 0.2],
  ];
  rings.forEach(([rx, ry, width, alpha], index) => {
    shapes.push(
      sonnetShape(`geo-ring-${index}`, ellipsePolygon(cx, cy, rx, ry, tilt, 60), {
        strokeTone: 1,
        strokeWidth: width,
        strokeAlpha: alpha,
        delay: 0.03 * index,
      }),
    );
  });
  shapes.push(
    sonnetShape('geo-orbit', circlePolygon(cx, cy, radius * 0.7, 72), {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.2,
      delay: 0.1,
    }),
    sonnetShape(
      'geo-moon',
      circlePolygon(
        cx + Math.cos(Math.PI / 4) * radius * 0.7,
        cy + Math.sin(Math.PI / 4) * radius * 0.7,
        8,
        20,
      ),
      { fillTone: 1, fillAlpha: 0.6, strokeTone: -1, delay: 0.12 },
    ),
  );
}

/** 第 7 档：**雷达 / 同心靶**（六圈靶环 + 十字准线 + 45° 扫掠扇 + 72 根刻度 + 锁定框）。 */
function drawRadar(
  shapes: SonnetShapeSpec[],
  cx: number,
  cy: number,
  radius: number,
  seed: number,
): void {
  for (let index = 1; index <= 6; index += 1) {
    shapes.push(
      sonnetShape(`geo-radar-ring-${index}`, circlePolygon(cx, cy, radius * 0.15 * index, 64), {
        strokeTone: 1,
        strokeWidth: index % 2 === 0 ? 2 : 1,
        // 照抄：`0.2 + (i % 3) * 0.1`。
        strokeAlpha: 0.2 + (index % 3) * 0.1,
        delay: 0.02 * index,
      }),
    );
  }
  shapes.push(
    sonnetShape('geo-radar-cross-h', [cx - radius * 0.9, cy, cx + radius * 0.9, cy], {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.4,
      delay: 0.05,
    }),
    sonnetShape('geo-radar-cross-v', [cx, cy - radius * 0.9, cx, cy + radius * 0.9], {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.4,
      delay: 0.05,
    }),
  );
  // 扫掠扇：从圆心到 0.75r、张开 45°（照抄 `arc(0, 0, 0.75r, 0, π/4)` 再回到圆心）。
  const sweep: number[] = [cx, cy];
  const sweepSteps = 12;
  for (let step = 0; step <= sweepSteps; step += 1) {
    const angle = (step / sweepSteps) * (Math.PI / 4);
    sweep.push(cx + Math.cos(angle) * radius * 0.75, cy + Math.sin(angle) * radius * 0.75);
  }
  sweep.push(cx, cy);
  shapes.push(
    sonnetShape('geo-radar-sweep', sweep, {
      fillTone: 1,
      fillAlpha: 0.1,
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.5,
      delay: 0.06,
    }),
  );
  const rOuter = radius * 0.8;
  for (let index = 0; index < 72; index += 1) {
    const angle = (index / 72) * Math.PI * 2;
    // 刻度长度是**绝对像素**（原版写死 20 / 10 / 5），不随半径缩放。
    const length = index % 18 === 0 ? 20 : index % 6 === 0 ? 10 : 5;
    shapes.push(
      sonnetShape(
        `geo-radar-tick-${index}`,
        [
          cx + Math.cos(angle) * rOuter,
          cy + Math.sin(angle) * rOuter,
          cx + Math.cos(angle) * (rOuter + length),
          cy + Math.sin(angle) * (rOuter + length),
        ],
        { strokeTone: 1, strokeWidth: 1, strokeAlpha: 0.4 },
      ),
    );
  }
  const lockAngle = ((Math.trunc(seed) % 360) * Math.PI) / 180;
  const lockR = radius * 0.45;
  const lx = cx + Math.cos(lockAngle) * lockR;
  const ly = cy + Math.sin(lockAngle) * lockR;
  shapes.push(
    sonnetShape('geo-radar-lock', [lx - 15, ly - 15, lx + 15, ly - 15, lx + 15, ly + 15, lx - 15, ly + 15, lx - 15, ly - 15], {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.8,
      delay: 0.08,
    }),
    sonnetShape('geo-radar-lock-v', [lx, ly - 20, lx, ly + 20], {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.6,
      delay: 0.09,
    }),
    sonnetShape('geo-radar-lock-h', [lx - 20, ly, lx + 20, ly], {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.6,
      delay: 0.09,
    }),
  );
}

/**
 * 出血范围（照抄 `sonnetShotMgViewport.ts` 的 `resolveSonnetShotMgBleed`）：
 * `{ x: max(r × 0.92, 宽 × 0.64), y: max(r × 0.92, 高 × 0.64) }` ——
 * 开放的背景线条要画到视口之外，才不会被边角切断。
 */
export function resolveSonnetGeoBleed(
  width: number,
  height: number,
  radius: number,
): { x: number; y: number } {
  return {
    x: Math.max(radius * 0.92, width * 0.64),
    y: Math.max(radius * 0.92, height * 0.64),
  };
}

/** 第 6 档：**线框山脉**（赛博网格地景：日月、三层山脊、基线、地面网格、透视汇聚线）。 */
function drawWireframeMountains(
  shapes: SonnetShapeSpec[],
  cx: number,
  cy: number,
  radius: number,
  width: number,
  height: number,
  seed: number,
): void {
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  const w = bleed.x * 1.08;
  const h = radius * 0.8;
  const baseY = radius * 0.2;
  // 背景里的日/月，加五条横纹。
  shapes.push(
    sonnetShape('geo-mountain-sun', circlePolygon(cx, cy + baseY - h * 0.6, radius * 0.3, 64), {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.4,
    }),
  );
  for (let index = 0; index < 5; index += 1) {
    const y = cy + baseY - h * 0.6 + index * 15;
    shapes.push(
      sonnetShape(`geo-mountain-sun-rule-${index}`, [cx - bleed.x, y, cx + bleed.x, y], {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.3,
        delay: 0.02 * index,
      }),
    );
  }
  // 三层山脊：每层七个峰，峰高由种子决定（照抄 `0.3 + 0.7·|sin(seed + 层×11 + 峰×7)|`）。
  const peaks = 7;
  for (let layer = 0; layer < 3; layer += 1) {
    const layerW = w * (1 + layer * 0.2);
    const layerH = h * (0.5 + layer * 0.25);
    const ridge: number[] = [cx - layerW / 2, cy + baseY];
    for (let index = 1; index < peaks; index += 1) {
      const px = -layerW / 2 + (layerW / peaks) * index;
      const py = baseY - layerH * (0.3 + 0.7 * Math.abs(Math.sin(seed + layer * 11 + index * 7)));
      ridge.push(cx + px, cy + py);
    }
    ridge.push(cx + layerW / 2, cy + baseY);
    shapes.push(
      sonnetShape(`geo-mountain-ridge-${layer}`, ridge, {
        strokeTone: 1,
        strokeWidth: 3 - layer,
        strokeAlpha: 0.6 - layer * 0.15,
        delay: 0.05 * layer,
      }),
    );
  }
  // 基线。
  shapes.push(
    sonnetShape('geo-mountain-base', [cx - w, cy + baseY, cx + w, cy + baseY], {
      strokeTone: 1,
      strokeWidth: 4,
      strokeAlpha: 0.8,
      delay: 0.12,
    }),
  );
  // 地面网格：越往下越稀（`i^1.5 × 12`）。
  for (let index = 0; index < 5; index += 1) {
    const gridY = cy + baseY + Math.pow(index, 1.5) * 12;
    shapes.push(
      sonnetShape(`geo-mountain-floor-${index}`, [cx - w, gridY, cx + w, gridY], {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.4 - index * 0.08,
        delay: 0.02 * index,
      }),
    );
  }
  // 透视汇聚线：从基线散开、延伸到画面下缘之外。
  for (let index = -4; index <= 4; index += 1) {
    shapes.push(
      sonnetShape(
        `geo-mountain-perspective-${index + 4}`,
        [
          cx + index * radius * 0.2,
          cy + baseY,
          cx + index * bleed.x * 0.32,
          cy + bleed.y,
        ],
        { strokeTone: 1, strokeWidth: 1, strokeAlpha: 0.3 },
      ),
    );
  }
}

/** 第 8 档：**技术感 HUD 装饰框**（四角括线 + 上下刻度尺 + 中心准星 + 三块数据块）。 */
function drawHudFrame(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number): void {
  const fw = radius * 0.85;
  const fh = radius * 0.65;
  const bracket = radius * 0.15;
  const corners: readonly (readonly [number, number])[] = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  corners.forEach(([sx, sy], index) => {
    const bx = cx + (sx ?? 0) * fw;
    const by = cy + (sy ?? 0) * fh;
    const dx = (sx ?? 0) * bracket;
    const dy = (sy ?? 0) * bracket;
    // 外层粗 L 角（3px / 0.7）。
    shapes.push(
      sonnetShape(
        `geo-hud-bracket-${index}`,
        [bx - dx, by, bx, by, bx, by - dy],
        { strokeTone: 1, strokeWidth: 3, strokeAlpha: 0.7, delay: 0.03 * index },
      ),
    );
    // 内层细角（1px / 0.4），往画面内侧缩 8px（照抄写死的 8）。
    shapes.push(
      sonnetShape(
        `geo-hud-bracket-inner-${index}`,
        [
          bx - dx * 0.8,
          by - (sy ?? 0) * 8,
          bx - (sx ?? 0) * 8,
          by - (sy ?? 0) * 8,
          bx - (sx ?? 0) * 8,
          by - dy * 0.8,
        ],
        { strokeTone: 1, strokeWidth: 1, strokeAlpha: 0.4, delay: 0.03 * index },
      ),
    );
  });
  // 刻度尺：每 20px 一根，60 的倍数那根长一点（12 / 6，照抄）。
  for (let offset = -fw + 20; offset < fw - 20; offset += 20) {
    const x = cx + offset;
    const length = offset % 60 === 0 ? 12 : 6;
    shapes.push(
      sonnetShape(`geo-hud-tick-top-${offset}`, [x, cy - fh, x, cy - fh - length], {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.5,
      }),
      sonnetShape(`geo-hud-tick-bottom-${offset}`, [x, cy + fh, x, cy + fh + length], {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.5,
      }),
    );
  }
  // 中心准星。
  shapes.push(
    sonnetShape('geo-hud-reticle', circlePolygon(cx, cy, radius * 0.1, 48), {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.4,
      delay: 0.1,
    }),
    sonnetShape('geo-hud-reticle-h', [cx - radius * 0.15, cy, cx + radius * 0.15, cy], {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.4,
      delay: 0.1,
    }),
    sonnetShape('geo-hud-reticle-v', [cx, cy - radius * 0.15, cx, cy + radius * 0.15], {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.4,
      delay: 0.1,
    }),
  );
  // 三块数据块（两竖一横，位置照抄写死的像素）。
  shapes.push(
    sonnetShape('geo-hud-block-1', rectPolygon(cx - fw, cy - fh + 20, 10, 40), {
      fillTone: 1,
      fillAlpha: 0.5,
      strokeTone: -1,
      delay: 0.12,
    }),
    sonnetShape('geo-hud-block-2', rectPolygon(cx - fw, cy - fh + 65, 10, 15), {
      fillTone: 1,
      fillAlpha: 0.3,
      strokeTone: -1,
      delay: 0.14,
    }),
    sonnetShape('geo-hud-block-3', rectPolygon(cx + fw - 10, cy + fh - 60, 10, 40), {
      fillTone: 1,
      fillAlpha: 0.5,
      strokeTone: -1,
      delay: 0.16,
    }),
  );
}

/** 第 9 档：**等距立方体**（四个方块，每个三面各自的填充深浅不同，另加两条连线）。 */
function drawIsometricCubes(
  shapes: SonnetShapeSpec[],
  cx: number,
  cy: number,
  radius: number,
): void {
  const cubes: readonly (readonly [number, number, number, number])[] = [
    [0, 0, radius * 0.35, 0.8],
    [radius * 0.4, -radius * 0.15, radius * 0.2, 0.5],
    [-radius * 0.45, radius * 0.25, radius * 0.25, 0.6],
    [0, radius * 0.45, radius * 0.15, 0.4],
  ];
  cubes.forEach(([ox, oy, size, alpha], index) => {
    const x = cx + ox;
    const y = cy + oy;
    const dy = size * 0.5;
    const dx = size * 0.866;
    // 顶面（最淡）/ 右面（最深）/ 左面（最浅）—— 照抄 `alpha × 0.15 / 0.3 / 0.05`。
    const faces: readonly (readonly [number[], number])[] = [
      [[x, y - size, x + dx, y - dy, x, y, x - dx, y - dy, x, y - size], alpha * 0.15],
      [[x, y, x + dx, y - dy, x + dx, y + size - dy, x, y + size, x, y], alpha * 0.3],
      [[x, y, x - dx, y - dy, x - dx, y + size - dy, x, y + size, x, y], alpha * 0.05],
    ];
    faces.forEach(([polygon, fillAlpha], face) => {
      shapes.push(
        sonnetShape(`geo-cube-${index}-${face}`, polygon, {
          fillTone: 1,
          fillAlpha,
          strokeTone: 1,
          strokeWidth: 2,
          strokeAlpha: alpha * 0.8,
          delay: 0.04 * index,
        }),
      );
    });
  });
  shapes.push(
    sonnetShape('geo-cube-link-1', [cx, cy, cx + radius * 0.4, cy - radius * 0.15], {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.3,
      delay: 0.08,
    }),
    sonnetShape('geo-cube-link-2', [cx, cy, cx - radius * 0.45, cy + radius * 0.25], {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.3,
      delay: 0.08,
    }),
  );
}

/** 第 10 档：**星座网络**（18 个节点 + 近邻连线，节点与角度都由种子决定）。 */
function drawConstellationNetwork(
  shapes: SonnetShapeSpec[],
  cx: number,
  cy: number,
  radius: number,
  seed: number,
): void {
  shapes.push(
    sonnetShape('geo-constellation-ring', circlePolygon(cx, cy, radius * 0.75, 72), {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.2,
    }),
    sonnetShape('geo-constellation-ring-inner', circlePolygon(cx, cy, radius * 0.73, 72), {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.1,
      delay: 0.03,
    }),
  );
  const nodes: { x: number; y: number }[] = [];
  for (let index = 0; index < 18; index += 1) {
    // 照抄：半径 `0.1 + ((seed×17 + i×23) % 65)/100`、角度 `(seed×11 + i×37) % 360`。
    const nodeRadius = radius * (0.1 + ((seed * 17 + index * 23) % 65) / 100);
    const angle = (((seed * 11 + index * 37) % 360) * Math.PI) / 180;
    nodes.push({ x: cx + Math.cos(angle) * nodeRadius, y: cy + Math.sin(angle) * nodeRadius });
  }
  const reach = radius * 0.45;
  nodes.forEach((node, index) => {
    shapes.push(
      sonnetShape(`geo-constellation-node-${index}`, circlePolygon(node.x, node.y, 3, 16), {
        fillTone: 1,
        fillAlpha: 0.7,
        strokeTone: -1,
        delay: 0.02 * index,
      }),
      sonnetShape(`geo-constellation-halo-${index}`, circlePolygon(node.x, node.y, 6, 20), {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.3,
        delay: 0.02 * index,
      }),
    );
    for (let other = index + 1; other < nodes.length; other += 1) {
      const partner = nodes[other];
      if (partner === undefined) continue;
      const distance = Math.hypot(node.x - partner.x, node.y - partner.y);
      if (distance >= reach) continue;
      // 越近越亮（照抄 `0.4 × (1 − 距离 / 0.45r)`）。
      shapes.push(
        sonnetShape(
          `geo-constellation-link-${index}-${other}`,
          [node.x, node.y, partner.x, partner.y],
          { strokeTone: 1, strokeWidth: 1, strokeAlpha: 0.4 * (1 - distance / reach) },
        ),
      );
    }
  });
}

/** 会画几何的**重镜头**种类（照抄 folia 的调用点：只有这两族进几何分支）。 */
export const SONNET_HEAVY_SHOT_KINDS = ['type-impact', 'fragment-collage'] as const;

export function isSonnetHeavyShotKind(kind: string): boolean {
  return (SONNET_HEAVY_SHOT_KINDS as readonly string[]).includes(kind);
}

/** 按角度采样圆弧（屏幕坐标 y 向下；`counterclockwise` 与 Pixi 的 `arc()` 同一个语义）。 */
function arcPolyline(
  cx: number,
  cy: number,
  radius: number,
  from: number,
  to: number,
  samples: number,
  counterclockwise: boolean,
): number[] {
  const swept = counterclockwise ? from - (to + Math.PI * 2) : to - from;
  const points: number[] = [];
  for (let step = 0; step <= samples; step += 1) {
    const angle = from + (swept * step) / samples;
    points.push(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
  }
  return points;
}

/** 三次贝塞尔折线。 */
function cubicPolyline(
  points: readonly number[],
  samples: number,
  cx: number,
  cy: number,
): number[] {
  const [x0 = 0, y0 = 0, c1x = 0, c1y = 0, c2x = 0, c2y = 0, x1 = 0, y1 = 0] = points;
  const out: number[] = [];
  for (let step = 0; step <= samples; step += 1) {
    const t = step / samples;
    const inv = 1 - t;
    out.push(
      cx + inv ** 3 * (x0 - cx) + 3 * inv * inv * t * (c1x - cx) + 3 * inv * t * t * (c2x - cx) + t ** 3 * (x1 - cx),
      cy + inv ** 3 * (y0 - cy) + 3 * inv * inv * t * (c1y - cy) + 3 * inv * t * t * (c2y - cy) + t ** 3 * (y1 - cy),
    );
  }
  return out;
}

/** 第 11 档：**月亮与月相**（月牙 + 满月线框 + 月相轨道 + 八个月相小图 + 三颗几何星）。 */
function drawLunarPhases(
  shapes: SonnetShapeSpec[],
  cx: number,
  cy: number,
  radius: number,
): void {
  const moonR = radius * 0.4;
  // 月牙：右半圆 + 一条向左凸的二次曲线闭合（照抄 `arc(-π/2→π/2)` + `quadraticCurveTo(-0.4moonR, 0, 起点)`）。
  const crescent = arcPolyline(cx, cy, moonR, -Math.PI / 2, Math.PI / 2, 32, false);
  const inner = quadraticPolyline(
    0,
    moonR,
    -moonR * 0.4,
    0,
    0,
    -moonR,
    20,
    cx,
    cy,
  );
  shapes.push(
    sonnetShape('geo-moon-crescent', [...crescent, ...inner], {
      fillTone: 1,
      fillAlpha: 0.8,
      strokeTone: -1,
    }),
    sonnetShape('geo-moon-full', circlePolygon(cx, cy, moonR, 64), {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.3,
      delay: 0.03,
    }),
  );
  const orbitR = radius * 0.65;
  shapes.push(
    sonnetShape('geo-moon-orbit', circlePolygon(cx, cy, orbitR, 72), {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.2,
      delay: 0.05,
    }),
  );
  // 八个月相：0 号是新月（只留外圈）、4 号是满月（实心）、其余是半个月牙（`i > 4` 换另一侧）。
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2 - Math.PI / 2;
    const mx = cx + Math.cos(angle) * orbitR;
    const my = cy + Math.sin(angle) * orbitR;
    shapes.push(
      sonnetShape(`geo-moon-phase-${index}-ring`, circlePolygon(mx, my, 8, 24), {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.5,
        delay: 0.02 * index,
      }),
    );
    if (index === 0) continue;
    if (index === 4) {
      shapes.push(
        sonnetShape(`geo-moon-phase-${index}-full`, circlePolygon(mx, my, 6, 24), {
          fillTone: 1,
          fillAlpha: 0.8,
          strokeTone: -1,
          delay: 0.02 * index,
        }),
      );
      continue;
    }
    shapes.push(
      sonnetShape(
        `geo-moon-phase-${index}-half`,
        [mx, my - 6, ...arcPolyline(mx, my, 6, -Math.PI / 2, Math.PI / 2, 20, index > 4), mx, my - 6],
        { fillTone: 1, fillAlpha: 0.5, strokeTone: -1, delay: 0.02 * index },
      ),
    );
  }
  // 三颗几何星（照抄那八点写法：四个尖 + 四个内凹点）。
  const stars: readonly (readonly [number, number, number])[] = [
    [-0.4, -0.5, 12],
    [0.5, -0.3, 8],
    [-0.2, 0.5, 15],
  ];
  stars.forEach(([fx, fy, sr], index) => {
    const sx = cx + fx * radius;
    const sy = cy + fy * radius;
    shapes.push(
      sonnetShape(
        `geo-moon-star-${index}`,
        [
          sx, sy - sr,
          sx + sr * 0.2, sy - sr * 0.2,
          sx + sr, sy,
          sx + sr * 0.2, sy + sr * 0.2,
          sx, sy + sr,
          sx - sr * 0.2, sy + sr * 0.2,
          sx - sr, sy,
          sx - sr * 0.2, sy - sr * 0.2,
        ],
        { fillTone: 1, fillAlpha: 0.7, strokeTone: -1, delay: 0.02 * index },
      ),
    );
  });
}

/** 一个花瓣：从圆心出发的两条二次曲线（照抄 `drawPetal`）。 */
function petalPolygon(
  cx: number,
  cy: number,
  angle: number,
  length: number,
  width: number,
): number[] {
  const endX = Math.cos(angle) * length;
  const endY = Math.sin(angle) * length;
  const control = length * 0.5;
  const leftAngle = angle - width;
  const rightAngle = angle + width;
  const first = quadraticPolyline(
    0,
    0,
    Math.cos(leftAngle) * control,
    Math.sin(leftAngle) * control,
    endX,
    endY,
    16,
    cx,
    cy,
  );
  const second = quadraticPolyline(
    endX,
    endY,
    Math.cos(rightAngle) * control,
    Math.sin(rightAngle) * control,
    0,
    0,
    16,
    cx,
    cy,
  );
  return [...first, ...second];
}

/** 第 12 档：**几何莲**（四层花瓣 8/12/16/20 + 花心 + 三条缠绕藤蔓）。 */
function drawLotus(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number): void {
  const petalLen = radius * 0.5;
  for (let layer = 0; layer < 4; layer += 1) {
    const petals = 8 + layer * 4;
    const length = petalLen * (1 - layer * 0.2);
    const width = 0.3 - layer * 0.05;
    const offset = layer * (Math.PI / petals);
    const alpha = 0.8 - layer * 0.15;
    for (let index = 0; index < petals; index += 1) {
      const angle = (index / petals) * Math.PI * 2 + offset;
      shapes.push(
        sonnetShape(`geo-lotus-p${layer}-${index}`, petalPolygon(cx, cy, angle, length, width), {
          fillTone: alpha > 0.5 ? 1 : -1,
          fillAlpha: alpha > 0.5 ? alpha * 0.2 : 0,
          strokeTone: 1,
          strokeWidth: 1,
          strokeAlpha: alpha,
          delay: 0.005 * (layer * 20 + index),
        }),
      );
    }
  }
  shapes.push(
    sonnetShape('geo-lotus-stamen', circlePolygon(cx, cy, radius * 0.08, 40), {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.8,
      delay: 0.1,
    }),
    sonnetShape('geo-lotus-core', circlePolygon(cx, cy, radius * 0.03, 24), {
      fillTone: 1,
      fillAlpha: 0.9,
      strokeTone: -1,
      delay: 0.12,
    }),
  );
  // 三条藤蔓：起点与终点都在同一圈上，控制点按角度 +1 / +2 取（照抄）。
  const stemR = radius * 0.65;
  for (let index = 0; index < 3; index += 1) {
    const start = (index / 3) * Math.PI * 2;
    const at = (angle: number, scale: number): number[] => [
      Math.cos(angle) * stemR * scale,
      Math.sin(angle) * stemR * scale,
    ];
    shapes.push(
      sonnetShape(
        `geo-lotus-vine-${index}`,
        cubicPolyline(
          [
            ...at(start, 1),
            ...at(start + 1, 1.2),
            ...at(start + 2, 0.8),
            ...at(start + 3, 1),
          ],
          24,
          cx,
          cy,
        ),
        { strokeTone: 1, strokeWidth: 1, strokeAlpha: 0.4, delay: 0.08 },
      ),
    );
    // 藤上的叶节点。
    const [leafX = 0, leafY = 0] = at(start + 1.5, 1.05);
    shapes.push(
      sonnetShape(`geo-lotus-leaf-${index}`, circlePolygon(cx + leafX, cy + leafY, 4, 16), {
        fillTone: 1,
        fillAlpha: 0.6,
        strokeTone: -1,
        delay: 0.1,
      }),
    );
  }
}

/** 第 13 档：**神圣几何（生命之种）**：中心圆 + 六个环绕 + 十二个外层 + 外框 + 极淡的辐射线。 */
function drawSeedOfLife(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number): void {
  const soflR = radius * 0.25;
  /** 强调档（原版这里用的就是 `secondary`，与其它档不同）。 */
  const SECONDARY = 2;
  shapes.push(
    sonnetShape('geo-seed-center', circlePolygon(cx, cy, soflR, 64), {
      strokeTone: 1,
      strokeWidth: 1.5,
      strokeAlpha: 0.35,
    }),
  );
  for (let index = 0; index < 6; index += 1) {
    const angle = (index / 6) * Math.PI * 2;
    shapes.push(
      sonnetShape(
        `geo-seed-ring-${index}`,
        circlePolygon(cx + Math.cos(angle) * soflR, cy + Math.sin(angle) * soflR, soflR, 56),
        { strokeTone: 1, strokeWidth: 1.5, strokeAlpha: 0.2, delay: 0.02 * index },
      ),
    );
  }
  for (let index = 0; index < 12; index += 1) {
    const angle = (index / 12) * Math.PI * 2;
    // 下一层的距离：偶数取 2R、奇数取 √3R（照抄）。
    const distance = index % 2 === 0 ? soflR * 2 : soflR * Math.sqrt(3);
    shapes.push(
      sonnetShape(
        `geo-seed-outer-${index}`,
        circlePolygon(cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance, soflR, 56),
        { strokeTone: SECONDARY, strokeWidth: 1, strokeAlpha: 0.1 },
      ),
      sonnetShape(
        `geo-seed-ray-${index}`,
        [
          cx + Math.cos(angle) * soflR * 0.5,
          cy + Math.sin(angle) * soflR * 0.5,
          cx + Math.cos(angle) * soflR * 3,
          cy + Math.sin(angle) * soflR * 3,
        ],
        { strokeTone: SECONDARY, strokeWidth: 1, strokeAlpha: 0.05 },
      ),
    );
  }
  shapes.push(
    sonnetShape('geo-seed-bound', circlePolygon(cx, cy, soflR * 3, 96), {
      strokeTone: 1,
      strokeWidth: 1.5,
      strokeAlpha: 0.2,
      delay: 0.06,
    }),
    sonnetShape('geo-seed-bound-outer', circlePolygon(cx, cy, soflR * 3.1, 96), {
      strokeTone: SECONDARY,
      strokeWidth: 1,
      strokeAlpha: 0.08,
      delay: 0.08,
    }),
  );
}

/* ------------------------------------------------------------------ *
 * 棱柱体块（第 14~17 档）：三种挤出体 + 一种实心长方体
 * 数值与做法照抄 `sonnetSpatialMgGeometry.ts`
 * ------------------------------------------------------------------ */

/**
 * **挤出多面体**（照抄 `drawSonnetExtrudedPolygon`）：把"前面"沿 `(depthX, depthY)` 挤出一层，
 * 每个侧面用 `alpha × (0.34 + (i % 3) × 0.12)` 交替深浅，最后再补一个 `alpha × 0.22` 的前面 ——
 * 画面上就成了一块有体积感的半透明块体。
 */
function extrudedPrismShapes(
  id: string,
  front: readonly (readonly [number, number])[],
  depthX: number,
  depthY: number,
  alpha: number,
): SonnetShapeSpec[] {
  const shapes: SonnetShapeSpec[] = [];
  const back = front.map(([x, y]) => [x + depthX, y + depthY] as const);
  front.forEach((point, index) => {
    const next = (index + 1) % front.length;
    const rear = back[index];
    const rearNext = back[next];
    const ahead = front[next];
    if (rear === undefined || rearNext === undefined || ahead === undefined) return;
    shapes.push(
      sonnetShape(
        `${id}-side-${index}`,
        [point[0], point[1], rear[0], rear[1], rearNext[0], rearNext[1], ahead[0], ahead[1]],
        { fillTone: 1, fillAlpha: alpha * (0.34 + (index % 3) * 0.12), strokeTone: -1, delay: 0.02 * index },
      ),
    );
  });
  shapes.push(
    sonnetShape(
      `${id}-front`,
      front.flatMap(([x, y]) => [x, y]),
      { fillTone: 1, fillAlpha: alpha * 0.22, strokeTone: -1, delay: 0.02 * front.length },
    ),
  );
  return shapes;
}

/** 实心长方体（照抄 `drawSonnetSolidCuboid`：顶面 `0.42`、侧面 `0.68`、前面 `0.24`，按这个顺序画）。 */
function solidCuboidShapes(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  depthX: number,
  depthY: number,
  alpha: number,
): SonnetShapeSpec[] {
  const left = x - width / 2;
  const right = x + width / 2;
  const top = y - height / 2;
  const bottom = y + height / 2;
  return [
    sonnetShape(
      `${id}-top`,
      [left, top, left + depthX, top + depthY, right + depthX, top + depthY, right, top],
      { fillTone: 1, fillAlpha: alpha * 0.42, strokeTone: -1 },
    ),
    sonnetShape(
      `${id}-side`,
      [right, top, right + depthX, top + depthY, right + depthX, bottom + depthY, right, bottom],
      { fillTone: 1, fillAlpha: alpha * 0.68, strokeTone: -1, delay: 0.02 },
    ),
    sonnetShape(`${id}-front`, [left, top, right, top, right, bottom, left, bottom], {
      fillTone: 1,
      fillAlpha: alpha * 0.24,
      strokeTone: -1,
      delay: 0.04,
    }),
  ];
}

/** 第 14 档：**半透明建筑巨碑**（三块实心长方体，`direction` 由种子定）。 */
function drawMonoliths(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const direction = seed % 2 === 0 ? 1 : -1;
  shapes.push(
    ...solidCuboidShapes('geo-monolith-0', cx + radius * 0.18 * direction, cy + radius * 0.03, radius * 0.62, radius * 0.7, radius * 0.22 * direction, -radius * 0.16, 0.34),
    ...solidCuboidShapes('geo-monolith-1', cx - radius * 0.48 * direction, cy + radius * 0.24, radius * 0.28, radius * 0.38, radius * 0.12 * direction, -radius * 0.09, 0.24),
    ...solidCuboidShapes('geo-monolith-2', cx + radius * 0.55 * direction, cy - radius * 0.3, radius * 0.2, radius * 0.26, radius * 0.09 * direction, -radius * 0.07, 0.2),
  );
}

/** 第 15 档：**漂浮三角柱**（三个，尺寸依次变小）。 */
function drawTriangularPrisms(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const direction = seed % 2 === 0 ? 1 : -1;
  const prism = (
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
    depthX: number,
    depthY: number,
    alpha: number,
  ): void => {
    shapes.push(
      ...extrudedPrismShapes(
        id,
        [
          [x, y - height / 2],
          [x + width / 2, y + height / 2],
          [x - width / 2, y + height / 2],
        ],
        depthX,
        depthY,
        alpha,
      ),
    );
  };
  prism('geo-triangle-0', cx - radius * 0.12 * direction, cy + radius * 0.02, radius * 0.72, radius * 0.68, radius * 0.18 * direction, -radius * 0.13, 0.34);
  prism('geo-triangle-1', cx + radius * 0.48 * direction, cy + radius * 0.26, radius * 0.28, radius * 0.25, -radius * 0.08 * direction, -radius * 0.06, 0.22);
  prism('geo-triangle-2', cx - radius * 0.5 * direction, cy - radius * 0.3, radius * 0.2, radius * 0.18, radius * 0.06 * direction, -radius * 0.05, 0.18);
}

/** 第 16 档：**多面六棱柱**（前面是不规则六边形：上下窄、中间宽）。 */
function drawHexagonalPrisms(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const direction = seed % 2 === 0 ? 1 : -1;
  const prism = (
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
    depthX: number,
    depthY: number,
    alpha: number,
  ): void => {
    shapes.push(
      ...extrudedPrismShapes(
        id,
        [
          [x - width * 0.25, y - height / 2],
          [x + width * 0.25, y - height / 2],
          [x + width / 2, y],
          [x + width * 0.25, y + height / 2],
          [x - width * 0.25, y + height / 2],
          [x - width / 2, y],
        ],
        depthX,
        depthY,
        alpha,
      ),
    );
  };
  prism('geo-hexprism-0', cx + radius * 0.12 * direction, cy, radius * 0.68, radius * 0.72, radius * 0.2 * direction, -radius * 0.14, 0.32);
  prism('geo-hexprism-1', cx - radius * 0.48 * direction, cy + radius * 0.27, radius * 0.25, radius * 0.28, radius * 0.07 * direction, -radius * 0.05, 0.2);
  prism('geo-hexprism-2', cx + radius * 0.52 * direction, cy - radius * 0.3, radius * 0.18, radius * 0.2, -radius * 0.06 * direction, -radius * 0.045, 0.17);
}

/** 第 17 档：**梯形棱柱与低矮基座**（前面是上窄下宽的梯形）。 */
function drawTrapezoidPrisms(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const direction = seed % 2 === 0 ? 1 : -1;
  const prism = (
    id: string,
    x: number,
    y: number,
    topWidth: number,
    bottomWidth: number,
    height: number,
    depthX: number,
    depthY: number,
    alpha: number,
  ): void => {
    shapes.push(
      ...extrudedPrismShapes(
        id,
        [
          [x - topWidth / 2, y - height / 2],
          [x + topWidth / 2, y - height / 2],
          [x + bottomWidth / 2, y + height / 2],
          [x - bottomWidth / 2, y + height / 2],
        ],
        depthX,
        depthY,
        alpha,
      ),
    );
  };
  prism('geo-trapezoid-0', cx + radius * 0.12 * direction, cy + radius * 0.04, radius * 0.3, radius * 0.68, radius * 0.62, radius * 0.18 * direction, -radius * 0.13, 0.34);
  prism('geo-trapezoid-1', cx - radius * 0.42 * direction, cy + radius * 0.28, radius * 0.2, radius * 0.38, radius * 0.22, radius * 0.08 * direction, -radius * 0.06, 0.21);
  prism('geo-trapezoid-2', cx + radius * 0.5 * direction, cy - radius * 0.3, radius * 0.2, radius * 0.12, radius * 0.22, -radius * 0.06 * direction, -radius * 0.05, 0.18);
}

/** 第 3 档子档 1：**稠合分子**（六元环 + 稠合五元环 + 五条支链，支链上的节点画小圈）。 */
function drawFusedMolecule(
  shapes: SonnetShapeSpec[],
  cx: number,
  cy: number,
  radius: number,
): void {
  const hexR = radius * 0.22;
  // 六元环。
  shapes.push(
    sonnetShape('geo-fused-hex', hexagonPolygon(cx, cy, hexR), {
      strokeTone: 1,
      strokeWidth: 3,
      strokeAlpha: 0.8,
    }),
  );
  // 内层两条双键短线（顶点 1→2 与 4→5 的 0.8 倍）。
  for (const [from, to] of [
    [1, 2],
    [4, 5],
  ] as const) {
    const at = (step: number): number[] => [
      cx + hexR * 0.8 * Math.sin((step * Math.PI) / 3),
      cy - hexR * 0.8 * Math.cos((step * Math.PI) / 3),
    ];
    shapes.push(
      sonnetShape(`geo-fused-bond-${from}`, [...at(from), ...at(to)], {
        strokeTone: 1,
        strokeWidth: 2,
        strokeAlpha: 0.5,
        delay: 0.02,
      }),
    );
  }
  // 稠合的五元环（照抄那五个点的取法）。
  const px1 = hexR * (Math.sqrt(3) / 2);
  const py1 = -hexR / 2;
  const px2 = px1;
  const py2 = hexR / 2;
  const pentMidX = px1 + hexR * 1.2;
  shapes.push(
    sonnetShape(
      'geo-fused-pentagon',
      [
        cx + px1, cy + py1,
        cx + px1 + hexR * 0.8, cy + py1 - hexR * 0.1,
        cx + pentMidX, cy,
        cx + px2 + hexR * 0.8, cy + py2 + hexR * 0.1,
        cx + px2, cy + py2,
      ],
      { strokeTone: 1, strokeWidth: 3, strokeAlpha: 0.8, delay: 0.04 },
    ),
  );
  // 五条支链；带 node 的那三条在末端加一个小圈。
  const branches: readonly (readonly [number, number, number, number, boolean])[] = [
    [0, -hexR, -Math.PI / 2, radius * 0.15, true],
    [(-hexR * Math.sqrt(3)) / 2, hexR / 2, Math.PI * 0.8, radius * 0.2, true],
    [(-hexR * Math.sqrt(3)) / 2, -hexR / 2, -Math.PI * 0.8, radius * 0.15, false],
    [pentMidX, 0, 0, radius * 0.18, false],
    [pentMidX + radius * 0.18, 0, Math.PI / 4, radius * 0.1, true],
  ];
  branches.forEach(([sx, sy, angle, length, node], index) => {
    const ex = sx + Math.cos(angle) * length;
    const ey = sy + Math.sin(angle) * length;
    shapes.push(
      sonnetShape(`geo-fused-branch-${index}`, [cx + sx, cy + sy, cx + ex, cy + ey], {
        strokeTone: 1,
        strokeWidth: 2,
        strokeAlpha: 0.6,
        delay: 0.03 * index,
      }),
    );
    if (!node) return;
    shapes.push(
      sonnetShape(`geo-fused-node-${index}`, circlePolygon(cx + ex, cy + ey, 6, 20), {
        strokeTone: 1,
        strokeWidth: 2,
        strokeAlpha: 0.8,
        delay: 0.03 * index,
      }),
    );
  });
}

/** 第 3 档子档 2：**线性聚合物链**（锯齿主链 + 交替的官能团）。 */
function drawPolymerChain(
  shapes: SonnetShapeSpec[],
  cx: number,
  cy: number,
  radius: number,
): void {
  const segLen = radius * 0.18;
  const steps = 7;
  const points: { x: number; y: number }[] = [];
  let cursorX = -segLen * (steps / 2) * Math.cos(Math.PI / 6);
  points.push({ x: cursorX, y: 0 });
  for (let index = 0; index < steps; index += 1) {
    cursorX += segLen * Math.cos(Math.PI / 6);
    // 照抄：y 每步**重新赋值**（不是累加），所以主链只有上下两条水平线。
    const cursorY = (index % 2 === 0 ? 1 : -1) * segLen * Math.sin(Math.PI / 6);
    points.push({ x: cursorX, y: cursorY });
  }
  shapes.push(
    sonnetShape(
      'geo-polymer-backbone',
      points.flatMap((point) => [cx + point.x, cy + point.y]),
      { strokeTone: 1, strokeWidth: 3, strokeAlpha: 0.8 },
    ),
  );
  // 第一段旁边的双键短线（法线方向偏移 6px）。
  const nx = -Math.sin(Math.PI / 6) * 6;
  const ny = Math.cos(Math.PI / 6) * 6;
  const first = points[1];
  const second = points[2];
  if (first !== undefined && second !== undefined) {
    shapes.push(
      sonnetShape(
        'geo-polymer-double-bond',
        [cx + first.x + nx, cy + first.y + ny, cx + second.x + nx, cy + second.y + ny],
        { strokeTone: 1, strokeWidth: 2, strokeAlpha: 0.5, delay: 0.02 },
      ),
    );
  }
  for (let index = 1; index < steps; index += 1) {
    const anchor = points[index];
    if (anchor === undefined) continue;
    const angle = index % 2 === 0 ? Math.PI / 2 : -Math.PI / 2;
    const bx = anchor.x;
    const by = anchor.y + Math.sin(angle) * segLen * 0.6;
    shapes.push(
      sonnetShape(
        `geo-polymer-group-${index}`,
        [cx + anchor.x, cy + anchor.y, cx + bx, cy + by],
        { strokeTone: 1, strokeWidth: 2, strokeAlpha: 0.5, delay: 0.01 * index },
      ),
    );
    if (index % 2 !== 0) {
      shapes.push(
        sonnetShape(`geo-polymer-node-${index}`, circlePolygon(cx + bx, cy + by, 5, 18), {
          strokeTone: 1,
          strokeWidth: 2,
          strokeAlpha: 0.8,
          delay: 0.01 * index,
        }),
      );
    } else {
      shapes.push(
        sonnetShape(
          `geo-polymer-tail-${index}`,
          [cx + bx, cy + by, cx + bx + segLen * 0.5, cy + by - segLen * 0.3],
          { strokeTone: 1, strokeWidth: 2, strokeAlpha: 0.5, delay: 0.01 * index },
        ),
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * 附加档 18~23（照抄 `sonnetAdditionalShotMg.ts`）
 * 原版这一段是六种"海报图形"，档位常量 `SONNET_ADDITIONAL_GEO_VARIANT_START = 18`、共 6 档
 * ------------------------------------------------------------------ */

export const SONNET_ADDITIONAL_GEO_VARIANT_START = 18;
export const SONNET_ADDITIONAL_GEO_VARIANT_COUNT = 6;

/** 第 18 档：**等高线图册**（八圈带涟漪的环 + 左下角一段图例线）。 */
function drawContourAtlas(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const steps = 48;
  for (let ring = 0; ring < 8; ring += 1) {
    const baseRadius = radius * (0.16 + ring * 0.075);
    const ringPoints: number[] = [];
    for (let step = 0; step <= steps; step += 1) {
      const angle = (step / steps) * Math.PI * 2;
      const ripple =
        Math.sin(angle * 3 + seed * 0.07 + ring) * radius * 0.018 +
        Math.cos(angle * 5 - seed * 0.03 + ring * 0.7) * radius * 0.012;
      const x = Math.cos(angle) * (baseRadius + ripple) + Math.sin(ring * 1.7) * radius * 0.055;
      const y =
        Math.sin(angle) * (baseRadius + ripple) * 0.72 + Math.cos(ring * 1.3) * radius * 0.035;
      ringPoints.push(cx + x, cy + y);
    }
    shapes.push(
      sonnetShape(`geo-contour-${ring}`, ringPoints, {
        // 照抄：每三圈一换色换粗细，透明度随圈数递增。
        strokeTone: ring % 3 === 0 ? 2 : 1,
        strokeWidth: ring % 3 === 0 ? 2 : 1,
        strokeAlpha: 0.2 + ring * 0.045,
        delay: 0.02 * ring,
      }),
    );
  }
  shapes.push(
    sonnetShape(
      'geo-contour-legend',
      [
        cx - radius * 0.78, cy + radius * 0.52,
        cx - radius * 0.58, cy + radius * 0.52,
        cx - radius * 0.58, cy + radius * 0.46,
        cx - radius * 0.38, cy + radius * 0.46,
      ],
      { strokeTone: 1, strokeWidth: 3, strokeAlpha: 0.64, delay: 0.16 },
    ),
  );
}

/** 第 19 档：**放射波形**（64 根按正弦高低起伏的条 + 三圈）。 */
function drawRadialWave(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const bars = 64;
  for (let index = 0; index < bars; index += 1) {
    const angle = (index / bars) * Math.PI * 2;
    const signal = 0.5 + 0.5 * Math.sin(index * 1.83 + seed * 0.11);
    const inner = radius * (0.29 + signal * 0.035);
    const outer = radius * (0.43 + signal * 0.21);
    shapes.push(
      sonnetShape(
        `geo-wave-bar-${index}`,
        [
          cx + Math.cos(angle) * inner,
          cy + Math.sin(angle) * inner,
          cx + Math.cos(angle) * outer,
          cy + Math.sin(angle) * outer,
        ],
        {
          strokeTone: index % 8 === 0 ? 2 : 1,
          strokeWidth: index % 8 === 0 ? 3 : 1,
          strokeAlpha: index % 2 === 0 ? 0.58 : 0.32,
          delay: 0.002 * index,
        },
      ),
    );
  }
  shapes.push(
    sonnetShape('geo-wave-core', circlePolygon(cx, cy, radius * 0.24, 64), {
      strokeTone: 1,
      strokeWidth: 5,
      strokeAlpha: 0.7,
    }),
    sonnetShape('geo-wave-outer', circlePolygon(cx, cy, radius * 0.68, 72), {
      strokeTone: 2,
      strokeWidth: 1,
      strokeAlpha: 0.18,
      delay: 0.1,
    }),
    sonnetShape('geo-wave-rim', circlePolygon(cx, cy, radius * 0.72, 72), {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.12,
      delay: 0.12,
    }),
  );
}

/** 第 20 档：**交通蓝图**（三条从画面外进来、再出去的折线路线 + 节点圈）。 */
function drawTransitBlueprint(
  shapes: SonnetShapeSpec[],
  cx: number,
  cy: number,
  radius: number,
  width: number,
  height: number,
  seed: number,
): void {
  const direction = seed % 2 === 0 ? 1 : -1;
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  const routes: readonly (readonly (readonly [number, number])[])[] = [
    [[-0.72, -0.38], [-0.38, -0.38], [-0.38, 0.08], [0.08, 0.08], [0.08, 0.52], [0.68, 0.52]],
    [[-0.62, 0.58], [-0.62, 0.24], [-0.14, 0.24], [-0.14, -0.52], [0.5, -0.52], [0.5, -0.2], [0.74, -0.2]],
    [[-0.78, -0.06], [-0.5, -0.06], [-0.5, -0.62], [0.24, -0.62], [0.24, 0.3], [0.72, 0.3]],
  ];
  routes.forEach((route, routeIndex) => {
    const first = route[0];
    const last = route[route.length - 1];
    if (first === undefined || last === undefined) return;
    // 两端都**伸出画面之外**（`bleed`），中间才是路线本体。
    const line: number[] = [cx - bleed.x * direction, cy + first[1] * radius];
    route.forEach(([x, y]) => {
      line.push(cx + x * radius * direction, cy + y * radius);
    });
    line.push(cx + bleed.x * direction, cy + last[1] * radius);
    shapes.push(
      sonnetShape(`geo-transit-route-${routeIndex}`, line, {
        strokeTone: routeIndex === 1 ? 2 : 1,
        strokeWidth: routeIndex === 0 ? 5 : 2,
        strokeAlpha: 0.34 + routeIndex * 0.12,
        delay: 0.03 * routeIndex,
      }),
    );
    route.forEach(([x, y], pointIndex) => {
      const isEnd = pointIndex === 0 || pointIndex === route.length - 1;
      if (!isEnd && (pointIndex + routeIndex) % 2 !== 0) return;
      const px = cx + x * radius * direction;
      const py = cy + y * radius;
      shapes.push(
        sonnetShape(`geo-transit-node-${routeIndex}-${pointIndex}`, circlePolygon(px, py, pointIndex === 0 ? 10 : 6, 20), {
          fillTone: pointIndex % 2 === 0 ? 1 : 2,
          fillAlpha: 0.72,
          strokeTone: -1,
          delay: 0.02 * routeIndex,
        }),
        sonnetShape(`geo-transit-halo-${routeIndex}-${pointIndex}`, circlePolygon(px, py, pointIndex === 0 ? 16 : 11, 24), {
          strokeTone: 1,
          strokeWidth: 1,
          strokeAlpha: 0.36,
          delay: 0.02 * routeIndex,
        }),
      );
    });
  });
}

/** 第 21 档：**计时码表**（三圈 + 48 根刻度 + 两根指针 + 轴心点）。 */
function drawChronograph(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const rings: readonly number[] = [0.2, 0.38, 0.62];
  rings.forEach((scale, index) => {
    shapes.push(
      sonnetShape(`geo-chrono-ring-${index}`, circlePolygon(cx, cy, radius * scale, 72), {
        strokeTone: index === 1 ? 2 : 1,
        strokeWidth: index === 2 ? 4 : 2,
        strokeAlpha: 0.3 + index * 0.13,
      }),
    );
  });
  for (let tick = 0; tick < 48; tick += 1) {
    const angle = (tick / 48) * Math.PI * 2;
    const outer = radius * 0.72;
    // 照抄：每四根一根长刻度（0.11r），其余 0.045r。
    const inner = outer - radius * (tick % 4 === 0 ? 0.11 : 0.045);
    shapes.push(
      sonnetShape(
        `geo-chrono-tick-${tick}`,
        [
          cx + Math.cos(angle) * inner,
          cy + Math.sin(angle) * inner,
          cx + Math.cos(angle) * outer,
          cy + Math.sin(angle) * outer,
        ],
        {
          strokeTone: tick % 4 === 0 ? 2 : 1,
          strokeWidth: tick % 4 === 0 ? 3 : 1,
          strokeAlpha: 0.5,
        },
      ),
    );
  }
  const handAngle = ((seed % 60) / 60) * Math.PI * 2 - Math.PI / 2;
  const secondAngle = (((seed * 7) % 60) / 60) * Math.PI * 2 - Math.PI / 2;
  shapes.push(
    sonnetShape(
      'geo-chrono-hand',
      [
        cx - Math.cos(handAngle) * radius * 0.12,
        cy - Math.sin(handAngle) * radius * 0.12,
        cx + Math.cos(handAngle) * radius * 0.55,
        cy + Math.sin(handAngle) * radius * 0.55,
      ],
      { strokeTone: 1, strokeWidth: 6, strokeAlpha: 0.74, delay: 0.14 },
    ),
    sonnetShape(
      'geo-chrono-second',
      [cx, cy, cx + Math.cos(secondAngle) * radius * 0.65, cy + Math.sin(secondAngle) * radius * 0.65],
      { strokeTone: 2, strokeWidth: 2, strokeAlpha: 0.72, delay: 0.14 },
    ),
    sonnetShape('geo-chrono-pin', circlePolygon(cx, cy, radius * 0.055, 24), {
      fillTone: 1,
      fillAlpha: 0.85,
      strokeTone: -1,
      delay: 0.16,
    }),
  );
}

/** 第 22 档：**折带**（五条横贯画面、上下交替鼓起的曲线带 + 两条极淡的竖线）。 */
function drawFoldedRibbons(
  shapes: SonnetShapeSpec[],
  cx: number,
  cy: number,
  radius: number,
  width: number,
  height: number,
  seed: number,
): void {
  const direction = seed % 2 === 0 ? 1 : -1;
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  for (let band = 0; band < 5; band += 1) {
    const y = (-0.5 + band * 0.25) * radius;
    const offset = (band % 2 === 0 ? 1 : -1) * direction;
    const curve = (dy: number): number[] =>
      cubicPolyline(
        [
          -bleed.x, y + dy,
          -radius * 0.38, y - radius * 0.28 * offset + dy,
          radius * 0.18, y + radius * 0.28 * offset + dy,
          bleed.x, y + dy,
        ],
        28,
        cx,
        cy,
      );
    shapes.push(
      sonnetShape(`geo-ribbon-${band}`, curve(0), {
        strokeTone: band % 2 === 0 ? 1 : 2,
        // 中间那条最粗（12）、其余 5。
        strokeWidth: band === 2 ? 12 : 5,
        strokeAlpha: 0.24 + band * 0.08,
        delay: 0.03 * band,
      }),
      // 每条带下面 0.055r 处再描一条 1px 的细线（照抄）。
      sonnetShape(`geo-ribbon-edge-${band}`, curve(radius * 0.055), {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.3,
        delay: 0.03 * band,
      }),
    );
  }
  shapes.push(
    sonnetShape('geo-ribbon-drop-1', [cx - radius * 0.34, cy - bleed.y, cx - radius * 0.34, cy - radius * 0.18], {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.18,
      delay: 0.16,
    }),
    sonnetShape('geo-ribbon-drop-2', [cx + radius * 0.34, cy + radius * 0.18, cx + radius * 0.34, cy + bleed.y], {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.18,
      delay: 0.16,
    }),
  );
}

/** 第 23 档：**半色调海报**（铺满画面的点阵，越靠中心越大越亮 + 两条参考线）。 */
function drawHalftonePoster(
  shapes: SonnetShapeSpec[],
  cx: number,
  cy: number,
  radius: number,
  width: number,
  height: number,
  seed: number,
): void {
  const spacing = radius * 0.17;
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  const columns = Math.ceil((bleed.x * 2) / spacing) + 2;
  const rows = Math.ceil((bleed.y * 2) / spacing) + 2;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = (column - (columns - 1) / 2) * spacing;
      const y = (row - (rows - 1) / 2) * spacing;
      const distance = Math.hypot(x, y) / radius;
      const pulse = 0.5 + 0.5 * Math.sin(column * 0.9 + row * 1.4 + seed * 0.08);
      const dotRadius =
        radius * (0.009 + Math.max(0, 0.72 - distance) * 0.034 + pulse * 0.012);
      shapes.push(
        sonnetShape(`geo-halftone-${row}-${column}`, circlePolygon(cx + x, cy + y, dotRadius, 16), {
          fillTone: (row + column) % 5 === 0 ? 2 : 1,
          fillAlpha: 0.24 + pulse * 0.5,
          strokeTone: -1,
        }),
      );
    }
  }
  shapes.push(
    sonnetShape('geo-halftone-rule-h', [cx - bleed.x, cy - bleed.y * 0.72, cx + bleed.x, cy - bleed.y * 0.72], {
      strokeTone: 2,
      strokeWidth: 2,
      strokeAlpha: 0.28,
      delay: 0.2,
    }),
    sonnetShape('geo-halftone-rule-v', [cx - bleed.x * 0.58, cy - bleed.y, cx - bleed.x * 0.58, cy + bleed.y], {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.2,
      delay: 0.2,
    }),
  );
}

/* ------------------------------------------------------------------ *
 * 开框档 36~47（照抄 `sonnetOpenFrameShotMg.ts`）
 * 原版这一段是十二种"开框"背景：**任何一笔都不闭合**（文字可能落在图形之外）
 * ------------------------------------------------------------------ */

export const SONNET_OPEN_GEO_VARIANT_START = 36;
export const SONNET_OPEN_GEO_VARIANT_COUNT = 12;

export const SONNET_OPEN_GEO_VARIANTS = [
  'open-arc-brackets',
  'dashed-orbits',
  'open-fragments',
  'horizon-bundles',
  'semi-wreath',
  'side-rulers',
  'diagonal-stream',
  'corner-petal-spray',
  'dotted-windows',
  'open-radar',
  'brush-strokes',
  'stitch-corners',
] as const;

const TAU = Math.PI * 2;

const rotatePoint = (x: number, y: number, angle: number): readonly [number, number] => [
  x * Math.cos(angle) - y * Math.sin(angle),
  x * Math.sin(angle) + y * Math.cos(angle),
];

/** 36 开框角弧：四个"想象中的角"各一段四分之一圆弧，互不相连。 */
function drawOpenArcBrackets(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, seed: number): void {
  const bx = width * 0.34;
  const by = height * 0.34;
  const arcR = radius * 0.17;
  const corners: readonly (readonly [number, number, number, number])[] = [
    [-bx, -by, Math.PI, Math.PI * 1.5],
    [bx, -by, -Math.PI / 2, 0],
    [bx, by, 0, Math.PI / 2],
    [-bx, by, Math.PI / 2, Math.PI],
  ];
  corners.forEach(([x, y, start, end], index) => {
    shapes.push(
      sonnetShape(`geo-open-bracket-${index}`, arcPolyline(cx + x, cy + y, arcR, start, end, 20, false), {
        strokeTone: index % 2 ? 2 : 1,
        strokeWidth: 3,
        strokeAlpha: 0.6,
        delay: 0.02 * index,
      }),
      sonnetShape(`geo-open-bracket-inner-${index}`, arcPolyline(cx + x, cy + y, arcR * 0.72, start, end, 16, false), {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.3,
        delay: 0.02 * index,
      }),
      sonnetShape(`geo-open-bracket-h${index}`, [cx + x - 5, cy + y, cx + x + 5, cy + y], {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.5,
      }),
      sonnetShape(`geo-open-bracket-v${index}`, [cx + x, cy + y - 5, cx + x, cy + y + 5], {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.5,
      }),
    );
  });
  const dotAngle = ((seed % 8) * TAU) / 8;
  shapes.push(
    sonnetShape(
      'geo-open-bracket-dot',
      circlePolygon(cx + Math.cos(dotAngle) * radius * 0.5, cy + Math.sin(dotAngle) * radius * 0.5, radius * 0.02, 20),
      { fillTone: 2, fillAlpha: 0.7, strokeTone: -1, delay: 0.1 },
    ),
  );
}

/** 37 虚线轨道：三圈都断成一节一节的弧，另有三个标记点。 */
function drawDashedOrbits(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  for (let ring = 0; ring < 3; ring += 1) {
    const ringRadius = radius * (0.32 + ring * 0.18);
    const dashes = 12 + ring * 4;
    const offset = seed * 0.13 + ring * 0.7;
    const span = (TAU / dashes) * 0.55;
    for (let dash = 0; dash < dashes; dash += 1) {
      const start = offset + (dash / dashes) * TAU;
      shapes.push(
        sonnetShape(
          `geo-orbit-dash-${ring}-${dash}`,
          arcPolyline(cx, cy, ringRadius, start, start + span, 6, false),
          {
            strokeTone: ring === 1 ? 2 : 1,
            strokeWidth: ring === 1 ? 1 : 2,
            strokeAlpha: 0.28 + ring * 0.06,
          },
        ),
      );
    }
  }
  const markerAngle = seed * 0.31;
  shapes.push(
    sonnetShape(
      'geo-orbit-marker-0',
      circlePolygon(cx + Math.cos(markerAngle) * radius * 0.68, cy + Math.sin(markerAngle) * radius * 0.68, radius * 0.022, 20),
      { fillTone: 1, fillAlpha: 0.75, strokeTone: -1, delay: 0.1 },
    ),
    sonnetShape(
      'geo-orbit-marker-1',
      circlePolygon(
        cx + Math.cos(markerAngle + Math.PI) * radius * 0.5,
        cy + Math.sin(markerAngle + Math.PI) * radius * 0.5,
        radius * 0.016,
        20,
      ),
      { fillTone: 2, fillAlpha: 0.6, strokeTone: -1, delay: 0.1 },
    ),
    sonnetShape('geo-orbit-core', circlePolygon(cx, cy, radius * 0.05, 24), {
      strokeTone: 1,
      strokeWidth: 1.5,
      strokeAlpha: 0.5,
      delay: 0.12,
    }),
  );
}

/** 38 散落碎框：五个**三边**方框（第四边故意不画），其中一个中间填一个小圆。 */
function drawOpenFragments(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  for (let index = 0; index < 5; index += 1) {
    const angle = (index / 5) * TAU + seed * 0.05;
    const distance = radius * (0.42 + ((seed + index * 7) % 30) / 100);
    const ox = Math.cos(angle) * distance;
    const oy = Math.sin(angle) * distance * 0.8;
    const size = radius * (0.07 + ((seed + index * 13) % 20) / 200);
    const rotation = seed * 0.11 + index * 0.9;
    const [p0, p1, p2, p3] = [
      rotatePoint(-size, -size, rotation),
      rotatePoint(size, -size, rotation),
      rotatePoint(size, size, rotation),
      rotatePoint(-size, size, rotation),
    ] as const;
    // 四个顶点连三条边 ⇒ 第四边留着不画（"开框"）。
    shapes.push(
      sonnetShape(
        `geo-fragment-${index}`,
        [cx + ox + p0[0], cy + oy + p0[1], cx + ox + p1[0], cy + oy + p1[1], cx + ox + p2[0], cy + oy + p2[1], cx + ox + p3[0], cy + oy + p3[1]],
        {
          strokeTone: index % 2 ? 2 : 1,
          strokeWidth: 2,
          strokeAlpha: 0.5,
          delay: 0.03 * index,
        },
      ),
    );
    if (index === seed % 5) {
      shapes.push(
        sonnetShape(`geo-fragment-dot-${index}`, circlePolygon(cx + ox, cy + oy, size * 0.28, 18), {
          fillTone: 1,
          fillAlpha: 0.35,
          strokeTone: -1,
          delay: 0.06,
        }),
      );
    }
  }
}

/** 39 地平线束：上下各三根**中间断开**的横线，中间大片留空。 */
function drawHorizonBundles(shapes: SonnetShapeSpec[], cx: number, cy: number, _radius: number, width: number, height: number, seed: number): void {
  const bundles: readonly (readonly [number, number])[] = [
    [-height * 0.28, 1],
    [height * 0.3, -1],
  ];
  bundles.forEach(([baseY, drift], bundleIndex) => {
    for (let line = 0; line < 3; line += 1) {
      const y = baseY + line * 10 * (drift ?? 1);
      const breakAt = width * ((((seed + line * 17 + bundleIndex * 31) % 40) + 30) / 100 - 0.5);
      const gapHalf = width * 0.045;
      const tone = line === 1 ? 2 : 1;
      const strokeWidth = line === 1 ? 2 : 1;
      const strokeAlpha = 0.42 - line * 0.08;
      shapes.push(
        sonnetShape(`geo-horizon-${bundleIndex}-${line}-a`, [cx - width * 0.4, cy + y, cx + breakAt - gapHalf, cy + y], {
          strokeTone: tone,
          strokeWidth,
          strokeAlpha,
          delay: 0.02 * line,
        }),
        sonnetShape(`geo-horizon-${bundleIndex}-${line}-b`, [cx + breakAt + gapHalf, cy + y, cx + width * 0.4, cy + y], {
          strokeTone: tone,
          strokeWidth,
          strokeAlpha,
          delay: 0.02 * line,
        }),
      );
    }
    shapes.push(
      sonnetShape(`geo-horizon-mark-${bundleIndex}`, [cx - width * 0.42, cy + baseY, cx - width * 0.42 + 6, cy + baseY], {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.4,
        delay: 0.08,
      }),
    );
  });
  shapes.push(
    sonnetShape('geo-horizon-badge', rectPolygon(cx + width * 0.36, cy - height * 0.28 - 3, width * 0.04, 6), {
      fillTone: 2,
      fillAlpha: 0.5,
      strokeTone: -1,
      delay: 0.1,
    }),
  );
}

/** 40 半花环：270° 的环 + 18 根叶状刻度，**留一道缺口**。 */
function drawSemiWreath(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const opening = (seed % 4) * (Math.PI / 2) + Math.PI / 8;
  const span = TAU * 0.75;
  const outer = radius * 0.58;
  const inner = radius * 0.5;
  shapes.push(
    sonnetShape('geo-wreath-outer', arcPolyline(cx, cy, outer, opening, opening + span, 48, false), {
      strokeTone: 1,
      strokeWidth: 2.5,
      strokeAlpha: 0.55,
    }),
    sonnetShape('geo-wreath-inner', arcPolyline(cx, cy, inner, opening, opening + span, 48, false), {
      strokeTone: 2,
      strokeWidth: 1,
      strokeAlpha: 0.3,
      delay: 0.03,
    }),
  );
  const ticks = 18;
  for (let index = 0; index < ticks; index += 1) {
    const angle = opening + (index / ticks) * span;
    shapes.push(
      sonnetShape(
        `geo-wreath-tick-${index}`,
        [
          cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer,
          cx + Math.cos(angle) * (outer + radius * 0.05), cy + Math.sin(angle) * (outer + radius * 0.05),
        ],
        { strokeTone: 1, strokeWidth: 1, strokeAlpha: 0.4 },
      ),
    );
    if (index % 6 === 0) {
      shapes.push(
        sonnetShape(
          `geo-wreath-node-${index}`,
          circlePolygon(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner, radius * 0.016, 16),
          { fillTone: 2, fillAlpha: 0.6, strokeTone: -1, delay: 0.06 },
        ),
      );
    }
  }
}

/** 41 两侧标尺：左右各一根竖线 + 12 根刻度（每四根一根长的）+ 一个强调小块。 */
function drawSideRulers(shapes: SonnetShapeSpec[], cx: number, cy: number, _radius: number, width: number, height: number, seed: number): void {
  for (const side of [-1, 1]) {
    const x = side * width * 0.36;
    shapes.push(
      sonnetShape(`geo-ruler-${side}`, [cx + x, cy - height * 0.3, cx + x, cy + height * 0.3], {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.35,
      }),
    );
    for (let tick = 0; tick < 12; tick += 1) {
      const y = -height * 0.3 + (tick / 11) * height * 0.6;
      const length = tick % 4 === 0 ? 18 : 9;
      shapes.push(
        sonnetShape(`geo-ruler-${side}-tick-${tick}`, [cx + x, cy + y, cx + x - side * length, cy + y], {
          strokeTone: tick % 4 === 0 ? 2 : 1,
          strokeWidth: 1,
          strokeAlpha: 0.45,
          delay: 0.01 * tick,
        }),
      );
    }
    const accentY = -height * 0.3 + (((seed + (side > 0 ? 5 : 0)) % 11) / 11) * height * 0.6;
    shapes.push(
      sonnetShape(`geo-ruler-${side}-accent`, rectPolygon(cx + (side > 0 ? x : x - 4), cy + accentY - 4, 4, 8), {
        fillTone: 2,
        fillAlpha: 0.6,
        strokeTone: -1,
        delay: 0.14,
      }),
    );
  }
}

/** 42 斜向流：七条平行斜线 + 两个**缺一边**的菱形。 */
function drawDiagonalStream(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const angle = Math.PI / 4 + (seed % 3) * (Math.PI / 12);
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const normalX = -dirY;
  const normalY = dirX;
  for (let line = 0; line < 7; line += 1) {
    const offset = (line - 3) * radius * 0.16;
    const length = radius * (0.55 + ((seed + line * 29) % 40) / 100);
    const ox = normalX * offset;
    const oy = normalY * offset;
    shapes.push(
      sonnetShape(
        `geo-stream-${line}`,
        [
          cx + ox - dirX * length, cy + oy - dirY * length,
          cx + ox + dirX * length * 0.6, cy + oy + dirY * length * 0.6,
        ],
        {
          strokeTone: line === 3 ? 2 : 1,
          strokeWidth: line === 3 ? 2 : 1,
          strokeAlpha: 0.22 + line * 0.03,
          delay: 0.02 * line,
        },
      ),
    );
  }
  [-radius * 0.16, radius * 0.16].forEach((offset, index) => {
    const ox = normalX * offset + dirX * radius * 0.1;
    const oy = normalY * offset + dirY * radius * 0.1;
    const size = radius * 0.07;
    const [p0, p1, p2, p3] = [
      rotatePoint(0, -size, angle),
      rotatePoint(size, 0, angle),
      rotatePoint(0, size, angle),
      rotatePoint(-size, 0, angle),
    ] as const;
    shapes.push(
      sonnetShape(
        `geo-stream-diamond-${index}`,
        [cx + ox + p0[0], cy + oy + p0[1], cx + ox + p1[0], cy + oy + p1[1], cx + ox + p2[0], cy + oy + p2[1], cx + ox + p3[0], cy + oy + p3[1]],
        { strokeTone: 1, strokeWidth: 1.5, strokeAlpha: 0.55, delay: 0.1 },
      ),
    );
    if (index === 0) {
      shapes.push(
        sonnetShape(`geo-stream-dot-${index}`, circlePolygon(cx + ox, cy + oy, size * 0.22, 16), {
          fillTone: 2,
          fillAlpha: 0.55,
          strokeTone: -1,
          delay: 0.12,
        }),
      );
    }
  });
}

/** 43 角部花瓣喷：只从两个对角喷出弯曲花瓣。 */
function drawCornerPetalSpray(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, seed: number): void {
  const sign = seed % 2 === 0 ? 1 : -1;
  const corners: readonly (readonly [number, number, number])[] = [
    [-sign * width * 0.28, -height * 0.26, Math.atan2(1, sign)],
    [sign * width * 0.28, height * 0.26, Math.atan2(-1, -sign)],
  ];
  corners.forEach(([ox, oy, base], cornerIndex) => {
    for (let petal = 0; petal < 5; petal += 1) {
      const spread = (petal - 2) * 0.3;
      const angle = base + spread;
      const length = radius * (0.3 - Math.abs(petal - 2) * 0.045);
      const endX = ox + Math.cos(angle) * length;
      const endY = oy + Math.sin(angle) * length;
      const ctrlX = ox + Math.cos(angle + 0.35) * length * 0.55;
      const ctrlY = oy + Math.sin(angle + 0.35) * length * 0.55;
      shapes.push(
        sonnetShape(
          `geo-petal-${cornerIndex}-${petal}`,
          quadraticPolyline(ox, oy, ctrlX, ctrlY, endX, endY, 18, cx, cy),
          {
            strokeTone: petal === 2 ? 2 : 1,
            strokeWidth: petal === 2 ? 2 : 1,
            strokeAlpha: 0.4,
            delay: 0.03 * petal,
          },
        ),
      );
    }
    if (cornerIndex === 0) {
      shapes.push(
        sonnetShape('geo-petal-origin', circlePolygon(cx + ox, cy + oy, radius * 0.02, 16), {
          fillTone: 1,
          fillAlpha: 0.6,
          strokeTone: -1,
          delay: 0.12,
        }),
      );
    }
  });
}

/** 44 点窗：稀疏散点 + 三个**直角**记号（想象窗格的角）。 */
function drawDottedWindows(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, seed: number): void {
  const columns = 7;
  const rows = 5;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if ((row * columns + column + seed) % 5 === 0) continue;
      const x = (column - (columns - 1) / 2) * width * 0.11;
      const y = (row - (rows - 1) / 2) * height * 0.14;
      shapes.push(
        sonnetShape(`geo-window-dot-${row}-${column}`, circlePolygon(cx + x, cy + y, 1.5, 12), {
          fillTone: 1,
          fillAlpha: 0.35,
          strokeTone: -1,
        }),
      );
    }
  }
  const arm = radius * 0.1;
  for (let window = 0; window < 3; window += 1) {
    const cellX = (((seed + window * 2) % columns) - (columns - 1) / 2) * width * 0.11;
    const cellY = (((seed + window * 3 + 1) % rows) - (rows - 1) / 2) * height * 0.14;
    const flipX = (seed + window) % 2 === 0 ? 1 : -1;
    const flipY = (seed + window * 2) % 2 === 0 ? 1 : -1;
    shapes.push(
      sonnetShape(
        `geo-window-bracket-${window}`,
        [cx + cellX + flipX * arm, cy + cellY, cx + cellX, cy + cellY, cx + cellX, cy + cellY + flipY * arm],
        { strokeTone: 2, strokeWidth: 2, strokeAlpha: 0.6, delay: 0.04 * window },
      ),
    );
  }
}

/** 45 开框雷达：三段约 200° 的弧 + 扫掠线 + **四段互不相接**的锁定刻度。 */
function drawOpenRadar(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const span = TAU * 0.56;
  for (let ring = 0; ring < 3; ring += 1) {
    const ringRadius = radius * (0.3 + ring * 0.18);
    const start = seed * 0.1 + ring * 0.9;
    shapes.push(
      sonnetShape(`geo-open-radar-ring-${ring}`, arcPolyline(cx, cy, ringRadius, start, start + span, 40, false), {
        strokeTone: ring === 1 ? 2 : 1,
        strokeWidth: ring === 1 ? 2 : 1,
        strokeAlpha: 0.35 + ring * 0.06,
        delay: 0.03 * ring,
      }),
    );
  }
  const sweep = seed * 0.07;
  shapes.push(
    sonnetShape('geo-open-radar-sweep', [cx, cy, cx + Math.cos(sweep) * radius * 0.66, cy + Math.sin(sweep) * radius * 0.66], {
      strokeTone: 1,
      strokeWidth: 1.5,
      strokeAlpha: 0.5,
      delay: 0.1,
    }),
  );
  const lockAngle = sweep + 0.8;
  const lockX = Math.cos(lockAngle) * radius * 0.48;
  const lockY = Math.sin(lockAngle) * radius * 0.48;
  const tick = radius * 0.04;
  shapes.push(
    sonnetShape(
      'geo-open-radar-lock-a',
      [cx + lockX - tick * 2, cy + lockY - tick, cx + lockX - tick * 2, cy + lockY - tick * 2, cx + lockX - tick, cy + lockY - tick * 2],
      { strokeTone: 2, strokeWidth: 1.5, strokeAlpha: 0.7, delay: 0.12 },
    ),
    sonnetShape(
      'geo-open-radar-lock-b',
      [cx + lockX + tick * 2, cy + lockY + tick, cx + lockX + tick * 2, cy + lockY + tick * 2, cx + lockX + tick, cy + lockY + tick * 2],
      { strokeTone: 2, strokeWidth: 1.5, strokeAlpha: 0.7, delay: 0.12 },
    ),
    sonnetShape('geo-open-radar-core', circlePolygon(cx, cy, radius * 0.018, 16), {
      fillTone: 1,
      fillAlpha: 0.8,
      strokeTone: -1,
      delay: 0.14,
    }),
    sonnetShape('geo-open-radar-lock-dot', circlePolygon(cx + lockX, cy + lockY, radius * 0.014, 16), {
      fillTone: 2,
      fillAlpha: 0.7,
      strokeTone: -1,
      delay: 0.14,
    }),
  );
}

/** 46 笔刷：四道粗笔触（横向纵向交替）+ 一个三边方框与一个小方块。 */
function drawBrushStrokes(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, seed: number): void {
  for (let stroke = 0; stroke < 4; stroke += 1) {
    const horizontal = stroke % 2 === 0;
    const along = (((seed + stroke * 23) % 50) / 100 - 0.25) * (horizontal ? width : height);
    const across = (((seed + stroke * 41) % 60) / 100 - 0.3) * (horizontal ? height : width);
    const length = radius * (0.3 + ((seed + stroke * 7) % 25) / 100);
    const x1 = horizontal ? along - length : across;
    const y1 = horizontal ? across : along - length;
    const x2 = horizontal ? along + length : across;
    const y2 = horizontal ? across : along + length;
    shapes.push(
      sonnetShape(`geo-brush-${stroke}`, [cx + x1, cy + y1, cx + x2, cy + y2], {
        strokeTone: stroke === 1 ? 2 : 1,
        strokeWidth: radius * 0.04,
        strokeAlpha: 0.22,
        delay: 0.03 * stroke,
      }),
      sonnetShape(
        `geo-brush-tip-${stroke}`,
        [
          cx + x1, cy + y1 + (horizontal ? radius * 0.035 : 0),
          cx + (horizontal ? x2 * 0.6 : x2), cy + (horizontal ? y2 + radius * 0.035 : y2 * 0.6),
        ],
        { strokeTone: 1, strokeWidth: radius * 0.012, strokeAlpha: 0.45, delay: 0.03 * stroke },
      ),
    );
  }
  const size = radius * 0.05;
  const anchorX = width * 0.3;
  const anchorY = -height * 0.3;
  shapes.push(
    sonnetShape(
      'geo-brush-corner',
      [
        cx + anchorX - size, cy + anchorY - size,
        cx + anchorX + size, cy + anchorY - size,
        cx + anchorX + size, cy + anchorY + size,
      ],
      { strokeTone: 2, strokeWidth: 1.5, strokeAlpha: 0.6, delay: 0.14 },
    ),
    sonnetShape('geo-brush-block', rectPolygon(cx - anchorX - size / 2, cy - anchorY - size / 2, size, size), {
      fillTone: 1,
      fillAlpha: 0.4,
      strokeTone: -1,
      delay: 0.14,
    }),
  );
}

/** 47 缝线角：四个远处角上的**虚线 L** + 中心的点线十字 + 两粒强调点。 */
function drawStitchCorners(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, seed: number): void {
  const arm = radius * 0.18;
  const dash = radius * 0.03;
  const corners: readonly (readonly [number, number, number, number])[] = [
    [-width * 0.39, -height * 0.36, 1, 1],
    [width * 0.39, -height * 0.36, -1, 1],
    [width * 0.39, height * 0.36, -1, -1],
    [-width * 0.39, height * 0.36, 1, -1],
  ];
  corners.forEach(([x, y, sx, sy], index) => {
    let step = 0;
    for (let offset = 0; offset + dash <= arm; offset += dash * 2) {
      shapes.push(
        sonnetShape(
          `geo-stitch-${index}-h${step}`,
          [cx + x + sx * offset, cy + y, cx + x + sx * (offset + dash), cy + y],
          { strokeTone: index % 2 ? 2 : 1, strokeWidth: 2, strokeAlpha: 0.5 },
        ),
        sonnetShape(
          `geo-stitch-${index}-v${step}`,
          [cx + x, cy + y + sy * offset, cx + x, cy + y + sy * (offset + dash)],
          { strokeTone: index % 2 ? 2 : 1, strokeWidth: 2, strokeAlpha: 0.5 },
        ),
      );
      step += 1;
    }
  });
  const crossArm = radius * 0.09;
  let crossStep = 0;
  for (let offset = -crossArm; offset + dash * 0.6 <= crossArm; offset += dash * 1.2) {
    shapes.push(
      sonnetShape(`geo-stitch-cross-h${crossStep}`, [cx + offset, cy, cx + offset + dash * 0.6, cy], {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.4,
      }),
      sonnetShape(`geo-stitch-cross-v${crossStep}`, [cx, cy + offset, cx, cy + offset + dash * 0.6], {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.4,
      }),
    );
    crossStep += 1;
  }
  shapes.push(
    sonnetShape('geo-stitch-core', circlePolygon(cx, cy, radius * 0.012, 16), {
      fillTone: 2,
      fillAlpha: 0.7,
      strokeTone: -1,
      delay: 0.16,
    }),
  );
  const accent = corners[seed % corners.length];
  if (accent !== undefined) {
    shapes.push(
      sonnetShape(
        'geo-stitch-accent',
        circlePolygon(cx + accent[0] + accent[2] * arm, cy + accent[1], radius * 0.014, 16),
        { fillTone: 1, fillAlpha: 0.6, strokeTone: -1, delay: 0.16 },
      ),
    );
  }
}

/**
 * **商籁几何档位的完整地图**（照抄原版的常量链）。
 *
 * 原版的档位空间是 `0~99`，四个家族首尾相接、**每一档都会画东西**：
 * | 档位 | 家族 | 来源 | 我们这边 |
 * |---|---|---|---|
 * | `0~17` | 基础几何（18） | `sonnetShotMg.ts` | ✅ 已搬 |
 * | `18~23` | 附加海报（6） | `sonnetAdditionalShotMg.ts` | ✅ 已搬 |
 * | `24~35` | 主题图形（12） | `sonnetThemedShotMg.ts` + 四个子模块 | ⏳ 未搬 |
 * | `36~47` | 开框背景（12） | `sonnetOpenFrameShotMg.ts` | ✅ 已搬 |
 * | `48~57` | 扩展 · 天体篇（10） | `sonnetShotMgCelestial.ts` | ✅ 已搬 |
 * | `58~67` | 扩展 · 海洋篇（10） | `sonnetShotMgMarine.ts` | ✅ 已搬 |
 * | `68~75` | 扩展 · 音乐篇（8） | `sonnetShotMgMusic.ts` | ✅ 已搬 |
 * | `76~85` | 扩展 · 工艺篇（10） | `sonnetShotMgCraft.ts` | ✅ 已搬 |
 * | `86~99` | 扩展 · 动态篇（14） | `sonnetShotMgKinetic.ts` | ✅ 已搬 |
 *
 * **这条地图纠正了前面几轮的两个猜测**：
 * ① 我一度以为"18 档往后原版可能什么都不画、我们的自拟兜底属于多画"——实际**每一档都有画面**，
 *    我们的兜底是"画得不一样"，不是"多画"；
 * ② 我一度按"每篇 10 档"把工艺篇猜成 `78~87`——原版文件头写明它是 `76~85`，
 *    所以音乐篇只有 8 档、动态篇有 14 档（这两个档数是由算术反推的，取到文件时要核对）。
 */
export const SONNET_THEMED_GEO_VARIANT_COUNT = 12;
export const SONNET_EXTENDED_GEO_VARIANT_START = 48;
export const SONNET_EXTENDED_GEO_VARIANT_COUNT = 52;
/** 扩展主题里**天体篇**的档数（`SONNET_CELESTIAL_GEO_VARIANTS` 的条目数，用例会核对两者一致）。 */
export const SONNET_CELESTIAL_GEO_VARIANT_COUNT = 10;
/** 扩展主题里**海洋篇**的档数（同上）。 */
export const SONNET_MARINE_GEO_VARIANT_COUNT = 10;
/**
 * 扩展主题里**音乐篇**的档数：原版文件头写明 `geo variants 68-75`，即 **8 档**
 * （与前面按 `48 + 10 + 10` 反推的起点一致）。
 */
export const SONNET_MUSIC_GEO_VARIANT_COUNT = 8;
/** 扩展主题里**工艺篇**的档数（原版文件头写明 `geo variants 76-85`，即 10 档）。 */
export const SONNET_CRAFT_GEO_VARIANT_COUNT = 10;
/**
 * 扩展主题里**动态篇**的档数：原版文件头写明 `geo variants 86-99`，即 **14 档**（与算术反推一致）。
 */
export const SONNET_KINETIC_GEO_VARIANT_COUNT = 14;

export interface SonnetGeoRange {
  readonly key: string;
  readonly start: number;
  readonly count: number;
  /** 我们这边**搬过来了多少档**（可以只搬了一部分，比如扩展主题目前只搬了天体篇）。 */
  readonly portedCount: number;
}

export const SONNET_GEO_RANGES: readonly SonnetGeoRange[] = [
  { key: '基础几何', start: 0, count: 18, portedCount: 18 },
  { key: '附加海报', start: SONNET_ADDITIONAL_GEO_VARIANT_START, count: SONNET_ADDITIONAL_GEO_VARIANT_COUNT, portedCount: SONNET_ADDITIONAL_GEO_VARIANT_COUNT },
  { key: '主题图形', start: SONNET_THEMED_GEO_VARIANT_START, count: SONNET_THEMED_GEO_VARIANT_COUNT, portedCount: SONNET_THEMED_PORTED_COUNT },
  { key: '开框背景', start: SONNET_OPEN_GEO_VARIANT_START, count: SONNET_OPEN_GEO_VARIANT_COUNT, portedCount: SONNET_OPEN_GEO_VARIANT_COUNT },
  {
    key: '扩展·天体篇',
    start: SONNET_EXTENDED_GEO_VARIANT_START,
    count: SONNET_CELESTIAL_GEO_VARIANT_COUNT,
    portedCount: SONNET_CELESTIAL_GEO_VARIANT_COUNT,
  },
  {
    key: '扩展·海洋篇',
    start: SONNET_EXTENDED_GEO_VARIANT_START + SONNET_CELESTIAL_GEO_VARIANT_COUNT,
    count: SONNET_MARINE_GEO_VARIANT_COUNT,
    portedCount: SONNET_MARINE_GEO_VARIANT_COUNT,
  },
  {
    key: '扩展·音乐篇',
    start: SONNET_EXTENDED_GEO_VARIANT_START + SONNET_CELESTIAL_GEO_VARIANT_COUNT + SONNET_MARINE_GEO_VARIANT_COUNT,
    count: SONNET_MUSIC_GEO_VARIANT_COUNT,
    portedCount: SONNET_MUSIC_GEO_VARIANT_COUNT,
  },
  {
    key: '扩展·工艺篇',
    start:
      SONNET_EXTENDED_GEO_VARIANT_START +
      SONNET_CELESTIAL_GEO_VARIANT_COUNT +
      SONNET_MARINE_GEO_VARIANT_COUNT +
      SONNET_MUSIC_GEO_VARIANT_COUNT,
    count: SONNET_CRAFT_GEO_VARIANT_COUNT,
    portedCount: SONNET_CRAFT_GEO_VARIANT_COUNT,
  },
  {
    key: '扩展·动态篇',
    start:
      SONNET_EXTENDED_GEO_VARIANT_START +
      SONNET_CELESTIAL_GEO_VARIANT_COUNT +
      SONNET_MARINE_GEO_VARIANT_COUNT +
      SONNET_MUSIC_GEO_VARIANT_COUNT +
      SONNET_CRAFT_GEO_VARIANT_COUNT,
    count: SONNET_KINETIC_GEO_VARIANT_COUNT,
    portedCount: SONNET_KINETIC_GEO_VARIANT_COUNT,
  },
];

/** 覆盖率读数（给诊断用）：已搬多少档、还差哪些家族。 */
export function describeSonnetGeoCoverage(): {
  ported: number;
  total: number;
  summary: string;
} {
  const total = SONNET_GEO_RANGES.reduce((sum, range) => sum + range.count, 0);
  const ported = SONNET_GEO_RANGES.reduce((sum, range) => sum + range.portedCount, 0);
  const label = (range: SonnetGeoRange): string =>
    range.portedCount === range.count
      ? `${range.key} ${range.start}~${range.start + range.count - 1}`
      : `${range.key} ${range.start}~${range.start + range.portedCount - 1}（共 ${range.count}）`;
  const done = SONNET_GEO_RANGES.filter((range) => range.portedCount > 0).map(label).join(' + ');
  const pending = SONNET_GEO_RANGES.filter((range) => range.portedCount < range.count)
    .map((range) =>
      range.portedCount === 0
        ? `${range.key} ${range.start}~${range.start + range.count - 1}`
        : `${range.key} 还差 ${range.start + range.portedCount}~${range.start + range.count - 1}`,
    )
    .join('、');
  return {
    ported,
    total,
    summary:
      ported === total
        ? `已搬 ${ported}/${total} 档（${done}）—— 全部搬完`
        : `已搬 ${ported}/${total} 档（${done}）；未搬：${pending}`,
  };
}

/* ------------------------------------------------------------------ *
 * 扩展主题 · 天体篇 48~57（照抄 `sonnetShotMgCelestial.ts`）
 * 原版这一段同样是"开框"的：没有闭合的取景框、也没有裁剪遮罩
 * ------------------------------------------------------------------ */

export const SONNET_CELESTIAL_GEO_VARIANTS = [
  'spiral-galaxy',
  'comet-trail',
  'eclipse-corona',
  'meteor-shower',
  'orbit-satellites',
  'aurora-ribbons',
  'crescent-halo',
  'nebula-veil',
  'star-map',
  'lunar-tide',
] as const;

/**
 * 数值混合（**照抄 folia `sonnetRandom.ts` 的 `mixSonnetSeed`**）：
 * 把种子与盐（`salt`）搅在一起，让不同子系统（几何档位 / 背景 HUD / 固定几何 / 装饰 / 逐粒子抖动）
 * 之间互不相关。流程是"先异或、再乘 2654435761（Knuth 黄金比例常数）"。
 */
export function mixSonnetSeed(seed: number, salt: number): number {
  return Math.imul((Math.trunc(seed) ^ salt) >>> 0, 2654435761) >>> 0;
}

/**
 * 字符串 → 32 位无符号种子（**照抄 folia `sonnetRandom.ts` 的 `hashSonnetSeed`**）：
 * FNV-1a（offset basis 2166136261、prime 16777619）。
 */
export function hashSonnetSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 每次元素索引一个确定的 0~1 抖动（**照抄 folia `sonnetRandom.ts` 的 `sonnetHash01`**）：
 * `mixSonnetSeed(seed + (index + 1) × 97, salt) / 2³²`。同一个种子 + 同一个下标永远给同一个值
 * （所以 seek 回去、重建场景都不会跳），但不同下标之间互不相关。
 *
 * 第 71 轮之前这里挂的是一个**自己写的替身**（三次混合），撒点位置因此与原版有出入；
 * 拿到上游这个模块后换成正主 —— 现在**撒点也逐位一致**了。
 */
export function sonnetHash01(seed: number, index: number, salt: number): number {
  return mixSonnetSeed(seed + Math.imul(index + 1, 97), salt) / 4294967296;
}

/**
 * **确定性的"随机流"**：给一串**按调用次序取值**的装饰参数用（不是按元素下标取值）。
 *
 * 为什么需要它：引导线那几处上游用的是**裸 `Math.random()`**，特征是"**同一个元素内**按次序各取一个数"
 * （角度 → 尺寸 → 转速 → 延迟 …）✗ —— 这种用法用不了 `sonnetHash01(seed, index, salt)`（它要一个元素下标 ✗）。
 * 若按"调用序号当下标"硬套，同一段装饰在**增删了任何一个随机点之后**整串数都会平移 ✗（观感随机跳变 ✗）。
 *
 * 这里改成**独立的四轮散列**：状态里带一个自增的 `counter`，每次 `next()` 把
 * `(seed, counter, salt)` 混一遍再自增 ✓ ⇒ 同一段、同一调用次序**永远得到同一串数** ✓，
 * 而不同段/不同 salt 之间互不相关 ✓。拖动进度条回同一时刻得到同一画面 ✓。
 *
 * `low` / `high` 是**闭-开**区间采样（`low + r × (high − low)`），与 `Math.random()` 的用法同构 ✓。
 */
export interface SonnetRandomStream {
  /** 取下一个 `[0, 1)` 的数（内部自增计数器 ✓）。 */
  next(): number;
  /** 取下一个 `[low, high)` 的数 ✓。 */
  range(low: number, high: number): number;
  /** 取下一个 `[0, 1)` 是否为真（概率 `probability` ✓）。 */
  chance(probability: number): boolean;
}

export function createSonnetRandomStream(seed: number, salt: number): SonnetRandomStream {
  let counter = 0;
  const next = (): number => {
    const value = sonnetHash01(seed, counter, salt);
    counter += 1;
    return value;
  };
  return {
    next,
    range: (low: number, high: number) => low + next() * (high - low),
    chance: (probability: number) => next() < probability,
  };
}

/** 48 螺旋星系：两条对数螺线 + 亮核 + 散落星尘。 */
function drawSpiralGalaxy(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  for (let arm = 0; arm < 2; arm += 1) {
    const offset = arm * Math.PI + sonnetHash01(seed, arm, 101) * 0.5;
    const spiral: number[] = [cx + Math.cos(offset) * radius * 0.06, cy + Math.sin(offset) * radius * 0.05];
    const steps = 56;
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps;
      const angle = offset + t * Math.PI * 3.1;
      const r = radius * (0.06 + t * 0.62);
      spiral.push(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r * 0.72);
    }
    shapes.push(
      sonnetShape(`geo-galaxy-arm-${arm}`, spiral, {
        strokeTone: arm === 0 ? 1 : 2,
        strokeWidth: 2,
        strokeAlpha: 0.5 - arm * 0.12,
        delay: 0.05 * arm,
      }),
    );
  }
  shapes.push(
    sonnetShape('geo-galaxy-core', circlePolygon(cx, cy, radius * 0.07, 32), {
      fillTone: 1,
      fillAlpha: 0.7,
      strokeTone: -1,
    }),
    sonnetShape('geo-galaxy-ring', circlePolygon(cx, cy, radius * 0.12, 40), {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.3,
      delay: 0.06,
    }),
  );
  for (let index = 0; index < 14; index += 1) {
    const angle = sonnetHash01(seed, index, 103) * TAU;
    const r = radius * (0.2 + sonnetHash01(seed, index, 107) * 0.55);
    shapes.push(
      sonnetShape(
        `geo-galaxy-star-${index}`,
        circlePolygon(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r * 0.72, 1.4 + sonnetHash01(seed, index, 109) * 2.2, 12),
        {
          fillTone: index % 3 === 0 ? 2 : 1,
          fillAlpha: 0.3 + sonnetHash01(seed, index, 113) * 0.35,
          strokeTone: -1,
          delay: 0.01 * index,
        },
      ),
    );
  }
}

/** 49 彗星：彗核 + 三条弯曲彗尾 + 十字闪光。 */
function drawCometTrail(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const direction = seed % 2 === 0 ? 1 : -1;
  const hx = radius * 0.34 * direction;
  const hy = -radius * 0.18;
  for (let tail = 0; tail < 3; tail += 1) {
    const spread = (tail - 1) * radius * 0.12;
    shapes.push(
      sonnetShape(
        `geo-comet-tail-${tail}`,
        cubicPolyline(
          [
            hx - direction * radius * 0.04, hy + spread * 0.3,
            hx - direction * radius * 0.35, hy + spread,
            hx - direction * radius * 0.6, hy + radius * 0.16 + spread,
            hx - direction * radius * (0.85 + tail * 0.06), hy + radius * 0.3 + spread * 1.2,
          ],
          26,
          cx,
          cy,
        ),
        {
          strokeTone: tail === 1 ? 2 : 1,
          strokeWidth: 3 - tail,
          strokeAlpha: 0.55 - tail * 0.12,
          delay: 0.04 * tail,
        },
      ),
    );
  }
  shapes.push(
    sonnetShape('geo-comet-head', circlePolygon(cx + hx, cy + hy, radius * 0.09, 32), {
      fillTone: 1,
      fillAlpha: 0.75,
      strokeTone: -1,
    }),
    sonnetShape('geo-comet-halo', circlePolygon(cx + hx, cy + hy, radius * 0.14, 36), {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.35,
      delay: 0.04,
    }),
  );
  for (let index = 0; index < 5; index += 1) {
    const x = (sonnetHash01(seed, index, 127) - 0.5) * radius * 1.4;
    const y = radius * (0.1 + sonnetHash01(seed, index, 131) * 0.5);
    const s = 2.5 + sonnetHash01(seed, index, 137) * 2.5;
    shapes.push(
      sonnetShape(`geo-comet-spark-h${index}`, [cx + x - s, cy + y, cx + x + s, cy + y], {
        strokeTone: 2,
        strokeWidth: 1,
        strokeAlpha: 0.45,
        delay: 0.02 * index,
      }),
      sonnetShape(`geo-comet-spark-v${index}`, [cx + x, cy + y - s, cx + x, cy + y + s], {
        strokeTone: 2,
        strokeWidth: 1,
        strokeAlpha: 0.45,
        delay: 0.02 * index,
      }),
    );
  }
}

/** 50 日蚀日冕：被遮住的圆盘 + 28 根长短交替的冕射。 */
function drawEclipseCorona(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const discR = radius * 0.24;
  shapes.push(
    sonnetShape('geo-eclipse-disc', circlePolygon(cx, cy, discR, 64), {
      fillTone: 1,
      fillAlpha: 0.16,
      strokeTone: -1,
    }),
    sonnetShape('geo-eclipse-rim', circlePolygon(cx, cy, discR, 64), {
      strokeTone: 2,
      strokeWidth: 2,
      strokeAlpha: 0.65,
      delay: 0.03,
    }),
    sonnetShape('geo-eclipse-halo', circlePolygon(cx, cy, discR * 1.14, 72), {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.25,
      delay: 0.05,
    }),
  );
  const rays = 28;
  for (let index = 0; index < rays; index += 1) {
    const angle = (index / rays) * TAU + sonnetHash01(seed, index, 139) * 0.08;
    const inner = discR * 1.2;
    const outer = radius * (index % 2 === 0 ? 0.6 : 0.42) * (0.85 + sonnetHash01(seed, index, 149) * 0.3);
    shapes.push(
      sonnetShape(
        `geo-corona-ray-${index}`,
        [
          cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner,
          cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer,
        ],
        {
          strokeTone: index % 4 === 0 ? 2 : 1,
          strokeWidth: index % 2 === 0 ? 2 : 1,
          strokeAlpha: 0.3 + (index % 3) * 0.1,
          delay: 0.005 * index,
        },
      ),
    );
  }
}

/** 51 流星雨：八条斜向流星（各带一条淡影）+ 发光头部。 */
function drawMeteorShower(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const direction = seed % 2 === 0 ? 1 : -1;
  for (let index = 0; index < 8; index += 1) {
    const x = (sonnetHash01(seed, index, 151) - 0.5) * radius * 1.5;
    const y = -radius * 0.55 + sonnetHash01(seed, index, 157) * radius * 0.9;
    const len = radius * (0.2 + sonnetHash01(seed, index, 163) * 0.3);
    const dx = direction * len;
    const dy = len * 0.55;
    shapes.push(
      sonnetShape(`geo-meteor-${index}`, [cx + x, cy + y, cx + x - dx, cy + y - dy], {
        strokeTone: 1,
        strokeWidth: 2,
        strokeAlpha: 0.55,
        delay: 0.02 * index,
      }),
      sonnetShape(
        `geo-meteor-shadow-${index}`,
        [cx + x - dx * 0.15, cy + y - dy * 0.15 + 3, cx + x - dx * 0.85, cy + y - dy * 0.85 + 3],
        { strokeTone: 2, strokeWidth: 1, strokeAlpha: 0.3, delay: 0.02 * index },
      ),
      sonnetShape(`geo-meteor-head-${index}`, circlePolygon(cx + x, cy + y, 2 + sonnetHash01(seed, index, 167) * 2, 12), {
        fillTone: index % 2 === 0 ? 2 : 1,
        fillAlpha: 0.7,
        strokeTone: -1,
        delay: 0.02 * index,
      }),
    );
  }
}

/** 52 卫星轨道：三圈断开的轨道 + 每圈一颗菱形卫星 + 中心点。 */
function drawOrbitSatellites(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  for (let ring = 0; ring < 3; ring += 1) {
    const r = radius * (0.28 + ring * 0.18);
    const gapStart = sonnetHash01(seed, ring, 173) * TAU;
    const segments = 3 + ring;
    for (let seg = 0; seg < segments; seg += 1) {
      const start = gapStart + (seg / segments) * TAU;
      shapes.push(
        sonnetShape(`geo-orbit-arc-${ring}-${seg}`, arcPolyline(cx, cy, r, start, start + (TAU / segments) * 0.68, 20, false), {
          strokeTone: ring === 1 ? 2 : 1,
          strokeWidth: ring === 0 ? 2 : 1,
          strokeAlpha: 0.35 + ring * 0.08,
          delay: 0.03 * ring,
        }),
      );
    }
    const satAngle = sonnetHash01(seed, ring, 179) * TAU;
    const sx = cx + Math.cos(satAngle) * r;
    const sy = cy + Math.sin(satAngle) * r;
    const d = 5 + ring * 2;
    shapes.push(
      sonnetShape(
        `geo-orbit-satellite-${ring}`,
        [sx, sy - d, sx + d, sy, sx, sy + d, sx - d, sy, sx, sy - d],
        { fillTone: 2, fillAlpha: 0.75, strokeTone: -1, delay: 0.06 },
      ),
    );
  }
  shapes.push(
    sonnetShape('geo-orbit-hub', circlePolygon(cx, cy, radius * 0.06, 28), {
      fillTone: 1,
      fillAlpha: 0.8,
      strokeTone: -1,
      delay: 0.08,
    }),
  );
}

/** 53 极光带：四条自上而下的飘带（各带一条极细的伴线）+ 雪点。 */
function drawAuroraRibbons(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  for (let band = 0; band < 4; band += 1) {
    const x0 = -radius * 0.6 + band * radius * 0.38 + (sonnetHash01(seed, band, 181) - 0.5) * radius * 0.1;
    const sway = (band % 2 === 0 ? 1 : -1) * radius * 0.2;
    shapes.push(
      sonnetShape(
        `geo-aurora-${band}`,
        cubicPolyline(
          [x0, -radius * 0.75, x0 + sway, -radius * 0.35, x0 - sway, radius * 0.1, x0 + sway * 0.6, radius * 0.55],
          28,
          cx,
          cy,
        ),
        {
          strokeTone: band % 2 === 0 ? 1 : 2,
          strokeWidth: 7 - band,
          strokeAlpha: 0.16 + band * 0.05,
          delay: 0.04 * band,
        },
      ),
      sonnetShape(
        `geo-aurora-edge-${band}`,
        cubicPolyline(
          [
            x0 + radius * 0.06, -radius * 0.7,
            x0 + sway + radius * 0.06, -radius * 0.3,
            x0 - sway + radius * 0.06, radius * 0.12,
            x0 + sway * 0.6 + radius * 0.06, radius * 0.5,
          ],
          24,
          cx,
          cy,
        ),
        { strokeTone: 1, strokeWidth: 1, strokeAlpha: 0.3, delay: 0.04 * band },
      ),
    );
  }
  for (let index = 0; index < 8; index += 1) {
    shapes.push(
      sonnetShape(
        `geo-aurora-snow-${index}`,
        circlePolygon(
          cx + (sonnetHash01(seed, index, 191) - 0.5) * radius * 1.5,
          cy - radius * 0.6 + sonnetHash01(seed, index, 193) * radius * 0.5,
          1.4,
          10,
        ),
        { fillTone: 2, fillAlpha: 0.5, strokeTone: -1, delay: 0.02 * index },
      ),
    );
  }
}

/** 54 月牙与光晕：月牙 + 两圈光晕 + 三条挂着星星的细线。 */
function drawCrescentHalo(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const moonR = radius * 0.3;
  const ox = -radius * 0.12;
  const oy = -radius * 0.1;
  shapes.push(
    sonnetShape(
      'geo-halo-crescent',
      [
        ...arcPolyline(cx + ox, cy + oy, moonR, -Math.PI / 2, Math.PI / 2, 32, false),
        ...quadraticPolyline(0, -moonR, -moonR * 0.45, 0, 0, -moonR, 20, cx + ox, cy + oy),
      ],
      { fillTone: 1, fillAlpha: 0.55, strokeTone: -1 },
    ),
    sonnetShape('geo-halo-ring-1', circlePolygon(cx + ox, cy + oy, moonR * 1.35, 64), {
      strokeTone: 2,
      strokeWidth: 1,
      strokeAlpha: 0.3,
      delay: 0.04,
    }),
    sonnetShape('geo-halo-ring-2', circlePolygon(cx + ox, cy + oy, moonR * 1.5, 72), {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.16,
      delay: 0.06,
    }),
  );
  for (let index = 0; index < 3; index += 1) {
    const px = radius * (0.18 + index * 0.16);
    const topY = -radius * 0.5 + sonnetHash01(seed, index, 197) * radius * 0.1;
    const len = radius * (0.14 + sonnetHash01(seed, index, 199) * 0.12);
    const sr = 4 + index;
    const sy = topY + len + sr;
    shapes.push(
      sonnetShape(`geo-halo-thread-${index}`, [cx + px, cy + topY, cx + px, cy + topY + len], {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.4,
        delay: 0.03 * index,
      }),
      sonnetShape(
        `geo-halo-star-${index}`,
        [
          cx + px, cy + sy - sr,
          cx + px + sr * 0.25, cy + sy - sr * 0.25,
          cx + px + sr, cy + sy,
          cx + px + sr * 0.25, cy + sy + sr * 0.25,
          cx + px, cy + sy + sr,
          cx + px - sr * 0.25, cy + sy + sr * 0.25,
          cx + px - sr, cy + sy,
          cx + px - sr * 0.25, cy + sy - sr * 0.25,
          cx + px, cy + sy - sr,
        ],
        { strokeTone: 2, strokeWidth: 1, strokeAlpha: 0.6, delay: 0.03 * index },
      ),
    );
  }
}

/** 55 星云纱：四团贝塞尔有机形状（前两团有极淡填充）+ 十粒尘埃。 */
function drawNebulaVeil(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  for (let blob = 0; blob < 4; blob += 1) {
    const bx = (sonnetHash01(seed, blob, 211) - 0.5) * radius * 0.5;
    const by = (sonnetHash01(seed, blob, 223) - 0.5) * radius * 0.4;
    const br = radius * (0.2 + blob * 0.1);
    const wobble = sonnetHash01(seed, blob, 227) * 0.6;
    const ringPoints: number[] = [];
    const segments: readonly (readonly number[])[] = [
      [bx + br, by, bx + br, by - br * (0.6 + wobble * 0.3), bx + br * 0.5, by - br, bx, by - br * (0.9 - wobble * 0.2)],
      [
        bx, by - br * (0.9 - wobble * 0.2),
        bx - br * 0.6, by - br * 0.8,
        bx - br, by - br * 0.3,
        bx - br * (0.85 + wobble * 0.2), by + br * 0.2,
      ],
      [
        bx - br * (0.85 + wobble * 0.2), by + br * 0.2,
        bx - br * 0.7, by + br * 0.7,
        bx - br * 0.2, by + br,
        bx + br * 0.3, by + br * (0.8 + wobble * 0.2),
      ],
      [
        bx + br * 0.3, by + br * (0.8 + wobble * 0.2),
        bx + br * 0.8, by + br * 0.6,
        bx + br, by + br * 0.4,
        bx + br, by,
      ],
    ];
    for (const segment of segments) {
      const sampled = cubicPolyline(segment, 12, cx, cy);
      // 每段都从段首开始，所以去掉重复的首点。
      ringPoints.push(...(ringPoints.length === 0 ? sampled : sampled.slice(2)));
    }
    shapes.push(
      sonnetShape(`geo-nebula-${blob}`, ringPoints, {
        strokeTone: blob % 2 === 0 ? 1 : 2,
        strokeWidth: 1.5,
        strokeAlpha: 0.35 - blob * 0.04,
        fillTone: blob < 2 ? 1 : -1,
        fillAlpha: blob < 2 ? 0.05 : 0,
        delay: 0.05 * blob,
      }),
    );
  }
  for (let index = 0; index < 10; index += 1) {
    shapes.push(
      sonnetShape(
        `geo-nebula-dust-${index}`,
        circlePolygon(
          cx + (sonnetHash01(seed, index, 229) - 0.5) * radius * 1.2,
          cy + (sonnetHash01(seed, index, 233) - 0.5) * radius * 1.0,
          1.2 + sonnetHash01(seed, index, 239) * 1.8,
          10,
        ),
        { fillTone: 1, fillAlpha: 0.25 + sonnetHash01(seed, index, 241) * 0.3, strokeTone: -1, delay: 0.02 * index },
      ),
    );
  }
}

/** 56 星图：5×4 的十字刻度网 + 一组由六颗亮星连成的星座。 */
function drawStarMap(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  for (let gx = 0; gx < 5; gx += 1) {
    for (let gy = 0; gy < 4; gy += 1) {
      const x = -radius * 0.6 + gx * radius * 0.3;
      const y = -radius * 0.45 + gy * radius * 0.3;
      shapes.push(
        sonnetShape(`geo-starmap-h-${gx}-${gy}`, [cx + x - 3, cy + y, cx + x + 3, cy + y], {
          strokeTone: 1,
          strokeWidth: 1,
          strokeAlpha: 0.18,
        }),
        sonnetShape(`geo-starmap-v-${gx}-${gy}`, [cx + x, cy + y - 3, cx + x, cy + y + 3], {
          strokeTone: 1,
          strokeWidth: 1,
          strokeAlpha: 0.18,
        }),
      );
    }
  }
  const nodes = 6;
  let previousX = 0;
  let previousY = 0;
  for (let index = 0; index < nodes; index += 1) {
    const x = -radius * 0.5 + sonnetHash01(seed, index, 251) * radius;
    const y = -radius * 0.4 + sonnetHash01(seed, index, 257) * radius * 0.8;
    if (index > 0) {
      shapes.push(
        sonnetShape(`geo-starmap-link-${index}`, [cx + previousX, cy + previousY, cx + x, cy + y], {
          strokeTone: 2,
          strokeWidth: 1.5,
          strokeAlpha: 0.55,
          delay: 0.02 * index,
        }),
      );
    }
    shapes.push(
      sonnetShape(`geo-starmap-node-${index}`, circlePolygon(cx + x, cy + y, 3, 12), {
        fillTone: 1,
        fillAlpha: 0.8,
        strokeTone: -1,
        delay: 0.02 * index,
      }),
      sonnetShape(`geo-starmap-halo-${index}`, circlePolygon(cx + x, cy + y, 6.5, 18), {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.3,
        delay: 0.02 * index,
      }),
    );
    previousX = x;
    previousY = y;
  }
}

/** 57 月与潮：上面一个带弧光的月亮，下面四排开弧的潮水。 */
function drawLunarTide(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const mx = radius * 0.28 * (seed % 2 === 0 ? 1 : -1);
  const my = -radius * 0.34;
  shapes.push(
    sonnetShape('geo-tide-moon', circlePolygon(cx + mx, cy + my, radius * 0.16, 48), {
      fillTone: 1,
      fillAlpha: 0.2,
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.6,
    }),
    sonnetShape('geo-tide-glow', arcPolyline(cx + mx, cy + my, radius * 0.24, Math.PI * 0.2, Math.PI * 0.8, 24, false), {
      strokeTone: 2,
      strokeWidth: 1,
      strokeAlpha: 0.35,
      delay: 0.04,
    }),
  );
  for (let row = 0; row < 4; row += 1) {
    const y = radius * (0.05 + row * 0.14);
    const arcs = 6 - row;
    for (let index = 0; index < arcs; index += 1) {
      const x = -radius * 0.62 + index * radius * 0.24 + (row % 2) * radius * 0.12;
      shapes.push(
        sonnetShape(
          `geo-tide-arc-${row}-${index}`,
          arcPolyline(cx + x, cy + y, radius * 0.09, Math.PI, TAU, 16, false),
          {
            strokeTone: row % 2 === 0 ? 1 : 2,
            strokeWidth: row === 0 ? 2 : 1,
            strokeAlpha: 0.45 - row * 0.07,
            delay: 0.02 * row,
          },
        ),
      );
    }
  }
}

export const SONNET_MARINE_GEO_VARIANTS = [
  'wave-scrolls',
  'nautilus',
  'coral-branch',
  'lighthouse-beam',
  'compass-rose',
  'sail-regatta',
  'bubble-rise',
  'tide-pools',
  'seaweed-sway',
  'deep-current',
] as const;

/** 58 浪卷：四排重复的浪冠弧（横贯到画面之外）+ 六粒气泡。 */
function drawWaveScrolls(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, seed: number): void {
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  for (let row = 0; row < 4; row += 1) {
    const y = -radius * 0.3 + row * radius * 0.22;
    const crestR = radius * 0.1;
    const step = crestR * 2.1;
    const count = Math.ceil((bleed.x * 2) / step);
    for (let index = 0; index < count; index += 1) {
      const x = -bleed.x + index * step + (row % 2) * crestR;
      // 浪冠是**上半弧**（π → 2π），所以一排排看过去是"开口朝下的波浪"。
      shapes.push(
        sonnetShape(
          `geo-wave-arc-${row}-${index}`,
          arcPolyline(cx + x, cy + y, crestR, Math.PI, TAU, 14, false),
          {
            strokeTone: (index + row) % 3 === 0 ? 2 : 1,
            strokeWidth: row === 1 ? 2 : 1,
            strokeAlpha: 0.42 - row * 0.06,
          },
        ),
      );
    }
  }
  for (let index = 0; index < 6; index += 1) {
    shapes.push(
      sonnetShape(
        `geo-wave-bubble-${index}`,
        circlePolygon(
          cx + (sonnetHash01(seed, index, 263) - 0.5) * bleed.x * 1.4,
          cy - radius * 0.55 + sonnetHash01(seed, index, 269) * radius * 0.25,
          1.6,
          10,
        ),
        { fillTone: 2, fillAlpha: 0.4, strokeTone: -1, delay: 0.02 * index },
      ),
    );
  }
}

/** 59 鹦鹉螺：对数螺线 + 八条隔室分隔线 + 螺心圈（外端**不闭合**）。 */
function drawNautilus(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const turns = 2.6;
  const steps = 90;
  const startAngle = sonnetHash01(seed, 0, 271) * TAU;
  const spiral: number[] = [cx + Math.cos(startAngle) * radius * 0.04, cy + Math.sin(startAngle) * radius * 0.04];
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const angle = startAngle + t * turns * TAU;
    const r = radius * (0.04 + t * 0.5);
    spiral.push(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r * 0.94);
  }
  shapes.push(sonnetShape('geo-nautilus-spiral', spiral, { strokeTone: 1, strokeWidth: 2.5, strokeAlpha: 0.65 }));
  for (let index = 1; index <= 8; index += 1) {
    const t = index / 9;
    const angle = startAngle + t * turns * TAU;
    const r = radius * (0.04 + t * 0.5);
    shapes.push(
      sonnetShape(
        `geo-nautilus-chamber-${index}`,
        [
          cx + Math.cos(angle) * r * 0.55, cy + Math.sin(angle) * r * 0.52,
          cx + Math.cos(angle) * r, cy + Math.sin(angle) * r * 0.94,
        ],
        { strokeTone: 2, strokeWidth: 1, strokeAlpha: 0.35, delay: 0.02 * index },
      ),
    );
  }
  shapes.push(
    sonnetShape('geo-nautilus-core', circlePolygon(cx, cy, radius * 0.05, 24), {
      strokeTone: 1,
      strokeWidth: 1.5,
      strokeAlpha: 0.5,
      delay: 0.12,
    }),
  );
}

/** 60 珊瑚枝：从底部往上递归分叉（三层），每个枝端一个小芽。 */
function drawCoralBranch(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const baseX = (seed % 2 === 0 ? -1 : 1) * radius * 0.12;
  let counter = 0;
  const fork = (x: number, y: number, angle: number, len: number, width_: number, depth: number, limb: number): void => {
    const ex = x + Math.cos(angle) * len;
    const ey = y + Math.sin(angle) * len;
    counter += 1;
    shapes.push(
      sonnetShape(
        `geo-coral-limb-${counter}`,
        quadraticPolyline(x, y, x + Math.cos(angle + 0.3) * len * 0.5, y + Math.sin(angle + 0.3) * len * 0.5, ex, ey, 16, cx, cy),
        {
          strokeTone: depth === 0 ? 2 : 1,
          strokeWidth: width_,
          strokeAlpha: 0.6 - depth * 0.12,
          delay: 0.02 * depth,
        },
      ),
      sonnetShape(`geo-coral-bud-${counter}`, circlePolygon(cx + ex, cy + ey, width_ * 0.9, 14), {
        fillTone: 2,
        fillAlpha: 0.5,
        strokeTone: -1,
        delay: 0.02 * depth,
      }),
    );
    if (depth < 2) {
      const spread = 0.55 + sonnetHash01(seed, limb, 277) * 0.3;
      fork(ex, ey, angle - spread, len * 0.62, Math.max(1, width_ - 1), depth + 1, limb * 2 + 1);
      fork(ex, ey, angle + spread * 0.8, len * 0.68, Math.max(1, width_ - 1), depth + 1, limb * 2 + 2);
    }
  };
  fork(baseX, radius * 0.62, -Math.PI / 2, radius * 0.34, 3, 0, 0);
  for (let index = 0; index < 5; index += 1) {
    shapes.push(
      sonnetShape(
        `geo-coral-polyp-${index}`,
        circlePolygon(
          cx + baseX + (sonnetHash01(seed, index, 281) - 0.5) * radius * 0.9,
          cy + radius * (0.3 + sonnetHash01(seed, index, 283) * 0.3),
          1.8,
          10,
        ),
        { fillTone: 1, fillAlpha: 0.35, strokeTone: -1, delay: 0.06 },
      ),
    );
  }
}

/** 61 灯塔光束：梯形塔身（**底边不闭合**）+ 灯室与灯点 + 两束光 + 五道海弧。 */
function drawLighthouseBeam(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const direction = seed % 2 === 0 ? 1 : -1;
  const bx = -radius * 0.3 * direction;
  const baseY = radius * 0.42;
  shapes.push(
    sonnetShape(
      'geo-lighthouse-tower',
      [
        cx + bx - radius * 0.09, cy + baseY,
        cx + bx - radius * 0.05, cy + baseY - radius * 0.42,
        cx + bx + radius * 0.05, cy + baseY - radius * 0.42,
        cx + bx + radius * 0.09, cy + baseY,
      ],
      { strokeTone: 1, strokeWidth: 2, strokeAlpha: 0.6 },
    ),
    sonnetShape('geo-lighthouse-lantern', rectPolygon(cx + bx - radius * 0.07, cy + baseY - radius * 0.52, radius * 0.14, radius * 0.1), {
      strokeTone: 1,
      strokeWidth: 1.5,
      strokeAlpha: 0.55,
      delay: 0.04,
    }),
    sonnetShape('geo-lighthouse-lamp', circlePolygon(cx + bx, cy + baseY - radius * 0.47, radius * 0.025, 16), {
      fillTone: 2,
      fillAlpha: 0.9,
      strokeTone: -1,
      delay: 0.06,
    }),
  );
  for (let beam = 0; beam < 2; beam += 1) {
    const spread = radius * (0.1 + beam * 0.12);
    const lampY = cy + baseY - radius * 0.47;
    shapes.push(
      sonnetShape(
        `geo-lighthouse-beam-${beam}-up`,
        [cx + bx, lampY, cx + bx + direction * radius * 0.85, lampY - spread],
        { strokeTone: 2, strokeWidth: 1.5, strokeAlpha: 0.4 - beam * 0.1, delay: 0.04 * beam },
      ),
      sonnetShape(
        `geo-lighthouse-beam-${beam}-down`,
        [cx + bx, lampY, cx + bx + direction * radius * 0.85, lampY + spread],
        { strokeTone: 2, strokeWidth: 1.5, strokeAlpha: 0.4 - beam * 0.1, delay: 0.04 * beam },
      ),
    );
  }
  for (let index = 0; index < 5; index += 1) {
    const x = -radius * 0.6 + index * radius * 0.3;
    shapes.push(
      sonnetShape(`geo-lighthouse-sea-${index}`, arcPolyline(cx + x, cy + radius * 0.56, radius * 0.1, Math.PI, TAU, 14, false), {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.35,
        delay: 0.02 * index,
      }),
    );
  }
}

/** 62 罗盘玫瑰：八根指针（长针隔一根）+ 玫瑰心 + **只在一段弧上**的 25 根刻度。 */
function drawCompassRose(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const roseR = radius * 0.42;
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * TAU - Math.PI / 2;
    const long = index % 2 === 0;
    const len = long ? roseR : roseR * 0.55;
    const halfWidth = long ? 0.09 : 0.06;
    const tx = Math.cos(angle) * len;
    const ty = Math.sin(angle) * len;
    const lx = Math.cos(angle + halfWidth) * roseR * 0.16;
    const ly = Math.sin(angle + halfWidth) * roseR * 0.16;
    const rx = Math.cos(angle - halfWidth) * roseR * 0.16;
    const ry = Math.sin(angle - halfWidth) * roseR * 0.16;
    const polygon = [lx, ly, tx, ty, rx, ry, lx, ly];
    shapes.push(
      sonnetShape(`geo-compass-needle-${index}`, polygon, {
        // 长针是"上下两根"合起来的菱形，所以这里只补一次填充（照抄 `long && i % 4 === 0`）。
        fillTone: long && index % 4 === 0 ? 1 : -1,
        fillAlpha: long && index % 4 === 0 ? 0.1 : 0,
        strokeTone: long ? 1 : 2,
        strokeWidth: long ? 2 : 1,
        strokeAlpha: long ? 0.65 : 0.45,
        delay: 0.02 * index,
      }),
    );
  }
  shapes.push(
    sonnetShape('geo-compass-ring', circlePolygon(cx, cy, roseR * 0.14, 32), {
      strokeTone: 1,
      strokeWidth: 1.5,
      strokeAlpha: 0.6,
    }),
    sonnetShape('geo-compass-core', circlePolygon(cx, cy, roseR * 0.05, 20), {
      fillTone: 2,
      fillAlpha: 0.8,
      strokeTone: -1,
      delay: 0.06,
    }),
  );
  const arcStart = sonnetHash01(seed, 0, 293) * TAU;
  for (let index = 0; index <= 24; index += 1) {
    const angle = arcStart + (index / 24) * Math.PI * 1.2;
    const inner = roseR * 1.12;
    const outer = inner + (index % 6 === 0 ? 10 : 5);
    shapes.push(
      sonnetShape(
        `geo-compass-tick-${index}`,
        [
          cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner,
          cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer,
        ],
        { strokeTone: 1, strokeWidth: 1, strokeAlpha: 0.4 },
      ),
    );
  }
}

/** 63 帆船赛：三条抽象帆船（桅杆 + 弯帆 + 内三角 + **两端开口**的船身）+ 七道水纹。 */
function drawSailRegatta(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  for (let boat = 0; boat < 3; boat += 1) {
    const scale = 1 - boat * 0.24;
    const bx = (boat - 1) * radius * 0.44 + (sonnetHash01(seed, boat, 307) - 0.5) * radius * 0.08;
    const by = radius * (0.28 - boat * 0.12);
    const mastH = radius * 0.34 * scale;
    shapes.push(
      sonnetShape(`geo-sail-mast-${boat}`, [cx + bx, cy + by, cx + bx, cy + by - mastH], {
        strokeTone: 1,
        strokeWidth: 2,
        strokeAlpha: 0.6,
      }),
      sonnetShape(
        `geo-sail-curve-${boat}`,
        quadraticPolyline(0, -mastH, radius * 0.2 * scale, -mastH * 0.55, 0, -mastH * 0.08, 20, cx + bx, cy + by),
        {
          strokeTone: boat === 1 ? 2 : 1,
          strokeWidth: 1.5,
          strokeAlpha: 0.55,
          delay: 0.03 * boat,
        },
      ),
      sonnetShape(
        `geo-sail-inner-${boat}`,
        [cx + bx, cy + by - mastH * 0.92, cx + bx - radius * 0.13 * scale, cy + by - mastH * 0.1, cx + bx, cy + by - mastH * 0.1],
        { strokeTone: 1, strokeWidth: 1, strokeAlpha: 0.4, delay: 0.03 * boat },
      ),
      sonnetShape(
        `geo-sail-hull-${boat}`,
        quadraticPolyline(-radius * 0.15 * scale, 0, 0, radius * 0.07 * scale, radius * 0.15 * scale, 0, 18, cx + bx, cy + by),
        { strokeTone: 1, strokeWidth: 2, strokeAlpha: 0.55, delay: 0.03 * boat },
      ),
    );
  }
  for (let index = 0; index < 7; index += 1) {
    const x = -radius * 0.66 + index * radius * 0.22;
    const y = radius * (0.42 + (index % 2) * 0.05);
    shapes.push(
      sonnetShape(`geo-sail-water-${index}`, [cx + x, cy + y, cx + x + radius * 0.1, cy + y], {
        strokeTone: 2,
        strokeWidth: 1,
        strokeAlpha: 0.35,
        delay: 0.01 * index,
      }),
    );
  }
}

/** 64 气泡上升：三列气泡（数量 5/6/7），大的那些再带一道高光弧。 */
function drawBubbleRise(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  for (let column = 0; column < 3; column += 1) {
    const x = (column - 1) * radius * 0.34 + (sonnetHash01(seed, column, 311) - 0.5) * radius * 0.12;
    const count = 5 + column;
    for (let index = 0; index < count; index += 1) {
      const t = index / count;
      const y = radius * 0.55 - t * radius * 1.05;
      const wobble = (sonnetHash01(seed, column * 10 + index, 313) - 0.5) * radius * 0.08;
      const r = radius * (0.02 + t * 0.055);
      shapes.push(
        sonnetShape(`geo-bubble-${column}-${index}`, circlePolygon(cx + x + wobble, cy + y, r, 20), {
          strokeTone: index % 3 === 0 ? 2 : 1,
          strokeWidth: 1,
          strokeAlpha: 0.35 + t * 0.35,
        }),
      );
      if (r > radius * 0.05) {
        shapes.push(
          sonnetShape(
            `geo-bubble-glint-${column}-${index}`,
            arcPolyline(cx + x + wobble, cy + y, r * 0.55, Math.PI * 1.1, Math.PI * 1.6, 10, false),
            { strokeTone: 2, strokeWidth: 1, strokeAlpha: 0.5 },
          ),
        );
      }
    }
  }
}

/** 65 潮池：四个有机形状的水洼（四段贝塞尔连成）各自带三粒小卵石。 */
function drawTidePools(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  for (let pool = 0; pool < 4; pool += 1) {
    const px = (sonnetHash01(seed, pool, 317) - 0.5) * radius * 0.7;
    const py = (sonnetHash01(seed, pool, 331) - 0.2) * radius * 0.5;
    const pr = radius * (0.16 + sonnetHash01(seed, pool, 337) * 0.12);
    const segments: readonly number[][] = [
      [px + pr, py, px + pr, py - pr * 0.7, px + pr * 0.4, py - pr, px, py - pr * 0.9],
      [px, py - pr * 0.9, px - pr * 0.7, py - pr * 0.8, px - pr, py - pr * 0.2, px - pr * 0.9, py + pr * 0.3],
      [px - pr * 0.9, py + pr * 0.3, px - pr * 0.6, py + pr * 0.8, px + pr * 0.2, py + pr, px + pr * 0.6, py + pr * 0.7],
      [px + pr * 0.6, py + pr * 0.7, px + pr * 0.95, py + pr * 0.5, px + pr, py + pr * 0.3, px + pr, py],
    ];
    const outline: number[] = [];
    for (const segment of segments) {
      const sampled = cubicPolyline(segment, 12, cx, cy);
      outline.push(...(outline.length === 0 ? sampled : sampled.slice(2)));
    }
    shapes.push(
      sonnetShape(`geo-tidepool-${pool}`, outline, {
        strokeTone: pool % 2 === 0 ? 1 : 2,
        strokeWidth: 1.5,
        strokeAlpha: 0.45,
        delay: 0.04 * pool,
      }),
    );
    for (let pebble = 0; pebble < 3; pebble += 1) {
      shapes.push(
        sonnetShape(
          `geo-tidepool-pebble-${pool}-${pebble}`,
          circlePolygon(
            cx + px + (sonnetHash01(seed, pool * 4 + pebble, 347) - 0.5) * pr,
            cy + py + (sonnetHash01(seed, pool * 4 + pebble, 349) - 0.5) * pr * 0.7,
            1.6 + pebble,
            12,
          ),
          { fillTone: 2, fillAlpha: 0.45, strokeTone: -1, delay: 0.04 * pool },
        ),
      );
    }
  }
}

/** 66 海草摇曳：六片自底部升起的海草（各带一个顶端小球）+ 六粒气泡。 */
function drawSeaweedSway(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  for (let blade = 0; blade < 6; blade += 1) {
    const x = -radius * 0.55 + blade * radius * 0.22 + (sonnetHash01(seed, blade, 353) - 0.5) * radius * 0.06;
    const h = radius * (0.4 + sonnetHash01(seed, blade, 359) * 0.3);
    const sway = (blade % 2 === 0 ? 1 : -1) * radius * 0.12;
    shapes.push(
      sonnetShape(
        `geo-seaweed-${blade}`,
        cubicPolyline(
          [
            x, radius * 0.62,
            x + sway, radius * 0.62 - h * 0.4,
            x - sway, radius * 0.62 - h * 0.7,
            x + sway * 0.5, radius * 0.62 - h,
          ],
          22,
          cx,
          cy,
        ),
        {
          strokeTone: blade % 2 === 0 ? 1 : 2,
          strokeWidth: 2,
          strokeAlpha: 0.5 - blade * 0.03,
          delay: 0.03 * blade,
        },
      ),
      sonnetShape(`geo-seaweed-tip-${blade}`, circlePolygon(cx + x + sway * 0.5, cy + radius * 0.62 - h, 2, 10), {
        fillTone: 2,
        fillAlpha: 0.5,
        strokeTone: -1,
        delay: 0.03 * blade,
      }),
    );
  }
  for (let index = 0; index < 6; index += 1) {
    shapes.push(
      sonnetShape(
        `geo-seaweed-bubble-${index}`,
        circlePolygon(
          cx + (sonnetHash01(seed, index, 367) - 0.5) * radius * 1.1,
          cy - radius * 0.5 + sonnetHash01(seed, index, 373) * radius * 0.5,
          1.4 + sonnetHash01(seed, index, 379) * 1.6,
          12,
        ),
        { strokeTone: 1, strokeWidth: 1, strokeAlpha: 0.35, delay: 0.02 * index },
      ),
    );
  }
}

/** 67 深流：五条横贯画面之外的水流线（中间那条用强调色）+ 六条逆流的鱼字纹。 */
function drawDeepCurrent(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, seed: number): void {
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  for (let line = 0; line < 5; line += 1) {
    const y = -radius * 0.4 + line * radius * 0.2;
    const lift = (line % 2 === 0 ? 1 : -1) * radius * 0.06;
    shapes.push(
      sonnetShape(
        `geo-current-${line}`,
        cubicPolyline(
          [-bleed.x, y, -radius * 0.3, y + lift, radius * 0.3, y - lift, bleed.x, y],
          26,
          cx,
          cy,
        ),
        {
          strokeTone: line === 2 ? 2 : 1,
          strokeWidth: line === 2 ? 2 : 1,
          strokeAlpha: 0.32 + (line % 3) * 0.07,
          delay: 0.03 * line,
        },
      ),
    );
  }
  for (let index = 0; index < 6; index += 1) {
    const x = (sonnetHash01(seed, index, 383) - 0.5) * radius * 1.2;
    const y = -radius * 0.3 + sonnetHash01(seed, index, 389) * radius * 0.6;
    const s = 5 + sonnetHash01(seed, index, 397) * 4;
    const flip = index % 2 === 0 ? 1 : -1;
    shapes.push(
      sonnetShape(
        `geo-current-fish-${index}`,
        [cx + x - s * flip, cy + y - s * 0.5, cx + x, cy + y, cx + x - s * flip, cy + y + s * 0.5],
        { strokeTone: 2, strokeWidth: 1.5, strokeAlpha: 0.55, delay: 0.02 * index },
      ),
    );
  }
}

/* ------------------------------------------------------------------ *
 * 扩展主题 · 工艺篇 76~85（照抄 `sonnetShotMgCraft.ts`）
 * 原版这一段是纸艺 / 织物 / 绳结：**用"缺口"表示上下穿插，整个范围里没有裁剪遮罩**
 * ------------------------------------------------------------------ */

export const SONNET_CRAFT_GEO_VARIANTS = [
  'origami-crane',
  'paper-plane-trail',
  'weave-band',
  'knot-loop',
  'stitch-sampler',
  'folded-fan',
  'ribbon-curl',
  'patchwork-trio',
  'dreamcatcher',
  'tassel-drop',
] as const;

/** 76 折纸鹤：全身折线（**只有一处会填充**：抬起的那片翅膀）。 */
function drawOrigamiCrane(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const direction = seed % 2 === 0 ? 1 : -1;
  const s = radius * 0.34;
  shapes.push(
    // 身体：菱形，回到起点 ⇒ 闭合的"箭形"。
    sonnetShape(
      'geo-crane-body',
      [cx, cy - s * 0.3, cx + direction * s * 0.5, cy, cx, cy + s * 0.35, cx - direction * s * 0.5, cy, cx, cy - s * 0.3],
      { strokeTone: 1, strokeWidth: 2, strokeAlpha: 0.6 },
    ),
    // 抬起的翅膀：先是折线，再用另外三个点单独填一次（极淡）。
    sonnetShape(
      'geo-crane-wing',
      [cx, cy - s * 0.3, cx - direction * s * 0.15, cy - s * 0.95, cx + direction * s * 0.28, cy - s * 0.1],
      { strokeTone: 1, strokeWidth: 1.5, strokeAlpha: 0.5, delay: 0.03 },
    ),
    sonnetShape(
      'geo-crane-wing-fold',
      [cx, cy - s * 0.3, cx - direction * s * 0.15, cy - s * 0.95, cx - direction * s * 0.42, cy + s * 0.02, cx, cy - s * 0.3],
      { fillTone: 1, fillAlpha: 0.07, strokeTone: -1, delay: 0.03 },
    ),
    sonnetShape(
      'geo-crane-neck',
      [cx + direction * s * 0.5, cy, cx + direction * s * 0.78, cy - s * 0.62, cx + direction * s * 0.98, cy - s * 0.5],
      { strokeTone: 2, strokeWidth: 1.5, strokeAlpha: 0.6, delay: 0.05 },
    ),
    sonnetShape(
      'geo-crane-tail',
      [cx - direction * s * 0.5, cy, cx - direction * s * 0.85, cy - s * 0.5],
      { strokeTone: 1, strokeWidth: 1.5, strokeAlpha: 0.5, delay: 0.05 },
    ),
    sonnetShape('geo-crane-crease-v', [cx, cy - s * 0.3, cx, cy + s * 0.35], {
      strokeTone: 2,
      strokeWidth: 1,
      strokeAlpha: 0.3,
      delay: 0.07,
    }),
    sonnetShape('geo-crane-crease-h', [cx - direction * s * 0.5, cy, cx + direction * s * 0.5, cy], {
      strokeTone: 2,
      strokeWidth: 1,
      strokeAlpha: 0.3,
      delay: 0.07,
    }),
  );
}

/** 77 纸飞机与航迹：两片折出的三角 + 三条**带缺口**的弧线航迹。 */
function drawPaperPlaneTrail(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const direction = seed % 2 === 0 ? 1 : -1;
  const px = radius * 0.4 * direction;
  const py = -radius * 0.28;
  const s = radius * 0.16;
  shapes.push(
    sonnetShape(
      'geo-plane-body',
      [
        cx + px + direction * s, cy + py,
        cx + px - direction * s * 0.8, cy + py - s * 0.55,
        cx + px - direction * s * 0.35, cy + py,
        cx + px + direction * s, cy + py,
      ],
      { strokeTone: 1, strokeWidth: 2, strokeAlpha: 0.65 },
    ),
    sonnetShape(
      'geo-plane-fold',
      [
        cx + px + direction * s, cy + py,
        cx + px - direction * s * 0.35, cy + py,
        cx + px - direction * s * 0.8, cy + py + s * 0.4,
      ],
      { strokeTone: 2, strokeWidth: 1.5, strokeAlpha: 0.5, delay: 0.03 },
    ),
  );
  for (let segment = 0; segment < 3; segment += 1) {
    const start = Math.PI * (0.1 + segment * 0.55);
    shapes.push(
      sonnetShape(
        `geo-plane-trail-${segment}`,
        arcPolyline(cx + px - direction * radius * 0.35, cy + py + radius * 0.3, radius * (0.34 + segment * 0.06), start, start + Math.PI * 0.4, 16, false),
        {
          strokeTone: segment === 1 ? 2 : 1,
          strokeWidth: 1.5,
          strokeAlpha: 0.45 - segment * 0.08,
          delay: 0.02 * segment,
        },
      ),
    );
  }
}

/** 78 织带：两条横向带被**缺口**切断，七条竖向带压在缺口上。 */
function drawWeaveBand(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  void seed;
  const bandY: readonly number[] = [-radius * 0.12, radius * 0.12];
  const strips = 7;
  bandY.forEach((y, row) => {
    for (let index = 0; index < strips; index += 1) {
      const x0 = -radius * 0.63 + index * radius * 0.18;
      const tone = row === 0 ? 1 : 2;
      if ((index + row) % 2 === 0) {
        // 这一格露在上面：只画中间一截。
        shapes.push(
          sonnetShape(`geo-weave-h-${row}-${index}`, [cx + x0 + radius * 0.02, cy + y, cx + x0 + radius * 0.16, cy + y], {
            strokeTone: tone,
            strokeWidth: 5,
            strokeAlpha: 0.4,
          }),
        );
      } else {
        // 被压住：分成左右两截，缺口留给竖带（**不是遮罩**）。
        shapes.push(
          sonnetShape(`geo-weave-h-${row}-${index}-a`, [cx + x0 - radius * 0.05, cy + y, cx + x0 + radius * 0.02, cy + y], {
            strokeTone: tone,
            strokeWidth: 5,
            strokeAlpha: 0.4,
          }),
          sonnetShape(`geo-weave-h-${row}-${index}-b`, [cx + x0 + radius * 0.16, cy + y, cx + x0 + radius * 0.23, cy + y], {
            strokeTone: tone,
            strokeWidth: 5,
            strokeAlpha: 0.4,
          }),
        );
      }
    }
  });
  for (let index = 0; index < strips; index += 1) {
    const x = -radius * 0.54 + index * radius * 0.18;
    const overRow = index % 2;
    const y = bandY[overRow] ?? 0;
    const otherY = bandY[1 - overRow] ?? 0;
    shapes.push(
      sonnetShape(`geo-weave-v-${index}`, [cx + x, cy + y - radius * 0.05, cx + x, cy + y + radius * 0.05], {
        strokeTone: 1,
        strokeWidth: 6,
        strokeAlpha: 0.6,
      }),
      sonnetShape(`geo-weave-v-thin-${index}`, [cx + x, cy + otherY - radius * 0.03, cx + x, cy + otherY + radius * 0.03], {
        strokeTone: 2,
        strokeWidth: 2,
        strokeAlpha: 0.3,
        delay: 0.02,
      }),
    );
  }
}

/** 79 八字绳结：四段贝塞尔 + 两条甩出去的散头（交叠处用**断开**表示压在上/下）。 */
function drawKnotLoop(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  void seed;
  const s = radius * 0.34;
  const segments: readonly (readonly [number, number, number, number, number, number, number, number])[] = [
    [0, 0, -s * 0.9, -s * 0.9, -s * 1.5, -s * 0.2, -s * 0.8, s * 0.28],
    [-s * 0.62, s * 0.34, -s * 0.3, s * 0.44, -s * 0.12, s * 0.2, 0, 0],
  ];
  segments.forEach((segment, index) => {
    shapes.push(
      sonnetShape(`geo-knot-left-${index}`, cubicPolyline([...segment], 22, cx, cy), {
        strokeTone: 1,
        strokeWidth: 3,
        strokeAlpha: 0.6,
      }),
    );
  });
  const rightSegments: readonly (readonly number[])[] = [
    [s * 0.12, -s * 0.08, s * 0.6, -s * 0.6, s * 1.4, -s * 0.3, s * 0.9, s * 0.2],
    [s * 0.72, s * 0.26, s * 0.4, s * 0.4, s * 0.05, s * 0.14, -s * 0.06, s * 0.04],
  ];
  rightSegments.forEach((segment, index) => {
    shapes.push(
      sonnetShape(`geo-knot-right-${index}`, cubicPolyline([...segment], 22, cx, cy), {
        strokeTone: 2,
        strokeWidth: 3,
        strokeAlpha: 0.6,
      }),
    );
  });
  shapes.push(
    sonnetShape(
      'geo-knot-end-a',
      cubicPolyline([0, 0, -s * 0.2, s * 0.5, -s * 0.4, s * 0.8, -s * 0.3, s * 1.1], 20, cx, cy),
      { strokeTone: 1, strokeWidth: 2, strokeAlpha: 0.4, delay: 0.06 },
    ),
    sonnetShape(
      'geo-knot-end-b',
      cubicPolyline([s * 0.06, -s * 0.02, s * 0.3, -s * 0.5, s * 0.5, -s * 0.8, s * 0.42, -s * 1.05], 20, cx, cy),
      { strokeTone: 2, strokeWidth: 2, strokeAlpha: 0.4, delay: 0.06 },
    ),
  );
}

/** 80 十字绣样本：四排十字（每排条数按 `7 − |row − 1.5|` 取整），越靠边越淡。 */
function drawStitchSampler(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  void seed;
  for (let row = 0; row < 4; row += 1) {
    const y = -radius * 0.36 + row * radius * 0.24;
    const count = 7 - Math.abs(row - 1.5);
    for (let index = 0; index < count; index += 1) {
      const x = (index - (count - 1) / 2) * radius * 0.16 + (row % 2) * radius * 0.08;
      const edgeFade = 1 - Math.abs(index - (count - 1) / 2) / (count / 2 + 0.5);
      const size = 4 + (row % 2);
      const alpha = 0.25 + edgeFade * 0.4;
      const tone = (index + row) % 3 === 0 ? 2 : 1;
      shapes.push(
        sonnetShape(`geo-stitch-s-${row}-${index}-a`, [cx + x - size, cy + y - size, cx + x + size, cy + y + size], {
          strokeTone: tone,
          strokeWidth: 1.5,
          strokeAlpha: alpha,
        }),
        sonnetShape(`geo-stitch-s-${row}-${index}-b`, [cx + x + size, cy + y - size, cx + x - size, cy + y + size], {
          strokeTone: tone,
          strokeWidth: 1.5,
          strokeAlpha: alpha,
        }),
      );
    }
  }
}

/** 81 折扇：11 根扇骨（中间那根最粗）+ 双道护边弧（**上方开口**）+ 轴心点。 */
function drawFoldedFan(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  void seed;
  const pivotY = radius * 0.42;
  const ribs = 11;
  const spread = Math.PI * 0.9;
  for (let index = 0; index < ribs; index += 1) {
    const angle = -Math.PI / 2 - spread / 2 + (index / (ribs - 1)) * spread;
    const len = radius * (0.5 + Math.sin((index / (ribs - 1)) * Math.PI) * 0.12);
    shapes.push(
      sonnetShape(
        `geo-fan-rib-${index}`,
        [cx, cy + pivotY, cx + Math.cos(angle) * len, cy + pivotY + Math.sin(angle) * len],
        {
          strokeTone: index % 2 === 0 ? 1 : 2,
          strokeWidth: index === 5 ? 2.5 : 1.5,
          strokeAlpha: 0.5,
        },
      ),
    );
  }
  shapes.push(
    sonnetShape(
      'geo-fan-guard-outer',
      arcPolyline(cx, cy + pivotY, radius * 0.5, -Math.PI / 2 - spread / 2, -Math.PI / 2 + spread / 2, 40, false),
      { strokeTone: 1, strokeWidth: 2, strokeAlpha: 0.45, delay: 0.06 },
    ),
    sonnetShape(
      'geo-fan-guard-inner',
      arcPolyline(
        cx,
        cy + pivotY,
        radius * 0.58,
        -Math.PI / 2 - spread / 2 + 0.06,
        -Math.PI / 2 + spread / 2 - 0.06,
        44,
        false,
      ),
      { strokeTone: 2, strokeWidth: 1, strokeAlpha: 0.3, delay: 0.06 },
    ),
    sonnetShape('geo-fan-pivot', circlePolygon(cx, cy + pivotY, radius * 0.03, 18), {
      fillTone: 2,
      fillAlpha: 0.8,
      strokeTone: -1,
      delay: 0.08,
    }),
  );
}

/** 82 卷曲缎带：两条平行的采样螺线（主 + 回声）+ 一段向上翘的散头。 */
function drawRibbonCurl(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const ox = radius * 0.15 * (seed % 2 === 0 ? 1 : -1);
  const start = sonnetHash01(seed, 0, 449) * TAU;
  for (const echo of [0, 1]) {
    const offset = echo * radius * 0.035;
    const spiral: number[] = [
      cx + ox + Math.cos(start) * radius * 0.06,
      cy - radius * 0.1 + Math.sin(start) * radius * 0.06 + offset,
    ];
    const steps = 64;
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps;
      const angle = start + t * TAU * 2.4;
      const r = radius * (0.06 + t * 0.42);
      spiral.push(cx + ox + Math.cos(angle) * r, cy - radius * 0.1 + Math.sin(angle) * r * 0.8 + offset);
    }
    shapes.push(
      sonnetShape(`geo-ribbon-curl-${echo}`, spiral, {
        strokeTone: echo === 0 ? 1 : 2,
        strokeWidth: echo === 0 ? 3 : 1,
        strokeAlpha: echo === 0 ? 0.55 : 0.3,
        delay: 0.03 * echo,
      }),
    );
  }
  const endAngle = start + TAU * 2.4;
  const ex = ox + Math.cos(endAngle) * radius * 0.48;
  const ey = -radius * 0.1 + Math.sin(endAngle) * radius * 0.38;
  shapes.push(
    sonnetShape(
      'geo-ribbon-flick',
      quadraticPolyline(ex, ey, ex + radius * 0.1, ey - radius * 0.12, ex + radius * 0.16, ey - radius * 0.04, 18, cx, cy),
      { strokeTone: 1, strokeWidth: 2, strokeAlpha: 0.5, delay: 0.06 },
    ),
  );
}

/** 83 拼布三片：三个交叠三角（各带三条**内部算出来**的斜纹，不需要遮罩）。 */
function drawPatchworkTrio(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  void seed;
  const configs: readonly (readonly [number, number, number, boolean])[] = [
    [-radius * 0.22, -radius * 0.05, radius * 0.3, true],
    [radius * 0.18, -radius * 0.12, radius * 0.24, false],
    [radius * 0.05, radius * 0.2, radius * 0.2, true],
  ];
  configs.forEach(([x, y, s, up], index) => {
    const topY = up ? y - s * 0.6 : y;
    const baseY = up ? y + s * 0.4 : y + s;
    shapes.push(
      sonnetShape(
        `geo-patch-tri-${index}`,
        [cx + x, cy + topY, cx + x + s * 0.55, cy + baseY, cx + x - s * 0.55, cy + baseY, cx + x, cy + topY],
        {
          strokeTone: index === 1 ? 2 : 1,
          strokeWidth: 2,
          strokeAlpha: 0.55,
          delay: 0.03 * index,
        },
      ),
    );
    for (let stripe = 1; stripe <= 3; stripe += 1) {
      const t = stripe / 4;
      const sy = topY + (baseY - topY) * t;
      const half = s * 0.55 * (up ? t : 1 - t);
      shapes.push(
        sonnetShape(`geo-patch-stripe-${index}-${stripe}`, [cx + x - half, cy + sy, cx + x + half, cy + sy], {
          strokeTone: index === 1 ? 1 : 2,
          strokeWidth: 1,
          strokeAlpha: 0.35,
          delay: 0.03 * index,
        }),
      );
    }
  });
}

/** 84 捕梦网：圆环 + 八条蛛网线（连到偏心的小圈）+ 三条垂下的羽毛（羽枝是斜线）。 */
function drawDreamcatcher(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const ringR = radius * 0.32;
  const ringY = -radius * 0.12;
  shapes.push(
    sonnetShape('geo-dream-ring', circlePolygon(cx, cy + ringY, ringR, 64), {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.6,
    }),
  );
  const hubX = radius * 0.05;
  const hubY = ringY - radius * 0.03;
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * TAU + 0.2;
    shapes.push(
      sonnetShape(
        `geo-dream-web-${index}`,
        [
          cx + Math.cos(angle) * ringR * 0.92, cy + ringY + Math.sin(angle) * ringR * 0.92,
          cx + hubX, cy + hubY,
        ],
        { strokeTone: index % 2 === 0 ? 1 : 2, strokeWidth: 1, strokeAlpha: 0.4 },
      ),
    );
  }
  shapes.push(
    sonnetShape('geo-dream-hub', circlePolygon(cx + hubX, cy + hubY, radius * 0.035, 20), {
      strokeTone: 2,
      strokeWidth: 1.5,
      strokeAlpha: 0.6,
      delay: 0.06,
    }),
  );
  for (let index = -1; index <= 1; index += 1) {
    const sx = index * ringR * 0.55;
    // 从环上往下挂：`topY` 取环在该横坐标处的下沿。
    const topY = ringY + Math.sqrt(Math.max(0, ringR * ringR - sx * sx));
    const len = radius * (0.22 + (1 - Math.abs(index)) * 0.12 + sonnetHash01(seed, index + 1, 457) * 0.06);
    shapes.push(
      sonnetShape(`geo-dream-string-${index + 1}`, [cx + sx, cy + topY, cx + sx, cy + topY + len], {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.45,
        delay: 0.04,
      }),
    );
    const featherY = topY + len;
    shapes.push(
      sonnetShape(`geo-dream-feather-${index + 1}`, [cx + sx, cy + featherY, cx + sx, cy + featherY + radius * 0.12], {
        strokeTone: 2,
        strokeWidth: 1.5,
        strokeAlpha: 0.55,
        delay: 0.04,
      }),
    );
    for (let barb = 1; barb <= 3; barb += 1) {
      const by = featherY + barb * radius * 0.03;
      const bl = radius * 0.04 * (1 - barb * 0.18);
      shapes.push(
        sonnetShape(`geo-dream-barb-${index + 1}-${barb}-l`, [cx + sx, cy + by, cx + sx - bl, cy + by + radius * 0.02], {
          strokeTone: 2,
          strokeWidth: 1,
          strokeAlpha: 0.4,
        }),
        sonnetShape(`geo-dream-barb-${index + 1}-${barb}-r`, [cx + sx, cy + by, cx + sx + bl, cy + by + radius * 0.02], {
          strokeTone: 2,
          strokeWidth: 1,
          strokeAlpha: 0.4,
        }),
      );
    }
  }
}

/** 85 流苏帘：一根短横杆 + 七条**长短不一**的垂线（各带一粒珠）。 */
function drawTasselDrop(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const barY = -radius * 0.4;
  shapes.push(
    sonnetShape('geo-tassel-bar', [cx - radius * 0.3, cy + barY, cx + radius * 0.3, cy + barY], {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.4,
    }),
  );
  const threads = 7;
  for (let index = 0; index < threads; index += 1) {
    const x = -radius * 0.27 + index * radius * 0.09;
    const len = radius * (0.3 + sonnetHash01(seed, index, 461) * 0.35);
    const sway = (sonnetHash01(seed, index, 463) - 0.5) * radius * 0.08;
    shapes.push(
      sonnetShape(
        `geo-tassel-thread-${index}`,
        quadraticPolyline(x, barY, x + sway, barY + len * 0.6, x + sway * 0.6, barY + len, 18, cx, cy),
        {
          strokeTone: index % 2 === 0 ? 1 : 2,
          strokeWidth: 1.5,
          strokeAlpha: 0.45,
          delay: 0.02 * index,
        },
      ),
      sonnetShape(
        `geo-tassel-bead-${index}`,
        circlePolygon(cx + x + sway * 0.6, cy + barY + len + 3, 2.5, 12),
        { fillTone: index % 3 === 0 ? 2 : 1, fillAlpha: 0.6, strokeTone: -1, delay: 0.02 * index },
      ),
    );
  }
}

/* ------------------------------------------------------------------ *
 * 扩展主题 · 动态篇 86~99（照抄 `sonnetShotMgKinetic.ts`）
 * 原版这一段用"错相位的一堆静态姿势"表示运动（摆、多米诺、涟漪），同样**不画闭合边框**
 * ------------------------------------------------------------------ */

export const SONNET_KINETIC_GEO_VARIANTS = [
  'pendulum-wave',
  'domino-arc',
  'gear-cluster',
  'circuit-delta',
  'signal-tower',
  'spiral-stair',
  'waterfall-lines',
  'pinwheel',
  'ripple-drop',
  'suspension-bridge',
  'field-lines',
  'prism-beam',
  'echo-arcs',
  'kite-string',
] as const;

/** 86 摆波：九根摆线沿一条弧排开、各摆到不同相位，最上面一根横梁。 */
function drawPendulumWave(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const pivotY = -radius * 0.42;
  const bobs = 9;
  for (let index = 0; index < bobs; index += 1) {
    const x = -radius * 0.5 + (index / (bobs - 1)) * radius;
    const len = radius * (0.4 + index * 0.035);
    const swing = Math.sin(index * 0.9 + seed * 0.07) * 0.35;
    const bx = x + Math.sin(swing) * len;
    const by = pivotY + Math.cos(swing) * len;
    shapes.push(
      sonnetShape(`geo-pendulum-string-${index}`, [cx + x, cy + pivotY, cx + bx, cy + by], {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.4,
      }),
      sonnetShape(`geo-pendulum-bob-${index}`, circlePolygon(cx + bx, cy + by, 3.5 + (index % 3), 16), {
        fillTone: index % 2 === 0 ? 2 : 1,
        fillAlpha: 0.7,
        strokeTone: -1,
        delay: 0.01 * index,
      }),
    );
  }
  shapes.push(
    sonnetShape('geo-pendulum-beam', [cx - radius * 0.58, cy + pivotY, cx + radius * 0.58, cy + pivotY], {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.35,
      delay: 0.06,
    }),
  );
}

/** 87 多米诺：十张骨牌沿弧排开、越到后面倒得越多（闭合四边形）。 */
function drawDominoArc(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const count = 10;
  const arcR = radius * 0.55;
  for (let index = 0; index < count; index += 1) {
    const angle = Math.PI * 1.15 + (index / (count - 1)) * Math.PI * 0.7;
    const bx = Math.cos(angle) * arcR;
    const by = Math.sin(angle) * arcR + radius * 0.5;
    const tilt = (index / (count - 1)) * 1.1 * (seed % 2 === 0 ? 1 : -1);
    const w = radius * 0.035;
    const h = radius * 0.14;
    const cos = Math.cos(tilt);
    const sin = Math.sin(tilt);
    const corner = (lx: number, ly: number): readonly [number, number] => [
      cx + bx + lx * cos - ly * sin,
      cy + by + lx * sin + ly * cos,
    ];
    const [x1, y1] = corner(-w, 0);
    const [x2, y2] = corner(w, 0);
    const [x3, y3] = corner(w, -h * 2);
    const [x4, y4] = corner(-w, -h * 2);
    shapes.push(
      sonnetShape(`geo-domino-${index}`, [x1, y1, x2, y2, x3, y3, x4, y4, x1, y1], {
        strokeTone: index % 3 === 0 ? 2 : 1,
        strokeWidth: 1.5,
        strokeAlpha: 0.55,
        delay: 0.02 * index,
      }),
    );
  }
}

/** 88 齿轮组：三个互相咬合的齿轮（圈 + 轴 + 齿），齿数 10/8/7。 */
function drawGearCluster(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const gears: readonly (readonly [number, number, number, number])[] = [
    [0, 0, radius * 0.26, 10],
    [radius * 0.42, -radius * 0.2, radius * 0.16, 8],
    [-radius * 0.4, radius * 0.22, radius * 0.13, 7],
  ];
  gears.forEach(([gx, gy, gr, teeth], gearIndex) => {
    const tone = gearIndex === 1 ? 2 : 1;
    shapes.push(
      sonnetShape(`geo-gear-ring-${gearIndex}`, circlePolygon(cx + gx, cy + gy, gr, 48), {
        strokeTone: tone,
        strokeWidth: 2,
        strokeAlpha: 0.55,
      }),
      sonnetShape(`geo-gear-hub-${gearIndex}`, circlePolygon(cx + gx, cy + gy, gr * 0.3, 24), {
        strokeTone: tone,
        strokeWidth: 1.5,
        strokeAlpha: 0.45,
        delay: 0.03,
      }),
    );
    const offset = sonnetHash01(seed, gearIndex, 467) * TAU;
    for (let tooth = 0; tooth < teeth; tooth += 1) {
      const angle = offset + (tooth / teeth) * TAU;
      shapes.push(
        sonnetShape(
          `geo-gear-tooth-${gearIndex}-${tooth}`,
          [
            cx + gx + Math.cos(angle) * gr, cy + gy + Math.sin(angle) * gr,
            cx + gx + Math.cos(angle) * gr * 1.18, cy + gy + Math.sin(angle) * gr * 1.18,
          ],
          { strokeTone: tone, strokeWidth: 3, strokeAlpha: 0.5 },
        ),
      );
    }
  });
}

/** 89 电路走线：四条横贯画外的走线（各带一个 45° 折角焊点），**没有板框**。 */
function drawCircuitDelta(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, seed: number): void {
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  const lanes = 4;
  for (let lane = 0; lane < lanes; lane += 1) {
    const y = -radius * 0.36 + lane * radius * 0.24;
    const bendX = -radius * 0.3 + sonnetHash01(seed, lane, 479) * radius * 0.6;
    const drop = (lane % 2 === 0 ? 1 : -1) * radius * 0.08;
    shapes.push(
      sonnetShape(
        `geo-circuit-lane-${lane}`,
        [
          cx - bleed.x, cy + y,
          cx + bendX - Math.abs(drop), cy + y,
          cx + bendX, cy + y + drop,
          cx + bleed.x, cy + y + drop,
        ],
        {
          strokeTone: lane === 1 ? 2 : 1,
          strokeWidth: 1.5,
          strokeAlpha: 0.45,
          delay: 0.03 * lane,
        },
      ),
      sonnetShape(`geo-circuit-pad-${lane}`, circlePolygon(cx + bendX, cy + y + drop, 3, 14), {
        fillTone: 2,
        fillAlpha: 0.7,
        strokeTone: -1,
        delay: 0.05,
      }),
      sonnetShape(`geo-circuit-via-${lane}`, circlePolygon(cx - bleed.x * 0.55, cy + y, 2.5, 12), {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.5,
        delay: 0.05,
      }),
    );
  }
}

/** 90 信号塔：三角塔身 + 三道横撑 + 塔顶灯 + **左右各三段**辐射弧。 */
function drawSignalTower(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, _seed: number): void {
  const baseY = radius * 0.45;
  const topY = -radius * 0.3;
  shapes.push(
    sonnetShape('geo-signal-mast', [cx - radius * 0.12, cy + baseY, cx, cy + topY, cx + radius * 0.12, cy + baseY], {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.6,
    }),
  );
  for (let brace = 1; brace <= 3; brace += 1) {
    const y = baseY - (baseY - topY) * (brace / 4);
    const half = radius * 0.12 * (1 - brace / 4.5);
    shapes.push(
      sonnetShape(`geo-signal-brace-${brace}`, [cx - half, cy + y, cx + half, cy + y - radius * 0.06], {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.4,
        delay: 0.02 * brace,
      }),
    );
  }
  shapes.push(
    sonnetShape('geo-signal-lamp', circlePolygon(cx, cy + topY, radius * 0.03, 16), {
      fillTone: 2,
      fillAlpha: 0.9,
      strokeTone: -1,
      delay: 0.06,
    }),
  );
  for (let side = -1; side <= 1; side += 2) {
    for (let ring = 0; ring < 3; ring += 1) {
      const r = radius * (0.12 + ring * 0.13);
      const from = side < 0 ? Math.PI * 0.75 : -Math.PI * 0.25;
      const to = side < 0 ? Math.PI * 1.25 : Math.PI * 0.25;
      shapes.push(
        sonnetShape(`geo-signal-wave-${side}-${ring}`, arcPolyline(cx, cy + topY, r, from, to, 18, false), {
          strokeTone: ring === 1 ? 2 : 1,
          strokeWidth: 1.5,
          strokeAlpha: 0.45 - ring * 0.1,
          delay: 0.02 * ring,
        }),
      );
    }
  }
}

/** 91 旋转楼梯：十二级踏步（每级一条踏面 + 一条竖板）+ 顶端**开口**的中心柱。 */
function drawSpiralStair(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const steps = 12;
  const startAngle = sonnetHash01(seed, 0, 487) * TAU;
  for (let index = 0; index < steps; index += 1) {
    const angle = startAngle + index * 0.42;
    const r = radius * (0.14 + index * 0.04);
    const x = Math.cos(angle) * r;
    const y = radius * 0.4 - index * radius * 0.055;
    const tread = radius * 0.09;
    const tx = x + Math.cos(angle) * tread;
    const ty = y + Math.sin(angle) * tread * 0.4;
    shapes.push(
      sonnetShape(`geo-stair-tread-${index}`, [cx + x, cy + y, cx + tx, cy + ty], {
        strokeTone: index % 3 === 0 ? 2 : 1,
        strokeWidth: 2,
        strokeAlpha: 0.55,
        delay: 0.015 * index,
      }),
      sonnetShape(`geo-stair-riser-${index}`, [cx + tx, cy + ty, cx + tx, cy + ty - radius * 0.055], {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.35,
        delay: 0.015 * index,
      }),
    );
  }
  shapes.push(
    sonnetShape('geo-stair-spine', [cx, cy + radius * 0.45, cx, cy - radius * 0.35], {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.3,
      delay: 0.1,
    }),
  );
}

/** 92 瀑布线：九条**长短不一**的垂落线 + 五道下方溅起的水弧。 */
function drawWaterfallLines(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const streams = 9;
  for (let index = 0; index < streams; index += 1) {
    const x = -radius * 0.5 + (index / (streams - 1)) * radius + (sonnetHash01(seed, index, 491) - 0.5) * radius * 0.05;
    const topY = -radius * 0.6 + sonnetHash01(seed, index, 499) * radius * 0.15;
    const len = radius * (0.55 + sonnetHash01(seed, index, 503) * 0.35);
    shapes.push(
      sonnetShape(`geo-waterfall-${index}`, [cx + x, cy + topY, cx + x, cy + topY + len], {
        strokeTone: index % 3 === 0 ? 2 : 1,
        strokeWidth: index % 3 === 0 ? 2 : 1,
        strokeAlpha: 0.4 + (index % 3) * 0.08,
        delay: 0.01 * index,
      }),
    );
  }
  for (let index = 0; index < 5; index += 1) {
    const x = -radius * 0.4 + index * radius * 0.2;
    shapes.push(
      sonnetShape(`geo-waterfall-splash-${index}`, arcPolyline(cx + x, cy + radius * 0.5, radius * 0.07, Math.PI, TAU, 12, false), {
        strokeTone: 2,
        strokeWidth: 1,
        strokeAlpha: 0.4,
        delay: 0.02 * index,
      }),
    );
  }
}

/** 93 风车：四片弯曲叶片（各带一根斜撑）+ 轴心 + 一圈极淡的外框。 */
function drawPinwheel(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const hubR = radius * 0.05;
  for (let blade = 0; blade < 4; blade += 1) {
    const angle = (blade / 4) * TAU + sonnetHash01(seed, 0, 509) * 0.5;
    const tipR = radius * 0.5;
    const tx = Math.cos(angle) * tipR;
    const ty = Math.sin(angle) * tipR;
    const edgeAngle = angle + 0.7;
    const tone = blade % 2 === 0 ? 1 : 2;
    shapes.push(
      sonnetShape(
        `geo-pinwheel-sail-${blade}`,
        quadraticPolyline(
          Math.cos(angle) * hubR,
          Math.sin(angle) * hubR,
          Math.cos(edgeAngle) * tipR * 0.55,
          Math.sin(edgeAngle) * tipR * 0.55,
          tx,
          ty,
          20,
          cx,
          cy,
        ),
        { strokeTone: tone, strokeWidth: 2, strokeAlpha: 0.55, delay: 0.02 * blade },
      ),
      sonnetShape(
        `geo-pinwheel-spar-${blade}`,
        [cx + tx, cy + ty, cx + Math.cos(angle + 0.45) * tipR * 0.62, cy + Math.sin(angle + 0.45) * tipR * 0.62],
        { strokeTone: tone, strokeWidth: 1.5, strokeAlpha: 0.4, delay: 0.02 * blade },
      ),
    );
  }
  shapes.push(
    sonnetShape('geo-pinwheel-hub', circlePolygon(cx, cy, hubR, 20), {
      fillTone: 2,
      fillAlpha: 0.8,
      strokeTone: -1,
      delay: 0.06,
    }),
    sonnetShape('geo-pinwheel-rim', circlePolygon(cx, cy, radius * 0.56, 72), {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.15,
      delay: 0.08,
    }),
  );
}

/** 94 涟漪滴落：一滴水 + 四圈**带缺口**的涟漪 + 两笔溅起的水冠。 */
function drawRippleDrop(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const dx = (sonnetHash01(seed, 0, 521) - 0.5) * radius * 0.2;
  shapes.push(
    sonnetShape(
      'geo-ripple-drop',
      [
        cx + dx, cy - radius * 0.52,
        ...cubicPolyline(
          [
            dx + radius * 0.07, -radius * 0.36,
            dx + radius * 0.06, -radius * 0.3,
            dx, -radius * 0.27,
          ],
          14,
          cx,
          cy,
        ).slice(2),
        ...cubicPolyline(
          [
            dx - radius * 0.06, -radius * 0.3,
            dx - radius * 0.07, -radius * 0.36,
            dx, -radius * 0.52,
          ],
          14,
          cx,
          cy,
        ).slice(2),
      ],
      { strokeTone: 2, strokeWidth: 2, strokeAlpha: 0.65 },
    ),
  );
  for (let ring = 0; ring < 4; ring += 1) {
    const r = radius * (0.14 + ring * 0.13);
    const y = radius * 0.25;
    const gapAt = sonnetHash01(seed, ring, 523) * TAU;
    shapes.push(
      sonnetShape(`geo-ripple-ring-${ring}`, arcPolyline(cx + dx, cy + y, r, gapAt, gapAt + TAU * 0.72, 32, false), {
        strokeTone: ring % 2 === 0 ? 1 : 2,
        strokeWidth: ring === 0 ? 2 : 1,
        strokeAlpha: 0.5 - ring * 0.09,
        delay: 0.03 * ring,
      }),
    );
  }
  shapes.push(
    sonnetShape('geo-ripple-crown-l', [cx + dx - radius * 0.05, cy + radius * 0.2, cx + dx - radius * 0.02, cy + radius * 0.12], {
      strokeTone: 1,
      strokeWidth: 1.5,
      strokeAlpha: 0.5,
      delay: 0.1,
    }),
    sonnetShape('geo-ripple-crown-r', [cx + dx + radius * 0.05, cy + radius * 0.2, cx + dx + radius * 0.02, cy + radius * 0.12], {
      strokeTone: 1,
      strokeWidth: 1.5,
      strokeAlpha: 0.5,
      delay: 0.1,
    }),
  );
}

/** 95 悬索桥：两端伸出画外的桥面、两座桥塔、三段主缆、六根吊索。 */
function drawSuspensionBridge(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, _seed: number): void {
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  const deckY = radius * 0.3;
  const towerX = radius * 0.34;
  const towerTop = -radius * 0.28;
  shapes.push(
    sonnetShape('geo-bridge-deck', [cx - bleed.x, cy + deckY, cx + bleed.x, cy + deckY], {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.5,
    }),
  );
  for (const side of [-1, 1]) {
    const x = side * towerX;
    shapes.push(
      sonnetShape(`geo-bridge-tower-${side}-a`, [cx + x - radius * 0.03, cy + deckY, cx + x - radius * 0.03, cy + towerTop], {
        strokeTone: 1,
        strokeWidth: 2,
        strokeAlpha: 0.55,
      }),
      sonnetShape(`geo-bridge-tower-${side}-b`, [cx + x + radius * 0.03, cy + deckY, cx + x + radius * 0.03, cy + towerTop], {
        strokeTone: 1,
        strokeWidth: 2,
        strokeAlpha: 0.55,
      }),
      sonnetShape(
        `geo-bridge-crossbeam-${side}`,
        [cx + x - radius * 0.04, cy + towerTop + radius * 0.08, cx + x + radius * 0.04, cy + towerTop + radius * 0.08],
        { strokeTone: 2, strokeWidth: 1.5, strokeAlpha: 0.45, delay: 0.04 },
      ),
    );
  }
  // 主缆分三段（三次二次曲线），两端都伸出画面之外。
  shapes.push(
    sonnetShape(
      'geo-bridge-cable-left',
      quadraticPolyline(-bleed.x, deckY - radius * 0.1, -towerX, towerTop - radius * 0.06, -towerX, towerTop, 22, cx, cy),
      { strokeTone: 2, strokeWidth: 1.5, strokeAlpha: 0.5, delay: 0.04 },
    ),
    sonnetShape(
      'geo-bridge-cable-mid',
      quadraticPolyline(-towerX, towerTop, 0, deckY - radius * 0.04, towerX, towerTop, 26, cx, cy),
      { strokeTone: 2, strokeWidth: 1.5, strokeAlpha: 0.5, delay: 0.04 },
    ),
    sonnetShape(
      'geo-bridge-cable-right',
      quadraticPolyline(towerX, towerTop, bleed.x, deckY - radius * 0.1, bleed.x, deckY - radius * 0.06, 22, cx, cy),
      { strokeTone: 2, strokeWidth: 1.5, strokeAlpha: 0.5, delay: 0.04 },
    ),
  );
  for (let index = 1; index < 7; index += 1) {
    const t = index / 7;
    const x = -towerX + t * towerX * 2;
    // 中跨主缆在 t 处的高度（二次 Bezier 的取点公式，照抄）。
    const cableY = (1 - t) * (1 - t) * towerTop + 2 * (1 - t) * t * (deckY - radius * 0.04) + t * t * towerTop;
    shapes.push(
      sonnetShape(`geo-bridge-hanger-${index}`, [cx + x, cy + cableY, cx + x, cy + deckY], {
        strokeTone: 1,
        strokeWidth: 1,
        strokeAlpha: 0.35,
        delay: 0.02 * index,
      }),
    );
  }
}

/** 96 磁力线：四个逐渐变大的环（上下镜像各一条），两端各一个极。 */
function drawFieldLines(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, _seed: number): void {
  const poleGap = radius * 0.2;
  for (let loop = 0; loop < 4; loop += 1) {
    const bulge = radius * (0.2 + loop * 0.16);
    for (const mirror of [-1, 1]) {
      shapes.push(
        sonnetShape(
          `geo-field-${loop}-${mirror}`,
          cubicPolyline(
            [
              0, -poleGap,
              mirror * bulge, -poleGap - radius * 0.1,
              mirror * bulge, poleGap + radius * 0.1,
              0, poleGap,
            ],
            26,
            cx,
            cy,
          ),
          {
            strokeTone: loop % 2 === 0 ? 1 : 2,
            strokeWidth: loop === 0 ? 2 : 1,
            strokeAlpha: 0.5 - loop * 0.08,
            delay: 0.03 * loop,
          },
        ),
      );
    }
  }
  shapes.push(
    sonnetShape('geo-field-pole-n', circlePolygon(cx, cy - poleGap, radius * 0.04, 18), {
      fillTone: 2,
      fillAlpha: 0.85,
      strokeTone: -1,
      delay: 0.12,
    }),
    sonnetShape('geo-field-pole-s', circlePolygon(cx, cy + poleGap, radius * 0.04, 18), {
      fillTone: 1,
      fillAlpha: 0.85,
      strokeTone: -1,
      delay: 0.12,
    }),
    sonnetShape('geo-field-bar-n', [cx - radius * 0.1, cy - poleGap, cx + radius * 0.1, cy - poleGap], {
      strokeTone: 2,
      strokeWidth: 1.5,
      strokeAlpha: 0.5,
      delay: 0.12,
    }),
    sonnetShape('geo-field-bar-s', [cx - radius * 0.1, cy + poleGap, cx + radius * 0.1, cy + poleGap], {
      strokeTone: 1,
      strokeWidth: 1.5,
      strokeAlpha: 0.5,
      delay: 0.12,
    }),
  );
}

/** 97 棱镜分光：一束从画外进来、被三角形分成四束扇形出去。 */
function drawPrismBeam(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, _seed: number): void {
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  const s = radius * 0.24;
  const topY = -s * 0.7;
  const baseY = s * 0.55;
  shapes.push(
    sonnetShape('geo-prism-body', [cx, cy + topY, cx + s * 0.8, cy + baseY, cx - s * 0.8, cy + baseY, cx, cy + topY], {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.6,
    }),
    sonnetShape('geo-prism-glass', [cx, cy + topY, cx + s * 0.8, cy + baseY, cx - s * 0.8, cy + baseY, cx, cy + topY], {
      fillTone: 1,
      fillAlpha: 0.06,
      strokeTone: -1,
      delay: 0.02,
    }),
  );
  const entryX = -s * 0.35;
  const entryY = s * 0.05;
  shapes.push(
    sonnetShape('geo-prism-inbound', [cx - bleed.x, cy + entryY + radius * 0.12, cx + entryX, cy + entryY], {
      strokeTone: 2,
      strokeWidth: 2.5,
      strokeAlpha: 0.6,
    }),
  );
  for (let ray = 0; ray < 4; ray += 1) {
    const exitY = -radius * 0.1 + ray * radius * 0.09;
    shapes.push(
      sonnetShape(
        `geo-prism-ray-${ray}`,
        [cx + s * 0.4, cy + entryY - radius * 0.05, cx + bleed.x, cy + exitY],
        {
          strokeTone: ray === 1 ? 2 : 1,
          strokeWidth: 1.5,
          strokeAlpha: 0.45 - ray * 0.05,
          delay: 0.03 * ray,
        },
      ),
    );
  }
}

/** 98 回声弧：五段在两面"看不见的墙"之间来回弹的弧（奇偶方向相反）。 */
function drawEchoArcs(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, _seed: number): void {
  for (let hop = 0; hop < 5; hop += 1) {
    const side = hop % 2 === 0 ? -1 : 1;
    const ox = side * radius * 0.52;
    const oy = -radius * 0.35 + hop * radius * 0.18;
    const r = radius * (0.14 + hop * 0.045);
    const from = side < 0 ? -Math.PI / 2 : Math.PI / 2;
    const to = side < 0 ? Math.PI / 2 : Math.PI * 1.5;
    shapes.push(
      sonnetShape(`geo-echo-arc-${hop}`, arcPolyline(cx + ox, cy + oy, r, from, to, 26, false), {
        strokeTone: hop % 2 === 0 ? 1 : 2,
        strokeWidth: 2 - hop * 0.2,
        strokeAlpha: 0.55 - hop * 0.07,
        delay: 0.03 * hop,
      }),
      sonnetShape(
        `geo-echo-dot-${hop}`,
        circlePolygon(cx + ox + (side < 0 ? r : -r) * 0.4, cy + oy + r * 0.6, 1.8, 12),
        { fillTone: 2, fillAlpha: 0.5, strokeTone: -1, delay: 0.03 * hop },
      ),
    );
  }
}

/** 99 风筝与线：菱形风筝（带十字骨与极淡填充）+ 一条采样出下垂的线 + 三个蝴蝶结。 */
function drawKiteString(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const kx = radius * 0.22 * (seed % 2 === 0 ? 1 : -1);
  const ky = -radius * 0.3;
  const kw = radius * 0.16;
  const kh = radius * 0.22;
  const outline = [kx, ky - kh, kx + kw, ky, kx, ky + kh, kx - kw, ky, kx, ky - kh];
  shapes.push(
    sonnetShape('geo-kite-body', outline, { strokeTone: 1, strokeWidth: 2, strokeAlpha: 0.6 }),
    sonnetShape('geo-kite-spar-v', [cx + kx, cy + ky - kh, cx + kx, cy + ky + kh], {
      strokeTone: 2,
      strokeWidth: 1,
      strokeAlpha: 0.4,
      delay: 0.02,
    }),
    sonnetShape('geo-kite-spar-h', [cx + kx - kw, cy + ky, cx + kx + kw, cy + ky], {
      strokeTone: 2,
      strokeWidth: 1,
      strokeAlpha: 0.4,
      delay: 0.02,
    }),
    sonnetShape('geo-kite-glass', outline, { fillTone: 1, fillAlpha: 0.06, strokeTone: -1, delay: 0.02 }),
  );
  // 线是**一整条**采样出来的（所以它会"整条一起长出来"），蝴蝶结另开命令。
  const stringPoints: number[] = [cx + kx, cy + ky + kh];
  const bows: { x: number; y: number }[] = [];
  const stringSteps = 24;
  for (let index = 1; index <= stringSteps; index += 1) {
    const t = index / stringSteps;
    const x = kx - t * radius * 0.5 + Math.sin(t * Math.PI * 2.2) * radius * 0.08;
    const y = ky + kh + t * radius * 0.6;
    stringPoints.push(cx + x, cy + y);
    if (index === 7 || index === 13 || index === 19) bows.push({ x, y });
  }
  shapes.push(
    sonnetShape('geo-kite-string', stringPoints, { strokeTone: 1, strokeWidth: 1.5, strokeAlpha: 0.5, delay: 0.06 }),
  );
  bows.forEach(({ x, y }, index) => {
    const bowS = radius * 0.035;
    shapes.push(
      sonnetShape(
        `geo-kite-bow-${index}`,
        [
          cx + x, cy + y,
          cx + x - bowS, cy + y - bowS,
          cx + x, cy + y - bowS * 0.3,
          cx + x + bowS, cy + y - bowS,
          cx + x, cy + y,
        ],
        { strokeTone: 2, strokeWidth: 1, strokeAlpha: 0.55, delay: 0.08 },
      ),
    );
  });
}

/* ------------------------------------------------------------------ *
 * 主题图形 24~35 的第一段：花木篇 24~26（照抄 `sonnetShotMgFlora.ts` + 图元文件）
 * ------------------------------------------------------------------ */

export const SONNET_THEMED_GEO_VARIANTS = [
  'camellia',
  'tulip-field',
  'wildflower',
  'fern',
  'ginkgo',
  'climbing-vine',
  'greenhouse',
  'pagoda',
  'city-facade',
  'terraces',
  'mountain-lake',
  'coastal-cliff',
] as const;

/**
 * 主题图形的共用图元：**带中脉的叶片 / 花瓣**，照抄 `sonnetThemedShotMgPrimitives.ts`
 * 的 `drawLeaf`（`drawPetal` 就是它本身）。原版这一笔由三段命令组成：
 * ① 两段二次曲线围成的闭合叶片**填充**；② 同一条路径再**描边**（透明度 = `min(0.8, 填充 × 3.2)`）；
 * ③ 从根部到尖端的一条**中脉**。
 */
function drawThemedLeaf(
  shapes: SonnetShapeSpec[],
  cx: number,
  cy: number,
  ox: number,
  oy: number,
  length: number,
  width: number,
  angle: number,
  tone: number,
  fillAlpha: number,
  id: string,
  delay = 0,
): void {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const nx = -dy;
  const ny = dx;
  const tipX = ox + dx * length;
  const tipY = oy + dy * length;
  const midX = ox + dx * length * 0.45;
  const midY = oy + dy * length * 0.45;
  const outline = [
    ...quadraticPolyline(ox, oy, midX + nx * width, midY + ny * width, tipX, tipY, 16, cx, cy),
    ...quadraticPolyline(tipX, tipY, midX - nx * width, midY - ny * width, ox, oy, 16, cx, cy).slice(2),
  ];
  shapes.push(
    sonnetShape(`${id}-fill`, outline, { fillTone: tone, fillAlpha, strokeTone: -1, delay }),
    sonnetShape(`${id}-stroke`, outline, {
      strokeTone: tone,
      strokeWidth: 1.5,
      strokeAlpha: Math.min(0.8, fillAlpha * 3.2),
      delay,
    }),
    sonnetShape(`${id}-rib`, [cx + ox, cy + oy, cx + tipX, cy + tipY], {
      strokeTone: tone,
      strokeWidth: 1,
      strokeAlpha: 0.32,
      delay,
    }),
  );
}

/** 24 山茶花：三层花瓣（7 / 11 / 15 片）朝外铺开，中间一小块花心。 */
function drawCamellia(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const turn = ((seed % 12) * Math.PI) / 72;
  for (let ring = 0; ring < 3; ring += 1) {
    const count = 7 + ring * 4;
    for (let index = 0; index < count; index += 1) {
      const angle = turn + (index / count) * Math.PI * 2 + ring * 0.12;
      drawThemedLeaf(
        shapes,
        cx,
        cy,
        0,
        0,
        radius * (0.28 + ring * 0.15),
        radius * (0.075 + ring * 0.018),
        angle,
        ring === 1 ? 2 : 1,
        0.07 + ring * 0.045,
        `geo-camellia-${ring}-${index}`,
        0.01 * ring,
      );
    }
  }
  shapes.push(
    sonnetShape('geo-camellia-core', circlePolygon(cx, cy, radius * 0.1, 32), {
      fillTone: 2,
      fillAlpha: 0.22,
      strokeTone: -1,
      delay: 0.1,
    }),
    sonnetShape('geo-camellia-rim', circlePolygon(cx, cy, radius * 0.13, 40), {
      strokeTone: 1,
      strokeWidth: 3,
      strokeAlpha: 0.68,
      delay: 0.1,
    }),
  );
}

/** 25 郁金香田：七株并排（茎 + 一片叶 + **填描两遍**的花苞）。 */
function drawTulipField(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const direction = seed % 2 === 0 ? 1 : -1;
  for (let index = 0; index < 7; index += 1) {
    const x = (-0.66 + index * 0.22) * radius;
    const top = (-0.3 + ((seed + index * 5) % 5) * 0.085) * radius;
    const bottom = radius * 0.68;
    const tone = index % 2 ? 2 : 1;
    shapes.push(
      sonnetShape(
        `geo-tulip-stem-${index}`,
        cubicPolyline(
          [
            x, bottom,
            x + radius * 0.04 * direction, radius * 0.28,
            x - radius * 0.05 * direction, top + radius * 0.12,
            x, top,
          ],
          22,
          cx,
          cy,
        ),
        { strokeTone: tone, strokeWidth: 2, strokeAlpha: 0.5, delay: 0.02 * index },
      ),
    );
    drawThemedLeaf(
      shapes,
      cx,
      cy,
      x,
      radius * 0.24,
      radius * 0.26,
      radius * 0.055,
      index % 2 ? -2.7 : -0.45,
      1,
      0.1,
      `geo-tulip-leaf-${index}`,
      0.02 * index,
    );
    const bloomTone = index % 3 === 0 ? 2 : 1;
    const bloom = [
      ...quadraticPolyline(x, top + radius * 0.14, x - radius * 0.18, top - radius * 0.04, x - radius * 0.11, top - radius * 0.2, 16, cx, cy),
      ...quadraticPolyline(x + radius * 0.11, top - radius * 0.2, x + radius * 0.18, top - radius * 0.04, x, top + radius * 0.14, 16, cx, cy).slice(2),
    ];
    // 原版把花苞路径**填一次、再描一次**（同一串顶点）。
    const bloomPoints = [
      cx + x, cy + top + radius * 0.14,
      cx + x - radius * 0.11, cy + top - radius * 0.2,
      cx + x, cy + top - radius * 0.1,
      cx + x + radius * 0.11, cy + top - radius * 0.2,
      ...bloom.slice(2),
    ];
    shapes.push(
      sonnetShape(`geo-tulip-bloom-fill-${index}`, bloomPoints, {
        fillTone: bloomTone,
        fillAlpha: 0.12 + (index % 3) * 0.045,
        strokeTone: -1,
        delay: 0.02 * index,
      }),
      sonnetShape(`geo-tulip-bloom-stroke-${index}`, bloomPoints, {
        strokeTone: bloomTone,
        strokeWidth: 2,
        strokeAlpha: 0.65,
        delay: 0.02 * index,
      }),
    );
  }
}

/** 26 野花：九株细茎野花（每株五瓣 + 一点花心）。 */
function drawWildflower(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  for (let stem = 0; stem < 9; stem += 1) {
    const x = (-0.72 + stem * 0.18) * radius;
    const lean = (((seed + stem * 7) % 9) - 4) * radius * 0.018;
    const flowerY = (-0.45 + ((seed + stem * 3) % 6) * 0.08) * radius;
    shapes.push(
      sonnetShape(
        `geo-wildflower-stem-${stem}`,
        quadraticPolyline(x, radius * 0.72, x - lean, radius * 0.12, x + lean, flowerY, 22, cx, cy),
        { strokeTone: stem % 2 ? 2 : 1, strokeWidth: 1.5, strokeAlpha: 0.42, delay: 0.01 * stem },
      ),
    );
    for (let petal = 0; petal < 5; petal += 1) {
      const angle = (petal / 5) * Math.PI * 2 - Math.PI / 2;
      drawThemedLeaf(
        shapes,
        cx,
        cy,
        x + lean,
        flowerY,
        radius * 0.105,
        radius * 0.032,
        angle,
        stem % 3 ? 1 : 2,
        0.1,
        `geo-wildflower-petal-${stem}-${petal}`,
        0.01 * stem,
      );
    }
    shapes.push(
      sonnetShape(`geo-wildflower-core-${stem}`, circlePolygon(cx + x + lean, cy + flowerY, radius * 0.025, 16), {
        fillTone: 2,
        fillAlpha: 0.48,
        strokeTone: -1,
        delay: 0.01 * stem,
      }),
    );
  }
}

/** 27 蕨：一条主茎 + 十三对羽叶（左右两片的透明度公式不同）。 */
function drawFern(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const tilt = (seed % 2 ? 1 : -1) * 0.18;
  shapes.push(
    sonnetShape(
      'geo-fern-stem',
      cubicPolyline(
        [
          -radius * 0.12, radius * 0.72,
          -radius * 0.04, radius * 0.2,
          radius * 0.12, -radius * 0.24,
          radius * 0.02, -radius * 0.72,
        ],
        32,
        cx,
        cy,
      ),
      { strokeTone: 1, strokeWidth: 3, strokeAlpha: 0.62 },
    ),
  );
  for (let index = 0; index < 13; index += 1) {
    const ratio = index / 13;
    const x = -radius * 0.12 + radius * 0.14 * ratio;
    const y = radius * (0.63 - ratio * 1.23);
    // 中段最长、两端渐短（照抄 `0.3 − |ratio − 0.5| × 0.18`）。
    const length = radius * (0.3 - Math.abs(ratio - 0.5) * 0.18);
    drawThemedLeaf(
      shapes,
      cx,
      cy,
      x,
      y,
      length,
      length * 0.22,
      Math.PI + tilt - ratio * 0.25,
      index % 3 ? 1 : 2,
      0.09 + ratio * 0.05,
      `geo-fern-left-${index}`,
    );
    drawThemedLeaf(
      shapes,
      cx,
      cy,
      x,
      y,
      length,
      length * 0.22,
      -tilt + ratio * 0.25,
      index % 3 ? 2 : 1,
      0.07 + ratio * 0.04,
      `geo-fern-right-${index}`,
    );
  }
}

/** 28 银杏：一条粗枝 + 八片扇形叶（每片 = 短柄 + 扇形填充 + 扇形描边）。 */
function drawGinkgo(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const direction = seed % 2 === 0 ? 1 : -1;
  shapes.push(
    sonnetShape(
      'geo-ginkgo-branch',
      cubicPolyline(
        [
          -radius * 0.72 * direction, radius * 0.55,
          -radius * 0.25 * direction, radius * 0.16,
          radius * 0.08 * direction, -radius * 0.12,
          radius * 0.65 * direction, -radius * 0.5,
        ],
        36,
        cx,
        cy,
      ),
      { strokeTone: 1, strokeWidth: 5, strokeAlpha: 0.38 },
    ),
  );
  for (let index = 0; index < 8; index += 1) {
    const ratio = index / 7;
    const x = (-0.58 + ratio * 1.12) * radius * direction;
    const y = (0.4 - ratio * 0.78 + Math.sin(index * 1.8) * 0.08) * radius;
    const angle = -1.1 + (index % 3) * 0.7;
    const size = radius * (0.13 + (index % 4) * 0.018);
    shapes.push(
      sonnetShape(
        `geo-ginkgo-petiole-${index}`,
        [cx + x, cy + y, cx + x + Math.cos(angle) * size * 0.7, cy + y + Math.sin(angle) * size * 0.7],
        { strokeTone: 2, strokeWidth: 1.5, strokeAlpha: 0.42, delay: 0.02 * index },
      ),
    );
    const fx = x + Math.cos(angle) * size;
    const fy = y + Math.sin(angle) * size;
    // 扇形 = 从"柄端"出发、沿一段弧再回到柄端（原版 `moveTo → arc → lineTo` 的那个形状）。
    const fan = [cx + fx, cy + fy, ...arcPolyline(cx + fx, cy + fy, size, angle + Math.PI * 0.1, angle + Math.PI * 0.9, 16, false), cx + fx, cy + fy];
    shapes.push(
      sonnetShape(`geo-ginkgo-fan-fill-${index}`, fan, {
        fillTone: index % 2 ? 1 : 2,
        fillAlpha: 0.09 + (index % 3) * 0.04,
        strokeTone: -1,
        delay: 0.02 * index,
      }),
      sonnetShape(`geo-ginkgo-fan-stroke-${index}`, fan, {
        strokeTone: 1,
        strokeWidth: 1.5,
        strokeAlpha: 0.58,
        delay: 0.02 * index,
      }),
    );
  }
}

/** 29 爬藤：三条上下贯通的藤（中间那条最粗、用强调色），每条挂五片叶。 */
function drawClimbingVine(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const mirror = seed % 2 === 0 ? 1 : -1;
  for (let vine = 0; vine < 3; vine += 1) {
    const offset = (vine - 1) * radius * 0.3;
    shapes.push(
      sonnetShape(
        `geo-vine-${vine}`,
        cubicPolyline(
          [
            offset, radius * 0.76,
            offset + radius * 0.5 * mirror, radius * 0.38,
            offset - radius * 0.48 * mirror, -radius * 0.1,
            offset + radius * 0.22 * mirror, -radius * 0.76,
          ],
          36,
          cx,
          cy,
        ),
        {
          strokeTone: vine === 1 ? 2 : 1,
          strokeWidth: vine === 1 ? 3 : 1.5,
          strokeAlpha: 0.46,
          delay: 0.03 * vine,
        },
      ),
    );
    for (let leaf = 0; leaf < 5; leaf += 1) {
      const ratio = (leaf + 1) / 6;
      const x = offset + Math.sin(ratio * Math.PI * 4 + vine) * radius * 0.16;
      const y = radius * (0.7 - ratio * 1.36);
      drawThemedLeaf(
        shapes,
        cx,
        cy,
        x,
        y,
        radius * 0.2,
        radius * 0.055,
        leaf % 2 ? -0.25 : Math.PI + 0.25,
        leaf % 2 ? 2 : 1,
        0.08 + vine * 0.035,
        `geo-vine-${vine}-leaf-${leaf}`,
        0.03 * vine,
      );
    }
  }
}

/** 把一串顶点补成**闭合**多边形（原版 `fillPolygon` / `strokePolygon` 都会回到起点）。 */
function closePolygon(points: readonly (readonly [number, number])[]): number[] {
  const first = points[0];
  const flat: number[] = [];
  for (const [x, y] of points) flat.push(x, y);
  if (first !== undefined) flat.push(first[0], first[1]);
  return flat;
}

/** 30 温室：五边形外壳（填 + 描）+ 中脊 + 七条玻璃格 + 门（填 + 描）+ 两端地平线。 */
function drawGreenhouse(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, seed: number): void {
  const direction = seed % 2 === 0 ? 1 : -1;
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  const shell = closePolygon([
    [-radius * 0.7, radius * 0.58],
    [-radius * 0.7, -radius * 0.12],
    [0, -radius * 0.62],
    [radius * 0.7, -radius * 0.12],
    [radius * 0.7, radius * 0.58],
  ]);
  const shellAbs = shell.map((value, index) => value + (index % 2 === 0 ? cx : cy));
  shapes.push(
    sonnetShape('geo-greenhouse-shell-fill', shellAbs, { fillTone: 1, fillAlpha: 0.055, strokeTone: -1 }),
    sonnetShape('geo-greenhouse-shell-stroke', shellAbs, { strokeTone: 1, strokeWidth: 3, strokeAlpha: 0.68, delay: 0.02 }),
    sonnetShape('geo-greenhouse-ridge', [cx, cy - radius * 0.62, cx, cy + radius * 0.58], {
      strokeTone: 2,
      strokeWidth: 2,
      strokeAlpha: 0.5,
      delay: 0.04,
    }),
  );
  for (let pane = -3; pane <= 3; pane += 1) {
    const x = pane * radius * 0.18;
    shapes.push(
      sonnetShape(
        `geo-greenhouse-pane-${pane}`,
        [cx + x, cy + radius * 0.58, cx + x * 0.38, cy - radius * (0.58 - Math.abs(pane) * 0.04)],
        { strokeTone: pane % 2 ? 2 : 1, strokeWidth: 1, strokeAlpha: 0.32, delay: 0.01 * Math.abs(pane) },
      ),
    );
  }
  const doorX = radius * 0.2 * direction;
  shapes.push(
    sonnetShape('geo-greenhouse-door-fill', rectPolygon(cx + doorX - radius * 0.13, cy + radius * 0.08, radius * 0.26, radius * 0.5), {
      fillTone: 2,
      fillAlpha: 0.1,
      strokeTone: -1,
      delay: 0.06,
    }),
    sonnetShape('geo-greenhouse-door-stroke', rectPolygon(cx + doorX - radius * 0.13, cy + radius * 0.08, radius * 0.26, radius * 0.5), {
      strokeTone: 2,
      strokeWidth: 2,
      strokeAlpha: 0.62,
      delay: 0.06,
    }),
    sonnetShape('geo-greenhouse-ground-l', [cx - bleed.x, cy + radius * 0.58, cx - radius * 0.7, cy + radius * 0.58], {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.3,
      delay: 0.08,
    }),
    sonnetShape('geo-greenhouse-ground-r', [cx + radius * 0.7, cy + radius * 0.58, cx + bleed.x, cy + radius * 0.58], {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.3,
      delay: 0.08,
    }),
  );
}

/** 31 塔：四层飞檐（每层 = 檐口填描 + 层身填描）+ 塔尖 + 两端地平线。 */
function drawPagoda(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, seed: number): void {
  const lean = seed % 2 === 0 ? 1 : -1;
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  for (let floor = 0; floor < 4; floor += 1) {
    const y = radius * (0.47 - floor * 0.27);
    const halfWidth = radius * (0.5 - floor * 0.075);
    const tone = floor % 2 ? 2 : 1;
    const roof = closePolygon([
      [-halfWidth * 1.18, y],
      [-halfWidth, y - radius * 0.11],
      [0, y - radius * 0.19],
      [halfWidth, y - radius * 0.11],
      [halfWidth * 1.18, y],
    ]);
    const roofAbs = roof.map((value, index) => value + (index % 2 === 0 ? cx : cy));
    shapes.push(
      sonnetShape(`geo-pagoda-roof-fill-${floor}`, roofAbs, {
        fillTone: tone,
        fillAlpha: 0.07 + floor * 0.025,
        strokeTone: -1,
        delay: 0.02 * floor,
      }),
      sonnetShape(`geo-pagoda-roof-stroke-${floor}`, roofAbs, {
        strokeTone: tone,
        strokeWidth: 2,
        strokeAlpha: 0.58,
        delay: 0.02 * floor,
      }),
      sonnetShape(
        `geo-pagoda-body-fill-${floor}`,
        rectPolygon(cx - halfWidth * 0.68, cy + y, halfWidth * 1.36, radius * 0.17),
        { fillTone: 1, fillAlpha: 0.035 + floor * 0.018, strokeTone: -1, delay: 0.02 * floor },
      ),
      sonnetShape(
        `geo-pagoda-body-stroke-${floor}`,
        rectPolygon(cx - halfWidth * 0.68, cy + y, halfWidth * 1.36, radius * 0.17),
        { strokeTone: 1, strokeWidth: 1, strokeAlpha: 0.36, delay: 0.02 * floor },
      ),
    );
  }
  shapes.push(
    sonnetShape('geo-pagoda-finial', [cx, cy - radius * 0.62, cx + radius * 0.035 * lean, cy - radius * 0.78], {
      strokeTone: 2,
      strokeWidth: 3,
      strokeAlpha: 0.65,
      delay: 0.1,
    }),
    sonnetShape('geo-pagoda-ground-l', [cx - bleed.x, cy + radius * 0.64, cx - radius * 0.52, cy + radius * 0.64], {
      strokeTone: 2,
      strokeWidth: 1,
      strokeAlpha: 0.22,
      delay: 0.12,
    }),
    sonnetShape('geo-pagoda-ground-r', [cx + radius * 0.52, cy + radius * 0.64, cx + bleed.x, cy + radius * 0.64], {
      strokeTone: 2,
      strokeWidth: 1,
      strokeAlpha: 0.22,
      delay: 0.12,
    }),
  );
}

/** 32 城市立面：七栋高低不同的楼（每栋填描 + 一层层窗）+ 一条地平线。 */
function drawCityFacade(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, seed: number): void {
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  const heights: readonly number[] = [0.52, 0.88, 0.66, 1.08, 0.74, 0.94, 0.58];
  const buildingWidth = radius * 0.205;
  heights.forEach((heightRatio, index) => {
    const x = radius * (-0.73 + index * 0.24);
    const buildingHeight = radius * heightRatio;
    const tone = index % 3 === 1 ? 2 : 1;
    const top = cy + radius * 0.62 - buildingHeight;
    const body = rectPolygon(cx + x, top, buildingWidth, buildingHeight);
    shapes.push(
      sonnetShape(`geo-city-body-fill-${index}`, body, {
        fillTone: tone,
        fillAlpha: 0.045 + (index % 3) * 0.035,
        strokeTone: -1,
        delay: 0.02 * index,
      }),
      sonnetShape(`geo-city-body-stroke-${index}`, body, {
        strokeTone: tone,
        strokeWidth: index === 3 ? 3 : 1.5,
        strokeAlpha: 0.5,
        delay: 0.02 * index,
      }),
    );
    const rows = Math.floor(heightRatio * 6);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < 2; column += 1) {
        // 照抄：`(row + column + index + seed) % 3 === 0` 才亮一盏窗。
        if ((row + column + index + seed) % 3 === 0) {
          shapes.push(
            sonnetShape(
              `geo-city-window-${index}-${row}-${column}`,
              rectPolygon(
                cx + x + radius * (0.035 + column * 0.085),
                cy + radius * 0.53 - buildingHeight + row * radius * 0.13,
                radius * 0.045,
                radius * 0.055,
              ),
              { fillTone: column ? 2 : 1, fillAlpha: 0.2, strokeTone: -1, delay: 0.01 * index },
            ),
          );
        }
      }
    }
  });
  shapes.push(
    sonnetShape('geo-city-ground', [cx - bleed.x, cy + radius * 0.63, cx + bleed.x, cy + radius * 0.63], {
      strokeTone: 1,
      strokeWidth: 4,
      strokeAlpha: 0.48,
      delay: 0.16,
    }),
  );
}

/** 33 梯田：七层横贯画面之外的田垄，每层一条起伏上缘 + 一片到下层之间的填充。 */
function drawTerraces(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, seed: number): void {
  const direction = seed % 2 === 0 ? 1 : -1;
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  for (let band = 0; band < 7; band += 1) {
    const y = radius * (-0.5 + band * 0.16);
    const amplitude = radius * (0.09 + band * 0.012);
    const crest = cubicPolyline(
      [
        -bleed.x, y,
        -radius * 0.35, y + amplitude * direction,
        radius * 0.08, y - amplitude * direction,
        bleed.x, y + amplitude * 0.35,
      ],
      28,
      cx,
      cy,
    );
    // 填充部分：沿上缘走一遍，再沿"下缘"折回左边（原版靠 fill 隐式闭合）。
    const trough = cubicPolyline(
      [
        bleed.x, y + radius * 0.12,
        radius * 0.12, y + radius * 0.04,
        -radius * 0.3, y + radius * 0.2,
        -bleed.x, y + radius * 0.12,
      ],
      28,
      cx,
      cy,
    );
    shapes.push(
      sonnetShape(`geo-terrace-fill-${band}`, [...crest, ...trough.slice(2), crest[0] ?? 0, crest[1] ?? 0], {
        fillTone: band % 2 ? 2 : 1,
        fillAlpha: 0.025 + band * 0.018,
        strokeTone: -1,
        delay: 0.03 * band,
      }),
      sonnetShape(`geo-terrace-crest-${band}`, crest, {
        strokeTone: band % 2 ? 2 : 1,
        strokeWidth: band % 3 === 0 ? 2.5 : 1,
        strokeAlpha: 0.34 + band * 0.04,
        delay: 0.03 * band,
      }),
    );
  }
}

/** 34 山湖：两层山脊（后淡前浓）+ 七道湖面横纹 + 左上角一轮月。 */
function drawMountainLake(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, seed: number): void {
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  const shift = (((seed % 7) - 3) / 3) * radius * 0.04;
  const back = closePolygon([
    [-bleed.x, radius * 0.1],
    [-radius * 0.42, -radius * 0.46],
    [-radius * 0.14, -radius * 0.16],
    [radius * 0.22, -radius * 0.62],
    [bleed.x, radius * 0.1],
  ]);
  const front = closePolygon([
    [-bleed.x, radius * 0.22],
    [-radius * 0.28 + shift, -radius * 0.2],
    [radius * 0.06, radius * 0.05],
    [radius * 0.48 + shift, -radius * 0.28],
    [bleed.x, radius * 0.22],
  ]);
  const abs = (polygon: number[]): number[] => polygon.map((value, index) => value + (index % 2 === 0 ? cx : cy));
  shapes.push(
    sonnetShape('geo-lake-back-fill', abs(back), { fillTone: 2, fillAlpha: 0.07, strokeTone: -1 }),
    sonnetShape('geo-lake-back-stroke', abs(back), { strokeTone: 2, strokeWidth: 1.5, strokeAlpha: 0.46, delay: 0.02 }),
    sonnetShape('geo-lake-front-fill', abs(front), { fillTone: 1, fillAlpha: 0.12, strokeTone: -1, delay: 0.04 }),
    sonnetShape('geo-lake-front-stroke', abs(front), { strokeTone: 1, strokeWidth: 2.5, strokeAlpha: 0.66, delay: 0.04 }),
  );
  for (let line = 0; line < 7; line += 1) {
    const y = radius * (0.28 + line * 0.07);
    const inset = radius * (0.08 + (line % 3) * 0.08);
    shapes.push(
      sonnetShape(`geo-lake-line-${line}`, [cx - bleed.x + inset, cy + y, cx + bleed.x - inset, cy + y], {
        strokeTone: line % 2 ? 2 : 1,
        strokeWidth: 1,
        strokeAlpha: 0.2 + line * 0.035,
        delay: 0.01 * line,
      }),
    );
  }
  shapes.push(
    sonnetShape('geo-lake-moon', circlePolygon(cx - radius * 0.48, cy - radius * 0.48, radius * 0.1, 32), {
      fillTone: 2,
      fillAlpha: 0.14,
      strokeTone: -1,
      delay: 0.1,
    }),
    sonnetShape('geo-lake-moon-ring', circlePolygon(cx - radius * 0.48, cy - radius * 0.48, radius * 0.13, 40), {
      strokeTone: 2,
      strokeWidth: 2,
      strokeAlpha: 0.5,
      delay: 0.1,
    }),
  );
}

/** 35 海岸悬崖：一整片崖体 + 崖顶小塔（身 + 三角顶）+ 六道海浪。 */
function drawCoastalCliff(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, seed: number): void {
  const direction = seed % 2 === 0 ? 1 : -1;
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  const cliff = closePolygon([
    [-bleed.x * direction, bleed.y],
    [-radius * 0.78 * direction, -radius * 0.1],
    [-radius * 0.5 * direction, -radius * 0.34],
    [-radius * 0.18 * direction, radius * 0.08],
    [radius * 0.08 * direction, radius * 0.58],
  ]);
  const abs = (polygon: number[]): number[] => polygon.map((value, index) => value + (index % 2 === 0 ? cx : cy));
  shapes.push(
    sonnetShape('geo-cliff-fill', abs(cliff), { fillTone: 1, fillAlpha: 0.11, strokeTone: -1 }),
    sonnetShape('geo-cliff-stroke', abs(cliff), { strokeTone: 1, strokeWidth: 2.5, strokeAlpha: 0.62, delay: 0.02 }),
  );
  const towerX = -radius * 0.5 * direction;
  shapes.push(
    sonnetShape('geo-cliff-tower-fill', rectPolygon(cx + towerX - radius * 0.09, cy - radius * 0.42, radius * 0.18, radius * 0.45), {
      fillTone: 2,
      fillAlpha: 0.12,
      strokeTone: -1,
      delay: 0.04,
    }),
    sonnetShape('geo-cliff-tower-stroke', rectPolygon(cx + towerX - radius * 0.09, cy - radius * 0.42, radius * 0.18, radius * 0.45), {
      strokeTone: 2,
      strokeWidth: 2,
      strokeAlpha: 0.7,
      delay: 0.04,
    }),
    // 塔顶：原版填的是三点三角、描的是补上首点的同一条边。
    sonnetShape(
      'geo-cliff-roof-fill',
      closePolygon([
        [towerX - radius * 0.14, -radius * 0.42],
        [towerX, -radius * 0.56],
        [towerX + radius * 0.14, -radius * 0.42],
      ]).map((value, index) => value + (index % 2 === 0 ? cx : cy)),
      { fillTone: 2, fillAlpha: 0.2, strokeTone: -1, delay: 0.05 },
    ),
    sonnetShape(
      'geo-cliff-roof-stroke',
      [
        cx + towerX - radius * 0.14, cy - radius * 0.42,
        cx + towerX, cy - radius * 0.56,
        cx + towerX + radius * 0.14, cy - radius * 0.42,
        cx + towerX - radius * 0.14, cy - radius * 0.42,
      ],
      { strokeTone: 2, strokeWidth: 2, strokeAlpha: 0.72, delay: 0.05 },
    ),
  );
  for (let wave = 0; wave < 6; wave += 1) {
    const y = radius * (0.14 + wave * 0.1);
    shapes.push(
      sonnetShape(
        `geo-cliff-wave-${wave}`,
        quadraticPolyline(-radius * 0.05 * direction, y, radius * 0.35 * direction, y - radius * 0.08, bleed.x * direction, y, 22, cx, cy),
        {
          strokeTone: wave % 2 ? 2 : 1,
          strokeWidth: wave % 3 === 0 ? 2 : 1,
          strokeAlpha: 0.26 + wave * 0.045,
          delay: 0.02 * wave,
        },
      ),
    );
  }
}

/* ------------------------------------------------------------------ *
 * 扩展主题 · 音乐篇 68~75（照抄 `sonnetShotMgMusic.ts`）
 * 原版文件头写明 `geo variants 68-75`（8 档），与前面按算术反推的档数一致
 * ------------------------------------------------------------------ */

export const SONNET_MUSIC_GEO_VARIANTS = [
  'sound-wave',
  'vinyl-grooves',
  'equalizer-bloom',
  'note-arc',
  'tuning-fork',
  'piano-ribbon',
  'metronome',
  'staff-wave',
] as const;

/** 68 声波：上下两条镜像波形（**中间那根轴线保持开口**，整条波形横贯画外）。 */
function drawSoundWave(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, seed: number): void {
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  const steps = 72;
  // 包络：中间高、两端收，再叠一层种子哈希。
  const envelope = (t: number): number => Math.sin(t * Math.PI) * (0.4 + 0.6 * sonnetHash01(seed, Math.round(t * 12), 401));
  for (const mirror of [-1, 1]) {
    const wave: number[] = [cx - bleed.x, cy];
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps;
      wave.push(
        cx - bleed.x + t * bleed.x * 2,
        cy + mirror * Math.sin(t * TAU * 5 + seed * 0.13) * radius * 0.22 * envelope(t),
      );
    }
    shapes.push(
      sonnetShape(`geo-soundwave-${mirror < 0 ? 'up' : 'down'}`, wave, {
        strokeTone: mirror < 0 ? 1 : 2,
        strokeWidth: mirror < 0 ? 2 : 1,
        strokeAlpha: 0.55,
      }),
    );
  }
  shapes.push(
    sonnetShape('geo-soundwave-axis', [cx - bleed.x, cy, cx + bleed.x, cy], {
      strokeTone: 1,
      strokeWidth: 1,
      strokeAlpha: 0.18,
      delay: 0.06,
    }),
  );
}

/** 69 黑胶：七圈**带缺口**的纹路（永不闭合）+ 中心孔 + 从角落伸进来的唱臂。 */
function drawVinylGrooves(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  for (let groove = 0; groove < 7; groove += 1) {
    const r = radius * (0.2 + groove * 0.08);
    const gapAt = sonnetHash01(seed, groove, 409) * TAU;
    shapes.push(
      // 只画 86% 的弧：缺口就是"唱片上的无槽区"。
      sonnetShape(`geo-vinyl-groove-${groove}`, arcPolyline(cx, cy, r, gapAt, gapAt + TAU * 0.86, 48, false), {
        strokeTone: groove % 3 === 0 ? 2 : 1,
        strokeWidth: groove % 3 === 0 ? 2 : 1,
        strokeAlpha: 0.3 + groove * 0.05,
        delay: 0.02 * groove,
      }),
    );
  }
  const pivotX = radius * 0.62;
  const pivotY = -radius * 0.52;
  shapes.push(
    sonnetShape('geo-vinyl-ring', circlePolygon(cx, cy, radius * 0.12, 40), {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.6,
    }),
    sonnetShape('geo-vinyl-hole', circlePolygon(cx, cy, radius * 0.03, 20), {
      fillTone: 2,
      fillAlpha: 0.8,
      strokeTone: -1,
      delay: 0.04,
    }),
    sonnetShape('geo-vinyl-pivot', circlePolygon(cx + pivotX, cy + pivotY, radius * 0.035, 20), {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.6,
      delay: 0.06,
    }),
    sonnetShape('geo-vinyl-arm', [cx + pivotX, cy + pivotY, cx + radius * 0.18, cy - radius * 0.1], {
      strokeTone: 1,
      strokeWidth: 3,
      strokeAlpha: 0.5,
      delay: 0.06,
    }),
    sonnetShape('geo-vinyl-needle', circlePolygon(cx + radius * 0.18, cy - radius * 0.1, 3, 12), {
      fillTone: 2,
      fillAlpha: 0.8,
      strokeTone: -1,
      delay: 0.08,
    }),
  );
}

/** 70 均衡器花：十七根沿一条浅弧绽放的条（越靠中间越高）+ 每根顶端一粒点。 */
function drawEqualizerBloom(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const bars = 17;
  for (let index = 0; index < bars; index += 1) {
    const t = index / (bars - 1);
    const x = -radius * 0.66 + t * radius * 1.32;
    const arcY = radius * 0.5 - Math.sin(t * Math.PI) * radius * 0.12;
    const h = radius * (0.08 + Math.sin(t * Math.PI) * 0.3 * (0.5 + sonnetHash01(seed, index, 419) * 0.8));
    shapes.push(
      sonnetShape(`geo-eq-bar-${index}`, [cx + x, cy + arcY, cx + x, cy + arcY - h], {
        strokeTone: index % 4 === 0 ? 2 : 1,
        strokeWidth: 3,
        strokeAlpha: 0.5 + Math.sin(t * Math.PI) * 0.25,
        delay: 0.01 * index,
      }),
      sonnetShape(`geo-eq-tip-${index}`, circlePolygon(cx + x, cy + arcY - h - 4, 1.6, 10), {
        fillTone: 2,
        fillAlpha: 0.55,
        strokeTone: -1,
        delay: 0.01 * index,
      }),
    );
  }
}

/** 71 音符弧：五个八分音符沿弧排列 + 一条**越过最后一个音符还继续伸出去**的符杠 + 一片散尾。 */
function drawNoteArc(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, _seed: number): void {
  const headR = radius * 0.045;
  const points: readonly { x: number; y: number }[] = Array.from({ length: 5 }, (_unused, index) => {
    const t = index / 4;
    return {
      x: -radius * 0.55 + t * radius * 1.1,
      y: radius * 0.22 - Math.sin(t * Math.PI * 0.9) * radius * 0.34,
    };
  });
  points.forEach((point, index) => {
    const tone = index === 2 ? 2 : 1;
    shapes.push(
      sonnetShape(`geo-note-head-${index}`, circlePolygon(cx + point.x, cy + point.y, headR, 20), {
        fillTone: tone,
        fillAlpha: 0.8,
        strokeTone: -1,
        delay: 0.02 * index,
      }),
      sonnetShape(
        `geo-note-stem-${index}`,
        [cx + point.x + headR, cy + point.y, cx + point.x + headR, cy + point.y - radius * 0.16],
        { strokeTone: tone, strokeWidth: 2, strokeAlpha: 0.65, delay: 0.02 * index },
      ),
    );
  });
  const first = points[0];
  const last = points[4];
  if (first === undefined || last === undefined) return;
  const beam: number[] = [cx + first.x + headR, cy + first.y - radius * 0.16];
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) continue;
    beam.push(cx + point.x + headR, cy + point.y - radius * 0.16);
  }
  beam.push(cx + last.x + radius * 0.12, cy + last.y - radius * 0.13);
  shapes.push(
    sonnetShape('geo-note-beam', beam, { strokeTone: 1, strokeWidth: 3, strokeAlpha: 0.5, delay: 0.1 }),
    sonnetShape(
      'geo-note-flag',
      quadraticPolyline(
        first.x + headR,
        first.y - radius * 0.16,
        first.x + radius * 0.1,
        first.y - radius * 0.1,
        first.x + radius * 0.06,
        first.y - radius * 0.02,
        18,
        cx,
        cy,
      ),
      { strokeTone: 2, strokeWidth: 1.5, strokeAlpha: 0.5, delay: 0.12 },
    ),
  );
}

/** 72 音叉：两根叉股 + 底部半圆 + 手柄 + 基座圈 + 两侧各三段共振弧。 */
function drawTuningFork(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const fx = (seed % 2 === 0 ? -1 : 1) * radius * 0.08;
  const topY = -radius * 0.4;
  const prongW = radius * 0.05;
  const prongGap = radius * 0.1;
  const uY = radius * 0.02;
  shapes.push(
    sonnetShape('geo-fork-left', [cx + fx - prongGap / 2 - prongW, cy + topY, cx + fx - prongGap / 2 - prongW, cy + uY], {
      strokeTone: 1,
      strokeWidth: 2.5,
      strokeAlpha: 0.65,
    }),
    sonnetShape('geo-fork-right', [cx + fx + prongGap / 2 + prongW, cy + topY, cx + fx + prongGap / 2 + prongW, cy + uY], {
      strokeTone: 1,
      strokeWidth: 2.5,
      strokeAlpha: 0.65,
    }),
    // 底部那个半圆（0 → π）。
    sonnetShape('geo-fork-bend', arcPolyline(cx + fx, cy + uY, prongGap / 2 + prongW, 0, Math.PI, 24, false), {
      strokeTone: 1,
      strokeWidth: 2.5,
      strokeAlpha: 0.65,
      delay: 0.02,
    }),
    sonnetShape('geo-fork-handle', [cx + fx, cy + uY + prongGap / 2 + prongW, cx + fx, cy + radius * 0.42], {
      strokeTone: 1,
      strokeWidth: 3,
      strokeAlpha: 0.6,
      delay: 0.04,
    }),
    sonnetShape('geo-fork-base', circlePolygon(cx + fx, cy + radius * 0.46, radius * 0.035, 20), {
      strokeTone: 2,
      strokeWidth: 2,
      strokeAlpha: 0.6,
      delay: 0.06,
    }),
  );
  for (let side = -1; side <= 1; side += 2) {
    for (let ring = 0; ring < 3; ring += 1) {
      const r = radius * (0.14 + ring * 0.1);
      const ox = fx + side * radius * 0.06;
      const oy = topY + radius * 0.1;
      shapes.push(
        sonnetShape(
          `geo-fork-wave-${side}-${ring}`,
          arcPolyline(
            cx + ox,
            cy + oy,
            r,
            side < 0 ? Math.PI * 0.6 : -Math.PI * 0.4,
            side < 0 ? Math.PI * 1.4 : Math.PI * 0.4,
            20,
            false,
          ),
          { strokeTone: ring === 1 ? 2 : 1, strokeWidth: 1.5, strokeAlpha: 0.42 - ring * 0.1, delay: 0.02 * ring },
        ),
      );
    }
  }
}

/** 73 琴键缎带：一条**两端都开口**的浅弧 + 十二根沿弧排开、黑白相间的琴键。 */
function drawPianoRibbon(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, _seed: number): void {
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  shapes.push(
    sonnetShape(
      'geo-piano-ribbon',
      cubicPolyline(
        [
          -bleed.x, radius * 0.18,
          -radius * 0.3, -radius * 0.05,
          radius * 0.3, radius * 0.3,
          bleed.x, radius * 0.05,
        ],
        36,
        cx,
        cy,
      ),
      { strokeTone: 1, strokeWidth: 1, strokeAlpha: 0.25 },
    ),
  );
  const keys = 12;
  for (let index = 0; index < keys; index += 1) {
    const t = index / (keys - 1);
    const x = -radius * 0.6 + t * radius * 1.2;
    const baseY = radius * 0.18 + Math.sin(t * Math.PI) * -radius * 0.1 + t * -radius * 0.06;
    // 黑键在 1 / 3 / 6 / 8 / 10 号位（照抄），也更短更粗。
    const black = [1, 3, 6, 8, 10].includes(index % 12);
    const len = radius * (black ? 0.14 : 0.24);
    shapes.push(
      sonnetShape(`geo-piano-key-${index}`, [cx + x, cy + baseY, cx + x, cy + baseY - len], {
        strokeTone: black ? 2 : 1,
        strokeWidth: black ? 4 : 3,
        strokeAlpha: black ? 0.7 : 0.45,
        delay: 0.02 * index,
      }),
    );
  }
}

/** 74 节拍器：梯形本体（**底边开口**）+ 斜摆的摆杆 + 平衡块 + 三道回声弧。 */
function drawMetronome(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, seed: number): void {
  const baseY = radius * 0.4;
  const topY = -radius * 0.36;
  const pivotY = radius * 0.16;
  shapes.push(
    sonnetShape('geo-metronome-left', [cx - radius * 0.2, cy + baseY, cx - radius * 0.06, cy + topY], {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.6,
    }),
    sonnetShape('geo-metronome-right', [cx + radius * 0.2, cy + baseY, cx + radius * 0.06, cy + topY], {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.6,
    }),
    sonnetShape('geo-metronome-top', [cx - radius * 0.06, cy + topY, cx + radius * 0.06, cy + topY], {
      strokeTone: 1,
      strokeWidth: 2,
      strokeAlpha: 0.6,
      delay: 0.02,
    }),
  );
  const tilt = (sonnetHash01(seed, 0, 431) - 0.5) * 0.9;
  const tipX = Math.sin(tilt) * radius * 0.5;
  const tipY = pivotY - Math.cos(tilt) * radius * 0.5;
  shapes.push(
    sonnetShape('geo-metronome-pivot', circlePolygon(cx, cy + pivotY, radius * 0.03, 18), {
      fillTone: 2,
      fillAlpha: 0.85,
      strokeTone: -1,
      delay: 0.04,
    }),
    sonnetShape('geo-metronome-rod', [cx, cy + pivotY, cx + tipX, cy + tipY], {
      strokeTone: 2,
      strokeWidth: 2,
      strokeAlpha: 0.7,
      delay: 0.04,
    }),
    sonnetShape('geo-metronome-weight', rectPolygon(cx + tipX - 4, cy + tipY - 4, 8, 8), {
      fillTone: 2,
      fillAlpha: 0.7,
      strokeTone: -1,
      delay: 0.06,
    }),
  );
  for (let index = 0; index < 3; index += 1) {
    const r = radius * (0.24 + index * 0.12);
    shapes.push(
      sonnetShape(
        `geo-metronome-echo-${index}`,
        arcPolyline(cx, cy + pivotY, r, -Math.PI / 2 - 0.5 - index * 0.1, -Math.PI / 2 + 0.5 + index * 0.1, 20, false),
        { strokeTone: 1, strokeWidth: 1, strokeAlpha: 0.3 - index * 0.06, delay: 0.02 * index },
      ),
    );
  }
}

/** 75 五线谱波：五条横贯画外的谱线（**中间那条更亮**）+ 四个散落音符。 */
function drawStaffWave(shapes: SonnetShapeSpec[], cx: number, cy: number, radius: number, width: number, height: number, seed: number): void {
  const bleed = resolveSonnetGeoBleed(width, height, radius);
  for (let line = 0; line < 5; line += 1) {
    const y0 = -radius * 0.16 + line * radius * 0.08;
    const lift = (line % 2 === 0 ? 1 : -1) * radius * 0.05;
    shapes.push(
      sonnetShape(
        `geo-staff-line-${line}`,
        cubicPolyline(
          [-bleed.x, y0, -radius * 0.3, y0 + lift, radius * 0.3, y0 - lift, bleed.x, y0],
          36,
          cx,
          cy,
        ),
        { strokeTone: 1, strokeWidth: 1, strokeAlpha: 0.3 + (line === 2 ? 0.15 : 0), delay: 0.01 * line },
      ),
    );
  }
  for (let index = 0; index < 4; index += 1) {
    const x = -radius * 0.45 + index * radius * 0.3 + (sonnetHash01(seed, index, 439) - 0.5) * radius * 0.08;
    const y = -radius * 0.16 + Math.floor(sonnetHash01(seed, index, 443) * 5) * radius * 0.08;
    const tone = index % 2 === 0 ? 2 : 1;
    shapes.push(
      sonnetShape(`geo-staff-note-${index}`, circlePolygon(cx + x, cy + y, radius * 0.032, 18), {
        fillTone: tone,
        fillAlpha: 0.85,
        strokeTone: -1,
        delay: 0.02 * index,
      }),
      sonnetShape(`geo-staff-stem-${index}`, [cx + x + radius * 0.032, cy + y, cx + x + radius * 0.032, cy + y - radius * 0.14], {
        strokeTone: tone,
        strokeWidth: 1.5,
        strokeAlpha: 0.6,
        delay: 0.02 * index,
      }),
    );
  }
}

/**
 * 重镜头的几何图形：**只有搬过来的档位会返回数组**；没搬的返回 `null`（调用方退回自拟图形）。
 */
export function hasSonnetGeoVariant(variant: number, _seed: number): boolean {
  /*
   * 直接**从档位地图推**：搬过的那一段（`portedCount` 是段首连续的一段）才算数。
   * 这样地图和实际行为不可能各说一套 —— 用例会逐档核对这两者一致。
   */
  const normalized = resolveSonnetGeoVariant(variant);
  return SONNET_GEO_RANGES.some(
    (range) => normalized >= range.start && normalized < range.start + range.portedCount,
  );
}

export function buildSonnetGeoShapes(
  viewport: SonnetGeoViewport,
  variant: number,
  seed: number,
): SonnetShapeSpec[] | null {
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  const radius = Math.min(viewport.width, viewport.height);
  const shapes: SonnetShapeSpec[] = [];
  const normalized = resolveSonnetGeoVariant(variant);
  switch (normalized) {
    case 0:
      drawSunburst(shapes, cx, cy, radius);
      break;
    case 1:
      drawNestedDiamonds(shapes, cx, cy, radius);
      break;
    case 2:
      drawHexagonGrid(shapes, cx, cy, radius);
      break;
    case 3: {
      // 三个分子子档位：0 苯环簇、1 稠合分子、2 线性聚合物链（子档位 = `floor(seed / 100) % 3`）。
      const molecule = resolveSonnetMoleculeVariant(seed);
      if (molecule === 1) drawFusedMolecule(shapes, cx, cy, radius);
      else if (molecule === 2) drawPolymerChain(shapes, cx, cy, radius);
      else drawBenzeneCluster(shapes, cx, cy, radius);
      break;
    }
    case 4:
      drawElectronOrbitals(shapes, cx, cy, radius);
      break;
    case 5:
      drawRingedPlanet(shapes, cx, cy, radius);
      break;
    case 6:
      drawWireframeMountains(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 7:
      drawRadar(shapes, cx, cy, radius, seed);
      break;
    case 8:
      drawHudFrame(shapes, cx, cy, radius);
      break;
    case 9:
      drawIsometricCubes(shapes, cx, cy, radius);
      break;
    case 10:
      drawConstellationNetwork(shapes, cx, cy, radius, seed);
      break;
    case 11:
      drawLunarPhases(shapes, cx, cy, radius);
      break;
    case 12:
      drawLotus(shapes, cx, cy, radius);
      break;
    case 13:
      drawSeedOfLife(shapes, cx, cy, radius);
      break;
    case 14:
      drawMonoliths(shapes, cx, cy, radius, seed);
      break;
    case 15:
      drawTriangularPrisms(shapes, cx, cy, radius, seed);
      break;
    case 16:
      drawHexagonalPrisms(shapes, cx, cy, radius, seed);
      break;
    case 17:
      drawTrapezoidPrisms(shapes, cx, cy, radius, seed);
      break;
    case 18:
      drawContourAtlas(shapes, cx, cy, radius, seed);
      break;
    case 19:
      drawRadialWave(shapes, cx, cy, radius, seed);
      break;
    case 20:
      drawTransitBlueprint(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 21:
      drawChronograph(shapes, cx, cy, radius, seed);
      break;
    case 22:
      drawFoldedRibbons(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 23:
      drawHalftonePoster(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 36:
      drawOpenArcBrackets(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 37:
      drawDashedOrbits(shapes, cx, cy, radius, seed);
      break;
    case 38:
      drawOpenFragments(shapes, cx, cy, radius, seed);
      break;
    case 39:
      drawHorizonBundles(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 40:
      drawSemiWreath(shapes, cx, cy, radius, seed);
      break;
    case 41:
      drawSideRulers(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 42:
      drawDiagonalStream(shapes, cx, cy, radius, seed);
      break;
    case 43:
      drawCornerPetalSpray(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 44:
      drawDottedWindows(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 45:
      drawOpenRadar(shapes, cx, cy, radius, seed);
      break;
    case 46:
      drawBrushStrokes(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 47:
      drawStitchCorners(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 48:
      drawSpiralGalaxy(shapes, cx, cy, radius, seed);
      break;
    case 49:
      drawCometTrail(shapes, cx, cy, radius, seed);
      break;
    case 50:
      drawEclipseCorona(shapes, cx, cy, radius, seed);
      break;
    case 51:
      drawMeteorShower(shapes, cx, cy, radius, seed);
      break;
    case 52:
      drawOrbitSatellites(shapes, cx, cy, radius, seed);
      break;
    case 53:
      drawAuroraRibbons(shapes, cx, cy, radius, seed);
      break;
    case 54:
      drawCrescentHalo(shapes, cx, cy, radius, seed);
      break;
    case 55:
      drawNebulaVeil(shapes, cx, cy, radius, seed);
      break;
    case 56:
      drawStarMap(shapes, cx, cy, radius, seed);
      break;
    case 57:
      drawLunarTide(shapes, cx, cy, radius, seed);
      break;
    case 58:
      drawWaveScrolls(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 59:
      drawNautilus(shapes, cx, cy, radius, seed);
      break;
    case 60:
      drawCoralBranch(shapes, cx, cy, radius, seed);
      break;
    case 61:
      drawLighthouseBeam(shapes, cx, cy, radius, seed);
      break;
    case 62:
      drawCompassRose(shapes, cx, cy, radius, seed);
      break;
    case 63:
      drawSailRegatta(shapes, cx, cy, radius, seed);
      break;
    case 64:
      drawBubbleRise(shapes, cx, cy, radius, seed);
      break;
    case 65:
      drawTidePools(shapes, cx, cy, radius, seed);
      break;
    case 66:
      drawSeaweedSway(shapes, cx, cy, radius, seed);
      break;
    case 67:
      drawDeepCurrent(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 76:
      drawOrigamiCrane(shapes, cx, cy, radius, seed);
      break;
    case 77:
      drawPaperPlaneTrail(shapes, cx, cy, radius, seed);
      break;
    case 78:
      drawWeaveBand(shapes, cx, cy, radius, seed);
      break;
    case 79:
      drawKnotLoop(shapes, cx, cy, radius, seed);
      break;
    case 80:
      drawStitchSampler(shapes, cx, cy, radius, seed);
      break;
    case 81:
      drawFoldedFan(shapes, cx, cy, radius, seed);
      break;
    case 82:
      drawRibbonCurl(shapes, cx, cy, radius, seed);
      break;
    case 83:
      drawPatchworkTrio(shapes, cx, cy, radius, seed);
      break;
    case 84:
      drawDreamcatcher(shapes, cx, cy, radius, seed);
      break;
    case 85:
      drawTasselDrop(shapes, cx, cy, radius, seed);
      break;
    case 86:
      drawPendulumWave(shapes, cx, cy, radius, seed);
      break;
    case 87:
      drawDominoArc(shapes, cx, cy, radius, seed);
      break;
    case 88:
      drawGearCluster(shapes, cx, cy, radius, seed);
      break;
    case 89:
      drawCircuitDelta(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 90:
      drawSignalTower(shapes, cx, cy, radius, seed);
      break;
    case 91:
      drawSpiralStair(shapes, cx, cy, radius, seed);
      break;
    case 92:
      drawWaterfallLines(shapes, cx, cy, radius, seed);
      break;
    case 93:
      drawPinwheel(shapes, cx, cy, radius, seed);
      break;
    case 94:
      drawRippleDrop(shapes, cx, cy, radius, seed);
      break;
    case 95:
      drawSuspensionBridge(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 96:
      drawFieldLines(shapes, cx, cy, radius, seed);
      break;
    case 97:
      drawPrismBeam(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 98:
      drawEchoArcs(shapes, cx, cy, radius, seed);
      break;
    case 99:
      drawKiteString(shapes, cx, cy, radius, seed);
      break;
    case 24:
      drawCamellia(shapes, cx, cy, radius, seed);
      break;
    case 25:
      drawTulipField(shapes, cx, cy, radius, seed);
      break;
    case 26:
      drawWildflower(shapes, cx, cy, radius, seed);
      break;
    case 27:
      drawFern(shapes, cx, cy, radius, seed);
      break;
    case 28:
      drawGinkgo(shapes, cx, cy, radius, seed);
      break;
    case 29:
      drawClimbingVine(shapes, cx, cy, radius, seed);
      break;
    case 30:
      drawGreenhouse(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 31:
      drawPagoda(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 32:
      drawCityFacade(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 33:
      drawTerraces(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 34:
      drawMountainLake(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 35:
      drawCoastalCliff(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 68:
      drawSoundWave(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 69:
      drawVinylGrooves(shapes, cx, cy, radius, seed);
      break;
    case 70:
      drawEqualizerBloom(shapes, cx, cy, radius, seed);
      break;
    case 71:
      drawNoteArc(shapes, cx, cy, radius, seed);
      break;
    case 72:
      drawTuningFork(shapes, cx, cy, radius, seed);
      break;
    case 73:
      drawPianoRibbon(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    case 74:
      drawMetronome(shapes, cx, cy, radius, seed);
      break;
    case 75:
      drawStaffWave(shapes, cx, cy, radius, viewport.width, viewport.height, seed);
      break;
    default:
      return null;
  }
  const rotation = resolveSonnetGeoRotation(normalized, seed);
  if (rotation === 0) return shapes;
  return shapes.map((item) => ({ ...item, polygon: rotatePolygon(item.polygon, cx, cy, rotation) }));
}
