import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from './Icons';
import { SettingsPage } from '../pages/SettingsPage';
import { useUi } from '../state/ui';

/**
 * 设置浮层（用户第八轮第 7 条）。
 *
 * 以前点「设置」是 `navigate('settings')`，整页换成设置页——用户要的是
 * 「设置页是在一个框里的」，并且切换动画要是：
 * 环形菜单的按键**逐个坠入悬浮球** → 悬浮球**向中心塌缩** → 设置框**从中心流出来**。
 *
 * 分工：
 * - 前两段（坠入 + 塌缩）在 `PiOrb` 里，它塌缩完才调 `openSettings()`，所以这里挂载的那一刻
 *   球已经在屏幕中心缩成一点了；
 * - 这一段（流出来）由 CSS 的 `data-phase='in'` 动画负责：框从原点的 0.28 倍放大、模糊散开，
 *   里面的分区再依次淡入（`animation-delay` 用子选择器排）。
 * 关闭时反过来：框缩回中心（`data-phase='out'`），动画放完才卸载；`PiOrb` 那边同时把球放回原位。
 */
const EXIT_MS = 340;

export function SettingsOverlay(): ReactNode {
  const open = useUi((s) => s.settingsOpen);
  const close = useUi((s) => s.closeSettings);
  /** 卸载要等退场动画跑完，所以「要不要画」和「想不想开着」是两个状态。 */
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    if (open) {
      setVisible(true);
      return;
    }
    if (!visible) return;
    const timer = window.setTimeout(() => setVisible(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open, visible]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, open]);

  if (!visible) return null;

  return (
    <div
      className="pi-settings-overlay"
      data-settings-overlay="true"
      data-phase={open ? 'in' : 'out'}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="pi-settings-overlay__box"
        data-settings-box="true"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
      >
        <button
          type="button"
          className="pi-settings-overlay__close"
          data-settings-close
          aria-label="关闭设置"
          onClick={close}
        >
          <Icon name="close" size={16} />
        </button>
        <SettingsPage />
      </div>
    </div>
  );
}
