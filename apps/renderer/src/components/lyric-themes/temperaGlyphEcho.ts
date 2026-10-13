/**
 * 凝彩「字形重影」两个装置 —— **照抄上游 `tempera/temperaTextView.ts` 的数值与做法**（第 615 轮接线）。
 *
 * 上游那一份在我们本地快照里**缺失**（`.folia-ref/` 只有 20 个 tempera 文件，没有 `temperaTextView.ts`），
 * 取值来自上游仓库同路径原文（AGPL-3.0，只取数值与做法，代码是自己写的）：
 * `https://raw.githubusercontent.com/chthollyphile/folia-major/main/src/components/visualizer/tempera/temperaTextView.ts`
 *
 * · **阴影拷贝**（`shadow`）：**不模糊**的同字拷贝，偏移按**字号等比**（`0.06em` / `0.08em`），
 *   不透明度 `0.34`。它**必须待在反色层之内、且垫在该层最底**——上游注释原话说明了原因：
 *   放到反色层**之下**就成了滤镜要采样的"底图"，每个字会跟自己的影子较劲、笔画碎成硬块；
 *   放进层里则影子与正文**一起被滤镜上色**，读起来是"套印错版"的第二块印版。
 *   影子自己**不带色**（滤镜会给），所以这里只需偏移与不透明度。
 *
 * · **运动回响**（`echoLayer`）：沿入场向量**再往后**停放的暗拷贝，层数 `2`。
 *   第 `i` 层的偏移是 `1 + i * 0.85` 倍（越深的越远），不透明度除以 `index + 1.4`；
 *   只要第一层的 `echoAlpha ≤ 0.004` 就整组隐藏（上游就是这条阈值）。
 *   这一层**挂在反色层之外**（不参与反色），否则入场途中拖尾也会变成滤镜要判断的背景。
 *
 * 纯函数：每帧由"运动层的当前帧 + 布局基准点"推出拷贝的偏移与不透明度，无跨帧状态。
 */

/** 阴影拷贝的横向偏移（**相对字号**；上游 `SHADOW_OFFSET_X`）。 */
export const TEMPERA_SHADOW_OFFSET_X = 0.06;

/** 阴影拷贝的纵向偏移（**相对字号**；上游 `SHADOW_OFFSET_Y`）。 */
export const TEMPERA_SHADOW_OFFSET_Y = 0.08;

/** 阴影拷贝的不透明度（上游 `SHADOW_ALPHA`）。 */
export const TEMPERA_SHADOW_ALPHA = 0.34;

/**
 * 运动回响的层数。
 *
 * 上游是 `echoCount: tuning.showDecor && !staticMode ? 2 : 0` —— 即**装饰开关**同时管着回响，
 * 默认 `showDecor = true`，所以常态 2 层。我们这边**没有 staticMode**（静态模式），
 * 且按第 614 轮的决定**不移植 `showDecor` 开关**（模板见 `CREDITS.md`「`showDecor`：有意不移植」）
 * ⇒ 这里就是**恒开**，等价于上游默认档；这是**有意偏离**，不是漏了开关。
 */
export const TEMPERA_ECHO_LAYERS = 2;

/** 回响的深度步长（上游 `const depth = 1 + index * 0.85`）。 */
export const TEMPERA_ECHO_DEPTH_STEP = 0.85;

/** 回响的不透明度分母（上游 `echo.alpha = frame.echoAlpha / (index + 1.4)`）。 */
export const TEMPERA_ECHO_ALPHA_DIVISOR = 1.4;

/** 回响可见的不透明度下限（上游 `frame.visible && frame.echoAlpha > 0.004`）。 */
export const TEMPERA_ECHO_VISIBLE_MIN = 0.004;

/** 阴影拷贝相对**显示位置**的偏移（px）。 */
export const resolveTemperaShadowOffset = (fontPx: number): { dx: number; dy: number } => ({
  dx: fontPx * TEMPERA_SHADOW_OFFSET_X,
  dy: fontPx * TEMPERA_SHADOW_OFFSET_Y,
});

/** 阴影拷贝的不透明度：跟着正文一起淡入淡出，只是打了 0.34 的折。 */
export const resolveTemperaShadowAlpha = (alpha: number): number => alpha * TEMPERA_SHADOW_ALPHA;

/** 一层回响的落点。 */
export interface TemperaEchoCopy {
  /**
   * 相对**布局基准点**的偏移（px）。
   *
   * 关键：不是相对"正文此刻的位置"—— 上游写的是 `baseX + echoX * depth`，
   * 即**用布局基准点 + 回响自身位移**，正文那一刻的位移**不叠加**。
   * 所以拖尾是"从入场向量上更远的地方跟过来"，而不是"正文后面拖一条等长尾巴"。
   */
  dx: number;
  dy: number;
  alpha: number;
  visible: boolean;
}

/**
 * 解这一帧的整组回响拷贝。
 *
 * `displayVisible` 是正文此刻是否可见（上游 `const echoVisible = frame.visible && frame.echoAlpha > 0.004`）——
 * 正文还没到时间时，回响也不能先冒出来。
 */
export const resolveTemperaEchoCopies = (
  echoX: number,
  echoY: number,
  echoAlpha: number,
  displayVisible: boolean,
): TemperaEchoCopy[] => {
  const visible = displayVisible && echoAlpha > TEMPERA_ECHO_VISIBLE_MIN;
  return Array.from({ length: TEMPERA_ECHO_LAYERS }, (_unused, index) => {
    const depth = 1 + index * TEMPERA_ECHO_DEPTH_STEP;
    return {
      dx: echoX * depth,
      dy: echoY * depth,
      alpha: echoAlpha / (index + TEMPERA_ECHO_ALPHA_DIVISOR),
      visible,
    };
  });
};
