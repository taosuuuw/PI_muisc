import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BINDINGS,
  SHORTCUT_ACTIONS,
  SHORTCUT_DEFINITIONS,
  bindingFromEvent,
  bindingFromString,
  bindingToString,
  eventMatchesBinding,
  findConflict,
  findMatchingAction,
  formatBinding,
  isBindableKey,
  isEditableElement,
  isHoldAction,
  isModifierKey,
  normalizeKey,
  sameBinding,
  type KeyBinding,
  type KeyEventLike,
  type ShortcutAction,
} from './shortcuts';

/** 造一个 keydown 事件的最小形状。 */
function keyEvent(init: {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}): KeyEventLike {
  return {
    key: init.key,
    ctrlKey: init.ctrl ?? false,
    altKey: init.alt ?? false,
    shiftKey: init.shift ?? false,
    metaKey: init.meta ?? false,
  };
}

function expectBinding(actual: KeyBinding | null, expected: KeyBinding): void {
  expect(actual).not.toBeNull();
  expect(actual !== null && sameBinding(actual, expected)).toBe(true);
}

describe('默认绑定', () => {
  it('九个动作各有一条默认绑定，与用户 m00001 第 5 条一致', () => {
    expect(SHORTCUT_ACTIONS).toHaveLength(9);
    expect(new Set(SHORTCUT_ACTIONS).size).toBe(9);
    expectBinding(DEFAULT_BINDINGS.exit, { key: 'Escape', ctrl: false, alt: false, shift: false, meta: false });
    expectBinding(DEFAULT_BINDINGS.collections, { key: 'Tab', ctrl: false, alt: false, shift: false, meta: false });
    expectBinding(DEFAULT_BINDINGS.quickSettings, { key: 'a', ctrl: true, alt: false, shift: false, meta: false });
    expectBinding(DEFAULT_BINDINGS.openSettings, { key: 's', ctrl: true, alt: false, shift: false, meta: false });
    expectBinding(DEFAULT_BINDINGS.togglePlay, { key: ' ', ctrl: false, alt: false, shift: false, meta: false });
    expectBinding(DEFAULT_BINDINGS.volumeUp, { key: 'ArrowUp', ctrl: false, alt: false, shift: false, meta: false });
    expectBinding(DEFAULT_BINDINGS.volumeDown, { key: 'ArrowDown', ctrl: false, alt: false, shift: false, meta: false });
    expectBinding(DEFAULT_BINDINGS.seekBackward, { key: 'ArrowLeft', ctrl: false, alt: false, shift: false, meta: false });
    expectBinding(DEFAULT_BINDINGS.seekForward, { key: 'ArrowRight', ctrl: false, alt: false, shift: false, meta: false });
  });

  it('动作表与动作顺序一一对应', () => {
    expect(SHORTCUT_DEFINITIONS.map((definition) => definition.action)).toEqual([...SHORTCUT_ACTIONS]);
  });

  it('只有音量与进度四条是长按动作', () => {
    const holds = SHORTCUT_ACTIONS.filter((action) => isHoldAction(action));
    expect(holds).toEqual(['volumeUp', 'volumeDown', 'seekBackward', 'seekForward']);
  });
});

describe('序列化 / 解析', () => {
  it('每条默认绑定都能字符串往返', () => {
    for (const action of SHORTCUT_ACTIONS) {
      const binding = DEFAULT_BINDINGS[action];
      const text = bindingToString(binding);
      expectBinding(bindingFromString(text), binding);
    }
  });

  it('组合键按 Ctrl+Alt+Shift+Meta 的固定顺序输出', () => {
    expect(formatBinding({ key: 'k', ctrl: true, alt: true, shift: true, meta: true })).toBe('Ctrl+Alt+Shift+Meta+K');
    expect(formatBinding(DEFAULT_BINDINGS.quickSettings)).toBe('Ctrl+A');
    expect(formatBinding(DEFAULT_BINDINGS.exit)).toBe('Esc');
    expect(formatBinding(DEFAULT_BINDINGS.togglePlay)).toBe('Space');
    expect(formatBinding(DEFAULT_BINDINGS.volumeUp)).toBe('Up');
  });

  it('大小写与别名都能解析回同一个绑定', () => {
    expectBinding(bindingFromString('ctrl+a'), DEFAULT_BINDINGS.quickSettings);
    expectBinding(bindingFromString('CTRL+SHIFT+K'), { key: 'k', ctrl: true, alt: false, shift: true, meta: false });
    expectBinding(bindingFromString('cmd+s'), { key: 's', ctrl: false, alt: false, shift: false, meta: true });
    expectBinding(bindingFromString('↑'), DEFAULT_BINDINGS.volumeUp);
    expectBinding(bindingFromString('ArrowDown'), DEFAULT_BINDINGS.volumeDown);
    expectBinding(bindingFromString('escape'), DEFAULT_BINDINGS.exit);
  });

  it('加号键自己不会被 split 拆坏', () => {
    expectBinding(bindingFromString('Ctrl++'), { key: '+', ctrl: true, alt: false, shift: false, meta: false });
    expectBinding(bindingFromString('+'), { key: '+', ctrl: false, alt: false, shift: false, meta: false });
  });

  it('纯修饰键 / 空串 / 认不出的东西解析成 null', () => {
    expect(bindingFromString('')).toBeNull();
    expect(bindingFromString('   ')).toBeNull();
    expect(bindingFromString('Ctrl')).toBeNull();
    expect(bindingFromString('Ctrl+Alt')).toBeNull();
    expect(bindingFromString('Shift')).toBeNull();
    expect(bindingFromString('Ctrl+Shift')).toBeNull();
  });
});

describe('事件匹配', () => {
  it('修饰键严格比较：Ctrl+A 不会被 Ctrl+Shift+A 命中', () => {
    expect(eventMatchesBinding(keyEvent({ key: 'a', ctrl: true }), DEFAULT_BINDINGS.quickSettings)).toBe(true);
    expect(eventMatchesBinding(keyEvent({ key: 'A', ctrl: true, shift: true }), DEFAULT_BINDINGS.quickSettings)).toBe(false);
    expect(eventMatchesBinding(keyEvent({ key: 'a' }), DEFAULT_BINDINGS.quickSettings)).toBe(false);
    expect(eventMatchesBinding(keyEvent({ key: 'a', ctrl: true, alt: true }), DEFAULT_BINDINGS.quickSettings)).toBe(false);
  });

  it('裸键不会被带修饰键的按下命中，反之亦然', () => {
    expect(eventMatchesBinding(keyEvent({ key: 'ArrowUp' }), DEFAULT_BINDINGS.volumeUp)).toBe(true);
    expect(eventMatchesBinding(keyEvent({ key: 'ArrowUp', shift: true }), DEFAULT_BINDINGS.volumeUp)).toBe(false);
    expect(eventMatchesBinding(keyEvent({ key: ' ' }), DEFAULT_BINDINGS.togglePlay)).toBe(true);
    expect(eventMatchesBinding(keyEvent({ key: 'Tab' }), DEFAULT_BINDINGS.collections)).toBe(true);
  });

  it('findMatchingAction 按动作表顺序给第一条命中的绑定', () => {
    const bindings: Record<ShortcutAction, KeyBinding> = { ...DEFAULT_BINDINGS, quickSettings: { ...DEFAULT_BINDINGS.exit } };
    expect(findMatchingAction(bindings, keyEvent({ key: 'Escape' }))).toBe('exit');
    expect(findMatchingAction(DEFAULT_BINDINGS, keyEvent({ key: 'a', ctrl: true }))).toBe('quickSettings');
    expect(findMatchingAction(DEFAULT_BINDINGS, keyEvent({ key: 'F9' }))).toBeNull();
  });

  it('findConflict 报出另一个用了同一组合的动作', () => {
    const bindings: Record<ShortcutAction, KeyBinding> = {
      ...DEFAULT_BINDINGS,
      quickSettings: { ...DEFAULT_BINDINGS.collections },
    };
    expect(findConflict(bindings, 'collections')).toBe('quickSettings');
    expect(findConflict(DEFAULT_BINDINGS, 'collections')).toBeNull();
  });
});

describe('按键归一化与捕获', () => {
  it('单字符键统一小写，Shift 由字段表达', () => {
    expect(normalizeKey('A')).toBe('a');
    expect(normalizeKey(' ')).toBe(' ');
    expect(normalizeKey('ArrowUp')).toBe('ArrowUp');
  });

  it('纯修饰键不能当绑定，捕获时返回 null（忽略这一下）', () => {
    expect(isModifierKey('Control')).toBe(true);
    expect(isModifierKey('a')).toBe(false);
    expect(isBindableKey('Control')).toBe(false);
    expect(isBindableKey('Unidentified')).toBe(false);
    expect(bindingFromEvent(keyEvent({ key: 'Shift' }))).toBeNull();
    expect(bindingFromEvent(keyEvent({ key: 'Control', ctrl: true }))).toBeNull();
  });

  it('捕获普通键时把修饰键状态一起记下来', () => {
    expectBinding(bindingFromEvent(keyEvent({ key: 'K', ctrl: true, shift: true })), {
      key: 'k',
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
    });
    expectBinding(bindingFromEvent(keyEvent({ key: 'Escape' })), DEFAULT_BINDINGS.exit);
  });
});

describe('输入焦点判定', () => {
  it('输入框 / 文本域 / 下拉 / contenteditable 算「正在打字」', () => {
    expect(isEditableElement({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableElement({ tagName: 'textarea' })).toBe(true);
    expect(isEditableElement({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableElement({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isEditableElement({ tagName: 'DIV', isContentEditable: false })).toBe(false);
    expect(isEditableElement({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableElement(null)).toBe(false);
    expect(isEditableElement(undefined)).toBe(false);
  });
});
