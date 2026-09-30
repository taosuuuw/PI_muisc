/**
 * 快捷键配置的 zustand 切片（用户 m00001 第 5 条）。
 *
 * 持久化走 renderer 自己的 localStorage（键 `pi.shortcuts`），与 `state/ui.ts` 里的
 * `uiStyle`（`pi.ui-style`）同一套路：纯前端偏好不进 `packages/shared` 的 `Settings`，
 * 免得动 `packages/ipc` 的通道名与主进程的白名单校验（见 `state/ui.ts` 第 54-58 行）。
 *
 * 监听与执行在 `components/ShortcutLayer.tsx`；本文件只管「读 / 改 / 记」。
 */

import { create } from 'zustand';
import {
  DEFAULT_BINDINGS,
  SHORTCUT_ACTIONS,
  SHORTCUT_STORAGE_KEY,
  bindingFromString,
  bindingToString,
  type KeyBinding,
  type ShortcutAction,
} from '../lib/shortcuts';

/**
 * 从 localStorage 读回绑定：逐条解析，认不出来的那一条退回默认值。
 * 存的是 `{ [action]: 'Ctrl+A' }` 这种规范化字符串，所以看到旧键位也能读懂。
 */
function readStoredBindings(): Record<ShortcutAction, KeyBinding> {
  const bindings: Record<ShortcutAction, KeyBinding> = { ...DEFAULT_BINDINGS };
  if (typeof window === 'undefined') return bindings;
  try {
    const raw = window.localStorage.getItem(SHORTCUT_STORAGE_KEY);
    if (!raw) return bindings;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return bindings;
    // 走 `Object.entries` 而不是断言表类型：坏数据（数组 / 别的对象）自然读不出值。
    const table = new Map<string, unknown>(Object.entries(parsed));
    for (const action of SHORTCUT_ACTIONS) {
      const value = table.get(action);
      if (typeof value !== 'string') continue;
      const binding = bindingFromString(value);
      if (binding !== null) bindings[action] = binding;
    }
  } catch {
    // 隐私模式 / 存的内容坏了：退回默认绑定，别阻断启动。
  }
  return bindings;
}

function persistBindings(bindings: Readonly<Record<ShortcutAction, KeyBinding>>): void {
  if (typeof window === 'undefined') return;
  try {
    const table: Record<string, string> = {};
    for (const action of SHORTCUT_ACTIONS) table[action] = bindingToString(bindings[action]);
    window.localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(table));
  } catch {
    // 配额满 / 被禁用：本次改动照样生效，只是记不住。
  }
}

export interface ShortcutsState {
  readonly bindings: Record<ShortcutAction, KeyBinding>;
  /** 正在等用户「按下新键」的动作；null = 不在捕获态。 */
  readonly capturing: ShortcutAction | null;
  readonly setBinding: (action: ShortcutAction, binding: KeyBinding) => void;
  readonly beginCapture: (action: ShortcutAction) => void;
  readonly cancelCapture: () => void;
  readonly resetBindings: () => void;
}

export const useShortcuts = create<ShortcutsState>((set, get) => ({
  bindings: readStoredBindings(),
  capturing: null,

  setBinding: (action, binding) => {
    const bindings = { ...get().bindings };
    bindings[action] = binding;
    set({ bindings, capturing: null });
    persistBindings(bindings);
  },

  beginCapture: (action) => set({ capturing: action }),
  cancelCapture: () => set({ capturing: null }),

  resetBindings: () => {
    const bindings: Record<ShortcutAction, KeyBinding> = { ...DEFAULT_BINDINGS };
    set({ bindings, capturing: null });
    persistBindings(bindings);
  },
}));
