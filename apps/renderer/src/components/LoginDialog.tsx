import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { QrLoginState, QrLoginTicket } from '@pi/shared';
import { CH, errorMessage, invoke } from '../bridge';
import { useUi } from '../state/ui';
import { Icon } from './Icons';

/** 轮询间隔。网易云二维码有效期约 5 分钟，2 秒一次足够灵敏也不至于打爆接口。 */
const POLL_MS = 2000;

/**
 * 二维码登录弹窗。
 *
 * 为什么只有二维码：网易云早在多年前就封禁了「手机号 + 密码」登录
 * （docs/PLAN.md §8），任何声称能用密码登录的方案要么已失效、要么在骗 cookie。
 *
 * 流程：要 key → 生成二维码图 → 轮询 key → 803 时主进程落盘 cookie 并广播事件。
 * 渲染进程**全程拿不到 cookie**，它只看到 state.code。
 */
export function LoginDialog() {
  const open = useUi((s) => s.loginOpen);
  const closeLogin = useUi((s) => s.closeLogin);
  const queryClient = useQueryClient();

  const [ticket, setTicket] = useState<QrLoginTicket | null>(null);
  const [state, setState] = useState<QrLoginState | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 递增即换一张二维码（手动点击或过期自动触发）。 */
  const [generation, setGeneration] = useState(0);

  // 1) 打开弹窗（或换一张）时取新二维码。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTicket(null);
    setState(null);
    setError(null);
    invoke(CH.authQrKey)
      .then((next) => {
        if (!cancelled) setTicket(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, generation]);

  // 2) 拿到二维码后开始轮询。
  useEffect(() => {
    if (!open || !ticket) return;
    let stopped = false;
    let timer: number | undefined;

    const tick = async (): Promise<void> => {
      try {
        const next = await invoke(CH.authQrCheck, { key: ticket.key });
        if (stopped) return;
        setState(next);
        if (next.code === 803) {
          // 主进程已经存好 cookie 并推送了新能力，这里只需要刷新缓存并关窗。
          await queryClient.invalidateQueries();
          closeLogin();
          return;
        }
        if (next.code === 800) {
          // 二维码过期：自动换一张，用户不需要做任何事。
          setGeneration((n) => n + 1);
          return;
        }
      } catch (err: unknown) {
        if (!stopped) setError(errorMessage(err));
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), POLL_MS);
    };

    timer = window.setTimeout(() => void tick(), 1200);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open, ticket, queryClient, closeLogin]);

  // 3) ESC 关闭。
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeLogin();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeLogin]);

  if (!open) return null;

  return (
    <div className="pi-mask" onClick={closeLogin} role="presentation">
      <div
        className="pi-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="扫码登录"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="pi-dialog__head">
          <strong>扫码登录</strong>
          <button type="button" className="pi-iconbtn" onClick={closeLogin} aria-label="关闭">
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="pi-dialog__body">
          {error ? <div className="pi-dialog__error">{error}</div> : null}
          {ticket ? (
            <img className="pi-qr" src={ticket.image} alt="网易云登录二维码" />
          ) : (
            <div className="pi-qr pi-qr--loading">
              <span>{error ? '获取二维码失败' : '正在获取二维码…'}</span>
            </div>
          )}
          <p className="pi-dialog__hint">{describe(state)}</p>
          {ticket?.url ? <p className="pi-dialog__url">{ticket.url}</p> : null}
        </div>

        <footer className="pi-dialog__foot">
          <button type="button" className="pi-btn" onClick={() => setGeneration((n) => n + 1)}>
            <Icon name="refresh" size={15} /> 换一张
          </button>
          <span className="pi-dialog__safe">
            PI 只加密保存登录 cookie，不接触你的账号密码。
          </span>
        </footer>
      </div>
    </div>
  );
}

function describe(state: QrLoginState | null): string {
  if (!state) return '打开网易云 App，使用「扫一扫」登录';
  switch (state.code) {
    case 800:
      return '二维码已过期，正在刷新…';
    case 802:
      return state.nickname ? `已扫码：${state.nickname}，请在手机上确认` : '已扫码，请在手机上确认';
    case 803:
      return '登录成功';
    default:
      return '打开网易云 App，使用「扫一扫」登录';
  }
}
