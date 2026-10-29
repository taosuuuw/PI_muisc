/**
 * `ort.wasm.min.mjs` 的最小类型声明（纯 wasm 的 extern-wasm 入口）。
 *
 * 这是从 onnxruntime-web 1.31.1 的 npm 包里 vendor 出来的构建产物，项目里没有那个依赖，
 * 所以只声明我们实际用到的三样东西（env / Tensor / InferenceSession），
 * 避免为了类型再拉一个几十 MB 的包。
 */
export interface OrtTensor {
  data: Float32Array;
}

export interface OrtSession {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}

export const Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => OrtTensor;

export const InferenceSession: {
  create(bytes: Uint8Array, options?: { executionProviders?: string[] }): Promise<OrtSession>;
};

export const env: {
  wasm: {
    wasmPaths: string | Record<string, string>;
    numThreads: number;
  };
};
