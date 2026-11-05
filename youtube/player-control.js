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
  const duration = typeof player.getDuration === 'function' ? player.getDuration() : NaN;
  const position = typeof player.getCurrentTime === 'function' ? player.getCurrentTime() : NaN;
  const live = Boolean(data?.isLive || data?.isWindowedLive);
  const muted = typeof player.isMuted === 'function' && player.isMuted();
  const canSeek = active && !live && [1, 2, 3].includes(status) && Number.isFinite(duration) && duration > 0 && duration <= 604800 && Number.isFinite(position) && typeof player.seekTo === 'function';
  const queue = window.rasppiYouTubeQueue;
  const queueState = queue?.status();
  const capabilities = [];
  if (queue && typeof player.loadVideoById === 'function') {
    capabilities.push('enqueue', 'autoplay', 'clearqueue', 'removequeue');
    if (queueState.can_next) capabilities.push('next');
    if (queueState.can_previous) capabilities.push('previous');
  }
  if (typeof player.mute === 'function' && typeof player.unMute === 'function' && typeof player.isMuted === 'function') capabilities.push(muted ? 'unmute' : 'mute');
  if (canSeek) capabilities.push('seek');
  if (typeof player.loadVideoById === 'function') capabilities.push('load');
  if (Number.isFinite(volume) && typeof player.setVolume === 'function') capabilities.push('volume');
  if (active) {
    if (typeof player.playVideo === 'function' && [0, 2, 5].includes(status)) capabilities.push('play');
    if (typeof player.pauseVideo === 'function' && [1, 3].includes(status)) capabilities.push('pause');
    // The TV receiver does not always expose its casting queue. Never guess or
    // invoke next/previous without a known playlist position.
    if (!queueState?.navigation_pending && Array.isArray(playlist) && Number.isInteger(index) && index >= 0) {
      if (!capabilities.includes('previous') && index > 0 && typeof player.previousVideo === 'function') capabilities.push('previous');
      if (!capabilities.includes('next') && index + 1 < playlist.length && typeof player.nextVideo === 'function') capabilities.push('next');
    }
  }
  if (input.action !== 'state') {
    if (!capabilities.includes(input.action)) throw new Error('Control unavailable');
    if (input.action === 'load' || input.action === 'enqueue') {
      if (typeof input.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(input.videoId)) throw new Error('Invalid video ID');
      if (input.action === 'enqueue') queue.enqueue(input.videoId, input.title);
      else if (queue) queue.play(input.videoId);
      else player.loadVideoById({videoId: input.videoId, startSeconds: 0});
    } else if (input.action === 'autoplay') {
      queue.setAutoplay(input.enabled);
    } else if (input.action === 'removequeue') {
      queue.remove(input.queueID);
    } else if (input.action === 'clearqueue') {
      queue.clear();
    } else if (input.action === 'next' && queueState?.can_next) {
      queue.next();
    } else if (input.action === 'previous' && queueState?.can_previous) {
      queue.previous();
    } else if (input.action === 'seek') {
      if (!Number.isInteger(input.positionMs) || input.positionMs < 0 || input.positionMs > Math.round(duration * 1000) || input.expectedVideoId !== data.video_id) throw new Error('Video changed or invalid position');
      player.seekTo(input.positionMs / 1000, true);
    } else if (input.action === 'mute' || input.action === 'unmute') {
      player[input.action === 'mute' ? 'mute' : 'unMute']();
    } else if (input.action === 'volume') {
      if (!Number.isInteger(input.volume) || input.volume < 0 || input.volume > 100) throw new Error('Invalid volume');
      player.setVolume(input.volume);
    } else {
      const methods = {play: 'playVideo', pause: 'pauseVideo', next: 'nextVideo', previous: 'previousVideo'};
      player[methods[input.action]]();
    }
    return {accepted: true};
  }
  return {...queueState, id: 'youtube', available: true, active, paused: ![1, 3].includes(status),
    volume: Number.isFinite(volume) ? Math.round(Math.max(0, Math.min(100, volume))) : null,
    muted, live,
    duration_ms: active && !live && Number.isFinite(duration) && duration > 0 && duration <= 604800 ? Math.round(duration * 1000) : null,
    position_ms: active && Number.isFinite(position) && position >= 0 ? Math.round(position * 1000) : null,
    artwork_url: active && /^[A-Za-z0-9_-]{11}$/.test(data.video_id) ? 'https://i.ytimg.com/vi/' + data.video_id + '/hqdefault.jpg' : '',
    artist: active && typeof data.author === 'string' ? data.author.slice(0, 300) : '',
    video_id: active && typeof data.video_id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(data.video_id) ? data.video_id : '',
    title: active && typeof data.title === 'string' ? data.title.trim().slice(0, 300) : '', capabilities};
}
