import { contextBridge, ipcRenderer } from 'electron';
import type { Channel, PreloadBridge, RouteMap } from '@pi/ipc';
import { INPUT_SCHEMAS, PRELOAD_KEY } from '@pi/ipc';

/**
 * preload —— 渲染进程能看到的**全部**能力都在这里。
 *
 * 安全约束（docs/PLAN.md §2.3）：
 * - `contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`，
 *   渲染进程拿不到 require / fs / net，只能通过下面这个受控桥。
 * - 入参在发出前先用 zod 校验一次：宁可在这里报错，也不要让脏数据进主进程。
 * - 不暴露 `ipcRenderer` 本身，只暴露两个受控函数，避免渲染进程任意发通道。
 */

const bridge: PreloadBridge = {
  async invoke<K extends Channel>(
    channel: K,
    payload?: RouteMap[K]['input'],
  ): Promise<RouteMap[K]['output']> {
    const schema = INPUT_SCHEMAS[channel];
    if (schema) {
      const result = schema.safeParse(payload);
      if (!result.success) {
        // 直接抛出可读错误，方便开发期定位是哪个通道的契约对不上。
        throw new Error(
          `[pi/ipc] 通道 ${channel} 的入参不合法：${result.error.issues
            .map((i) => `${i.path.join('.')} ${i.message}`)
            .join('; ')}`,
        );
      }
    }
    return (await ipcRenderer.invoke(channel, payload)) as RouteMap[K]['output'];
  },

  on(channel: string, listener: (payload: unknown) => void): () => void {
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld(PRELOAD_KEY, bridge);
