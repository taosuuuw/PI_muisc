/**
 * 凝彩的**文字反色滤镜**：让歌词压在任意色块上都读得出来。
 *
 * === 它在做什么 ===
 * 单遍阈值反色：采样**已经画好的下层画面**（色块 / 网线 / 缝），对每个文字像素，
 * 在「墨色」与「纸色」之间选**离背景更远的那个** —— 于是亮块上自动出墨字、暗块上自动出纸字，
 * 不用为每一种构图手工挑字色，就有了那种"印刷套色"的观感。
 *
 * === AGPL 说明 ===
 * folia-major 是 AGPL-3.0。这里**只借鉴数值与做法**（阈值比较、5 抽样平均、解除预乘、
 * 没画到的地方按纸算、`resolution: 'inherit'` 这个必须项），着色器与 JS 都是在本仓库重写的。
 * 顶点着色器那一段是 **Pixi v8 自定义滤镜的接口样板**（字段名与算式由框架规定），不是创作部分。
 *
 * === 与 folia 的差异（照实记）===
 * folia 的滤镜还有第二种形态：`inversion: false` 时退化成"只上色带"（四档色相渐变沿整行扫过，
 * 并保留反色选出的亮度）。我们 app 没有渐变字模式，所以这一形态**没有实现**。
 */

import type { Filter, GlProgram as GlProgramType } from 'pixi.js';

type PixiModule = typeof import('pixi.js');

/** Pixi v8 自定义滤镜的顶点样板：把滤镜自己的框映射到裁剪空间，并把 uv 传给片元。 */
const VERTEX = `
in vec2 aPosition;
out vec2 vUv;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

void main(void) {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    gl_Position = vec4(position, 0.0, 1.0);
    vUv = aPosition * (uOutputFrame.zw * uInputSize.zw);
}
`;

const FRAGMENT = `
in vec2 vUv;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uBackTexture;

uniform highp vec4 uInputSize;
uniform vec3 uInk;
uniform vec3 uPaper;
uniform float uInkLuminance;
uniform float uPaperLuminance;
uniform float uBias;

/**
 * 下层某一点的亮度。
 *
 * 两个细节：Pixi 的渲染目标是**预乘**的，读亮度前要先除回去；而 alpha 接近 0 的地方
 * 说明那里什么都没画（透出的是外壳背景），那就按"纸"算 —— 否则洞与画外会读出黑色。
 */
float backdropLuminance(vec2 uv) {
    vec4 back = texture(uBackTexture, uv);
    vec3 straight = back.rgb / max(back.a, 1e-4);
    float lum = dot(straight, vec3(0.2126, 0.7152, 0.0722));
    return mix(uPaperLuminance, lum, clamp(back.a * 3.0, 0.0, 1.0));
}

void main(void) {
    vec4 glyph = texture(uTexture, vUv);

    // 5 抽样平均：细网线会让逐像素判定来回抖，平均一下就不闪了。
    vec2 texel = uInputSize.zw * 1.5;
    float lum = backdropLuminance(vUv) * 0.4
        + (backdropLuminance(vUv + texel)
            + backdropLuminance(vUv - texel)
            + backdropLuminance(vUv + vec2(texel.x, -texel.y))
            + backdropLuminance(vUv + vec2(-texel.x, texel.y))) * 0.15;

    // 选离背景更远的那一端：无论主题是"浅纸深墨"还是"深纸浅墨"，对比都不会塌。
    vec3 tone = mix(uInk, uPaper, step(abs(lum - uInkLuminance) + uBias, abs(lum - uPaperLuminance)));
    finalColor = vec4(tone * glyph.a, glyph.a);
}
`;

const REC709 = [0.2126, 0.7152, 0.0722] as const;

function normalizedRgb(color: string, fallback: readonly [number, number, number]): Float32Array {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(color.trim());
  if (match === null) return new Float32Array(fallback);
  return new Float32Array([
    Math.min(1, Math.max(0, Number(match[1]) / 255)),
    Math.min(1, Math.max(0, Number(match[2]) / 255)),
    Math.min(1, Math.max(0, Number(match[3]) / 255)),
  ]);
}

function luminanceOf(rgb: Float32Array): number {
  return rgb[0]! * REC709[0] + rgb[1]! * REC709[1] + rgb[2]! * REC709[2];
}

export interface TemperaDifferenceOptions {
  /** 字色（应当已经由 `resolveCssColor` 落成计算色，不能是 `var(...)` 链）。 */
  readonly ink: string;
  /** 纸色（没画到的地方按它算）。 */
  readonly paper: string;
  /** 0..1，0.5 中立；越大越偏向选墨色。 */
  readonly threshold?: number;
}

/** 建一个凝彩反色滤镜。调用方（渲染层）负责把它挂到歌词层上；换色时**重建**即可（换色很少）。 */
export function createTemperaDifferenceFilter(
  pixi: PixiModule,
  options: TemperaDifferenceOptions,
): Filter {
  const ink = normalizedRgb(options.ink, [1, 1, 1]);
  const paper = normalizedRgb(options.paper, [0, 0, 0]);
  const uniforms = new pixi.UniformGroup({
    uInk: { value: ink, type: 'vec3<f32>' },
    uPaper: { value: paper, type: 'vec3<f32>' },
    uInkLuminance: { value: luminanceOf(ink), type: 'f32' },
    uPaperLuminance: { value: luminanceOf(paper), type: 'f32' },
    uBias: { value: (options.threshold ?? 0.5) - 0.5, type: 'f32' },
  });
  const program: GlProgramType = pixi.GlProgram.from({
    vertex: VERTEX,
    fragment: FRAGMENT,
    name: 'pi-tempera-difference-inversion',
  });
  return new pixi.Filter({
    glProgram: program,
    // 让 Pixi 把本层**已画在下面的像素**快照进 `uBackTexture`；下面那个空纹理是它要求的占位。
    blendRequired: true,
    resources: { piDifferenceUniforms: uniforms, uBackTexture: pixi.Texture.EMPTY },
    padding: 0,
    /*
     * **必须是 `'inherit'`**。Pixi 的 Filter 默认是硬编码的 1，那会让输入纹理的分辨率与背景纹理不一致
     * （后者永远跟随渲染目标），于是同一组 vUv 在两张纹理上指向不同位置：反色会在成片的地方选错颜色，
     * 细网线上最明显。实测过默认值：字会整块糊掉。
     */
    resolution: 'inherit',
  });
}
