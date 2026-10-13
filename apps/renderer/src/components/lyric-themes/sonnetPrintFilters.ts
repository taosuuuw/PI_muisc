/**
 * 商籁（sonnet）的**印刷感滤镜组**之一：网点（halftone）。
 *
 * 来源：`chthollyphile/folia-major@main` 的
 * `src/components/visualizer/sonnet/sonnetPrintFilters.ts`（AGPL-3.0，
 * **只取算法与数值，代码按本仓库风格重写**；本地快照 `.folia-ref/sonnet__sonnetPrintFilters.ts`）。
 *
 * 上游那一组共 **三个**滤镜（`rgbShift` / `halftone` / `vignette`，各自带一个 `uAmount`），
 * 共用 `createPass` 工厂、对外由 `createSonnetPrintFilters(pixi, amounts): Filter[]` 返回数组。
 * **本轮只落 halftone 这一个**；另两个随后各补一轮，最后再合到一个数组工厂里。
 *
 * halftone 的数值（全部取自上游）：
 *   · 网胞边长 **`cellSize = 5.0`**；
 *   · 三个通道各用一个网点角度：**R 15°、G 75°、B 0°**（`radians(15.0) / radians(75.0) / radians(0.0)`）；
 *   · 网点半径 `radius = sqrt(clamp(value, 0, 1)) * cellSize * 0.62`；
 *   · 边缘用 `1 - smoothstep(radius - 1.2, radius + 1.2, dist)`，其中
 *     `dist = length(fract(rotated / cellSize) - 0.5) * cellSize`，
 *     `rotated = mat2(c, s, -s, c) * fragCoord`（`c = cos(angle)`、`s = sin(angle)`）；
 *   · 最终 `color.rgb = mix(color.rgb, screened, uAmount)`。
 *
 * 两个必须保住的细节：
 *   1. **它用 `gl_FragCoord`（屏幕空间），并且不采 `uInputClamp`** ——
 *      这不是遗漏，是设计（与同组的 rgbShift 不同，那个有 `uInputClamp`）。**不要顺手"补齐"。**
 *   2. **先解预乘、算完再预乘回去**：`if (color.a > 0.0) color.rgb /= color.a;` … `color.rgb *= color.a;`
 *      （Pixi 的渲染纹理是预乘的，与 `sonnetLensFilter.ts` 里那条注意事项同源）。
 *
 * `padding`：**上游的 `createPass` 没有设 `padding`**（用 Pixi 默认），本模块与之保持一致 ——
 * 这是核对过的结论，不是缺省遗漏。
 * `antialias: 'on'`：**上游明确设了**，理由原话是「画布是 MSAA（`antialias: true`），
 * 但滤镜 pass 渲染到的离屏纹理默认**不是**多重采样的，细笔画会丢抗锯齿、变毛刺，
 * 所以这些全场景 pass 必须保 MSAA」。**本模块照设。**
 *
 * ⬜ **尚未接线**：目前只被 typecheck 覆盖，没挂到任何场景上。
 */

import { Filter, GlProgram, UniformGroup } from 'pixi.js';

/** 顶点着色器：Pixi v8 的标准写法（与 `sonnetGlitchFilter.ts` / `sonnetLensFilter.ts` 里那份一致）。 */
const SONNET_PRINT_VERTEX = `
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

/** 网点片段着色器（数值全部照搬上游，见文件头逐条列出的那一组）。 */
const SONNET_HALFTONE_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uAmount;

float dotScreen(vec2 fragCoord, float angle, float value, float cellSize) {
    float c = cos(angle);
    float s = sin(angle);
    vec2 rotated = mat2(c, s, -s, c) * fragCoord;
    float dist = length(fract(rotated / cellSize) - 0.5) * cellSize;
    float radius = sqrt(clamp(value, 0.0, 1.0)) * cellSize * 0.62;
    return 1.0 - smoothstep(radius - 1.2, radius + 1.2, dist);
}

void main(void) {
    vec4 color = texture(uTexture, vTextureCoord);
    if (color.a > 0.0) {
        color.rgb /= color.a;
    }
    float cellSize = 5.0;
    vec3 screened = vec3(
        dotScreen(gl_FragCoord.xy, radians(15.0), color.r, cellSize),
        dotScreen(gl_FragCoord.xy, radians(75.0), color.g, cellSize),
        dotScreen(gl_FragCoord.xy, radians(0.0), color.b, cellSize)
    );
    color.rgb = mix(color.rgb, screened, uAmount);
    color.rgb *= color.a;
    finalColor = color;
}
`;

export interface SonnetHalftoneEffect {
  filter: Filter;
  update: (amount: number) => void;
}

/** 网点滤镜：`amount` 是 0~1 的混合量（0 = 原样、1 = 全网点）。 */
export function createSonnetHalftoneFilter(amount: number): SonnetHalftoneEffect {
  const uniforms = new UniformGroup({
    uAmount: { value: amount, type: 'f32' },
  });
  const filter = new Filter({
    glProgram: GlProgram.from({
      vertex: SONNET_PRINT_VERTEX,
      fragment: SONNET_HALFTONE_FRAGMENT,
      name: 'sonnet-print-halftone',
    }),
    resources: { halftoneUniforms: uniforms },
    // 上游 `createPass` 的取值（理由见文件头）：全场景 pass 必须保 MSAA，否则细笔画变毛刺。
    antialias: 'on',
  });
  filter.enabled = false;
  return {
    filter,
    update: (next: number) => {
      uniforms.uniforms.uAmount = next;
    },
  };
}

/**
 * 暗角片段着色器（数值全部照搬上游）。
 *
 * 上游注释原意：容器用的是**视口大小的 `filterArea`**，所以这里用
 * `vTextureCoord * uInputSize.xy / uOutputFrame.zw` 拿回**稳定的 0..1 视口坐标**，
 * 而不是从歌词包围盒推出来的坐标；并且**混向不透明黑** `vec4(0,0,0,1)`，
 * 这样在场景的**透明背景**上也能读出来。
 */
const SONNET_VIGNETTE_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform float uAmount;

void main(void) {
    vec4 color = texture(uTexture, vTextureCoord);
    vec2 screenUv = vTextureCoord * uInputSize.xy / uOutputFrame.zw;
    vec2 centered = screenUv - 0.5;
    centered.x *= uOutputFrame.z / uOutputFrame.w;
    float vignette = clamp(smoothstep(0.52, 1.08, length(centered)) * uAmount * 0.6, 0.0, 1.0);
    finalColor = mix(color, vec4(0.0, 0.0, 0.0, 1.0), vignette);
}
`;

export interface SonnetVignetteEffect {
  filter: Filter;
  update: (amount: number) => void;
}

/**
 * 暗角滤镜。数值：`smoothstep(0.52, 1.08, r) * uAmount * 0.6`，结果夹在 0..1；
 * `r = length(centered)`，其中 `centered = screenUv - 0.5` 且 `x` 乘过 aspect。
 */
export function createSonnetVignetteFilter(amount: number): SonnetVignetteEffect {
  const uniforms = new UniformGroup({
    uAmount: { value: amount, type: 'f32' },
  });
  const filter = new Filter({
    glProgram: GlProgram.from({
      vertex: SONNET_PRINT_VERTEX,
      fragment: SONNET_VIGNETTE_FRAGMENT,
      name: 'sonnet-print-vignette',
    }),
    resources: { vignetteUniforms: uniforms },
    // 与 halftone 同一取值：上游 `createPass` 就是 `antialias: 'on'`（理由见文件头）。
    antialias: 'on',
  });
  filter.enabled = false;
  return {
    filter,
    update: (next: number) => {
      uniforms.uniforms.uAmount = next;
    },
  };
}

/**
 * 三通道错位（RGB shift）片段着色器（数值全部照搬上游）。
 *
 * 数值：偏移方向 **`vec2(0.9063, 0.4226)`**（≈25°），幅度 **`uAmount * 3.0 * uInputSize.zw`**（即 3 个纹素）；
 * `coreWeight = 0.84 - clamp(uAmount, 0, 1) * 0.18`；合成 `max(center.rgb * coreWeight, vec3(red.r, center.g, blue.b))`。
 *
 * 两点与 `sonnetLensFilter.ts` **完全同构**（上游也复述了同一条理由）：
 *   1. 那个**中性内核不能去掉** —— 否则透明的红/蓝错位样本会把一根白色 MG 细线
 *      塌成意外的"只有绿色"；
 *   2. **采 `uInputClamp`**（与 halftone 不同、与 lens 相同），越界返回 `vec4(0)`。
 */
const SONNET_RGB_SHIFT_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uInputClamp;
uniform float uAmount;

vec4 sampleInside(vec2 uv) {
    if (uv.x < uInputClamp.x || uv.y < uInputClamp.y
        || uv.x > uInputClamp.z || uv.y > uInputClamp.w) {
        return vec4(0.0);
    }
    return texture(uTexture, uv);
}

void main(void) {
    vec2 offset = vec2(0.9063, 0.4226) * uAmount * 3.0 * uInputSize.zw;
    vec4 redSample = sampleInside(vTextureCoord + offset);
    vec4 center = sampleInside(vTextureCoord);
    vec4 blueSample = sampleInside(vTextureCoord - offset);
    float alpha = max(center.a, max(redSample.a, blueSample.a));
    float coreWeight = 0.84 - clamp(uAmount, 0.0, 1.0) * 0.18;
    vec3 core = center.rgb * coreWeight;
    vec3 separated = vec3(redSample.r, center.g, blueSample.b);
    finalColor = vec4(max(core, separated), alpha);
}
`;

export interface SonnetRgbShiftEffect {
  filter: Filter;
  update: (amount: number) => void;
}

/** 三通道错位滤镜。 */
export function createSonnetRgbShiftFilter(amount: number): SonnetRgbShiftEffect {
  const uniforms = new UniformGroup({
    uAmount: { value: amount, type: 'f32' },
  });
  const filter = new Filter({
    glProgram: GlProgram.from({
      vertex: SONNET_PRINT_VERTEX,
      fragment: SONNET_RGB_SHIFT_FRAGMENT,
      name: 'sonnet-print-rgb-shift',
    }),
    resources: { rgbShiftUniforms: uniforms },
    antialias: 'on',
  });
  filter.enabled = false;
  return {
    filter,
    update: (next: number) => {
      uniforms.uniforms.uAmount = next;
    },
  };
}

/**
 * 上游的**数组工厂**：`SonnetPrintEffectAmounts = { rgbShift, halftone, vignette }`，
 * **每个效果只在它的 amount > 0 时才入数组**，顺序即 rgbShift → halftone → vignette。
 *
 * ⚠ 与本文件里三个单个工厂的一处**必要差异**：上游 `createPass` **不禁用**滤镜（默认可用），
 * 而本文件那三个单个工厂一律 `enabled = false`（为了"手工挂/摘"的场景）。
 * 所以这里必须**显式启用**，否则数组里全是失效滤镜、等于没挂。
 */
export interface SonnetPrintEffectAmounts {
  rgbShift: number;
  halftone: number;
  vignette: number;
}

export function createSonnetPrintFilters(amounts: SonnetPrintEffectAmounts): Filter[] {
  const filters: Filter[] = [];
  if (amounts.rgbShift > 0) filters.push(createSonnetRgbShiftFilter(amounts.rgbShift).filter);
  if (amounts.halftone > 0) filters.push(createSonnetHalftoneFilter(amounts.halftone).filter);
  if (amounts.vignette > 0) filters.push(createSonnetVignetteFilter(amounts.vignette).filter);
  for (const filter of filters) filter.enabled = true;
  return filters;
}
