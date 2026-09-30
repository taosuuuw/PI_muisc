import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CH, invoke } from '../bridge';
import { currentTimeMs, getAudio } from '../lib/audio-engine';
import { usePlayer } from '../state/player';

/**
 * `<audio>` 元素与播放 store 之间的唯一连接点。
 *
 * 它不渲染任何东西：元素是 `lib/audio-engine.ts` 里的单例（切页面不断音），
 * 这里只负责「把元素事件翻译成 store 动作」和「启动时从设置里恢复音量/模式」。
 */
export function AudioEngine(): null {
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => invoke(CH.settingsGet) });

  const hydrate = usePlayer((s) => s.hydrate);
  const reportTime = usePlayer((s) => s.reportTime);
  const reportEnded = usePlayer((s) => s.reportEnded);
  const reportError = usePlayer((s) => s.reportError);
  const reportPlaying = usePlayer((s) => s.reportPlaying);

  useEffect(() => {
    if (settings.data) hydrate(settings.data);
  }, [settings.data, hydrate]);

  useEffect(() => {
    const audio = getAudio();
    const onTime = (): void => {
      const duration = Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0;
      reportTime(currentTimeMs(), duration);
    };
    const onEnded = (): void => reportEnded();
    const onError = (): void => {
      const code = audio.error?.code;
      reportError(
        code === 4
          ? '这首歌的音频地址无法解码（可能已失效），按「下一首」重试解析。'
          : '音频加载失败，可能是网络问题或地址已过期。',
      );
    };
    const onPlay = (): void => reportPlaying(true);
    const onPause = (): void => reportPlaying(false);

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('durationchange', onTime);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('durationchange', onTime);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
    };
  }, [reportTime, reportEnded, reportError, reportPlaying]);

  return null;
}
