/**
 * 单张 combined 场的异步提交 gate。
 *
 * - 任意时刻最多一个 toBlob/decode 在飞；
 * - 新场景/新 seed 直接推进 token，旧回调只能被丢弃，不能碰新场；
 * - 新图先 decode，再替换 href；旧 BlobURL 在替换后的下一帧撤销；
 * - dispose 撤销当前 URL，并阻断所有 late callback。
 */
export interface RainFieldEncodeRequest {
  pixels: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
}

export interface RainFieldEncoderDeps {
  encode(
    request: RainFieldEncodeRequest,
    done: (blob: Blob | null) => void,
  ): void;
  decode(url: string): Promise<void>;
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
  setHref(url: string): void;
  schedule(callback: () => void): void;
  transparentUrl: string;
}

export class RainFieldEncoder {
  private scene = 0;
  private inFlight = false;
  private currentUrl: string | null = null;
  private disposed = false;

  constructor(private readonly deps: RainFieldEncoderDeps) {}

  beginScene(): number {
    this.scene += 1;
    this.inFlight = false;
    this.releaseCurrent();
    this.deps.setHref(this.deps.transparentUrl);
    return this.scene;
  }

  get busy(): boolean {
    return this.inFlight;
  }

  tryStart(): number | null {
    if (this.disposed || this.inFlight) return null;
    this.inFlight = true;
    return this.scene;
  }

  submit(
    request: RainFieldEncodeRequest,
    token: number,
    onSettled: (committed: boolean) => void,
  ): void {
    if (!this.isCurrent(token)) {
      this.inFlight = false;
      onSettled(false);
      return;
    }
    this.deps.encode(request, (blob) => {
      if (!blob || !this.isCurrent(token)) {
        if (this.isCurrent(token)) this.inFlight = false;
        onSettled(false);
        return;
      }
      const url = this.deps.createUrl(blob);
      this.deps.decode(url).then(
        () => {
          if (!this.isCurrent(token) || this.disposed) {
            this.deps.revokeUrl(url);
            onSettled(false);
            return;
          }
          const previous = this.currentUrl;
          this.currentUrl = url;
          this.deps.setHref(url);
          this.inFlight = false;
          if (previous) {
            // 新 href 已提交；下一帧再释放旧图，避免当前合成仍引用它。
            this.deps.schedule(() => this.deps.revokeUrl(previous));
          }
          onSettled(true);
        },
        () => {
          this.deps.revokeUrl(url);
          if (this.isCurrent(token)) this.inFlight = false;
          onSettled(false);
        },
      );
    });
  }

  abort(token: number): void {
    if (this.isCurrent(token)) this.inFlight = false;
  }

  dispose(): void {
    this.disposed = true;
    this.scene += 1;
    this.inFlight = false;
    this.releaseCurrent();
  }

  private isCurrent(token: number): boolean {
    return !this.disposed && token === this.scene;
  }

  private releaseCurrent(): void {
    if (this.currentUrl) {
      this.deps.revokeUrl(this.currentUrl);
      this.currentUrl = null;
    }
  }
}
