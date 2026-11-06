'use strict';
// Lucide icons, ISC license: ICONS-LICENSE.txt. No runtime dependency.
const playerIcons = {"play": "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">\n  <polygon points=\"6 3 20 12 6 21 6 3\" />\n</svg>\n", "pause": "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">\n  <rect x=\"14\" y=\"4\" width=\"4\" height=\"16\" rx=\"1\" />\n  <rect x=\"6\" y=\"4\" width=\"4\" height=\"16\" rx=\"1\" />\n</svg>\n", "volume-2": "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">\n  <path d=\"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z\" />\n  <path d=\"M16 9a5 5 0 0 1 0 6\" />\n  <path d=\"M19.364 18.364a9 9 0 0 0 0-12.728\" />\n</svg>\n", "volume-x": "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">\n  <path d=\"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z\" />\n  <line x1=\"22\" x2=\"16\" y1=\"9\" y2=\"15\" />\n  <line x1=\"16\" x2=\"22\" y1=\"9\" y2=\"15\" />\n</svg>\n"};
const seekDragging = new Map();
const timelines = new Map();
const titleAnimations = new Map();

function setIconButton(button, icon, label) {
  if (button.dataset.icon !== icon) { button.innerHTML = playerIcons[icon]; button.dataset.icon = icon; }
  button.setAttribute('aria-label', label);
  button.title = label;
}
function formatTime(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—:—';
  const seconds = Math.floor(milliseconds / 1000), minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
function mediaID(player) { return player?.id === 'youtube' ? player.video_id : player?.track_id; }
function titleMotion(id) {
  const box = $(id + '-track-box'), track = $(id + '-track');
  const overlay = box.dataset.overlay === 'true';
  const distance = overlay ? 0 : Math.max(0, track.scrollWidth - box.clientWidth);
  box.title = overlay ? track.textContent : '';
  const previous = titleAnimations.get(id);
  const animate = box.getClientRects().length > 0 && distance > 4 && box.dataset.active === 'true' && !document.hidden && !reducedMotion.matches;
  box.classList.toggle('is-overflowing', distance > 4);
  if (previous?.distance === distance && previous.text === track.textContent && previous.enabled === animate) return;
  previous?.animation?.cancel();
  let animation = null;
  if (animate) {
    const travel = Math.max(2000, distance / 28 * 1000), duration = travel * 2 + 4000;
    animation = track.animate([
      {transform: 'translateX(0)', offset: 0},
      {transform: 'translateX(0)', offset: 2000 / duration},
      {transform: `translateX(-${distance}px)`, offset: (2000 + travel) / duration},
      {transform: `translateX(-${distance}px)`, offset: (4000 + travel) / duration},
      {transform: 'translateX(0)', offset: 1}
    ], {duration, iterations: Infinity, easing: 'linear'});
    if (box.matches(':hover, :focus-within')) animation.pause();
  }
  titleAnimations.set(id, {distance, text: track.textContent, enabled: animate, animation});
}
function renderMedia(id, player, available) {
  const name = id === 'spotify' ? 'Spotify' : 'YouTube';
  const title = !player ? 'Waiting for player state…' : player?.title || (player?.active ? 'Title unavailable' : id === 'spotify' ? 'Choose RaspPi in Spotify' : 'Paste a link or cast from your phone');
  const track = $(id + '-track'), box = $(id + '-track-box');
  if (track.textContent !== title) track.textContent = title;
  track.classList.toggle('is-idle', !player?.active);
  box.dataset.active = String(Boolean(connected && player?.active));
  box.setAttribute('aria-label', title);
  $(id + '-full-title').textContent = title;
  const artist = $(id + '-artist');
  artist.textContent = player?.active ? player.artist || '' : '';
  artist.title = artist.textContent;
  const image = $(id + '-artwork');
  const url = player?.active ? player.artwork_url || '' : '';
  if (image.dataset.source !== url) {
    image.hidden = true;
    image.dataset.source = url;
    // Prefer the unpadded, high-resolution thumbnail for the large cover.
    // Remember the source separately so snapshots do not retry a failed size.
    const youtubeThumbnail = id === 'youtube' && /^https:\/\/i\.ytimg\.com\/vi\/[A-Za-z0-9_-]{11}\/hqdefault\.jpg$/.test(url);
    image.dataset.url = youtubeThumbnail ? url.replace('/hqdefault.jpg', '/maxresdefault.jpg') : url;
    image.dataset.fallback = youtubeThumbnail ? url.replace('/hqdefault.jpg', '/mqdefault.jpg') : '';
    if (url) image.src = image.dataset.url; else image.removeAttribute('src');
  }
  titleMotion(id);
  const muted = Boolean(player?.muted);
  const mute = $(id + '-mute');
  mute.dataset.action = muted ? 'unmute' : 'mute';
  setControlDisabled(mute, !available || !player.capabilities?.includes(mute.dataset.action));
  mute.setAttribute('aria-pressed', String(muted));
  setIconButton(mute, muted ? 'volume-x' : 'volume-2', `${muted ? 'Unmute' : 'Mute'} ${name}`);
  if (muted && mute.disabled && available && !busy) mute.title = 'Set a volume to unmute';
  const key = mediaID(player);
  const drag = seekDragging.get(id);
  if (drag && (drag.mediaID !== key || !available)) drag.invalid = true;
  const old = timelines.get(id);
  if (!old || old.player !== player) timelines.set(id, {player, received: performance.now(), available});
  else old.available = available;
  renderTimeline(id);
}
// Freeze the displayed position before disconnecting; retain it until a fresh snapshot.
function freezeTimelines() {
  const now = performance.now();
  for (const entry of timelines.values()) {
    const player = entry.player;
    if (entry.available && player?.active && !player.paused && Number.isFinite(player.position_ms) && Number.isFinite(player.duration_ms)) {
      player.position_ms = Math.min(player.duration_ms, player.position_ms + Math.max(0, now - entry.received));
    }
    entry.received = now;
  }
}
function renderTimeline(id) {
  const entry = timelines.get(id), player = entry?.player, slider = $(id + '-seek');
  const known = player?.available && player?.active && Number.isFinite(player.duration_ms) && player.duration_ms > 0 && Number.isFinite(player.position_ms) && !player.live;
  const drag = seekDragging.get(id);
  setControlDisabled(slider, !known || !entry?.available || !connected || Boolean(drag?.invalid) || !player.capabilities?.includes('seek'));
  const elapsed = !player?.paused && connected && entry?.available ? Math.max(0, performance.now() - (entry?.received || 0)) : 0;
  const position = drag ? Number(slider.value) * 1000 : known ? Math.min(player.duration_ms, player.position_ms + elapsed) : null;
  if (!drag) {
    slider.max = known ? String(Math.floor(player.duration_ms / 1000)) : '1';
    slider.value = known ? String(Math.floor(position / 1000)) : '0';
  }
  slider.style.setProperty('--position', `${known ? Math.min(100, position / player.duration_ms * 100) : 0}%`);
  slider.setAttribute('aria-valuetext', known ? `${formatTime(position)} of ${formatTime(player.duration_ms)}` : player?.live ? 'Live stream' : 'Unavailable');
  $(id + '-elapsed').textContent = formatTime(position);
  $(id + '-duration').textContent = player?.live ? 'Live' : known ? formatTime(player.duration_ms) : '—:—';
}
// Use the current media identity and interpolated position, never a stale slider value.
function relativeSeekTarget(id, seconds, ignorePending = false) {
  const entry = timelines.get(id), player = entry?.player;
  if (!connected || (busy && !ignorePending) || seekDragging.has(id) || !entry?.available || !player?.available || !player.active || player.live || !player.capabilities?.includes('seek') || !mediaID(player) || !Number.isFinite(player.position_ms) || !Number.isFinite(player.duration_ms) || player.duration_ms <= 0 || !Number.isFinite(seconds)) return null;
  const elapsed = player.paused ? 0 : Math.max(0, performance.now() - entry.received);
  const position = Math.min(player.duration_ms, player.position_ms + elapsed);
  return {player: id, action: 'seek', position_ms: Math.round(Math.max(0, Math.min(player.duration_ms, position + seconds * 1000))), media_id: mediaID(player)};
}
async function skipPlayer(id, seconds) {
  const target = relativeSeekTarget(id, seconds);
  if (!target) return;
  if (await change('api/player', target, `Position set to ${formatTime(target.position_ms)}`)) {
    const entry = timelines.get(id);
    if (mediaID(entry?.player) === target.media_id) { entry.player.position_ms = target.position_ms; entry.received = performance.now(); }
  }
  renderTimeline(id);
}
function initPlayerUI() {
  for (const id of ['spotify', 'youtube']) {
    const image = $(id + '-artwork');
    const fallbackArtwork = () => {
      if (image.currentSrc && image.currentSrc !== image.dataset.url) return;
      image.hidden = true;
      if (image.dataset.fallback) {
        image.dataset.url = image.dataset.fallback;
        image.dataset.fallback = '';
        image.src = image.dataset.url;
      }
    };
    image.addEventListener('load', () => {
      if (image.currentSrc !== image.dataset.url) return;
      // Some unavailable sizes return a tiny placeholder rather than an error.
      if (image.dataset.fallback && image.naturalWidth <= 120) { fallbackArtwork(); return; }
      image.hidden = !image.dataset.url;
    });
    image.addEventListener('error', fallbackArtwork);
    const box = $(id + '-track-box');
    new ResizeObserver(() => titleMotion(id)).observe(box);
    const pause = () => titleAnimations.get(id)?.animation?.pause();
    const resume = () => { if (!box.matches(':hover, :focus-within')) titleAnimations.get(id)?.animation?.play(); };
    box.addEventListener('pointerenter', pause); box.addEventListener('focusin', pause);
    box.addEventListener('pointerleave', resume); box.addEventListener('focusout', resume);
    const slider = $(id + '-seek');
    const begin = () => {
      if (!seekDragging.has(id) && !slider.disabled) seekDragging.set(id, {mediaID: mediaID(timelines.get(id)?.player)});
    };
    slider.addEventListener('pointerdown', begin);
    slider.addEventListener('input', () => { begin(); renderTimeline(id); });
    slider.addEventListener('change', async () => {
      const drag = seekDragging.get(id), position = Number(slider.value) * 1000;
      seekDragging.delete(id);
      if (!drag || drag.invalid || drag.mediaID !== mediaID(timelines.get(id)?.player)) { renderTimeline(id); return; }
      if (await change('api/player', {player: id, action: 'seek', position_ms: position, media_id: drag.mediaID}, `Position set to ${formatTime(position)}`)) {
        const entry = timelines.get(id);
        if (mediaID(entry?.player) === drag.mediaID) { entry.player.position_ms = position; entry.received = performance.now(); }
      }
      renderTimeline(id);
    });
    const cancel = () => { seekDragging.delete(id); renderTimeline(id); };
    slider.addEventListener('pointercancel', cancel);
    slider.addEventListener('pointerup', () => { if (seekDragging.get(id)?.invalid) cancel(); });
    slider.addEventListener('blur', cancel);
    slider.addEventListener('keydown', event => { if (event.key === 'Escape') cancel(); });
  }
  // Interpolate the display locally; do not poll the Pi every animation frame.
  setInterval(() => { if (!document.hidden) for (const id of ['spotify', 'youtube']) renderTimeline(id); }, 250);
  const motion = () => { for (const id of ['spotify', 'youtube']) titleMotion(id); };
  document.addEventListener('visibilitychange', motion);
  reducedMotion.addEventListener('change', motion);
}
