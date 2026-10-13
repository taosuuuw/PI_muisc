/**
 * 凝彩逐字**时序落库**层（照抄上游 `tempera/temperaLayout.ts` 的 `applyGlyphTiming` 与两个常量）。
 *
 * 上游把这一步放在**排版收尾**：字形的 `settleTime / releaseTime / trackingX / trackingY`
 * 先在记录里写成占位（`releaseTime: 0`、`settleTime: glyph.endTime`），
 * 最后由 `applyGlyphTiming(placements, settleStretch)` 统一算定 —— 因为这三样都依赖
 * "**这一镜整体**"（本镜歌词结束时刻、本行跨多长、色块中心在哪），不是单个字形能定的。
 *
 * 三条规则（逐条照抄，别想当然）：
 *
 * 1. **归位**：`settleTime = startTime + MIN_SETTLE + max(0, 本镜歌词结束 − startTime − MIN_SETTLE) × stretch`
 *    —— 下限 `0.34` 秒，再加上"到本镜歌词结束所剩距离"的一部分（`stretch` 默认 `0.5`）。
 *    这样错落会从第一个字**平滑**缩到最后一个字，整镜像一次横扫，而不是一排各自弹跳。
 * 2. **释放**：`releaseTime = max(endTime, settleTime) + max(0.5, 本行跨时长)`
 *    —— 唱完的字**缓慢把字距张开**，时长"跟这一行一样长、最短 0.5 秒"。
 * 3. **力臂**：`trackingX/Y = x/y − 中心`，其中
 *    **中心 = 所有字形位置的算术平均**（上游原文就是这么算的：**不是包围盒中心**）。
 *
 * 关于 `stretch` 这个旋钮，上游注释把两个极端讲得很清楚（值得留档）：
 * `0` ⇒ 每个字都拿同样短的小窗口，"密集快歌读起来像打击乐"，但**慢句会在头一秒全落完**；
 * `1` ⇒ 整镜正好落在它自己的歌词结束时刻，慢句全程有生命，但**快镜没有静止时刻、字全在动、看着糊**；
 * `0.5` ⇒ 多数情况下切镜前已安顿好，同时长句的入场又能**深深伸进这一镜里**。
 */

/** 任何字形入场**最短**的时长（上游 `MIN_SETTLE_SECONDS`）。 */
export const TEMPERA_MIN_SETTLE_SECONDS = 0.34;

/** "朝本镜歌词结束拉伸多少"的默认值（上游 `DEFAULT_SETTLE_STRETCH`）。 */
export const TEMPERA_DEFAULT_SETTLE_STRETCH = 0.5;

/** 逐字记录里本层需要的部分（其余字段原样保留）。 */
export interface TemperaTimingPlacement {
  lineIndex: number;
  startTime: number;
  endTime: number;
  x: number;
  y: number;
  settleTime?: number;
  releaseTime?: number;
  trackingX?: number;
  trackingY?: number;
}

/**
 * 给一镜的字形记录补上 `settleTime / releaseTime / trackingX / trackingY`（**纯函数**，返回新数组）。
 *
 * 注意：**同一个 `lineIndex` 的字形会被视为同一行**（上游用行号做 map 的键），
 * 而行跨时长取的是这些字形的 `[最早开始, 最晚结束]`。
 */
export const applyTemperaGlyphTiming = <T extends TemperaTimingPlacement>(
  placements: readonly T[],
  settleStretch: number = TEMPERA_DEFAULT_SETTLE_STRETCH,
): (T & Required<Pick<TemperaTimingPlacement, 'settleTime' | 'releaseTime' | 'trackingX' | 'trackingY'>>)[] => {
  if (placements.length === 0) return [];
  // 非法值回落到默认（上游同口径）。
  const stretch = Number.isFinite(settleStretch)
    ? Math.min(1, Math.max(0, settleStretch))
    : TEMPERA_DEFAULT_SETTLE_STRETCH;

  const lineSpans = new Map<number, number>();
  const lineStarts = new Map<number, number>();
  placements.forEach((placement) => {
    lineSpans.set(placement.lineIndex, Math.max(lineSpans.get(placement.lineIndex) ?? 0, placement.endTime));
    lineStarts.set(
      placement.lineIndex,
      Math.min(lineStarts.get(placement.lineIndex) ?? Number.POSITIVE_INFINITY, placement.startTime),
    );
  });

  // 这里所有记录都属于**当前这一镜**。
  const shotLyricEnd = placements.reduce((latest, placement) => Math.max(latest, placement.endTime), 0);

  // 色块中心 = **位置的算术平均**（上游原样，不是包围盒中心）。
  const centerX = placements.reduce((sum, placement) => sum + placement.x, 0) / placements.length;
  const centerY = placements.reduce((sum, placement) => sum + placement.y, 0) / placements.length;

  return placements.map((placement) => {
    const reach = Math.max(0, shotLyricEnd - placement.startTime - TEMPERA_MIN_SETTLE_SECONDS);
    const settleTime = placement.startTime + TEMPERA_MIN_SETTLE_SECONDS + reach * stretch;
    const span = Math.max(
      0.5,
      (lineSpans.get(placement.lineIndex) ?? placement.endTime) -
        (lineStarts.get(placement.lineIndex) ?? placement.startTime),
    );
    return {
      ...placement,
      settleTime,
      releaseTime: Math.max(placement.endTime, settleTime) + span,
      trackingX: placement.x - centerX,
      trackingY: placement.y - centerY,
    };
  });
};
