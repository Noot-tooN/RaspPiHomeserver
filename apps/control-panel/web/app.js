'use strict';
const $ = id => document.getElementById(id);
let current = null, connected = false, busy = false, dragging = false, events = null, noticeTimer, staleTimer;
const playerDragging = new Set();
const restartUntil = {spotify: 0, youtube: 0};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
// Temporary opt-in while the player layout is being refined.
const visualizerEnabled = new URLSearchParams(window.location.search).get('visualizer') === '1';
const queueRows = new Map();
let queueDrag = null;
let pendingQueueMove = null;
let queueMoveTimer;
let spectrumTimer, connectionTimer;
let connectionPending = false, connectionGrace = false;
const backgroundGraceMs = 120000, stateFreshMs = 16000;
let backgroundTimer, hiddenSince = null, lastStateAt = null;
const spectrumBars = Object.fromEntries(['spotify', 'youtube'].map(id => {
  $(id + '-spectrum').hidden = !visualizerEnabled;
  const bars = Array.from({length: visualizerEnabled ? 48 : 0}, (_, index) => {
    const column = document.createElement('span'); column.className = 'spectrum-column';
    const fill = document.createElement('span'); fill.className = 'spectrum-fill';
    column.style.setProperty('--wave-delay', `${index * 25}ms`);
    column.append(fill);
    return {column, fill, level: 0};
  });
  $(id + '-spectrum').append(...bars.map(bar => bar.column));
  return [id, bars];
}));
let lastSpectrumAt = performance.now();
function renderSpectrum(frame = {}) {
  if (!visualizerEnabled) return;
  const now = performance.now(), seconds = Math.max(0, Math.min(1, (now - lastSpectrumAt) / 1000));
  lastSpectrumAt = now;
  for (const id of ['spotify', 'youtube']) {
    $(id + '-spectrum').dataset.frozen = String(!connected || document.hidden);
    if (!connected || document.hidden) continue;
    const value = frame[id];
    const live = !document.hidden && !reducedMotion.matches && value?.status === 'live' && value.bands?.length === 24;
    $(id + '-spectrum').classList.toggle('is-live', live);
    $(id + '-spectrum').classList.toggle('is-idle', !live && !document.hidden && !reducedMotion.matches);
    spectrumBars[id].forEach((bar, index) => {
      // Interpolate the server's 24 bands across the finer display bars.
      const position = index * 23 / (spectrumBars[id].length - 1);
      const lower = Math.floor(position), fraction = position - lower;
      // Fixed response curve: quiet bins recede without normalizing silence
      // into full-height motion. Server values already use a logarithmic scale.
      const level = band => live && Number.isFinite(value.bands[band])
        ? Math.pow(Math.max(0, Math.min(1, (value.bands[band] - 15) / 75)), 1.25) : 0;
      const target = level(lower) * (1 - fraction) + level(Math.min(23, lower + 1)) * fraction;
      // Quick attack and time-based release preserve transients between frames.
      const rising = target >= bar.level;
      bar.level = !live ? 0 : rising ? target : target + (bar.level - target) * Math.exp(-seconds / .14);
      bar.fill.style.transitionDuration = !live ? '350ms' : rising ? '60ms' : '100ms';
      bar.fill.style.height = `max(2px, ${bar.level * 100}%)`;
    });
  }
}

let pairingBusy = false, pairingTimer, pairingRetryAt = 0, pairingEpoch = 0, pairingCode = '', pairingExpiresAt = 0, pairingError = '';

function hidePairing() {
  pairingEpoch++;
  clearTimeout(pairingTimer);
  pairingCode = ''; pairingExpiresAt = 0; pairingError = '';
  renderPairing();
}

function notice(message, error = false) {
  clearTimeout(noticeTimer);
  if ($('settings-drawer').open || !$('youtube-panel').hidden) {
    const feedback = $($('settings-drawer').open ? 'settings-feedback' : 'youtube-action-feedback');
    feedback.textContent = message;
    feedback.title = message;
    feedback.className = `action-feedback${error ? ' error' : ''}`;
    feedback.hidden = false;
    if (!error) noticeTimer = setTimeout(() => { feedback.hidden = true; }, 4000);
    return;
  }
  $('notice').textContent = message;
  $('notice').className = error ? 'notice error' : 'notice';
  $('notice').hidden = false;
  if (!error) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 5000);
}

function connection(online, label, quiet = false) {
  if (connected && !online) freezeTimelines();
  connected = online;
  if (online || document.hidden) {
    clearTimeout(connectionTimer);
    connectionTimer = undefined;
    connectionPending = false;
    connectionGrace = false;
    for (const id of ['spotify', 'youtube']) $(id + '-cover').dataset.connecting = 'false';
  } else if (!connectionPending) {
    connectionPending = true;
    connectionGrace = quiet && Boolean(current);
    // Empty covers already show the note: animate it immediately. Only delay
    // introducing an overlay over artwork, to avoid flashing on brief outages.
    for (const id of ['spotify', 'youtube']) {
      const image = $(id + '-artwork');
      $(id + '-cover').dataset.connecting = String(!quiet && (image.hidden || !image.dataset.url));
    }
    connectionTimer = setTimeout(() => {
      connectionGrace = false;
      for (const id of ['spotify', 'youtube']) {
        $(id + '-cover').dataset.connecting = 'true';
        renderNoteMotion(id);
      }
    }, quiet ? 750 : 250);
  }
  for (const id of ['spotify', 'youtube']) $(id + '-spectrum').dataset.frozen = String(!online || document.hidden);
  $('connection-text').textContent = label || (online ? 'Connected' : current ? 'Reconnecting' : 'Connecting');
  $('connection').title = online ? 'Live updates' : current ? 'Showing last known values. Controls are paused until fresh data arrives.' : 'Waiting for the Pi';
  if (!online) {
    dragging = false;
    playerDragging.clear();
    seekDragging.clear();
    renderSpectrum();
  }
  render();
}

// Pending requests keep their normal appearance; genuinely unavailable controls dim.
function setControlDisabled(control, unavailable) {
  control.disabled = Boolean(unavailable || busy);
  control.dataset.pending = String(Boolean(busy && !unavailable));
}

function render() {
  const audio = current?.audio;
  const ready = connected && Boolean(audio?.available);
  setControlDisabled($('volume'), !ready);
  setControlDisabled($('mute'), !ready);
  if (!dragging) {
    $('volume-value').textContent = audio?.available ? audio.volume : '—';
    $('volume').value = Math.min(100, audio?.volume || 0);
    $('volume').style.setProperty('--position', `${$('volume').value}%`);
    $('volume').setAttribute('aria-valuetext', ready ? `${audio.volume} percent` : 'Unavailable');
  }
  setIconButton($('mute'), audio?.muted ? 'volume-x' : 'volume-2', audio?.muted ? 'Unmute master output' : 'Mute master output');
  $('mute').setAttribute('aria-pressed', String(Boolean(audio?.muted)));
  $('volume-note').textContent = audio && !audio.available ? (audio.error || 'Audio unavailable') : audio?.volume > 100 ? 'Saved volume is above 100%. This control sets 0–100%.' : '';
  $('volume-note').hidden = !$('volume-note').textContent;
  $('volume-note').title = $('volume-note').textContent;

  for (const id of ['spotify', 'youtube']) {
    const service = current?.services.find(s => s.id === id);
    const player = current?.players?.find(p => p.id === id);
    let label = 'Unknown', style = 'neutral', detail = '';
    if (!current) { label = 'Checking'; }
    else if (Date.now() < restartUntil[id]) { label = 'Restarting'; style = 'warning'; }
    else if (service && !service.error) {
      if (service.active === 'active') {
        if (player?.available) { label = player.active ? (player.paused ? 'Paused' : 'Playing') : 'Ready'; style = player.active && !player.paused ? '' : 'neutral'; }
        else { label = 'Unavailable'; style = 'warning'; detail = player?.error || 'Waiting for the player'; }
      } else if (['activating', 'deactivating', 'reloading'].includes(service.active)) { label = 'Starting'; style = 'warning'; }
      else if (service.active === 'failed') { label = 'Failed'; style = 'error'; detail = 'Open Settings to restart the service'; }
      else { label = 'Stopped'; detail = 'Open Settings to restart the service'; }
    } else { detail = service?.error || 'Service status unavailable'; }
    $(id + '-status').textContent = label;
    $(id + '-status').className = `badge ${style}`;
    $(id + '-status').style.visibility = ['Playing', 'Paused', 'Ready', 'Checking'].includes(label) ? 'hidden' : 'visible';
    $(id + '-status').hidden = ['Playing', 'Paused', 'Ready', 'Checking'].includes(label);
    $(id + '-detail').textContent = detail;
    $(id + '-detail').hidden = !detail;
    $(id + '-detail').title = detail;
    setControlDisabled($(id + '-restart'), !connected || !service || Boolean(service.error) || Date.now() < restartUntil[id]);
  }
  renderPlayers();
  const youtube = current?.services.find(s => s.id === 'youtube');
  const youtubePlayer = current?.players?.find(p => p.id === 'youtube');
  const canLoad = connected && youtube?.active === 'active' && !youtube.error && Date.now() >= restartUntil.youtube && youtubePlayer?.available && youtubePlayer.capabilities?.includes('load');
  setControlDisabled($('youtube-url'), !canLoad);
  const queueCount = youtubePlayer?.queue_count || 0;
  setControlDisabled($('youtube-enqueue'), !canLoad || !youtubePlayer.capabilities?.includes('enqueue') || queueCount >= 50);
  setControlDisabled($('youtube-autoplay'), !canLoad || !youtubePlayer.capabilities?.includes('autoplay'));
  $('youtube-autoplay').setAttribute('aria-checked', String(Boolean(youtubePlayer?.autoplay)));
  setControlDisabled($('youtube-clearqueue'), !canLoad || !queueCount || !youtubePlayer.capabilities?.includes('clearqueue'));
  renderQueue(youtubePlayer, canLoad);
  $('youtube-queue-error').textContent = youtubePlayer?.queue_error || '';
  $('youtube-queue-error').title = youtubePlayer?.queue_error || '';
  $('youtube-queue-error').hidden = !youtubePlayer?.queue_error;
  renderPairing();
  if (typeof renderShell === 'function') renderShell();
}

$('youtube-link-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('youtube-url');
  const url = input.value.trim();
  if (input.disabled || !url) return;
  if ($('youtube-enqueue').disabled) return;
  if (await change('api/player', {player: 'youtube', action: 'enqueue', url})) {
    if (input.value.trim() === url) input.value = '';
  }
});

function renderUpNext(id, player, available) {
  const queued = player?.queue?.[0];
  const video = queued || (player?.autoplay ? player.recommendation : null);
  const next = id === 'spotify' ? player?.next_track : video ? {
    title: video.title || `Video ${video.video_id}`,
    artwork_url: /^[A-Za-z0-9_-]{11}$/.test(video.video_id) ? `https://i.ytimg.com/vi/${video.video_id}/default.jpg` : '',
    artist: queued ? (queued.starting ? 'Starting…' : 'From your queue') : 'YouTube recommendation'
  } : null;
  const pending = !next && Boolean(id === 'youtube' && player?.autoplay_pending);
  const title = next?.title || (!player ? 'Waiting for player…' : !player.available ? 'Player unavailable'
    : pending ? 'Finding a recommendation…' : 'Nothing up next');
  $(id + '-up-next').setAttribute('aria-busy', String(pending));
  $(id + '-up-next').dataset.empty = String(!next);
  $(id + '-up-next-title').textContent = title;
  $(id + '-up-next-title').title = title;
  $(id + '-up-next-detail').textContent = next ? ['Next', next.artist].filter(Boolean).join(' · ') : '';
  if (id === 'spotify') {
    const play = $('spotify-up-next-play');
    setControlDisabled(play, !available || !next || !player?.capabilities?.includes('next'));
    play.setAttribute('aria-label', next ? `Play next Spotify track: ${title}` : 'Play next Spotify track');
    renderEmptySlots('spotify', 1);
  }
  const artwork = $(id + '-up-next-artwork');
  const url = next?.artwork_url || '';
  if (artwork.dataset.url !== url) {
    artwork.dataset.url = url;
    artwork.hidden = true;
    if (url) artwork.src = url; else artwork.removeAttribute('src');
  }
}

for (const id of ['spotify', 'youtube']) {
  const artwork = $(id + '-up-next-artwork');
  artwork.addEventListener('load', () => { artwork.hidden = !artwork.dataset.url; });
  artwork.addEventListener('error', () => { artwork.hidden = true; });
}

$('spotify-up-next-play').addEventListener('click', () => {
  if (!$('spotify-up-next-play').disabled) change('api/player', {player: 'spotify', action: 'next'});
});

function renderEmptySlots(id, occupied) {
  const slots = $(id + '-empty-slots');
  if (!slots.children.length) {
    for (let index = 0; index < 6; index++) {
      const row = document.createElement('div'); row.className = 'queue-empty-slot';
      row.innerHTML = '<span class="queue-artwork"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><use href="#artwork-placeholder"/></svg></span><span class="queue-empty-label">Empty slot</span>';
      slots.append(row);
    }
  }
  slots.style.top = `calc(var(--queue-row-height) * ${Math.min(occupied, 6)})`;
  slots.hidden = occupied >= 6;
}

function queuedEntries() {
  return current?.players?.find(player => player.id === 'youtube')?.queue || [];
}
async function moveQueueEntry(id, beforeID) {
  const entries = queuedEntries(), index = entries.findIndex(entry => entry.id === id);
  if (pendingQueueMove || index < 0 || (entries[index + 1]?.id || '') === beforeID) return;
  const ids = entries.filter(entry => entry.id !== id).map(entry => entry.id);
  const destination = beforeID ? ids.indexOf(beforeID) : ids.length;
  if (destination < 0) return;
  ids.splice(destination, 0, id);
  const move = {baseOrder: entries.map(entry => entry.id).join(','), ids};
  pendingQueueMove = move;
  // Keep the drop position visible while the receiver acknowledges the move.
  render();
  const applied = await change('api/player', {player: 'youtube', action: 'reorderqueue', queue_id: id, before_id: beforeID});
  if (applied) {
    $('queue-announcement').textContent = `Moved ${entries[index].title || 'video'} ${beforeID ? 'in the queue' : 'to the end of the queue'}.`;
  }
  if (pendingQueueMove !== move) return;
  if (!applied) { pendingQueueMove = null; render(); return; }
  queueMoveTimer = setTimeout(() => {
    if (pendingQueueMove === move) { pendingQueueMove = null; render(); }
  }, 3000);
}
function cancelQueueDrag() {
  if (!queueDrag) return;
  const drag = queueDrag;
  queueDrag = null;
  cancelAnimationFrame(drag.frame);
  if (drag.handle.hasPointerCapture(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
  for (const [index, entry] of queuedEntries().entries()) {
    const row = queueRows.get(entry.id);
    if (!row) continue;
    row.element.style.transform = '';
    row.element.dataset.dragging = 'false';
    row.element.dataset.next = String(index === 0);
    row.detail.textContent = entry.starting ? 'Starting…' : index === 0 ? 'Next' : '';
    row.detail.hidden = !row.detail.textContent;
  }
  $('youtube-queue-list').dataset.dragging = 'false';
}
function previewQueueDrop(scroll = true) {
  if (!queueDrag?.active) return;
  const drag = queueDrag, list = $('youtube-queue-list'), bounds = list.getBoundingClientRect();
  const entries = queuedEntries(), sourceIndex = entries.findIndex(entry => entry.id === drag.id);
  const rowHeight = queueRows.get(drag.id).element.getBoundingClientRect().height;
  if (!rowHeight || sourceIndex < 0) return;
  if (scroll) {
    const edge = 32;
    const speed = drag.y < bounds.top + edge ? -Math.min(8, (bounds.top + edge - drag.y) / 4)
      : drag.y > bounds.bottom - edge ? Math.min(8, (drag.y - bounds.bottom + edge) / 4) : 0;
    list.scrollTop += speed;
  }
  // Use untransformed row positions so animated neighbours cannot move the drop target.
  const top = Math.max(0, Math.min((entries.length - 1) * rowHeight, drag.y - bounds.top + list.scrollTop - drag.offsetY));
  const destination = Math.max(0, Math.min(entries.length - 1, Math.round(top / rowHeight)));
  const ids = entries.filter(entry => entry.id !== drag.id).map(entry => entry.id);
  drag.beforeID = ids[destination] || '';
  ids.splice(destination, 0, drag.id);
  list.dataset.dragging = 'true';
  entries.forEach((entry, index) => {
    const row = queueRows.get(entry.id), previewIndex = ids.indexOf(entry.id);
    const offset = entry.id === drag.id ? top - sourceIndex * rowHeight : (previewIndex - index) * rowHeight;
    row.element.style.transform = `translateY(${offset}px)`;
    row.element.dataset.dragging = String(entry.id === drag.id);
    row.element.dataset.next = String(previewIndex === 0);
    row.detail.textContent = previewIndex === 0 ? 'Next' : '';
    row.detail.hidden = !row.detail.textContent;
  });
}
function updateQueueDrop() {
  if (!queueDrag?.active) return;
  previewQueueDrop();
  queueDrag.frame = requestAnimationFrame(updateQueueDrop);
}

function wireQueueHandle(handle, id) {
  handle.addEventListener('pointerdown', event => {
    if (handle.disabled || event.button !== 0 || event.isPrimary === false) return;
    cancelQueueDrag();
    event.preventDefault(); handle.focus();
    handle.setPointerCapture(event.pointerId);
    queueDrag = {id, handle, pointer: event.pointerId, startY: event.clientY, y: event.clientY,
      active: false, offsetY: event.clientY - queueRows.get(id).element.getBoundingClientRect().top, order: queuedEntries().map(entry => entry.id).join(',')};
  });
  handle.addEventListener('pointermove', event => {
    if (!queueDrag || queueDrag.pointer !== event.pointerId) return;
    queueDrag.y = event.clientY;
    if (!queueDrag.active && Math.abs(queueDrag.y - queueDrag.startY) >= 5) {
      queueDrag.active = true; updateQueueDrop();
    }
  });
  handle.addEventListener('pointerup', event => {
    if (!queueDrag || queueDrag.pointer !== event.pointerId) return;
    const drag = queueDrag;
    drag.y = event.clientY;
    if (drag.active) previewQueueDrop(false);
    cancelQueueDrag();
    if (drag.active) return moveQueueEntry(id, drag.beforeID);
  });
  handle.addEventListener('pointercancel', cancelQueueDrag);
  handle.addEventListener('lostpointercapture', () => { if (queueDrag?.handle === handle) cancelQueueDrag(); });
  handle.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { cancelQueueDrag(); return; }
    if (handle.disabled || queueDrag) return;
    const entries = queuedEntries(), index = entries.findIndex(entry => entry.id === id);
    if (index < 0) return;
    if (event.key === 'ArrowUp' && index > 0) return moveQueueEntry(id, entries[index - 1].id);
    if (event.key === 'ArrowDown' && index < entries.length - 1) return moveQueueEntry(id, entries[index + 2]?.id || '');
    if (event.key === 'Home' && index > 0) return moveQueueEntry(id, entries[0].id);
    if (event.key === 'End') return moveQueueEntry(id, '');
  });
}

function renderQueue(player, available) {
  let entries = player?.queue || [];
  if (pendingQueueMove) {
    if (entries.map(entry => entry.id).join(',') !== pendingQueueMove.baseOrder) {
      pendingQueueMove = null; clearTimeout(queueMoveTimer);
    } else {
      const byID = new Map(entries.map(entry => [entry.id, entry]));
      entries = pendingQueueMove.ids.map(id => byID.get(id));
    }
  }
  if (queueDrag && (!available || busy || !player?.capabilities?.includes('reorderqueue') || queueDrag.order !== entries.map(entry => entry.id).join(','))) cancelQueueDrag();
  const list = $('youtube-queue-list');
  list.dataset.settling = String(Boolean(pendingQueueMove));
  const ids = new Set(entries.map(entry => entry.id));
  for (const [id, row] of queueRows) {
    if (!ids.has(id)) { row.element.remove(); queueRows.delete(id); }
  }
  entries.forEach((entry, index) => {
    let row = queueRows.get(entry.id);
    if (!row) {
      const element = document.createElement('li'); element.className = 'queue-entry';
      const artwork = document.createElement('img'); artwork.alt = ''; artwork.loading = 'lazy'; artwork.referrerPolicy = 'no-referrer';
      const cover = document.createElement('span'); cover.className = 'queue-artwork';
      cover.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#artwork-placeholder"/></svg>';
      cover.append(artwork);
      const handle = document.createElement('button'); handle.type = 'button'; handle.className = 'button icon-button queue-handle';
      handle.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>';
      handle.setAttribute('aria-describedby', 'queue-reorder-help');
      wireQueueHandle(handle, entry.id);
      const play = document.createElement('button'); play.type = 'button'; play.className = 'queue-track queue-play';
      const text = document.createElement('span'); text.className = 'queue-entry-text';
      play.addEventListener('click', () => {
        if (!play.disabled) change('api/player', {player: 'youtube', action: 'playqueue', queue_id: entry.id});
      });
      const title = document.createElement('span'); title.className = 'queue-entry-title';
      const detail = document.createElement('span'); detail.className = 'queue-entry-detail';
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button icon-button queue-remove'; remove.textContent = '×';
      remove.addEventListener('click', () => {
        if (!remove.disabled) change('api/player', {player: 'youtube', action: 'removequeue', queue_id: entry.id});
      });
      artwork.addEventListener('error', () => { artwork.style.visibility = 'hidden'; });
      text.append(title, detail); play.append(cover, text); element.append(handle, play, remove);
      row = {element, artwork, title, detail, remove, play, handle}; queueRows.set(entry.id, row);
    }
    const title = entry.title || `Video ${entry.video_id}`;
    row.title.textContent = title; row.title.title = title;
    row.detail.textContent = entry.starting ? 'Starting…' : index === 0 ? 'Next' : '';
    row.detail.hidden = !row.detail.textContent;
    row.element.dataset.next = String(index === 0);
    const imageURL = /^[A-Za-z0-9_-]{11}$/.test(entry.video_id) ? `https://i.ytimg.com/vi/${entry.video_id}/default.jpg` : '';
    if (row.artwork.dataset.url !== imageURL) {
      row.artwork.dataset.url = imageURL; row.artwork.style.visibility = imageURL ? 'visible' : 'hidden';
      if (imageURL) row.artwork.src = imageURL;
    }
    row.handle.setAttribute('aria-label', `Reorder ${title}, position ${index + 1} of ${entries.length}`);
    setControlDisabled(row.handle, !available || !player?.capabilities?.includes('reorderqueue') || entries.length < 2 || Boolean(pendingQueueMove));
    row.play.setAttribute('aria-label', `Play ${title}`);
    row.play.setAttribute('aria-busy', String(Boolean(entry.starting)));
    setControlDisabled(row.play, !available || !player?.capabilities?.includes('playqueue') || entry.starting);
    row.remove.setAttribute('aria-label', `Remove ${title} from queue`);
    setControlDisabled(row.remove, !available || !player?.capabilities?.includes('removequeue') || entry.starting);
    if (list.children[index] !== row.element) list.insertBefore(row.element, list.children[index] || null);
  });
  // The same row presents either a recommendation or the empty-state placeholder.
  $('youtube-recommendation-row').hidden = entries.length > 0;
  renderEmptySlots('youtube', Math.max(1, entries.length));
  if (queueDrag?.active) previewQueueDrop(false);
}

$('youtube-autoplay').addEventListener('click', () => {
  if ($('youtube-autoplay').disabled) return;
  const player = current?.players?.find(p => p.id === 'youtube');
  change('api/player', {player: 'youtube', action: 'autoplay', enabled: !player?.autoplay});
});
$('youtube-clearqueue').addEventListener('click', () => {
  if (!$('youtube-clearqueue').disabled) change('api/player', {player: 'youtube', action: 'clearqueue'});
});

function renderPairing() {
  const valid = Boolean(pairingCode) && Date.now() < pairingExpiresAt;
  const service = current?.services.find(s => s.id === 'youtube');
  const ready = connected && service?.active === 'active' && !service.error && Date.now() >= restartUntil.youtube;
  $('pairing-code').textContent = valid ? pairingCode.match(/.{3}/g).join(' ') : '··· ··· ··· ···';
  $('pairing-code').dataset.empty = String(!valid);
  $('pairing-code').setAttribute('aria-label', valid ? `YouTube TV code ${pairingCode.split('').join(' ')}` : pairingBusy ? 'Getting YouTube TV code' : 'YouTube TV code not requested');
  $('pairing-result').setAttribute('aria-busy', String(pairingBusy));
  setControlDisabled($('youtube-pair'), !ready || pairingBusy || Date.now() < pairingRetryAt);
  $('pairing-status').textContent = pairingBusy ? 'Getting your TV code…' : !ready ? 'YouTube must be connected and running to get a code.' : pairingError || 'YouTube on your phone → Cast → Link with TV code';
  $('pairing-status').className = pairingError && !valid && !pairingBusy ? 'hint error' : 'hint';
}
async function requestPairing() {
  const service = current?.services.find(s => s.id === 'youtube');
  if (pairingBusy || busy || !connected || service?.active !== 'active' || service.error || Date.now() < pairingRetryAt || Date.now() < restartUntil.youtube) { renderPairing(); return; }
  hidePairing();
  const epoch = pairingEpoch;
  pairingBusy = true; busy = true; render();
  pairingRetryAt = Date.now() + 15000;
  try {
    const response = await fetch('api/youtube/pairing', {
      method: 'POST', headers: {'Content-Type': 'application/json', 'X-Requested-With': 'rasppi-control-panel'},
      body: '{}', signal: AbortSignal.timeout(35000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not get a TV code');
    if (!/^[0-9]{12}$/.test(result.code)) throw new Error('YouTube returned an unreadable TV code. Try again.');
    if (epoch !== pairingEpoch) return;
    // Memory only; an explicit request refreshes the code, which expires after five minutes.
    pairingCode = result.code;
    pairingExpiresAt = Date.now() + 5 * 60 * 1000;
    pairingTimer = setTimeout(hidePairing, 5 * 60 * 1000);
  } catch (error) {
    if (epoch !== pairingEpoch) return;
    pairingError = error.name === 'TimeoutError' ? 'YouTube took too long. Wait a moment and retry.' : error.message || 'Connection lost. Try again.';
  } finally {
    pairingBusy = false; busy = false; render();
    setTimeout(render, Math.max(0, pairingRetryAt - Date.now()) + 50);
  }
}
$('youtube-pair').addEventListener('click', requestPairing);

async function change(path, payload, message) {
  if (busy || !connected) return false;
  clearTimeout(noticeTimer);
  $('youtube-action-feedback').hidden = true;
  $('settings-feedback').hidden = true;
  $('notice').hidden = true;
  busy = true; render();
  try {
    const response = await fetch(path, {
      method: 'POST', headers: {'Content-Type': 'application/json', 'X-Requested-With': 'rasppi-control-panel'},
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not apply the change');
    if (message) notice(message);
    return true;
  } catch (error) {
    notice(error.name === 'TimeoutError' ? 'Request timed out. Check the current state before trying again.' : error.message || 'Connection lost. Try again.', true);
    return false;
  } finally { busy = false; render(); }
}

$('volume').addEventListener('input', () => {
  dragging = true;
  $('volume-value').textContent = $('volume').value;
  $('volume').style.setProperty('--position', `${$('volume').value}%`);
  $('volume').setAttribute('aria-valuetext', `${$('volume').value} percent`);
});
$('volume').addEventListener('change', async () => {
  const volume = Number($('volume').value);
  dragging = false;
  if (await change('api/volume', {volume}, `Volume set to ${volume}%`)) {
    if (current?.audio) current.audio.volume = volume;
    render();
  }
});
$('mute').addEventListener('click', async () => {
  const muted = !current?.audio.muted;
  if (await change('api/mute', {muted})) {
    if (current?.audio) current.audio.muted = muted;
    render();
  }
});
for (const button of document.querySelectorAll('[data-service]')) {
  button.addEventListener('click', async () => {
    const id = button.dataset.service;
    if (id === 'youtube') hidePairing();
    if (await change('api/restart', {service: id}, `${id === 'spotify' ? 'Spotify' : 'YouTube'} restart requested`)) {
      restartUntil[id] = Date.now() + 5000;
      render();
      setTimeout(render, 5100);
    }
  });
}

function renderPlayers() {
  for (const id of ['spotify', 'youtube']) {
    const player = current?.players?.find(p => p.id === id);
    const service = current?.services.find(s => s.id === id);
    const available = connected && service?.active === 'active' && !service.error && Date.now() >= restartUntil[id] && player?.available;
    const capabilities = available ? player.capabilities || [] : [];
    const can = action => capabilities.includes(action);
    renderMedia(id, player, available);
    renderUpNext(id, player, available);
    const playback = $(id + '-playback');
    playback.dataset.action = player?.paused ? 'play' : 'pause';
    setIconButton(playback, player?.active && !player.paused ? 'pause' : 'play', `${player?.active && !player.paused ? 'Pause' : 'Play'} ${id === 'spotify' ? 'Spotify' : 'YouTube'}`);
    setControlDisabled(playback, !can(playback.dataset.action));
    for (const action of ['previous', 'next']) {
      const button = $(id + '-' + action);
      setControlDisabled(button, !can(action));
      button.title = !available ? 'Player unavailable' : id === 'youtube' && !can(action)
        ? (action === 'next' ? 'No next video available yet' : 'No previous video available yet')
        : `${action === 'next' ? 'Next' : 'Previous'} ${id === 'spotify' ? 'track' : 'video'} (Shift + ${action === 'next' ? '→' : '←'})`;
    }
    const slider = $(id + '-volume');
    setControlDisabled(slider, !can('volume'));
    if (!playerDragging.has(id)) {
      const known = player?.available && Number.isInteger(player.volume);
      slider.value = known ? player.volume : 0;
      slider.style.setProperty('--position', `${slider.value}%`);
      slider.setAttribute('aria-valuetext', known ? `${player.volume} percent` : 'Unavailable');
      $(id + '-volume-value').textContent = known ? `${player.volume}%` : '—';
    }

  }
}

for (const button of document.querySelectorAll('[data-player]')) {
  button.addEventListener('click', () => change('api/player', {player: button.dataset.player, action: button.dataset.action}, null));
}
for (const id of ['spotify', 'youtube']) {
  const slider = $(id + '-volume');
  slider.addEventListener('input', () => {
    playerDragging.add(id);
    $(id + '-volume-value').textContent = `${slider.value}%`;
    slider.style.setProperty('--position', `${slider.value}%`);
    slider.setAttribute('aria-valuetext', `${slider.value} percent`);
  });
  slider.addEventListener('change', async () => {
    const volume = Number(slider.value);
    playerDragging.delete(id);
    if (await change('api/player', {player: id, action: 'volume', volume}, `${id === 'spotify' ? 'Spotify' : 'YouTube'} volume set to ${volume}%`)) {
      const player = current?.players?.find(p => p.id === id);
      if (player) player.volume = volume;
      render();
    }
  });
}

// Preview the value under the pointer without changing the slider or audio.
for (const slider of document.querySelectorAll('.slider-row input[type=range]')) {
  const tooltip = slider.nextElementSibling;
  const hide = () => { tooltip.hidden = true; };
  const show = clientX => {
    if (slider.disabled) { hide(); return; }
    const rect = slider.getBoundingClientRect();
    // Native range values run between the thumb's centers at either end.
    const inset = parseFloat(getComputedStyle(slider).getPropertyValue('--thumb-size')) / 2;
    const travel = Math.max(1, rect.width - 2 * inset);
    const min = Number(slider.min), max = Number(slider.max), step = Number(slider.step);
    const fraction = clientX === undefined ? (Number(slider.value) - min) / (max - min)
      : Math.max(0, Math.min(1, (clientX - rect.left - inset) / travel));
    const value = Math.max(min, Math.min(max, min + Math.round(fraction * (max - min) / step) * step));
    tooltip.textContent = slider.classList.contains('seek') ? formatTime(value * 1000) : `${value}%`;
    tooltip.style.left = `${inset + (value - min) / (max - min) * travel}px`;
    tooltip.hidden = false;
  };
  slider.addEventListener('pointerenter', event => show(event.clientX));
  slider.addEventListener('pointermove', event => show(event.clientX));
  slider.addEventListener('pointerleave', hide);
  slider.addEventListener('pointercancel', hide);
  slider.addEventListener('pointerup', event => { if (event.pointerType !== 'mouse') hide(); });
  slider.addEventListener('focus', () => show());
  slider.addEventListener('input', () => show());
  slider.addEventListener('blur', hide);
  slider.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
}

function closeEvents() {
  if (events) events.close();
  events = null;
  clearTimeout(staleTimer);
  clearTimeout(spectrumTimer);
}
function expireBackgroundConnection() {
  closeEvents();
  connected = false;
}
function watchStateFreshness() {
  clearTimeout(staleTimer);
  if (!document.hidden && lastStateAt !== null) {
    staleTimer = setTimeout(() => connection(false), Math.max(0, stateFreshMs - (Date.now() - lastStateAt)));
  }
}
function connect(quiet = false) {
  closeEvents();
  if (document.hidden) { connected = false; return; }
  connection(false, undefined, quiet);
  const source = new EventSource(!visualizerEnabled || reducedMotion.matches ? 'api/events?spectrum=0' : 'api/events');
  events = source;
  source.addEventListener('spectrum', event => {
    if (!visualizerEnabled || events !== source || document.hidden) return;
    try { renderSpectrum(JSON.parse(event.data)); } catch { renderSpectrum(); }
    clearTimeout(spectrumTimer);
    spectrumTimer = setTimeout(renderSpectrum, 1000);
  });
  source.onmessage = event => {
    if (events !== source) return;
    // Check elapsed time as well as the timer: background timers can be delayed.
    if (document.hidden && hiddenSince !== null && Date.now() - hiddenSince >= backgroundGraceMs) {
      expireBackgroundConnection(); return;
    }
    try { current = JSON.parse(event.data); }
    catch { if (document.hidden) connected = false; else connection(false); return; }
    lastStateAt = Date.now();
    if (document.hidden) { connected = true; return; }
    watchStateFreshness();
    connection(true);
  };
  source.onerror = () => {
    if (events !== source) return;
    if (document.hidden) connected = false;
    else connection(false);
  };
}
function pageVisibility() {
  clearTimeout(backgroundTimer);
  if (document.hidden) {
    hiddenSince = Date.now();
    clearTimeout(staleTimer);
    clearTimeout(spectrumTimer);
    clearTimeout(connectionTimer);
    connectionPending = false;
    connectionGrace = false;
    dragging = false;
    playerDragging.clear();
    seekDragging.clear();
    for (const id of ['spotify', 'youtube']) {
      titleAnimations.get(id)?.animation?.pause();
      noteMotions.get(id)?.animation?.pause();
      $(id + '-spectrum').dataset.frozen = 'true';
    }
    backgroundTimer = setTimeout(expireBackgroundConnection, backgroundGraceMs);
    return;
  }
  const expired = hiddenSince !== null && Date.now() - hiddenSince >= backgroundGraceMs;
  hiddenSince = null;
  if (!expired && events && connected && lastStateAt !== null && Date.now() - lastStateAt < stateFreshMs) {
    watchStateFreshness();
    connection(true);
  } else connect(true);
  for (const id of ['spotify', 'youtube']) {
    noteMotions.get(id)?.animation?.play();
    const box = $(id + '-track-box');
    if (!box.matches(':hover, :focus-within')) titleAnimations.get(id)?.animation?.play();
  }
}
document.addEventListener('visibilitychange', pageVisibility);
reducedMotion.addEventListener('change', () => connect());
initPlayerUI();
connect();
