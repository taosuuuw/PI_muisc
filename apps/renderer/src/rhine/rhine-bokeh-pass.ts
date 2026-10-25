import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { BokehShader } from 'three/addons/shaders/BokehShader.js';

/**
 * 景深（DOF）pass，**深度直接从主渲染那一遍拿**，不再重绘整个场景。
 *
 * three 自带的 `BokehPass` 每次 `render()` 都会把场景用 `MeshDepthMaterial` 重画一遍
 * 到自己的深度纹理里（`BokehPass.js:139-150`）。阵列这一屏有二十几个 batch、
 * 几百个实例，那一次额外全场景渲染实测要 230ms —— 切档那一帧直接从 55ms 涨到 286ms
 * （2026-10-24 用 `__piRhinePasses()` 二分量到的）。
 *
 * 其实 `BokehShader` 本来就两种深度读法，靠 `DEPTH_PACKING` 宏切换：
 *  · `1`：采样 RGBA 打包的深度（`unpackRGBAToDepth`），那是给"自己重绘深度"用的；
 *  · `0`：直接采样 `texture2D(tDepth, uv).x`，正好喂 WebGL 原生的深度纹理。
 *
 * 所以这里把宏改成 0，并让 `tDepth` 指向 `readBuffer.depthTexture` —— 主 RenderPass
 * 已经把深度写在那张纹理里了，白重绘一遍纯粹是浪费。
 *
 * 前提：上游那个 render target 必须挂了 `depthTexture`（见 `RhineScene` 里给
 * `composer.renderTarget1/2` 装 `DepthTexture` 的那段），并且本 pass 必须紧跟在
 * RenderPass 后面 —— 再往后 RT 会交替，后面的 target 上就没有本帧的深度了。
 */
export class RhineBokehPass extends Pass {
  readonly uniforms: Record<string, THREE.IUniform>;

  private readonly quad: FullScreenQuad;
  private readonly material: THREE.ShaderMaterial;

  constructor(params: {
    focus: number;
    aperture: number;
    maxblur: number;
    near: number;
    far: number;
    aspect: number;
  }) {
    super();
    const uniforms = THREE.UniformsUtils.clone(BokehShader.uniforms) as Record<
      string,
      THREE.IUniform<number | THREE.Texture | null>
    >;
    const set = (name: string, value: number | THREE.Texture | null): void => {
      const entry = uniforms[name];
      if (entry !== undefined) entry.value = value;
    };
    set('tDepth', null);
    set('focus', params.focus);
    set('aperture', params.aperture);
    set('maxblur', params.maxblur);
    set('nearClip', params.near);
    set('farClip', params.far);
    set('aspect', params.aspect);
    this.uniforms = uniforms;
    this.material = new THREE.ShaderMaterial({
      // 0 = 直接读原生深度纹理（不再是 RGBA 打包的那套）。
      defines: { ...BokehShader.defines, DEPTH_PACKING: 0 },
      uniforms,
      vertexShader: BokehShader.vertexShader,
      fragmentShader: BokehShader.fragmentShader,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const depth = readBuffer.depthTexture;
    if (depth === null) return;
    const depthUniform = this.uniforms.tDepth;
    const colorUniform = this.uniforms.tColor;
    if (depthUniform !== undefined) depthUniform.value = depth;
    if (colorUniform !== undefined) colorUniform.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  override setSize(width: number, height: number): void {
    const aspect = this.uniforms.aspect;
    if (aspect !== undefined) aspect.value = width / Math.max(1, height);
  }

  override dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}
