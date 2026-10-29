import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CH, invoke } from '../bridge';
import { currentTimeMs, ensureDecks, getAudio } from '../lib/audio-engine';
import { usePlayer } from '../state/player';

/**
 * `<audio>` 元素与播放 store 之间的唯一连接点。
 *
 * 它不渲染任何东西：元素是 `lib/audio-engine.ts` 里的两个 deck（切页面不断音），
 * 这里只负责「把**活动 deck** 的事件翻译成 store 动作」和「启动时从设置里恢复音量/模式」。
 *
 * 为什么每条事件都要先问一句「是不是活动 deck」：P2 的交叉淡化期间两个元素同时在放，
 * 出场那一路也会发 `timeupdate` / `ended` / `pause`。不筛的话，出场 deck 的自然结束会在
 * 过渡刚完成时再切一次歌（队列连跳两首），它的进度也会把新歌的歌词顶歪。
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
    const decks = ensureDecks();
    const isActive = (event: Event): boolean => event.target === getAudio();

    const onTime = (event: Event): void => {
      if (!isActive(event)) return;
      const audio = event.target as HTMLAudioElement;
      const duration = Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0;
      reportTime(currentTimeMs(), duration);
    };
    const onEnded = (event: Event): void => {
      if (!isActive(event)) return;
      reportEnded();
    };
    const onError = (event: Event): void => {
      // 预取中的下一首失败了不该把正在听的这首标成 error：那条路在 `player.ts` 里自己回退。
      if (!isActive(event)) return;
      const code = (event.target as HTMLAudioElement).error?.code;
      reportError(
        code === 4
          ? '这首歌的音频地址无法解码（可能已失效），按「下一首」重试解析。'
          : '音频加载失败，可能是网络问题或地址已过期。',
      );
    };
    const onPlay = (event: Event): void => {
      if (isActive(event)) reportPlaying(true);
    };
    const onPause = (event: Event): void => {
      if (isActive(event)) reportPlaying(false);
    };

    const elements = [decks.a, decks.b];
    for (const element of elements) {
      element.addEventListener('timeupdate', onTime);
      element.addEventListener('durationchange', onTime);
      element.addEventListener('ended', onEnded);
      element.addEventListener('error', onError);
      element.addEventListener('play', onPlay);
      element.addEventListener('pause', onPause);
    }
    return () => {
      for (const element of elements) {
        element.removeEventListener('timeupdate', onTime);
        element.removeEventListener('durationchange', onTime);
        element.removeEventListener('ended', onEnded);
        element.removeEventListener('error', onError);
        element.removeEventListener('play', onPlay);
        element.removeEventListener('pause', onPause);
      }
    };
  }, [reportTime, reportEnded, reportError, reportPlaying]);

  return null;
}
