/**
 * 商籁**主题图标的"分布与时机"规则**（照抄 folia `sonnet/sonnetIcons.ts` 的纯函数部分；
 * 文字与代码我们重写；AGPL-3.0）。
 *
 * === 上游文件头 ===
 * *"Validates theme icon names and produces cacheable SVG data URLs for Pixi."* ✓
 *
 * === ⚠ 我们这边的差异（照实记）===
 * 上游那两件**渲染**函数（`buildSonnetIconDataUrl` / 纹理键之外的 SVG 生成）靠
 * **`lucide-react` ＋ `react-dom/server` 的 `renderToStaticMarkup`** ✓ ——
 * **我们仓库没有这两个依赖** ✗（已 grep 全 `apps/renderer`：零命中 ✓）⇒
 * 本文件**只搬"规则"**（什么时候出现 / 出现几次 / 用哪一个 / 用时多久 ✓），
 * **不搬渲染** ✓（渲染将来走"自绘 SVG 字符串" ✓，**不引新依赖** ✗）。
 */

/** 图标名兜底：解析结果为空就用 `Flower`（照抄上游 ✓）。 */
export const SONNET_ICON_FALLBACK_NAME = 'Flower';

export const resolveSonnetIconNames = (names: readonly string[] | undefined): readonly string[] => {
  const resolved = (names ?? []).filter((name) => name.trim() !== '');
  return resolved.length > 0 ? resolved : [SONNET_ICON_FALLBACK_NAME];
};

/**
 * 把**图标粒子**撒进场景，**同时保证"每一个可用图标都被用上"** ✓（上游注释的承诺 ✓）。
 *
 * 返回长度 = `particleCount` ✓；每一项是**该粒子该用第几个图标**（`null` = 这个粒子不出图标 ✓）。
 * 做法：把粒子按"**band**"分组 ✓ ——
 * `iconParticleCount = min(粒子数, max(ceil(粒子数 / 4), 图标数))` ✓
 * （即：**最多四分之一**的粒子带图标 ✓，但**至少够每个图标各出现一次** ✓）；
 * 只有当 `floor(i·k/n) !== floor((i+1)·k/n)` 时，第 `i` 个粒子才出图标 ✓
 * ⇒ 出图标的粒子在序列里**均匀铺开** ✓。
 */
export const buildSonnetIconParticleIndices = (
  iconCount: number,
  particleCount: number,
  seed: number,
): readonly (number | null)[] => {
  const safeIconCount = Math.max(0, Math.floor(iconCount));
  const safeParticleCount = Math.max(0, Math.floor(particleCount));
  if (safeIconCount === 0) {
    return Array.from({ length: safeParticleCount }, () => null);
  }
  const iconParticleCount = Math.min(
    safeParticleCount,
    Math.max(Math.ceil(safeParticleCount / 4), safeIconCount),
  );
  let emittedIconCount = 0;
  return Array.from({ length: safeParticleCount }, (_unused, index) => {
    const previousBand = Math.floor((index * iconParticleCount) / safeParticleCount);
    const currentBand = Math.floor(((index + 1) * iconParticleCount) / safeParticleCount);
    if (currentBand === previousBand) {
      return null;
    }
    // **归一化取模** ✓：`seed` 为负也一定落进 `[0, iconCount)` ✓（我们踩过这个坑 ✓）。
    const iconIndex = (((seed + emittedIconCount) % safeIconCount) + safeIconCount) % safeIconCount;
    emittedIconCount += 1;
    return iconIndex;
  });
};

/**
 * 每个图标的**入场相位**（0~1 ✓）：把出场时刻摊在整镜的大部分时间里，
 * **给最后的揭示留出时间** ✓（上游注释 ✓）。
 * 单个图标 ⇒ `0.12` ✓；否则 `0.04 + (index / (count − 1)) × 0.82` ✓（两端 = `0.04` / `0.86` ✓）。
 */
export const resolveSonnetIconEntryPhase = (index: number, iconCount: number): number => {
  const safeCount = Math.max(0, Math.floor(iconCount));
  if (safeCount <= 1) {
    return 0.12;
  }
  const safeIndex = Math.min(safeCount - 1, Math.max(0, Math.floor(index)));
  return 0.04 + (safeIndex / (safeCount - 1)) * 0.82;
};

/*
 * **入场时长 / 延迟：不在这里实现**（第 549 轮去重 ✓）——
 * 它们**早就在** `sonnetScene.ts` 里（`:61` / `:69` ✓），且**带用例**（`sonnetScene.test.ts` ✓）。
 * 我第 205 轮照抄了一遍 ⇒ 两份真值会漂 ✗ ⇒ 现在改成**再导出** ✓（一份实现、两个入口 ✓，用例全不用动 ✓）。
 * 教训（第五次同源）：**写新纯函数前，先在同一目录里 grep 同名/同义函数** ✗。
 */
export { resolveSonnetIconEntryDuration, resolveSonnetIconEntryDelay } from './sonnetScene';

/** 纹理缓存键（照抄上游格式 ✓）`name|color|strokeWidth|size|resolution` ✓。 */
export const buildSonnetIconTextureKey = (
  name: string,
  color: string,
  strokeWidth: number,
  size: number,
  resolution: number,
): string => `${name}|${color}|${strokeWidth}|${size}|${resolution}`;

/* ------------------------------------------------------------------ *
 * 自绘图标
 *
 * ⚠ **差异 ②（见 `CREDITS.md`）**：上游用 `lucide-react` + `react-dom/server`
 * 把图标渲成 SVG；**我们没有这两个依赖** ⇒ 这里自己手写形状。
 * ⇒ 因此**美术是我们的**（工具名与规则照抄，形状不等于 Lucide）。
 *
 * 画法**对齐上游那三个属性**：`fill: 'none'`、`stroke` 用传入色、
 * `stroke-width` 用传入值、`absoluteStrokeWidth` 语义 ⇒ **线宽不随 viewBox 缩放**
 * （上游用真人字号时开这个开关；我们直接把 `stroke-width` 写死在 24 单位坐标系里，
 *   再把整张 SVG 缩放到 `size` ⇒ 效果一致）。
 * ------------------------------------------------------------------ */

/** 手写形状集：**`Flower` 必须有**（它是上游的兜底名 ✓）；其余按"和商籁气质合"挑 ✓。 */
export const SONNET_ICON_SVG_SHAPES: Readonly<Record<string, string>> = {
  Flower:
    '<circle cx="12" cy="12" r="2.2"/><circle cx="12" cy="6.4" r="3"/><circle cx="17.6" cy="12" r="3"/>' +
    '<circle cx="12" cy="17.6" r="3"/><circle cx="6.4" cy="12" r="3"/>',
  Star: '<polygon points="12,3 14.6,9.4 21.5,9.9 16.2,14.4 17.9,21.1 12,17.4 6.1,21.1 7.8,14.4 2.5,9.9 9.4,9.4"/>',
  Sparkle: '<polygon points="12,2 13.6,10.4 22,12 13.6,13.6 12,22 10.4,13.6 2,12 10.4,10.4"/>',
  Ring: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/>',
  Diamond: '<polygon points="12,2 22,12 12,22 2,12"/>',
  Triangle: '<polygon points="12,3 21.5,20 2.5,20"/>',
  Cross: '<line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/>',
  Orbit: '<ellipse cx="12" cy="12" rx="9.5" ry="4"/><ellipse cx="12" cy="12" rx="9.5" ry="4" transform="rotate(60 12 12)"/>' +
    '<circle cx="12" cy="12" r="1.6"/>',
};

/**
 * 把图标渲成 **SVG data URL** ✓（`null` = 这个名字我们没有形状 ✓）。
 * ⚠ **不需要 React** ✗ —— 纯字符串拼接 ✓，所以我们**不引上游那两个依赖** ✓。
 */
export const buildSonnetIconSvg = (
  name: string,
  color: string,
  strokeWidth: number,
  size: number,
): string | null => {
  const shape = SONNET_ICON_SVG_SHAPES[name];
  if (shape === undefined) {
    return null;
  }
  const sizeValue = Math.max(1, size);
  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sizeValue}" height="${sizeValue}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="${color}" stroke-width="${Math.max(0, strokeWidth)}" ` +
    `stroke-linecap="round" stroke-linejoin="round">${shape}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
};
