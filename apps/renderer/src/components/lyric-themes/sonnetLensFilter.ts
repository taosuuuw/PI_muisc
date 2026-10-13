/**
 * 商籁（sonnet）的**镜头滤镜**：桶形畸变 + 径向色散（彩色边缘）。
 *
 * 来源：`chthollyphile/folia-major@main` 的
 * `src/components/visualizer/sonnet/sonnetLensFilter.ts`（AGPL-3.0，
 * **只取算法与数值，代码按本仓库风格重写**；登记见 `docs/CREDITS.md` 第 575 轮）。
 * 结构与写法沿用本仓已有的 `sonnetGlitchFilter.ts`（同类移植的现成先例）。
 *
 * 它做的事（**数值全部来自上游，逐条列出**）：
 *   · 屏幕坐标中心化并按 aspect 拉正：`centered = screenUv − 0.5`、`centered.x *= aspect`；
 *   · **桶形畸变**：`curvature = uDistortion * 0.32`
 *     （上游注释：`uDistortion` 在 UI/store 里是 **0..2** 的量，乘 0.32 是为了低端保持轻微、
 *     同时给"参考观感里那种宽桶形畸变"留足余量），
 *     `radialScale = 1 − curvature·r² + curvature·0.16·r⁴`；
 *   · **径向色散**：`edgeWeight = smoothstep(0.12, 0.9, r)`、
 *     `dispersion = radialDirection · uDispersion · 0.012 · edgeWeight`；
 *   · 三次采样（中心 / `+dispersion` / `−dispersion`），`alpha = max(三个 a)`；
 *   · **内核权重** `coreWeight = 0.84 − clamp(uDispersion, 0, 1) * 0.18`；
 *   · 合成 `color = max(center.rgb * coreWeight, vec3(red.r, center.g, blue.b))`。
 *
 * 两个必须保住的细节（上游注释的原意）：
 *   1. **`max(core, separated)` 里的那个中性内核不能去掉** —— 一像素宽的细 MG 笔画若采到透明的
 *      红/蓝 texel，会变成一根意外的"只有绿色"的笔画。
 *   2. **Pixi 的渲染纹理是预乘的**，`max` 之后的通道值仍是预乘值，所以直接 `vec4(color, alpha)`。
 *
 * 采样一律走 `sampleInside()`：**越出 `uInputClamp` 返回 `vec4(0)`**（与 glitch 同一套夹取）。
 *
 * ⬜ **尚未接线**：本模块目前只被单测引用，没挂到任何场景上。
 */

import { Filter, GlProgram, UniformGroup } from 'pixi.js';

/** 顶点着色器：Pixi v8 的标准写法（与 `sonnetGlitchFilter.ts` 里那份逐字一致）。 */
const SONNET_LENS_VERTEX = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

void main(void) {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    gl_Position = vec4(position, 0.0, 1.0);
    vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}
`;

/** 片段着色器：桶形畸变 + 径向色散（数值全部照搬上游，见文件头）。 */
const SONNET_LENS_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uInputClamp;
uniform vec4 uOutputFrame;
uniform float uDistortion;
uniform float uDispersion;

vec2 screenToTextureUv(vec2 screenUv) {
    return screenUv * uOutputFrame.zw * uInputSize.zw;
}

vec4 sampleInside(vec2 uv) {
    if (uv.x < uInputClamp.x || uv.y < uInputClamp.y
        || uv.x > uInputClamp.z || uv.y > uInputClamp.w) {
        return vec4(0.0);
    }
    return texture(uTexture, uv);
}

void main(void) {
    vec2 screenUv = vTextureCoord * uInputSize.xy / max(uOutputFrame.zw, vec2(1.0));
    vec2 centered = screenUv - 0.5;
    float aspect = uOutputFrame.z / max(uOutputFrame.w, 1.0);
    centered.x *= aspect;

    float radiusSquared = dot(centered, centered);
    float curvature = uDistortion * 0.32;
    float radialScale = 1.0 - curvature * radiusSquared
        + curvature * 0.16 * radiusSquared * radiusSquared;
    vec2 lensCentered = centered * radialScale;
    lensCentered.x /= aspect;
    vec2 lensUv = lensCentered + 0.5;

    float radius = sqrt(radiusSquared);
    vec2 radialDirection = radius > 0.0001 ? centered / radius : vec2(0.0);
    float edgeWeight = smoothstep(0.12, 0.9, radius);
    vec2 dispersion = radialDirection * uDispersion * 0.012 * edgeWeight;
    dispersion.x /= aspect;

    vec4 center = sampleInside(screenToTextureUv(lensUv));
    vec4 redSample = sampleInside(screenToTextureUv(lensUv + dispersion));
    vec4 blueSample = sampleInside(screenToTextureUv(lensUv - dispersion));
    float alpha = max(center.a, max(redSample.a, blueSample.a));
    float coreWeight = 0.84 - clamp(uDispersion, 0.0, 1.0) * 0.18;

    vec3 core = center.rgb * coreWeight;
    vec3 separated = vec3(redSample.r, center.g, blueSample.b);
    vec3 color = max(core, separated);

    finalColor = vec4(color, alpha);
}
`;

export interface SonnetLensEffectAmounts {
  /** 桶形畸变强度：**UI/store 里是 0..2 的量**（见文件头）。 */
  distortion: number;
  /** 径向色散强度（`coreWeight` 里按 0..1 夹取）。 */
  dispersion: number;
}

export interface SonnetLensEffect {
  filter: Filter;
  update: (amounts: SonnetLensEffectAmounts) => void;
}

export function createSonnetLensFilter(amounts: SonnetLensEffectAmounts): SonnetLensEffect {
  const uniforms = new UniformGroup({
    uDistortion: { value: amounts.distortion, type: 'f32' },
    uDispersion: { value: amounts.dispersion, type: 'f32' },
  });
  const filter = new Filter({
    glProgram: GlProgram.from({
      vertex: SONNET_LENS_VERTEX,
      fragment: SONNET_LENS_FRAGMENT,
      name: 'sonnet-lens',
    }),
    resources: { lensUniforms: uniforms },
    // 与 glitch 同样取 0：采样由 `uInputClamp` 夹住，不需要视口外的余量
    // （padding 会让 Pixi 在裁到视口**之后**才放大共享渲染帧，暗角坐标会整体平移）。
    padding: 0,
  });
  filter.enabled = false;
  return {
    filter,
    update: (next: SonnetLensEffectAmounts) => {
      uniforms.uniforms.uDistortion = next.distortion;
      uniforms.uniforms.uDispersion = next.dispersion;
    },
  };
}
