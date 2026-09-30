import {
  CH,
  EVT,
  type Channel,
  type EventMap,
  type EventName,
  type PreloadBridge,
  type RouteMap,
} from '@pi/ipc';

/**
 * 渲染进程侧对 preload 桥的类型化封装。
 *
 * 渲染进程**永远不直接访问网络或文件系统**，一切经由这里走 IPC（见 docs/PLAN.md §2.2）。
 */

interface PiWindow {
  pi?: PreloadBridge;
}

export function getBridge(): PreloadBridge | undefined {
  return (window as unknown as PiWindow).pi;
}

export async function invoke<K extends Channel>(
  channel: K,
  ...args: RouteMap[K]['input'] extends undefined | void
    ? []
    : [payload: RouteMap[K]['input']]
): Promise<RouteMap[K]['output']> {
  const bridge = getBridge();
  if (!bridge) {
    throw new Error('PI 的预加载桥不可用（preload 脚本未加载），请检查打包产物。');
  }
  const payload = args[0];
  return bridge.invoke(channel, payload);
}

export function subscribe<K extends Channel>(
  channel: K,
  listener: (payload: RouteMap[K]['output']) => void,
): () => void {
  const bridge = getBridge();
  if (!bridge) return () => {};
  return bridge.on(channel, (payload: unknown) => listener(payload as RouteMap[K]['output']));
}

/** 订阅主进程推送的事件（登录态变更、内嵌服务健康度）。 */
export function subscribeEvent<K extends EventName>(
  event: K,
  listener: (payload: EventMap[K]) => void,
): () => void {
  const bridge = getBridge();
  if (!bridge) return () => {};
  return bridge.on(event, (payload: unknown) => listener(payload as EventMap[K]));
}

/** Electron 会把主进程异常包成 "Error invoking remote method 'x': Error: <真实消息>"，这里剥掉外层。 */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message.replace(/^Error invoking remote method '[^']*':\s*/, '');
}

export { CH, EVT };
