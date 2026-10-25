/**
 * 莱茵阵列的画质档位。
 *
 * 数值直接取自参考实现的画质预设（SOURCE: `RhineLabUI src/render-quality.ts:14-59`），
 * 四档的语义也照抄：**画质只调「渲染精度与可选效果」，不重新制作模型、不动光照与动效**
 * （参考的 DESIGN.md 明确了这条边界，我们沿用）。
 *
 * 与参考的差别（照实说）：参考有九项独立参数 + 一个「自定义」档；我们这一期只做四档预设
 * （性能 / 原始 / 高 / 极高），默认「原始」—— 也就是参考的 default。独立微调留到后面再说。
 */
export interface RhineQuality {
  /** 渲染比例（%）。 */
  scale: number;
  /** 像素密度上限（与设备 DPR 取小）。 */
  pixelRatio: number;
  antialias: 'off' | 'smaa';
  /** 阴影贴图边长，0 = 关阴影。 */
  shadows: number;
  /** SSAO 采样数，0 = 关环境遮蔽。 */
  aoSamples: number;
  /** 环境遮蔽的分辨率倍率。 */
  aoResolution: number;
  /** 景深强度（%），0 = 关景深。 */
  depthOfField: number;
  /** 玻璃透射的保留比例（性能档降到 0.5）。 */
  transmission: number;
  /** 各向异性上限。 */
  anisotropy: number;
}

export type RhineQualityPreset = 'performance' | 'original' | 'high' | 'ultra';

/** SOURCE: `RhineLabUI src/render-quality.ts:14-59`（四档逐字段照抄）。 */
export const RHINE_QUALITY_PRESETS: Record<RhineQualityPreset, RhineQuality> = {
  performance: {
    scale: 80,
    pixelRatio: 1,
    antialias: 'off',
    shadows: 1024,
    aoSamples: 0,
    aoResolution: 0.5,
    depthOfField: 0,
    transmission: 0.5,
    anisotropy: 4,
  },
  original: {
    scale: 100,
    pixelRatio: 1.5,
    antialias: 'off',
    shadows: 2048,
    aoSamples: 32,
    aoResolution: 1,
    depthOfField: 100,
    transmission: 1,
    anisotropy: 16,
  },
  high: {
    scale: 125,
    pixelRatio: 2,
    antialias: 'smaa',
    shadows: 4096,
    aoSamples: 32,
    aoResolution: 1,
    /*
     * 景深强度 100 → 45（2026-10-22 主人：「极高选项下视窗里也是一片模糊」）。
     *
     * 这个值喂给 BokehPass 的 aperture，满值等于"整屏只有焦点那一薄片是清楚的"。
     * 参考画面确实有景深，但主体始终清晰、只有远处才散；45 让焦点附近保持锐利。
     */
    depthOfField: 45,
    transmission: 1,
    anisotropy: 16,
  },
  ultra: {
    scale: 150,
    pixelRatio: 2,
    antialias: 'smaa',
    shadows: 4096,
    aoSamples: 64,
    aoResolution: 1,
    depthOfField: 55,
    transmission: 1,
    anisotropy: 16,
  },
};

export const RHINE_QUALITY_LABELS: Record<RhineQualityPreset, string> = {
  performance: '性能',
  original: '原始',
  high: '高',
  ultra: '极高',
};

const QUALITY_KEY = 'pi.rhine-quality';

/** 读上次选的档；非法值 / 存储不可用都退回「原始」。 */
export function readStoredRhineQuality(): RhineQualityPreset {
  if (typeof window === 'undefined') return 'original';
  try {
    const raw = window.localStorage.getItem(QUALITY_KEY);
    return raw !== null && raw in RHINE_QUALITY_PRESETS ? (raw as RhineQualityPreset) : 'original';
  } catch {
    return 'original';
  }
}

export function persistRhineQuality(preset: RhineQualityPreset): void {
  try {
    window.localStorage.setItem(QUALITY_KEY, preset);
  } catch {
    /* 写不进去也不该崩：本次会话仍然生效 */
  }
}

export interface RhineRenderSize {
  ratio: number;
  width: number;
  height: number;
  /** 是否被像素预算 / 纹理尺寸上限压下过。 */
  limited: boolean;
}

/**
 * 实际渲染尺寸。
 * SOURCE: `RhineLabUI src/render-quality.ts:127-151`（`renderDimensions`）——
 * 全尺寸缓冲上限 8,294,400 像素（约 8.3MP），并且不得超过显卡的纹理边长上限。
 */
export function rhineRenderSize(
  quality: RhineQuality,
  width: number,
  height: number,
  deviceRatio: number,
  maxTextureSize: number,
  pixelBudget = 8_294_400,
): RhineRenderSize {
  const requested = (Math.min(deviceRatio, quality.pixelRatio) * quality.scale) / 100;
  const ratio = Math.min(
    requested,
    Math.sqrt(pixelBudget / Math.max(1, width * height)),
    maxTextureSize / Math.max(1, width, height),
  );
  return {
    ratio,
    width: Math.max(1, Math.floor(width * ratio)),
    height: Math.max(1, Math.floor(height * ratio)),
    limited: ratio < requested - 0.0001,
  };
}
