import type { ReactNode } from 'react';
import { coverAt } from '../lib/cover';
import { useAccount, useLogout } from '../lib/queries';
import { useUi } from '../state/ui';
import { Icon } from './Icons';

/**
 * 账号卡。
 *
 * 原来长在 `NavDrawer` 里（抽屉底部）。用户 m08768 第 8 条要求设置页也按「账号」分类
 * 放这一块，所以搬到这里，抽屉与设置页**共用同一个组件**——不是复制一份。
 * 为什么不能复制：这是全应用唯一的登录入口，写两份就会出现两套 pending 状态与两套退出
 * 逻辑，登录态一改两边还可能不同步；而「我没登录」恰恰是用户最需要立刻处理的状态。
 *
 * 两种形态的差异**只允许收在 settings-frame.css 里**（面板态的分隔线 / 40px 头像 / ID 小字）：
 * 默认形态必须与从前的抽屉底部逐字节一致，否则等于顺手改了那条救急路径的外观。
 */
export interface AccountCardProps {
  /**
   * `drawer`：抽屉底部的原样单行（26px 头像 + 一条下边框）。
   * `panel`：设置页「账号」tab 的卡片态（40px 头像、昵称与 ID 分两行、去掉抽屉分隔线）。
   */
  variant?: 'drawer' | 'panel';
}

export function AccountCard({ variant = 'drawer' }: AccountCardProps): ReactNode {
  const account = useAccount();
  const openLogin = useUi((s) => s.openLogin);
  const logout = useLogout();

  if (account.isPending) {
    return <div className="pi-account">正在读取账号…</div>;
  }

  const capability = account.data;
  if (!capability?.loggedIn) {
    return (
      <button type="button" className="pi-btn pi-btn--primary" onClick={openLogin}>
        <Icon name="user" size={15} /> 扫码登录
      </button>
    );
  }

  const avatar = coverAt(capability.avatarUrl, 100);
  const name = (
    <span className="pi-account__name" title={capability.nickname ?? undefined}>
      {capability.nickname ?? `用户 ${capability.userId ?? ''}`}
    </span>
  );

  return (
    <div className={`pi-account${variant === 'panel' ? ' pi-account--panel' : ''}`}>
      {avatar ? (
        <img className="pi-account__avatar" src={avatar} alt="" />
      ) : (
        <span className="pi-account__avatar pi-account__avatar--empty">
          <Icon name="user" size={15} />
        </span>
      )}
      {/*
        面板态把「昵称 + ID」叠成两行（对齐参考图里的 ID: 76421439）：参考图上 ID 是
        独立的等宽小字，跟昵称挤在一行会互相抢宽度、窄面板里先被截断的是 ID。
      */}
      {variant === 'panel' ? (
        <span className="pi-account__who">
          {name}
          {capability.userId !== undefined ? (
            <span className="pi-account__id">ID: {capability.userId}</span>
          ) : null}
        </span>
      ) : (
        name
      )}
      {capability.vip ? <span className="pi-badge">VIP</span> : null}
      <button
        type="button"
        className="pi-iconbtn"
        onClick={logout}
        aria-label="退出登录"
        title="退出登录"
      >
        <Icon name="logout" size={15} />
      </button>
    </div>
  );
}
