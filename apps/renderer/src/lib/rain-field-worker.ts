/**
 * 雨场 PNG 专用 Dedicated Worker。
 *
 * 主线程只负责 copy/stamp/putImageData，然后把像素 ArrayBuffer transfer 过来；
 * 这里用 OffscreenCanvas.convertToBlob 做 PNG 编码，避免录屏时 toBlob 卡渲染线程。
 */
interface FieldEncodeRequest {
  type: 'encode';
  jobId: number;
  width: number;
  height: number;
  pixels: ArrayBuffer;
}

interface FieldEncodeResponse {
  type: 'encoded' | 'error';
  jobId: number;
  blob?: Blob;
  message?: string;
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<FieldEncodeRequest>) => void) | null;
  postMessage: (message: FieldEncodeResponse) => void;
};

let encodeCanvas: OffscreenCanvas | null = null;
let encodeCtx: OffscreenCanvasRenderingContext2D | null = null;
let encodeWidth = 0;
let encodeHeight = 0;

function ensureCpuCanvas(
  width: number,
  height: number,
): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas unavailable in rain field worker');
  }
  if (!encodeCanvas) encodeCanvas = new OffscreenCanvas(width, height);
  if (encodeWidth !== width || encodeHeight !== height) {
    encodeCanvas.width = width;
    encodeCanvas.height = height;
    encodeWidth = width;
    encodeHeight = height;
    // resize 会重设 backing store；重新取 context，避免继续使用旧状态。
    encodeCtx = null;
  }
  if (!encodeCtx) {
    // 纯 CPU 像素编码：阻止 GPU 上传/读回，复用同一 canvas/context。
    encodeCtx = encodeCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!encodeCtx) throw new Error('OffscreenCanvas 2d context unavailable');
  return { canvas: encodeCanvas, ctx: encodeCtx };
}

workerScope.onmessage = (event: MessageEvent<FieldEncodeRequest>) => {
  const { jobId, width, height, pixels } = event.data;
  void (async () => {
    try {
      const { canvas, ctx } = ensureCpuCanvas(width, height);
      ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      workerScope.postMessage({ type: 'encoded', jobId, blob });
    } catch (error) {
      workerScope.postMessage({
        type: 'error',
        jobId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
