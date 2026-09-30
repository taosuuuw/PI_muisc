import type { ReactNode } from 'react';
import { errorMessage } from '../bridge';

export interface AsyncSectionProps {
  isPending: boolean;
  error: unknown;
  children: ReactNode;
  loadingText?: string;
}

/**
 * 统一的「加载中 / 加载失败 / 正常」三分支。
 *
 * 抽出来是因为 M1 之后几乎所有页面都要处理这三种状态，各写一遍必然出现
 * 「某个页面忘了显示错误」这种情况——那时用户只会看到一个空白页。
 */
export function AsyncSection({
  isPending,
  error,
  children,
  loadingText = '正在加载…',
}: AsyncSectionProps): ReactNode {
  if (error) {
    return (
      <div className="pi-card pi-placeholder">
        <strong>加载失败</strong>
        <span>{errorMessage(error)}</span>
      </div>
    );
  }
  if (isPending) return <div className="pi-placeholder">{loadingText}</div>;
  return <>{children}</>;
}
