import type { AutomixResources, Song } from '@pi/shared';
import { CH, invoke } from '../../bridge';
import { analyzeSamples, downmixAndDownsample, type TrackProfileCore } from './analyze';
import { detectBeatWithModelInWorker, warmUpBeatThis, type BeatGridResult } from './beat-this';
import { readProfile, writeProfile } from './profile-cache';
import { PROFILE_VERSION, type TrackProfile } from './profile';
import { detectSections } from './structure';

/**
 * 分析服务（P3）：把一首歌变成一份 `TrackProfile`。
 *
 * 流程：`fetch(src)` → `decodeAudioData`（直接解到 22050Hz）→ 降成单声道 → Worker 里算特征。
 *
 * 几个刻意的取舍：
 * - **完整取字节**：`decodeAudioData` 需要完整容器，截断的 mp3 会解出半首或直接失败，
 *   所以这里不玩 Range 花招；流量代价换「一定能解」。
 * - **解到 22050**：`OfflineAudioContext(1, 1, 22050)` 让浏览器在解码时就把采样率降下来，
 *   3 分钟的歌只占约 16MB，比 44.1k 立体声省四倍。
 * - **结果落 localStorage**：几百字节一条，一首歌只分析一次；换音源不重算（节拍与结构
 *   不会因为码率不同而变）。
 * - **彻底失败不影响播放**：任何一步出错都只写日志，`undefined` 返回，调用方当没有档案。
 */
export const ANALYZE_SAMPLE_RATE = 22_050;
/** 单次分析的上限：超长音频或网络卡死不该把队列拖住。 */
const ANALYZE_TIMEOUT_MS = 45_000;

const inflight = new Map<number, Promise<TrackProfile | undefined>>();
let worker: Worker | undefined;
let requestId = 0;
const pending = new Map<number, (core: TrackProfileCore) => void>();

/** 模型地址只问一次主进程；不可用时缓存 `undefined`，之后不再反复问。 */
let resourcesPromise: Promise<AutomixResources | undefined> | undefined;

function getResources(): Promise<AutomixResources | undefined> {
  if (!resourcesPromise) {
    resourcesPromise = invoke(CH.automixResources)
      .then((resources) => {
        if (!resources.available) {
          console.info(`[pi/automix] Beat This! 不可用，拍点用 DSP 兜底：${resources.reason ?? '未知原因'}`);
          return undefined;
        }
        return resources;
      })
      .catch((error: unknown) => {
        console.warn('[pi/automix] 询问推理资源失败，拍点用 DSP 兜底：', error);
        return undefined;
      });
  }
  return resourcesPromise;
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('分析超时')), ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 把 PCM 交给 Worker 算；没有 Worker（单测环境）就同步算。 */
function runWorker(samples: Float32Array, durationMs: number): Promise<TrackProfileCore> {
  if (typeof Worker === 'undefined') {
    return Promise.resolve(analyzeSamples(samples, ANALYZE_SAMPLE_RATE, durationMs));
  }
  if (!worker) {
    worker = new Worker(new URL('./analyze.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; core: TrackProfileCore }>) => {
      const resolve = pending.get(event.data.id);
      pending.delete(event.data.id);
      resolve?.(event.data.core);
    };
  }
  const active = worker;
  return new Promise<TrackProfileCore>((resolve) => {
    const id = ++requestId;
    pending.set(id, resolve);
    // transferable：把 PCM 的所有权交出去，主线程这份立刻失效（本来也不再需要）。
    active.postMessage({ id, samples, sampleRate: ANALYZE_SAMPLE_RATE, durationMs }, [samples.buffer]);
  });
}

async function analyze(song: Song, src: string): Promise<TrackProfile | undefined> {
  const started = performance.now();
  try {
    /*
     * 先把模型加载**提前**启动：它要 fetch 83MB + 初始化 WASM，约 2.7 秒，
     * 和下面「下载音频 + 解码」是两件互不依赖的事，并行起来能省掉其中一段。
     * `warmUpBeatThis` 是 fire-and-forget，`detectBeatWithModel` 会复用同一个 Promise。
     */
    const resources = await getResources();
    if (resources) warmUpBeatThis(resources);
    const response = await fetch(src);
    if (!response.ok) {
      console.warn(`[pi/automix] 分析取字节失败：${song.name}（HTTP ${response.status}）`);
      return undefined;
    }
    const bytes = await response.arrayBuffer();
    // decodeAudioData 会 detach 传入的 ArrayBuffer，送一份副本。
    const context = new OfflineAudioContext(1, 1, ANALYZE_SAMPLE_RATE);
    const buffer = await context.decodeAudioData(bytes.slice(0));
    const samples = downmixAndDownsample(buffer, ANALYZE_SAMPLE_RATE);
    const durationMs = Math.round(buffer.duration * 1000);
    /*
     * 拍点优先走 Beat This!（有模型时），结构永远走 DSP：
     * - 模型推理按块跑、每块几秒，慢但准；
     * - 尾部/头部静音是纯统计，DSP 又准又便宜，没必要喂给模型。
     * 顺序不能反：Worker 会 transfer 走 `samples` 的所有权，模型必须先用。
     */
    let beatGrid: BeatGridResult | undefined;
    if (resources) {
      try {
        // 只推理开头 30 秒（正好一块）：整曲推理 30 秒，比预取窗口还长，来不及。
        // 30 秒约 40~60 拍，估 BPM 够用；前奏太长的歌会测不出，自动退回 DSP。
        // 走 Worker：那 5 秒不该冻住界面。
        beatGrid = await detectBeatWithModelInWorker(samples, resources, { maxSeconds: 30 });
      } catch (error) {
        console.warn('[pi/automix] Beat This! 推理失败，拍点用 DSP 兜底：', error);
      }
    }
    /*
     * 结构段落要在 samples 被 transfer 给 Worker 之前算（detectSections 只读）。
     * 全曲 mel 谱 + 自相似矩阵，3 分钟约几百毫秒；一次分析只做一回。
     */
    const structureStarted = performance.now();
    const structure = detectSections(samples, durationMs / 1000);
    const structureMs = Math.round(performance.now() - structureStarted);

    const dspCore = await withTimeout(runWorker(samples, durationMs), ANALYZE_TIMEOUT_MS);
    const core: TrackProfileCore = beatGrid
      ? {
          ...dspCore,
          bpm: beatGrid.bpm,
          beatOffsetSec: beatGrid.offsetSec,
          beatPeriodSec: beatGrid.periodSec,
          confidence: beatGrid.confidence,
        }
      : dspCore;
    const profile: TrackProfile = {
      ...core,
      songId: song.id,
      version: PROFILE_VERSION,
      analyzedAt: Date.now(),
      analysisMs: Math.round(performance.now() - started),
      sections: structure.sections,
      chorusClassId: structure.chorusClassId,
    };
    writeProfile(profile);
    console.info(
      `[pi/automix] 分析完成：${song.name}（id=${song.id}）` +
        ` bpm=${profile.bpm ?? '—'}（${beatGrid ? 'Beat This!' : 'DSP'}）` +
        ` 尾部静音=${profile.tail.silenceSec}s` +
        ` 头部静音=${profile.head.silenceSec}s` +
        ` 段落=${structure.sections.length}段(副歌类=${structure.chorusClassId ?? '—'}, ${structureMs}ms)` +
        ` 耗时=${profile.analysisMs}ms`,
    );
    return profile;
  } catch (error) {
    console.warn(`[pi/automix] 分析失败：${song.name}（id=${song.id}）`, error);
    return undefined;
  }
}

/**
 * 确保这首歌有档案：命中缓存直接返回，正在分析就复用同一个 Promise。
 *
 * 调用方不用 `await`（预取阶段是 fire-and-forget）：分析失败只会让那次过渡回退到固定窗口。
 */
export function ensureTrackProfile(song: Song, src: string): Promise<TrackProfile | undefined> {
  const cached = readProfile(song.id);
  if (cached) {
    console.debug(`[pi/automix] 档案命中：${song.name}（id=${song.id}）`);
    return Promise.resolve(cached);
  }
  const running = inflight.get(song.id);
  if (running) return running;
  const task = analyze(song, src).finally(() => {
    inflight.delete(song.id);
  });
  inflight.set(song.id, task);
  return task;
}

/** 只读缓存（过渡规划用）：没有就返回 undefined，绝不触发分析。 */
export function peekTrackProfile(songId: number): TrackProfile | undefined {
  return readProfile(songId);
}
