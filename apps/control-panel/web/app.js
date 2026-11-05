'use strict';
const $ = id => document.getElementById(id);
let current = null, connected = false, busy = false, dragging = false, events = null, noticeTimer, staleTimer;
const playerDragging = new Set();
const restartUntil = {spotify: 0, youtube: 0};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let spectrumTimer;
const spectrumBars = Object.fromEntries(['spotify', 'youtube'].map(id => {
  const bars = Array.from({length: 48}, (_, index) => {
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
  const now = performance.now(), seconds = Math.max(0, Math.min(1, (now - lastSpectrumAt) / 1000));
  lastSpectrumAt = now;
  for (const id of ['spotify', 'youtube']) {
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
  if (typeof actionKind !== 'undefined' && actionKind === 'link' && !$('youtube-panel').hidden) {
    const feedback = $('youtube-action-feedback');
    feedback.textContent = message;
    feedback.className = `action-feedback${error ? ' error' : ''}`;
    feedback.hidden = false;
    return;
  }
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').className = error ? 'notice error' : 'notice';
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 10000 : 5000);
}

function connection(online, label) {
  if (connected && !online) freezeTimelines();
  connected = online;
  $('connection').className = `connection ${online ? 'online' : 'offline'}`;
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
  setControlDisabled($('youtube-load'), !canLoad);
  renderPairing();
  if (typeof renderShell === 'function') renderShell();
}

$('youtube-link-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('youtube-url');
  const url = input.value.trim();
  if (input.disabled || !url) return;
  hidePairing();
  if (await change('api/player', {player: 'youtube', action: 'load', url}, 'Video sent to RaspPi')) {
    input.value = '';
  }
});

function renderPairing() {
  const valid = Boolean(pairingCode) && Date.now() < pairingExpiresAt;
  const service = current?.services.find(s => s.id === 'youtube');
  const ready = connected && service?.active === 'active' && !service.error && Date.now() >= restartUntil.youtube;
  $('pairing-code').textContent = valid ? pairingCode.match(/.{3}/g).join(' ') : '';
  $('pairing-code').hidden = !valid;
  $('pairing-placeholder').hidden = !pairingBusy;
  $('pairing-result').setAttribute('aria-busy', String(pairingBusy));
  $('youtube-pair').hidden = valid || pairingBusy;
  setControlDisabled($('youtube-pair'), !ready || Date.now() < pairingRetryAt);
  $('pairing-status').textContent = valid ? 'YouTube on your phone → Cast → Link with TV code' : pairingBusy ? 'Getting your TV code…' : !ready ? 'YouTube must be connected and running to get a code.' : pairingError || 'Code expired. Retry to get a new code.';
  $('pairing-status').className = pairingError && !valid && !pairingBusy ? 'hint error' : 'hint';
}
async function requestPairing() {
  if (pairingCode && Date.now() < pairingExpiresAt) { renderPairing(); return; }
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
    // Memory only: reopening the field can reuse a recent code without interrupting playback.
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
    const playback = $(id + '-playback');
    playback.dataset.action = player?.paused ? 'play' : 'pause';
    setIconButton(playback, player?.active && !player.paused ? 'pause' : 'play', `${player?.active && !player.paused ? 'Pause' : 'Play'} ${id === 'spotify' ? 'Spotify' : 'YouTube'}`);
    setControlDisabled(playback, !can(playback.dataset.action));
    for (const action of ['previous', 'next']) {
      const button = $(id + '-' + action);
      setControlDisabled(button, !can(action));
      button.title = id === 'youtube' && !capabilities.includes(action) ? 'YouTube has not exposed a queue to skip through' : `${action === 'next' ? 'Next' : 'Previous'} ${id === 'spotify' ? 'track' : 'video'}`;
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
  button.addEventListener('click', () => change('api/player', {player: button.dataset.player, action: button.dataset.action}, ['mute', 'unmute'].includes(button.dataset.action) ? null : 'Playback command sent'));
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

function connect() {
  if (events) events.close();
  clearTimeout(staleTimer);
  clearTimeout(spectrumTimer);
  renderSpectrum();
  if (document.hidden) { events = null; connection(false, 'Updates paused'); return; }
  connection(false);
  const source = new EventSource(reducedMotion.matches ? 'api/events?spectrum=0' : 'api/events');
  events = source;
  source.addEventListener('spectrum', event => {
    if (events !== source || document.hidden) return;
    try { renderSpectrum(JSON.parse(event.data)); } catch { renderSpectrum(); }
    clearTimeout(spectrumTimer);
    spectrumTimer = setTimeout(renderSpectrum, 1000);
  });
  source.onmessage = event => {
    if (events !== source || document.hidden) return;
    try { current = JSON.parse(event.data); } catch { connection(false); return; }
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => connection(false), 16000);
    connection(true);
  };
  source.onerror = () => { if (events === source && !document.hidden) connection(false); };
}
document.addEventListener('visibilitychange', connect);
reducedMotion.addEventListener('change', connect);
initPlayerUI();
connect();
