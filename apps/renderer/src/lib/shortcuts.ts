/**
 * 快捷键的绑定模型与纯逻辑（用户 m00001 第 5 条）。
 *
 * 为什么配置放在 renderer 侧、而不是 `packages/shared` 的 `Settings`：
 * 见 `state/ui.ts` 第 54-58 行的先例——纯前端的开关走那条路要动 `packages/ipc` 的通道名
 * 与主进程的白名单校验，代价不划算。这里同样用 localStorage（键 `pi.shortcuts`）持久化，
 * 由 `state/shortcuts.ts` 读写，本文件只放与 DOM / store 无关的纯函数，方便单测。
 */

/** 九个可改绑的动作。 */
export type ShortcutAction =
  | 'exit'
  | 'collections'
  | 'quickSettings'
  | 'openSettings'
  | 'togglePlay'
  | 'volumeUp'
  | 'volumeDown'
  | 'seekBackward'
  | 'seekForward';

/**
 * 一条绑定：一个按键 + 需要同时按住的修饰键。
 * `key` 是 `KeyboardEvent.key` 归一化后的值——单字符键统一小写（`'a'` / `' '` / `'!'`），
 * 其余键（`'ArrowUp'` / `'Escape'` / `'F1'`）原样保留。这样 Shift 只由 `shift` 字段表达，
 * 不会出现「同一个键因为大小写被当成两个键」。
 */
export interface KeyBinding {
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

/** keydown / keyup 里匹配绑定真正会读到的字段（便于单测直接造假事件）。 */
export interface KeyEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

/** localStorage 键名。与 `pi.ui-style` 同一套路，纯 renderer 侧持久化。 */
export const SHORTCUT_STORAGE_KEY = 'pi.shortcuts';

/** 纯修饰键：捕获时按下它们不算一次绑定，也不会取消捕获。 */
const MODIFIER_KEYS: readonly string[] = ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS'];

/** 没有实际按键的 `key`：既不能绑定，也不能拿来匹配。 */
const IGNORED_KEYS: readonly string[] = ['Unidentified', 'Dead', 'Process'];

/** 单字符键归一化为小写；其余键原样。 */
export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/** 是不是「只有修饰键自己」的那一下（Ctrl / Alt / Shift / Meta…）。 */
export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.includes(key);
}

/** 这个 `key` 能不能当绑定：不是纯修饰键、也不是 Unidentified 之类。 */
export function isBindableKey(key: string): boolean {
  return key.length > 0 && !isModifierKey(key) && !IGNORED_KEYS.includes(key);
}

/**
 * 从一次 keydown 造绑定；纯修饰键与无按键的事件返回 null（捕获态据此「忽略」而不是「取消」）。
 */
export function bindingFromEvent(event: KeyEventLike): KeyBinding | null {
  const key = normalizeKey(event.key);
  if (!isBindableKey(key)) return null;
  return {
    key,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
}

/**
 * 事件是否命中这条绑定。修饰键是**严格**比较：Ctrl+A 的绑定不会被 Ctrl+Shift+A 触发
 * （否则「改成一个组合键」就形同虚设）。
 */
export function eventMatchesBinding(event: KeyEventLike, binding: KeyBinding): boolean {
  return (
    normalizeKey(event.key) === binding.key &&
    event.ctrlKey === binding.ctrl &&
    event.altKey === binding.alt &&
    event.shiftKey === binding.shift &&
    event.metaKey === binding.meta
  );
}

export function sameBinding(left: KeyBinding, right: KeyBinding): boolean {
  return (
    left.key === right.key &&
    left.ctrl === right.ctrl &&
    left.alt === right.alt &&
    left.shift === right.shift &&
    left.meta === right.meta
  );
}

/** 默认绑定（用户 m00001 第 5 条列的原始需求）。 */
export const DEFAULT_BINDINGS: Readonly<Record<ShortcutAction, KeyBinding>> = {
  // Esc → 退出当前页：先一层层关掉最上面的浮层，都关完了才回播放页。
  exit: { key: 'Escape', ctrl: false, alt: false, shift: false, meta: false },
  // Tab → PI 圆键上划出来的六宫格卡。
  collections: { key: 'Tab', ctrl: false, alt: false, shift: false, meta: false },
  // Ctrl+A → PI 圆键右划出来的迷你设置卡。
  quickSettings: { key: 'a', ctrl: true, alt: false, shift: false, meta: false },
  // Ctrl+S → 详细设置页（盖在页面上的完整设置框）。
  openSettings: { key: 's', ctrl: true, alt: false, shift: false, meta: false },
  // 空格 → 播放 / 暂停。
  togglePlay: { key: ' ', ctrl: false, alt: false, shift: false, meta: false },
  // 上下 → 音量加减。
  volumeUp: { key: 'ArrowUp', ctrl: false, alt: false, shift: false, meta: false },
  volumeDown: { key: 'ArrowDown', ctrl: false, alt: false, shift: false, meta: false },
  // 左右 → 歌曲进度加减。
  seekBackward: { key: 'ArrowLeft', ctrl: false, alt: false, shift: false, meta: false },
  seekForward: { key: 'ArrowRight', ctrl: false, alt: false, shift: false, meta: false },
};

/** 设置页要展示的一条：动作 + 文案 + 是否支持长按连续。 */
export interface ShortcutDefinition {
  readonly action: ShortcutAction;
  readonly label: string;
  readonly hint: string;
  /** `hold` = 按住会匀速连续走（长按线性移动）。 */
  readonly kind: 'tap' | 'hold';
}

/** 展示顺序也决定了按键匹配顺序（先匹配到的动作生效，避免重复绑定时一起触发）。 */
export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  {
    action: 'exit',
    label: '退出当前页',
    hint: '一层层关掉最上面的浮层 / 抽屉 / 卡片，都关完了才回播放页',
    kind: 'tap',
  },
  {
    action: 'collections',
    label: '歌单选择页',
    hint: 'PI 圆键上划出来的六宫格卡；已经是它时再按一次关掉',
    kind: 'tap',
  },
  {
    action: 'quickSettings',
    label: '快捷设置页',
    hint: 'PI 圆键右划出来的迷你设置卡；已经是它时再按一次关掉',
    kind: 'tap',
  },
  {
    action: 'openSettings',
    label: '详细设置页',
    hint: '盖在播放页上的完整设置框，Esc 关掉',
    kind: 'tap',
  },
  {
    action: 'togglePlay',
    label: '播放 / 暂停',
    hint: '正在播就暂停，暂停或空闲就开始播',
    kind: 'tap',
  },
  { action: 'volumeUp', label: '音量 +', hint: '点一下一小格，按住连续加', kind: 'hold' },
  { action: 'volumeDown', label: '音量 −', hint: '点一下一小格，按住连续减', kind: 'hold' },
  {
    action: 'seekBackward',
    label: '进度 −',
    hint: '点一下退 5 秒，按住线性倒退',
    kind: 'hold',
  },
  {
    action: 'seekForward',
    label: '进度 +',
    hint: '点一下进 5 秒，按住线性快进',
    kind: 'hold',
  },
];

/** 给遍历用的动作顺序，与 `SHORTCUT_DEFINITIONS` 一致。 */
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = SHORTCUT_DEFINITIONS.map(
  (definition) => definition.action,
);

export function isHoldAction(action: ShortcutAction): boolean {
  return action === 'volumeUp' || action === 'volumeDown' || action === 'seekBackward' || action === 'seekForward';
}

export function shortcutLabel(action: ShortcutAction): string {
  for (const definition of SHORTCUT_DEFINITIONS) {
    if (definition.action === action) return definition.label;
  }
  return action;
}

/** 按顺序找第一条命中的动作；都没命中返回 null。 */
export function findMatchingAction(
  bindings: Readonly<Record<ShortcutAction, KeyBinding>>,
  event: KeyEventLike,
): ShortcutAction | null {
  for (const action of SHORTCUT_ACTIONS) {
    if (eventMatchesBinding(event, bindings[action])) return action;
  }
  return null;
}

/** 与 `action` 当前绑定完全相同的**其它**动作（设置页提示冲突用），没有则 null。 */
export function findConflict(
  bindings: Readonly<Record<ShortcutAction, KeyBinding>>,
  action: ShortcutAction,
): ShortcutAction | null {
  const target = bindings[action];
  for (const other of SHORTCUT_ACTIONS) {
    if (other !== action && sameBinding(bindings[other], target)) return other;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 序列化：组合键 ↔ 字符串
 * ------------------------------------------------------------------ */

/** 键 → 展示用的名字。 */
const KEY_LABEL: Readonly<Record<string, string>> = {
  ' ': 'Space',
  Escape: 'Esc',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

/** 展示名（大小写不敏感）→ `key`。 */
const LABEL_KEY: Readonly<Record<string, string>> = {
  space: ' ',
  esc: 'Escape',
  escape: 'Escape',
  up: 'ArrowUp',
  arrowup: 'ArrowUp',
  down: 'ArrowDown',
  arrowdown: 'ArrowDown',
  left: 'ArrowLeft',
  arrowleft: 'ArrowLeft',
  right: 'ArrowRight',
  arrowright: 'ArrowRight',
  // 方向键的箭头字形也认：手写进 localStorage 的旧值不至于读不出来。
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
};

function keyLabel(key: string): string {
  const known = KEY_LABEL[key];
  if (known !== undefined) return known;
  return key.length === 1 ? key.toUpperCase() : key;
}

function labelToKey(token: string): string | null {
  const lower = token.toLowerCase();
  const known = LABEL_KEY[lower];
  if (known !== undefined) return known;
  // 纯修饰键不能单独当绑定。
  if (isModifierKey(token) || lower === 'ctrl' || lower === 'cmd' || lower === 'super') return null;
  if (/^f\d{1,2}$/i.test(token)) return token.toUpperCase();
  if (token.length === 1) return normalizeKey(token);
  return token;
}

/** 绑定 → 规范字符串，例如 `Ctrl+A` / `Shift+Tab` / `Esc` / `Space` / `Up`。 */
export function bindingToString(binding: KeyBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  if (binding.meta) parts.push('Meta');
  parts.push(keyLabel(binding.key));
  return parts.join('+');
}

/** 设置页展示用；与 `bindingToString` 同一套写法。 */
export function formatBinding(binding: KeyBinding): string {
  return bindingToString(binding);
}

const MODIFIER_PREFIXES: readonly {
  readonly prefix: string;
  readonly flag: 'ctrl' | 'alt' | 'shift' | 'meta';
}[] = [
  { prefix: 'ctrl', flag: 'ctrl' },
  { prefix: 'alt', flag: 'alt' },
  { prefix: 'shift', flag: 'shift' },
  { prefix: 'meta', flag: 'meta' },
  { prefix: 'cmd', flag: 'meta' },
  { prefix: 'super', flag: 'meta' },
];

/**
 * 规范字符串 → 绑定；认不出来返回 null。
 *
 * 从头部反复剥修饰键前缀，而不是 `split('+')`：加号键本身序列化成 `Ctrl++`，
 * 用 split 会被拆成三段丢掉那个 `'+'`。
 */
export function bindingFromString(text: string): KeyBinding | null {
  let rest = text.trim();
  if (!rest) return null;

  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  for (;;) {
    const lower = rest.toLowerCase();
    let stripped = false;
    for (const { prefix, flag } of MODIFIER_PREFIXES) {
      if (!lower.startsWith(`${prefix}+`)) continue;
      if (flag === 'ctrl') ctrl = true;
      else if (flag === 'alt') alt = true;
      else if (flag === 'shift') shift = true;
      else meta = true;
      rest = rest.slice(prefix.length + 1);
      stripped = true;
      break;
    }
    if (!stripped) break;
  }

  if (!rest) return null;
  const key = labelToKey(rest);
  if (key === null) return null;
  return { key, ctrl, alt, shift, meta };
}

/* ------------------------------------------------------------------ *
 * 输入焦点判定
 * ------------------------------------------------------------------ */

/** 只读 `tagName` / `isContentEditable`，真实 `Element` 天然满足这个结构。 */
export interface EditableLike {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
}

/**
 * 焦点是不是在「正在打字」的地方。在输入框里不该抢 Tab / 空格 / 方向键，
 * 否则用户连字都打不顺。
 */
export function isEditableElement(element: EditableLike | null | undefined): boolean {
  if (!element) return false;
  if (element.isContentEditable === true) return true;
  const tag = (element.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
