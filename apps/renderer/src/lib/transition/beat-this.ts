import * as ort from '../../vendor/ort/ort.wasm.min.mjs';
// 「外部 wasm」入口：加载器必须以副作用方式导入，才会把 wasm factory 注册给 `ort`。
// 这样它就被 Vite 打进 bundle，不需要在运行时动态 import 一个 http 模块
// （打包态页面是 file://，Chromium 不允许它 import 跨源模块）。
import '../../vendor/ort/ort-wasm-simd-threaded.mjs';
import BeatThisWorker from './beat-this.worker?worker';
import type { AutomixResources } from '@pi/shared';
import {
  BEAT_CHUNK_BORDER,
  BEAT_CHUNK_FRAMES,
  BEAT_HOP,
  BEAT_N_MELS,
  BEAT_SAMPLE_RATE,
  logMelSpectrogram,
} from './mel';

/**
 * Beat This! 推理（P3·模型接入）。
 *
 * 契约（来自模型作者与 `beat_this_cpp` 的 ONNX 说明）：
 * - 输入 `input_spectrogram`：`(1, frames, 128)` 的 log-Mel 谱（22050Hz、n_fft 1024、hop 441）；
 * - 输出 `beat` / `downbeat`：`(1, frames)` 的 logits，50 帧/秒；
 * - 分块 1500 帧、块间留 6 帧边框（边框只用于给模型上下文，结果丢弃）。
 *
 * 为什么值钱：DSP 的 `detectBeat` 对弱节奏/变速/自由拍号基本没辙（实测那首歌 `bpm=—`），
 * Beat This! 在同一批素材上是「有拍就给拍」——这正是 AutoMix 对齐乐句的前提。
 */
export interface BeatGridResult {
  bpm: number;
  /** 第一拍离歌曲开头的秒数。 */
  offsetSec: number;
  /** 拍长（秒）。 */
  periodSec: number;
  /** 峰值帧上的平均 logit，0.5~3 之间；低于 0.6 基本不可信。 */
  confidence: number;
  /** 拍点帧序号（50fps），排障用。 */
  beats: number[];
}

let sessionPromise: Promise<unknown> | undefined;

/** 只加载一次：模型 83MB，重复加载既慢又占内存。 */
async function loadSession(resources: AutomixResources): Promise<unknown | undefined> {
  if (!resources.available) return undefined;
  if (!sessionPromise) {
    sessionPromise = (async () => {
      // 目录前缀：运行时自己拼 `ort-wasm-simd-threaded.{mjs,wasm}`。
      ort.env.wasm.wasmPaths = resources.wasmBase;
      // 多线程 WASM 需要 SharedArrayBuffer + 跨源隔离头；这里稳一点用单线程。
      ort.env.wasm.numThreads = 1;
      const bytes = new Uint8Array(await (await fetch(resources.modelUrl)).arrayBuffer());
      return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    })().catch((error: unknown) => {
      console.warn('[pi/automix] Beat This! 模型加载失败，退回 DSP：', error);
      sessionPromise = undefined;
      return undefined;
    });
  }
  return sessionPromise;
}

/** 让出主线程一帧：整曲推理要十几块，每块之后让浏览器喘口气。 */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * 用模型跑拍点，返回拍网格。
 *
 * **只推理开头 `maxSeconds` 秒**（默认 60）：拍子在歌曲前段基本已经稳定，而 WASM 单线程
 * 推理约 3.3ms/帧，整首 3 分钟要 30 秒——比预取窗口还长，完全来不及。60 秒约 3000 帧、
 * 两块，4 秒上下；前奏超过 60 秒还听不出拍子的歌本来也少见，测不出就退回 DSP。
 *
 * 失败（模型不可用 / 输出形状不对 / 拍点太少）一律返回 `undefined`，调用方退回 DSP。
 */
export async function detectBeatWithModel(
  samples: Float32Array,
  resources: AutomixResources,
  options: { maxSeconds?: number } = {},
): Promise<BeatGridResult | undefined> {
  const session = await loadSession(resources);
  if (!session) return undefined;
  const active = session as {
    run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
  };

  const maxSeconds = options.maxSeconds ?? 60;
  const limit = Math.floor(maxSeconds * BEAT_SAMPLE_RATE);
  const scope = samples.length > limit ? samples.subarray(0, limit) : samples;
  const { data, frames } = logMelSpectrogram(scope);
  if (frames < 50) return undefined;

  const beatLogits = new Float32Array(frames);
  for (let start = 0; start < frames; start += BEAT_CHUNK_FRAMES) {
    const end = Math.min(frames, start + BEAT_CHUNK_FRAMES);
    // 边框：给模型前后文，但只取中间段的输出。
    const chunkStart = Math.max(0, start - BEAT_CHUNK_BORDER);
    const chunkEnd = Math.min(frames, end + BEAT_CHUNK_BORDER);
    const chunkFrames = chunkEnd - chunkStart;
    const input = new Float32Array(chunkFrames * BEAT_N_MELS);
    input.set(data.subarray(chunkStart * BEAT_N_MELS, chunkEnd * BEAT_N_MELS));
    const tensor = new ort.Tensor('float32', input, [1, chunkFrames, BEAT_N_MELS]);
    const output = await active.run({ input_spectrogram: tensor });
    const logits = output.beat?.data;
    if (!logits) return undefined;
    for (let frame = start; frame < end; frame += 1) {
      beatLogits[frame] = logits[frame - chunkStart] ?? 0;
    }
    await yieldToMain();
  }

  // 峰值：>0.5 且局部最大。模型输出是 logits（不是概率），阈值沿用 beat_this_cpp 的默认。
  const beats: number[] = [];
  let confidenceSum = 0;
  for (let frame = 1; frame < frames - 1; frame += 1) {
    const value = beatLogits[frame] as number;
    if (value > 0.5 && value >= (beatLogits[frame - 1] as number) && value >= (beatLogits[frame + 1] as number)) {
      beats.push(frame);
      confidenceSum += value;
    }
  }
  if (beats.length < 8) return undefined;

  // 拍长取相邻间隔的中位数（对漏拍/多拍更稳）。
  const gaps: number[] = [];
  for (let i = 1; i < beats.length; i += 1) gaps.push((beats[i] as number) - (beats[i - 1] as number));
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  if (!medianGap || medianGap <= 0) return undefined;

  const frameRate = BEAT_SAMPLE_RATE / BEAT_HOP;
  return {
    bpm: Math.round(((60 * frameRate) / medianGap) * 10) / 10,
    offsetSec: Math.round(((beats[0] as number) / frameRate) * 100) / 100,
    periodSec: Math.round((medianGap / frameRate) * 1000) / 1000,
    confidence: Math.round((confidenceSum / beats.length) * 100) / 100,
    beats,
  };
}

/** 提前把模型加载起来（可选；预取时调一下，省掉第一次推理的等待）。 */
export function warmUpBeatThis(resources: AutomixResources): void {
  void loadSession(resources);
}

let inferenceWorker: Worker | undefined;
let workerSeq = 0;
const workerPending = new Map<number, (value: BeatGridResult | undefined) => void>();

/**
 * 在 Worker 里跑推理（主线程只留解码）。
 *
 * 音频要**复制**一份进去：`samples` 后面还要给 DSP 做尾部/头部静音，不能把所有权 transfer 掉。
 * 30 秒的单声道 22050 也就 2.6MB，复制一次很便宜；换来的是那 5 秒里界面完全不卡。
 *
 * Worker 用 Vite 的 `?worker&inline`（blob URL）：打包态页面是 `file://`，
 * 从磁盘再加载一个 module worker 会撞上同样的跨源限制，内联最稳。
 */
export function detectBeatWithModelInWorker(
  samples: Float32Array,
  resources: AutomixResources,
  options: { maxSeconds?: number } = {},
): Promise<BeatGridResult | undefined> {
  if (typeof Worker === 'undefined') return detectBeatWithModel(samples, resources, options);
  if (!inferenceWorker) {
    const worker = new BeatThisWorker();
    inferenceWorker = worker;
    worker.onmessage = (event: MessageEvent<{ id: number; result?: BeatGridResult; error?: string }>) => {
      const resolve = workerPending.get(event.data.id);
      workerPending.delete(event.data.id);
      if (event.data.error) console.warn('[pi/automix] Worker 推理出错：', event.data.error);
      resolve?.(event.data.result);
    };
    // Worker 脚本本身加载失败（例如 wasm/模块被 CSP 拦）时不会走 onmessage：
    // 不兜底的话调用方会永远等下去，分析链就静默卡死。
    worker.onerror = (event: ErrorEvent) => {
      console.warn('[pi/automix] Worker 崩溃：', event.message);
      for (const resolve of workerPending.values()) resolve(undefined);
      workerPending.clear();
      worker.terminate();
      inferenceWorker = undefined;
    };
  }
  const worker = inferenceWorker;
  const maxSeconds = options.maxSeconds ?? 60;
  const limit = Math.floor(maxSeconds * BEAT_SAMPLE_RATE);
  const payload = (samples.length > limit ? samples.subarray(0, limit) : samples).slice();
  return new Promise<BeatGridResult | undefined>((resolve) => {
    const id = ++workerSeq;
    // 超时兜底：Worker 活着但推理卡住（或消息丢了）时，宁可回退 DSP 也不让分析链挂死。
    const timer = setTimeout(() => {
      if (!workerPending.has(id)) return;
      workerPending.delete(id);
      console.warn('[pi/automix] Worker 推理超时，退回 DSP');
      resolve(undefined);
    }, 60_000);
    workerPending.set(id, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    worker.postMessage({ id, samples: payload, resources, maxSeconds }, [payload.buffer]);
  });
}
