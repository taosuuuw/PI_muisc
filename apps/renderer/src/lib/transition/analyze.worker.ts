import { analyzeSamples, type TrackProfileCore } from './analyze';

/**
 * 分析 Worker（P3）。
 *
 * 为什么单独开一个：`analyzeSamples` 要在整首歌的帧上做自相关，几十万到上百万次乘加，
 * 放主线程会把进度条和歌词动画卡住。解码留在主线程（`OfflineAudioContext` 只在 window 有），
 * 这里只接已降采样的 PCM 做数学。
 *
 * 消息约定：`{ id, samples, sampleRate, durationMs }` → `{ id, core }`。
 * `samples` 用 transferable 传过来，主线程那份会失效（调用方本来也不再需要它）。
 */
interface AnalyzeRequest {
  id: number;
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
}

interface AnalyzeResponse {
  id: number;
  core: TrackProfileCore;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AnalyzeRequest>) => void) | null;
  postMessage: (message: AnalyzeResponse) => void;
};

scope.onmessage = (event) => {
  const { id, samples, sampleRate, durationMs } = event.data;
  try {
    const core = analyzeSamples(samples, sampleRate, durationMs);
    scope.postMessage({ id, core });
  } catch (error) {
    // Worker 里抛错会让主线程的 Promise 永远挂着：回一个「没测出来」的空档案。
    console.warn('[pi/automix] 分析 Worker 出错：', error);
    scope.postMessage({
      id,
      core: {
        durationMs,
        bpm: null,
        beatOffsetSec: null,
        beatPeriodSec: null,
        confidence: 0,
        tail: { silenceSec: 0, activityRatio: 0 },
        head: { silenceSec: 0, startsHot: false },
      },
    });
  }
};
