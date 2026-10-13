/**
 * 全屏 pass 的纹理分辨率预算（照抄 folia `pixiTextureBudget.ts` 的档位吸附；来源见 `docs/CREDITS.md`）。
 *
 * ## 为什么需要它
 *
 * Pixi 的 `TexturePool.getOptimalTexture` 会把每个 render target **逐轴向上取整到 2 的幂**
 * （`nextPow2(ceil(frame * resolution - 1e-6))`），并拿这一对尺寸当池 key ——
 * 也就是说**一个 pass 是按「档位」计费，而不是按画幅计费**。
 * 781×850 的视口在 1.5x 下光栅化成 1172×1275，落进 2048×2048 那一档：
 * 16MB 的纹理里 **71% 从来没画过东西**。
 * tempera 同时挂着若干这样的全屏 pass，再叠加反色 filter 的 backdrop 拷贝，浪费是成倍的。
 *
 * 代价还是**阶梯式的、不是线性的**，这一点最容易估错：上游 Intel 核显实测，
 * 窗口从 640×640 放大到 700×700（面积 +18%）会把常驻显存从 628MB 抬到 822MB（+31%），
 * 只因为 `1.5 × 700` 越过了 1024，所有池化目标在两个轴上同时翻倍 ——
 * 而画面本身没有任何变化配得上这个涨幅。
 *
 * ## 做法
 *
 * 吸附**只让出"能换到更小档位"的那部分分辨率**，不做全局调低
 * （全局调低会哪儿都变糊，而且照样落在原来那一档）。
 * 同一个 781×850 视口上它给出 `1.2047` 而不是 `1.5`：糊约 20%，
 * 但池化目标从 2048×2048 降到 1024×1024（四分之一显存），
 * 画幅对纹理的填充率从 29% 升到 **92%** —— **每字节换到的清晰度是升的**。
 *
 * 三条约束（照抄上游）：
 * 1. **每轴只考虑降一档**，且只接受降幅落在 `TEXTURE_POOL_MAX_RESOLUTION_DROP`（25%）以内的候选。
 *    边界太远的视口（2000×1200 在 1.5x 下要降到 1.024，砍 32%）**保持原样** ——
 *    那种情形下多付一个档位，比把整幅画糊掉三分之一划算。
 * 2. 吸附值**随视口变化**，不只随设置变化 ⇒ 每次 resize 都要重算，
 *    并和 `renderer.resize(w, h, resolution)` 一起下发；比较 tuning 时比的也该是吸附后的值
 *    （两个相邻滑块位置共用同一档位时，不该白白重建 surface）。
 * 3. runtime 里**写死数值的 filter pass 一律从吸附后的 `renderResolution` 派生**，
 *    不能读 `tuning.textureResolution`。读设置的话，pass 会去要一个比它实际落地的 surface
 *    更大的档位 —— 那正好是吸附想消掉的那部分浪费。
 *
 * 吸附出来的画面与"用户手动把滑块拨到同一个值"**逐像素一致**（上游实测最大差 1/255），
 * 所以它不是一种新的渲染模式。
 *
 * === 与 folia 的差异（照实说）===
 * 上游那个文件所在的模块群还包含**画布图片池**（用户自备图片、`visualizerImageAsset`、
 * IndexedDB 存储、zip 导入导出、back/front 两层与反色滤镜的前后关系），
 * 那是"用户往画布上放东西"的功能，与"纹理档位换算"无关，我们**没有移植**。
 * 本文件只搬**档位吸附**这一件纯函数的事。
 *
 * 另注：上游 `textureResolution` 默认 **1.5**（`tempera` 的 tuning 默认值）。
 */

/** 吸附允许的最大降幅（相对原始分辨率）。照抄上游 `TEXTURE_POOL_MAX_RESOLUTION_DROP`。 */
export const TEXTURE_POOL_MAX_RESOLUTION_DROP = 0.25;

/** 逐轴向上取整到 2 的幂（与 Pixi 内部那条 `nextPow2` 同义）。 */
export function nextPowerOfTwo(value: number): number {
  if (!Number.isFinite(value) || value <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(value));
}

export interface TextureBudgetOptions {
  /** 视口宽（CSS 像素，未乘分辨率）。 */
  readonly width: number;
  /** 视口高（CSS 像素，未乘分辨率）。 */
  readonly height: number;
  /** 用户设置的分辨率倍率（tempera 默认 1.5）。 */
  readonly resolution: number;
}

/**
 * 把 `textureResolution` 吸附到"刚好落进更小一个档位"的值。
 *
 * 用**长边**定档位：候选档位 = 当前长边档位的**一半**，于是
 * `候选分辨率 = 候选档位 / 长边` —— 长边正好铺满该档，短边最多也只降一档
 * （短边档位不会超过长边，所以"每轴只降一档"自动成立）。
 * 降幅超过 `TEXTURE_POOL_MAX_RESOLUTION_DROP` 就**原样返回**，不做牺牲。
 */
export function snapResolutionToTexturePool(options: TextureBudgetOptions): number {
  const { width, height, resolution } = options;
  const maxDimension = Math.max(width, height);
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) return resolution;
  if (!Number.isFinite(resolution) || resolution <= 0) return resolution;
  // 与 Pixi 同一条式子：先 ceil 再取到 2 的幂（减去 1e-6 是为了让"正好等于档位"的值不被 ceil 抬上去）。
  const currentTier = nextPowerOfTwo(Math.ceil(maxDimension * resolution - 1e-6));
  const nextTier = currentTier / 2;
  if (nextTier < 1) return resolution;
  const candidate = nextTier / maxDimension;
  if (!Number.isFinite(candidate) || candidate <= 0 || candidate >= resolution) return resolution;
  const drop = (resolution - candidate) / resolution;
  return drop <= TEXTURE_POOL_MAX_RESOLUTION_DROP ? candidate : resolution;
}
