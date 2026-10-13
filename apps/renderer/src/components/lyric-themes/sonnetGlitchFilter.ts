/**
 * 商籁（sonnet）转场用的**故障滤镜**（mono-glitch 通道的渲染实现）。
 *
 * 来源：`chthollyphile/folia-major@main` 的 `src/components/visualizer/sonnet/sonnetGlitchFilter.ts`
 * （AGPL-3.0，**只取算法与数值，代码按本仓库风格重写**；见 `docs/CREDITS.md`）。
 *
 * 它做的事（也是"mono"的含义 —— **不**做 RGB 色散，而是"单色安全"的横向切片撕裂）：
 *   · 按屏幕纵坐标切 **26 条粗带**与 **110 条细带**；
 *   · 用 `fract(sin(dot(...)) * 43758.5453)` 这个哈希给每条带一个噪声；
 *   · `step(0.58, 噪声)` / `step(0.88, 噪声)` 决定这条带**要不要动**（只有一小部分带会被选中）；
 *   · 被选中的带横向偏移 `(噪声 × 2 − 1) × amount × 0.095`（粗）/ `× 0.035`（细）；
 *   · 再叠一层**亮度撕裂**：`color.rgb *= 1 + (…) × amount × 0.42` —— 三个通道**等量**变亮，
 *     所以结构上有故障感、颜色上不散开。
 *
 * 采样用 `uInputClamp` 夹住，所以 **padding 必须是 0**：上游注释里写得很清楚 ——
 * Pixi 会把滤镜链里所有滤镜的 padding 相加，并在裁到视口**之后**再放大共享渲染帧，
 * 于是 padding 只会带来视口外的像素，同时让场景的暗角（vignette）阶段算出的屏幕坐标整体平移，
 * 每次故障转场暗角都会往外弹一下。撕裂本来就靠 `uInputClamp` 夹住，不需要那圈余量。
 */

import { Filter, GlProgram, UniformGroup } from 'pixi.js';

/** 顶点着色器：Pixi v8 的标准写法（把输入帧铺到输出帧上）。 */
const SONNET_GLITCH_VERTEX = `
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

/** 片段着色器：粗/细两层带 + 等量亮度撕裂（数值全部照抄上游）。 */
const SONNET_GLITCH_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputClamp;
uniform float uAmount;
uniform float uSeed;

float hash(vec2 value) {
    return fract(sin(dot(value, vec2(12.9898, 78.233))) * 43758.5453);
}

void main(void) {
    float coarseBand = floor(vTextureCoord.y * 26.0);
    float fineBand = floor(vTextureCoord.y * 110.0);
    float coarseNoise = hash(vec2(coarseBand, uSeed));
    float fineNoise = hash(vec2(fineBand + 41.0, uSeed * 1.37));
    float coarseGate = step(0.58, coarseNoise);
    float fineGate = step(0.88, fineNoise);
    float coarseShift = (hash(vec2(coarseBand + 17.0, uSeed)) * 2.0 - 1.0)
        * coarseGate * uAmount * 0.095;
    float fineShift = (hash(vec2(fineBand + 73.0, uSeed)) * 2.0 - 1.0)
        * fineGate * uAmount * 0.035;
    vec2 sampleUv = vec2(vTextureCoord.x + coarseShift + fineShift, vTextureCoord.y);
    vec4 color = texture(uTexture, clamp(sampleUv, uInputClamp.xy, uInputClamp.zw));

    // 亮度撕裂对**每个颜色通道一视同仁**：有故障结构，但没有 RGB 色散。
    float tear = (coarseGate * (coarseNoise - 0.58) + fineGate * 0.12) * uAmount;
    color.rgb *= 1.0 + tear * 0.42;
    finalColor = color;
}
`;

/** 故障效果：一个滤镜 + 一个更新入口（数值来自帧层的 `transition.glitch` / `glitchSeed`）。 */
export interface SonnetGlitchEffect {
  readonly filter: Filter;
  /** `amount` 是 0~1 的缓动量，`seed` 是**按 14 档量化**过的跳帧种子。 */
  readonly update: (amount: number, seed: number) => void;
}

export function createSonnetGlitchEffect(): SonnetGlitchEffect {
  const uniforms = new UniformGroup({
    uAmount: { value: 0, type: 'f32' },
    uSeed: { value: 0, type: 'f32' },
  });
  const filter = new Filter({
    glProgram: GlProgram.from({
      vertex: SONNET_GLITCH_VERTEX,
      fragment: SONNET_GLITCH_FRAGMENT,
      name: 'sonnet-mono-glitch',
    }),
    resources: { glitchUniforms: uniforms },
    // 必须为 0，理由见文件头的注释（否则暗角会往外弹）。
    padding: 0,
  });
  filter.enabled = false;
  return {
    filter,
    update: (amount: number, seed: number) => {
      uniforms.uniforms.uAmount = amount;
      uniforms.uniforms.uSeed = seed;
    },
  };
}
