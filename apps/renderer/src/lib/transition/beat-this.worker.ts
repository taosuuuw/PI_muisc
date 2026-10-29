import type { AutomixResources } from '@pi/shared';
import { detectBeatWithModel } from './beat-this';

/**
 * Beat This! 推理 Worker（P3 优化）。
 *
 * 推理是整条分析链里唯一「纯 CPU、秒级、可搬走」的一段：单块 1500 帧要 5 秒左右，
 * 放主线程会把进度条和歌词动画一起冻住。搬进来之后主线程只负责解码和收结果。
 *
 * 消息约定：`{ id, samples, resources, maxSeconds }` → `{ id, result }` 或 `{ id, error }`。
 * 失败一律回传 `error` 而不是让 Promise 永远挂着——主线程拿到后回退 DSP。
 */
interface BeatWorkerRequest {
  id: number;
  samples: Float32Array;
  resources: AutomixResources;
  maxSeconds?: number;
}

interface BeatWorkerResponse {
  id: number;
  result?: unknown;
  error?: string;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<BeatWorkerRequest>) => void) | null;
  postMessage: (message: BeatWorkerResponse) => void;
};

scope.onmessage = (event) => {
  const { id, samples, resources, maxSeconds } = event.data;
  void (async () => {
    try {
      const result = await detectBeatWithModel(samples, resources, { maxSeconds });
      scope.postMessage({ id, result });
    } catch (error) {
      scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  })();
};
