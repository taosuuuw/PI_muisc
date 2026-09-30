import { useUi } from '../state/ui';
import { Icon } from './Icons';

/**
 * 「这里需要登录」的统一占位。
 *
 * 全应用只有这一个入口文案，避免每个页面各写一套措辞——用户看到的引导
 * 应该始终一致。
 */
export function NeedsLogin({ what }: { what: string }) {
  const openLogin = useUi((s) => s.openLogin);
  return (
    <div className="pi-card pi-placeholder">
      <strong>{what}需要登录网易云账号</strong>
      <span>PI 使用二维码登录，不需要也不接受账号密码。</span>
      <div>
        <button type="button" className="pi-btn pi-btn--primary" onClick={openLogin}>
          <Icon name="user" size={15} /> 扫码登录
        </button>
      </div>
    </div>
  );
}
