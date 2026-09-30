export function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return '--:--';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function artistNames(song: { artists: { name: string }[] }): string {
  if (song.artists.length === 0) return '未知歌手';
  return song.artists.map((a) => a.name).join(' / ');
}
