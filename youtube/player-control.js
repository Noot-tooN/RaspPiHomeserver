// Invoked only by the local CDP helper. No network requests or arbitrary scripts
// are accepted from the panel. Read-only status never starts a video.
function controlYouTube(input) {
  if (location.origin !== 'https://www.youtube.com' || !/^\/tv(?:\/|$)/.test(location.pathname)) throw new Error('Not the TV receiver');
  const player = document.getElementById('ytlr-player__player-container-player');
  if (!player || typeof player.getPlayerState !== 'function') throw new Error('Player unavailable');
  const data = typeof player.getVideoData === 'function' ? player.getVideoData() : {};
  const active = Boolean(data?.video_id);
  const status = player.getPlayerState();
  const volume = typeof player.getVolume === 'function' ? player.getVolume() : undefined;
  const playlist = typeof player.getPlaylist === 'function' ? player.getPlaylist() : [];
  const index = typeof player.getPlaylistIndex === 'function' ? player.getPlaylistIndex() : -1;
  const capabilities = [];
  if (typeof player.loadVideoById === 'function') capabilities.push('load');
  if (Number.isFinite(volume) && typeof player.setVolume === 'function') capabilities.push('volume');
  if (active) {
    if (typeof player.playVideo === 'function' && [0, 2, 5].includes(status)) capabilities.push('play');
    if (typeof player.pauseVideo === 'function' && [1, 3].includes(status)) capabilities.push('pause');
    // The TV receiver does not always expose its casting queue. Never guess or
    // invoke next/previous without a known playlist position.
    if (Array.isArray(playlist) && Number.isInteger(index) && index >= 0) {
      if (index > 0 && typeof player.previousVideo === 'function') capabilities.push('previous');
      if (index + 1 < playlist.length && typeof player.nextVideo === 'function') capabilities.push('next');
    }
  }
  if (input.action !== 'state') {
    if (!capabilities.includes(input.action)) throw new Error('Control unavailable');
    if (input.action === 'load') {
      if (typeof input.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(input.videoId)) throw new Error('Invalid video ID');
      player.loadVideoById({videoId: input.videoId, startSeconds: 0});
    } else if (input.action === 'volume') {
      if (!Number.isInteger(input.volume) || input.volume < 0 || input.volume > 100) throw new Error('Invalid volume');
      player.setVolume(input.volume);
    } else {
      const methods = {play: 'playVideo', pause: 'pauseVideo', next: 'nextVideo', previous: 'previousVideo'};
      player[methods[input.action]]();
    }
    return {accepted: true};
  }
  return {id: 'youtube', available: true, active, paused: ![1, 3].includes(status),
    volume: Number.isFinite(volume) ? Math.round(Math.max(0, Math.min(100, volume))) : null,
    muted: typeof player.isMuted === 'function' && player.isMuted(),
    video_id: active && typeof data.video_id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(data.video_id) ? data.video_id : '',
    title: active && typeof data.title === 'string' ? data.title.trim().slice(0, 300) : '', capabilities};
}
