import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  CASE_DEPTH,
  CASE_HEIGHT,
  CASE_WIDTH,
  COVER_SIZE,
  COVER_X,
  DARK_EDGE_COLOR,
  DARK_GLASS_COLOR,
  DARK_TRAY_COLOR,
  EDGE_COLOR,
  EDGE_ROUGHNESS,
  GLASS_ATTENUATION,
  GLASS_ATTENUATION_DISTANCE,
  GLASS_CLEARCOAT,
  GLASS_CLEARCOAT_ROUGHNESS,
  GLASS_COLOR,
  GLASS_IOR,
  GLASS_ROUGHNESS,
  GLASS_THICKNESS,
  GLASS_TRANSMISSION,
  PRINT_EXPOSURE,
  SPINE_WIDTH,
  TRAY_COLOR,
  TRAY_ROUGHNESS,
} from './rhine-constants';

/**
 * **程序化**的 CD 盒：参考用 Blender 导出的模型（`archive-cassette.glb` / 音乐版的
 * `music-cd`），我们没有 Blender，也不打算把它的模型资产搬过来 —— 所以按它**公开的尺寸**
 * （SOURCE: `Rhine-Music-Demo src/music-model.ts:7-9,29-31`：`3.996 × 3.35 × 0.14`、
 * 封面 `2.98 × 2.98 @ x=0.14`、书脊 `≈0.269`）用基本体拼一只自己的盒子。
 *
 * 层数与参考保持一致的那几层（SOURCE: `RhineLabUI src/scene.ts:411-424`：阵列里只保留
 * **外壳 / 边条 / 紧固件 / 索引嵌条 / 封面承托**，亚毫米的光学与印刷几何只在抽出来那一张上）：
 *
 * | 面 | 作用 | 材质 |
 * |---|---|---|
 * | `glass` | 磨砂盖板（透射 + 清漆 + 底部的暖色吸收渐变） | `MeshPhysicalMaterial` |
 * | `edge`  | 象牙色边条 + 两颗紧固件（右上 / 左下，SOURCE: `DESIGN.md` 外壳细节目录） | `MeshStandardMaterial` |
 * | `inlay` | 左侧书脊嵌条（琥珀 / 暖灰） | `MeshStandardMaterial` |
 * | `tray`  | 封面承托（阵列里偏向琥珀，让玻璃后面有东西可透） | `MeshStandardMaterial` |
 * | `cover` | 封面纸面（图集采样，实例属性查瓦片） | `MeshStandardMaterial` |
 */

export interface RhineCaseSurfaces {
  glass: THREE.BufferGeometry;
  edge: THREE.BufferGeometry;
  inlay: THREE.BufferGeometry;
  tray: THREE.BufferGeometry;
  cover: THREE.BufferGeometry;
  /** 把全部几何释放掉。 */
  dispose(): void;
}

/** 盖板底部的暖色吸收（参考用 `vPanelHeight` 做了一模一样的渐变，SOURCE: `scene.ts:437-450`）。 */
const PANEL_LOW_LIGHT: readonly [number, number, number] = [0.4, 0.3, 0.2];
const PANEL_HIGH_LIGHT: readonly [number, number, number] = [1.0, 0.98, 0.94];
const PANEL_LOW_DARK: readonly [number, number, number] = [0.42, 0.34, 0.26];
const PANEL_HIGH_DARK: readonly [number, number, number] = [0.92, 0.93, 0.95];

function box(width: number, height: number, depth: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(width, height, depth).translate(x, y, z);
}

/** 造一套盒子的几何（同一份几何被阵列的每个实例共用，所以只建一次）。 */
export function createRhineCaseSurfaces(capacity: number): RhineCaseSurfaces {
  // 盖板：圆角盒。厚度只取 0.1（盒子总厚 0.14 里剩下的留给承托与纸面）。
  const glass = new RoundedBoxGeometry(CASE_WIDTH, CASE_HEIGHT, 0.1, 3, 0.045).translate(
    0,
    CASE_HEIGHT / 2,
    0.02,
  );
  const edge = mergeGeometries([
    box(CASE_WIDTH, 0.05, 0.135, 0, CASE_HEIGHT - 0.025, 0),
    box(CASE_WIDTH, 0.05, 0.135, 0, 0.025, 0),
    box(0.05, CASE_HEIGHT, 0.135, -(CASE_WIDTH / 2 - 0.025), CASE_HEIGHT / 2, 0),
    box(0.05, CASE_HEIGHT, 0.135, CASE_WIDTH / 2 - 0.025, CASE_HEIGHT / 2, 0),
    // 右上与左下两颗紧固件（参考外壳只保留这两处）。
    new THREE.CylinderGeometry(0.05, 0.05, 0.022, 14)
      .rotateX(Math.PI / 2)
      .translate(CASE_WIDTH / 2 - 0.17, CASE_HEIGHT - 0.17, 0.078),
    new THREE.CylinderGeometry(0.05, 0.05, 0.022, 14)
      .rotateX(Math.PI / 2)
      .translate(-(CASE_WIDTH / 2 - 0.17), 0.17, 0.078),
  ]);
  if (edge === null) throw new Error('莱茵盒子：边条几何合并失败');
  const inlay = box(SPINE_WIDTH, CASE_HEIGHT - 0.32, 0.02, -(CASE_WIDTH / 2 - 0.17), CASE_HEIGHT / 2, 0.066);
  /*
   * 托盘**只比封面大一点点**（2026-10-22 主人：「做出来的是白色边框 cd 盒，实际要玻璃质感」）。
   *
   * 原来托盘是「整盒大小 - 0.1」，于是从正面透过玻璃看到的是一整圈米色纸板 ——
   * 那一圈就成了"白色边框"。参考里封面四周是**透空**的：能直接看到后面的盒子。
   * 缩到封面尺寸之后，四周只剩玻璃和边条，边框感就没了。
   */
  const tray = box(COVER_SIZE + 0.06, COVER_SIZE + 0.06, 0.06, COVER_X, CASE_HEIGHT / 2, -0.035);
  /*
   * 封面纸面：贴在**盒面外侧**（盖板前面），不是封在玻璃里。
   *
   * 这一条是照着参考的数值纠回来的：它的印刷标签 `label.position.set(-1.36, 3.04, 0.255)`
   * 而外壳前面在 `z ≈ 0.206` —— 标签在**玻璃盖板之外**（SOURCE: `RhineLabUI src/scene.ts:488-498`
   * 与 DESIGN.md 的「外壳与自上而下」一节里那个 `前面 z=0.206`）。
   * 第一版我把封面放在玻璃内部（`z = CASE_DEPTH/2 - 0.008`），结果整面墙的封面都被盖板折射 +
   * 背面主光的阴影压成了深色块（`docs/RHINE-SKIN.md` 的「照实记」记了这次排查）。
   */
  const cover = new THREE.PlaneGeometry(COVER_SIZE, COVER_SIZE).translate(
    COVER_X,
    CASE_HEIGHT / 2,
    CASE_DEPTH / 2 + 0.004,
  );
  const tileOffsets = new Float32Array(capacity * 4);
  cover.setAttribute('coverTile', new THREE.InstancedBufferAttribute(tileOffsets, 4));
  const coverReady = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
  coverReady.setUsage(THREE.DynamicDrawUsage);
  cover.setAttribute('coverReady', coverReady);
  return {
    glass,
    edge,
    inlay,
    tray,
    cover,
    dispose(): void {
      glass.dispose();
      edge.dispose();
      inlay.dispose();
      tray.dispose();
      cover.dispose();
    },
  };
}

/** 造一个**不带实例属性**的封面面片（抽出来那一张用高清纹理，单独一张纸）。 */
export function createSelectedCoverGeometry(): THREE.BufferGeometry {
  /*
   * 封面**贴在壳外**（`CASE_DEPTH/2 + 0.008`），和阵列里一致。
   *
   * 曾经试过把它挪进壳里，想做出"纸面罩在玻璃框里"的效果 —— 实测失败：玻璃的透射会把
   * 封面压成一块浅色（2026-10-22 详情页截图：抽出来的那张只剩白面，专辑图完全看不见）。
   * 现在玻璃只保留**边沿**这一圈（`edge`），封面本身就贴在它前面，所以看上去仍然是
   * "透明盒子里装着封面纸"。
   */
  return new THREE.PlaneGeometry(COVER_SIZE, COVER_SIZE).translate(
    COVER_X,
    CASE_HEIGHT / 2,
    CASE_DEPTH / 2 + 0.008,
  );
}

export interface RhineCaseMaterials {
  glass: THREE.MeshPhysicalMaterial;
  edge: THREE.MeshStandardMaterial;
  inlay: THREE.MeshStandardMaterial;
  tray: THREE.MeshStandardMaterial;
  cover: THREE.MeshStandardMaterial;
  /** 盖板底部暖色渐变的着色器 uniform（明暗切换时改它）。 */
  panel: { low: THREE.Vector3; high: THREE.Vector3 };
  /** 磨砂 ↔ 清透（抽取时的「解密」效果）。 */
  setClarity(value: number): void;
  setTheme(dark: boolean): void;
  setTransmissionScale(scale: number): void;
  dispose(): void;
}

/** 盖板底部的暖色吸收：与参考同一套 `vPanelHeight` 做法（我们用它做「盒体厚度」的暗示）。 */
function applyPanelGradient(
  material: THREE.Material,
  panel: { low: THREE.Vector3; high: THREE.Vector3 },
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.panelLow = { value: panel.low };
    shader.uniforms.panelHigh = { value: panel.high };
    shader.vertexShader = `varying float vPanelHeight;\n${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\nvPanelHeight = position.y / ${CASE_HEIGHT.toFixed(3)};`,
    );
    shader.fragmentShader = `varying float vPanelHeight;\nuniform vec3 panelLow;\nuniform vec3 panelHigh;\n${shader.fragmentShader}`.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\ndiffuseColor.rgb *= mix(panelLow, panelHigh, smoothstep(0.1, 1.0, vPanelHeight));',
    );
  };
  material.customProgramCacheKey = () => 'rhine-panel-gradient-v1';
}

/**
 * **歌单页的那条"光带"其实是着色器里的高斯带**（2026-10-22）。
 *
 * SOURCE: `Rhine-Music-Demo src/music-row-lighting.ts:92-98`（`sampleRowLighting`）：
 *
 *   exp(−ln2 · row²) · exp(−lane⁶)
 *
 * `row` 是「离这条带多远」（按行距归一），`lane` 是「离这条带所在的列多远」（按列半径归一）。
 * 效果是：**带上的盒子整体变亮、带外迅速沉黑**，而不是一道可见的光柱 —— 参考截图里
 * 那条斜线的两侧就是这么渐变的。
 *
 * 这里把同一条公式注入片元着色器，用世界坐标算（实例化后每张盒子的世界位置不同），
 * 逐帧只更新两个 uniform。横向用的是列坐标，所以它同时还限定了"只在视觉中心那几列亮"。
 */
export function applyBandLighting(material: THREE.Material, uniforms: RhineBandUniforms): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.uniforms.rhineBand = uniforms.band;
    shader.uniforms.rhineBandGain = uniforms.gain;
    /*
     * **在顶点里算光带**，片元只收一个 `varying float`。
     * 上一版把 `instanceMatrix` 和 `pow()` 都放在片元里，结果整屏黑 —— 说明那段没编译过。
     * 顶点里拿世界坐标是安全的（`instanceMatrix` 本来就只在实例化顶点着色器里存在），
     * 片元只需要一个插值出来的亮度系数，复杂度最低。
     */
    shader.vertexShader =
      `uniform vec4 rhineBand;\nvarying float vRhineBand;\n${shader.vertexShader}`.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec3 rhineWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        /*
         * rhineBand = (带的中心 world z, 跨带半宽, 横向半径, 中心 world x)
         *
         * 完全照参考的场（SOURCE: music-row-lighting.ts:107-113）：
         *   row  = (z - 中心z) / (半宽)          → exp(-ln2 · row²)
         *   lane = (x - 中心x) / 横向半径        → exp(-lane⁶)
         *
         * 不带对角项。参考的光带在**世界坐标里是一条横带**（所有列上同一行），
         * 投影到屏幕上自然就是那条穿过名牌的斜线 —— 我先前加的对角偏移反而是错的。
         */
        float rhineRow = (rhineWorld.z - rhineBand.x) / rhineBand.y;
        float rhineLane = (rhineWorld.x - rhineBand.w) / rhineBand.z;
        float lane2 = rhineLane * rhineLane;
        vRhineBand = exp(-0.693 * rhineRow * rhineRow) * exp(-lane2 * lane2 * lane2);`,
      );
      /*
       * **和参考一样：乘在最终颜色上**（SOURCE: `music-row-lighting.ts:100-113`
       * 的注释「The same expression is used by prints and shells」）。
       *
       * 之前我是在自发光上**加**一份 —— 加不出来"带外全黑"的效果，因为环境光照在
       * 玻璃壳/托盘上的亮度根本不经过那个加法。改成乘最终颜色之后，场值是 0 的地方
       * 无论环境光多亮都会变成 0，这才是参考那种"带外什么都看不见"。
       */
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vRhineBand;\nuniform float rhineBandGain;')
        .replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>
        // 光带是**白光**（主人标注：穿过名牌那条线应该是白色的光带），所以不加色偏。
        gl_FragColor.rgb *= (0.72 + 0.28 * vRhineBand * rhineBandGain);`,
        );
  };
  material.customProgramCacheKey = () => 'rhine-band-v2';
}

/** 光带的 uniform（场景逐帧写，材质读）。 */
export interface RhineBandUniforms {
  /** (中心 world z, 跨带半宽, 沿带半长, 横向半径) */
  band: { value: THREE.Vector4 };
  gain: { value: number };
}

/**
 * 封面纸面的印刷曝光（参考在 shader 里只抬印刷面曝光、不抬玻璃，SOURCE: `music-lighting.ts:153-181`）。 */
function applyPrintExposure(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>\ndiffuseColor.rgb *= ${PRINT_EXPOSURE.toFixed(3)};`,
    );
    /*
     * **印刷面自发光**（2026-10-21 截图迭代）：只抬漫反射在暗场景里不够 —— 近景时封面
     * 只剩下一点点环境光，整张纸发灰。参考用一整段 shader 单独点亮印刷面
     * （`music-lighting.ts:153-181`），这里取同一个效果的最小实现：在自发光项上再加一份
     * 「封面自身颜色 × 系数」，相当于给纸面补一盏跟着它走的小灯。
     *
     * 系数取 0.22：够把暗处的封面提到可读，又不至于在亮处发光（`diffuseColor` 已经含图集颜色）。
     */
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.22;',
    );
  };
  material.customProgramCacheKey = () => 'rhine-print-exposure-v2';
}
/**
 * 封面纸面的材质：图集 + 实例属性查表。
 * 做法与参考一致（SOURCE: `Rhine-Music-Demo src/cover-atlas.ts:169-193`）：顶点里
 * `vMapUv = coverTile.xy + uv * coverTile.zw`，片元里没准备好就 `discard`，采样时按半像素内缩。
 */
export function applyAtlasSampling(material: THREE.Material, atlasSize: { width: number; height: number }): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.vertexShader =
      `attribute vec4 coverTile;\nattribute float coverReady;\nvarying float vCoverReady;\nvarying vec4 vCoverTile;\n${shader.vertexShader}`.replace(
        '#include <uv_vertex>',
        '#include <uv_vertex>\nvCoverReady = coverReady;\nvCoverTile = coverTile;\nvMapUv = coverTile.xy + uv * coverTile.zw;',
      );
    shader.uniforms.coverAtlasTexel = {
      value: new THREE.Vector2(1 / atlasSize.width, 1 / atlasSize.height),
    };
    const mapFragment = THREE.ShaderChunk.map_fragment.replace(
      'texture2D( map, vMapUv )',
      'texture2D( map, clamp(vMapUv, vCoverTile.xy + coverAtlasTexel * 0.5, vCoverTile.xy + vCoverTile.zw - coverAtlasTexel * 0.5) )',
    );
    shader.fragmentShader =
      `varying float vCoverReady;\nvarying vec4 vCoverTile;\nuniform vec2 coverAtlasTexel;\n${shader.fragmentShader}`.replace(
        '#include <map_fragment>',
        `if (vCoverReady < 0.5) discard;\n${mapFragment}`,
      );
    // 调试接缝：把编译后的 shader 挂在材质上，冒烟可以核对注入到底生没生效。
    material.userData.rhineShader = shader;
  };
  material.customProgramCacheKey = () => 'rhine-atlas-cover-v1';
}

/**
 * **单张瓦片采样**：给没有实例属性的普通 Mesh 用（换选时留在原地的那张「归位副本」）。
 *
 * 数学与 `applyAtlasSampling` 完全一致（顶点里 `vMapUv = coverTile.xy + uv * coverTile.zw`、
 * 片元没准备好就 `discard`、采样按半像素内缩），区别只有一个：瓦片坐标来自 **uniform**，
 * 因为副本是普通 `Mesh`，拿不到实例属性。uniform 对象本身挂在 `material.userData.rhineTile` /
 * `rhineReady` 上，调用方直接改它的 `value` 就能换封面。
 */
export function applySingleTileSampling(
  material: THREE.Material,
  atlasSize: { width: number; height: number },
): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    const tile = { value: new THREE.Vector4(0, 0, 0, 0) };
    const ready = { value: 0 };
    shader.uniforms.coverTile = tile;
    shader.uniforms.coverReady = ready;
    shader.uniforms.coverAtlasTexel = {
      value: new THREE.Vector2(1 / atlasSize.width, 1 / atlasSize.height),
    };
    shader.vertexShader =
      `uniform vec4 coverTile;\nuniform float coverReady;\nvarying float vCoverReady;\nvarying vec4 vCoverTile;\n${shader.vertexShader}`.replace(
        '#include <uv_vertex>',
        '#include <uv_vertex>\nvCoverReady = coverReady;\nvCoverTile = coverTile;\nvMapUv = coverTile.xy + uv * coverTile.zw;',
      );
    const mapFragment = THREE.ShaderChunk.map_fragment.replace(
      'texture2D( map, vMapUv )',
      'texture2D( map, clamp(vMapUv, vCoverTile.xy + coverAtlasTexel * 0.5, vCoverTile.xy + vCoverTile.zw - coverAtlasTexel * 0.5) )',
    );
    shader.fragmentShader =
      `varying float vCoverReady;\nvarying vec4 vCoverTile;\nuniform vec2 coverAtlasTexel;\n${shader.fragmentShader}`.replace(
        '#include <map_fragment>',
        `if (vCoverReady < 0.5) discard;\n${mapFragment}`,
      );
    material.userData.rhineTile = tile;
    material.userData.rhineReady = ready;
  };
  material.customProgramCacheKey = () => 'rhine-atlas-single-v1';
}

export function createRhineCaseMaterials(
  dark: boolean,
  atlas: { texture: THREE.Texture; width: number; height: number },
  /*
   * 阵列里一份材质、抽出来那张另有一份。**只有阵列那份能套图集采样着色器**：
   * 它注入的是 `vMapUv = coverTile.xy + uv * coverTile.zw` 和 `vCoverReady < 0.5 → discard`，
   * 依赖逐实例的 `coverTile` / `coverReady` 属性。抽出来那张是**普通 Mesh**、没有这两个属性，
   * 于是 UV 变成乱的、`ready` 恒为 0 被整片 discard —— 表现就是「详情页抽出来的那张没有封面」
   * （2026-10-22 定位）。它有自己的 512 高清纹理，按普通 UV 采就行。
   */
  atlasSampling = true,
  /** 歌单页高斯光带的 uniform（不传 = 没有光带）。 */
  bandUniforms: RhineBandUniforms | null = null,
): RhineCaseMaterials {
  const panel = {
    low: new THREE.Vector3(...(dark ? PANEL_LOW_DARK : PANEL_LOW_LIGHT)),
    high: new THREE.Vector3(...(dark ? PANEL_HIGH_DARK : PANEL_HIGH_LIGHT)),
  };
  const glass = new THREE.MeshPhysicalMaterial({
    color: dark ? DARK_GLASS_COLOR : GLASS_COLOR,
    roughness: GLASS_ROUGHNESS,
    metalness: 0,
    transmission: GLASS_TRANSMISSION,
    thickness: GLASS_THICKNESS,
    ior: GLASS_IOR,
    clearcoat: GLASS_CLEARCOAT,
    clearcoatRoughness: GLASS_CLEARCOAT_ROUGHNESS,
    attenuationColor: new THREE.Color(GLASS_ATTENUATION),
    attenuationDistance: GLASS_ATTENUATION_DISTANCE,
    envMapIntensity: 0.6,
    // 阵列里不开 alpha 混合（参考也是 `transparent = false`）：一叠透明面互相排序会闪。
    transparent: false,
  });
  applyPanelGradient(glass, panel);
  /*
   * 边条也是**玻璃**：参考的盒子里四边不是白色塑料条，而是同一块亚克力的折边 ——
   * 所以这里把它从 `MeshStandardMaterial`（不透明）换成带透射的物理材质，
   * 只留一圈很细的高光。之前那一圈象牙白边框正是主人说的"白色边框 cd 盒"。
   */
  const edge = new THREE.MeshPhysicalMaterial({
    color: dark ? DARK_EDGE_COLOR : EDGE_COLOR,
    roughness: EDGE_ROUGHNESS,
    metalness: 0,
    transmission: 0.85,
    thickness: 0.04,
    ior: 1.49,
    clearcoat: 0.5,
    clearcoatRoughness: 0.08,
    envMapIntensity: 0.9,
    transparent: false,
  });
  const inlay = new THREE.MeshStandardMaterial({
    // 书脊嵌条两档同色（参考不按主题改盒身）：暗档原来用深褐 `#6e6455`，在一墙白玻璃里变成黑条。
    color: '#e4d6c5',
    roughness: 0.5,
    metalness: 0.05,
    envMapIntensity: 0.6,
  });
  const tray = new THREE.MeshStandardMaterial({
    color: dark ? DARK_TRAY_COLOR : TRAY_COLOR,
    roughness: TRAY_ROUGHNESS,
    metalness: 0,
    envMapIntensity: 0.6,
  });
  const cover = new THREE.MeshStandardMaterial({
    map: atlas.texture,
    roughness: 0.74,
    metalness: 0,
    envMapIntensity: 0.35,
  });
  applyPrintExposure(cover);
  if (atlasSampling) applyAtlasSampling(cover, atlas);
  /*
   * 光带加在**封面纸面 / 侧条**上。
   * 玻璃壳也加过一次，结果整面墙都泛亮（玻璃本身就是大面积反光体），所以撤掉 ——
   * 对角线两端发亮的问题要另外解决：门控是按"到带的垂直距离"，端头同样落在带内。
   */
  if (bandUniforms !== null) {
    applyBandLighting(cover, bandUniforms);
    applyBandLighting(edge, bandUniforms);
    applyBandLighting(glass, bandUniforms);
    applyBandLighting(tray, bandUniforms);
    applyBandLighting(inlay, bandUniforms);
  } else {
    applyPrintExposure(cover);
  }
  const baseTransmission = GLASS_TRANSMISSION;
  return {
    glass,
    edge,
    inlay,
    tray,
    cover,
    panel,
    // 抽取时把磨砂盖板变清透：0 = 磨砂、1 = 完全清晰。
    // SOURCE: `RhineLabUI DESIGN.md` 外壳一节（整面磨砂 `roughness 0.42` → 完全清晰 `0.025`）。
    setClarity(value: number): void {
      const v = Math.max(0, Math.min(1, value));
      glass.roughness = 0.42 + (0.025 - 0.42) * v;
      glass.thickness = 0.28 - 0.24 * v;
      glass.attenuationDistance = 1.2 + 4.8 * v;
    },
    // 明暗档：只换颜色与环境强度，不动几何、不动动效（SOURCE: `DESIGN.md` 明暗配色一节）。
    setTheme(next: boolean): void {
      glass.color.set(next ? DARK_GLASS_COLOR : GLASS_COLOR);
      edge.color.set(next ? DARK_EDGE_COLOR : EDGE_COLOR);
      inlay.color.set('#e4d6c5');
      tray.color.set(next ? DARK_TRAY_COLOR : TRAY_COLOR);
      panel.low.set(...(next ? PANEL_LOW_DARK : PANEL_LOW_LIGHT));
      panel.high.set(...(next ? PANEL_HIGH_DARK : PANEL_HIGH_LIGHT));
    },
    setTransmissionScale(scale: number): void {
      glass.transmission = baseTransmission * Math.max(0, Math.min(1, scale));
    },
    dispose(): void {
      glass.dispose();
      edge.dispose();
      inlay.dispose();
      tray.dispose();
      cover.dispose();
    },
  };
}
