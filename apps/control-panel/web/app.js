'use strict';
const $ = id => document.getElementById(id);
let current = null, connected = false, busy = false, dragging = false, events = null, noticeTimer, staleTimer;
const playerDragging = new Set();
const restartUntil = {spotify: 0, youtube: 0};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let spectrumTimer;
const spectrumBars = Object.fromEntries(['spotify', 'youtube'].map(id => {
  const bars = Array.from({length: 24}, () => document.createElement('span'));
  $(id + '-spectrum').append(...bars);
  return [id, bars];
}));

function renderSpectrum(frame = {}) {
  for (const id of ['spotify', 'youtube']) {
    const value = frame[id];
    const live = !reducedMotion.matches && value?.status === 'live' && value.bands?.length === 24;
    $(id + '-spectrum').classList.toggle('is-live', live);
    spectrumBars[id].forEach((bar, index) => {
      const level = live && Number.isFinite(value.bands[index]) ? value.bands[index] : 0;
      bar.style.transform = `scaleY(${Math.max(.045, Math.min(1, level / 100))})`;
    });
  }
}

let pairingBusy = false, pairingTimer, pairingRetryAt = 0;

function hidePairing() {
  clearTimeout(pairingTimer);
  $('pairing-code').textContent = '';
  $('pairing-result').hidden = true;
}

function notice(message, error = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').className = error ? 'notice error' : 'notice';
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 10000 : 5000);
}

function connection(online) {
  connected = online;
  $('connection').className = `connection ${online ? 'online' : 'offline'}`;
  $('connection-text').textContent = online ? 'Connected' : 'Reconnecting';
  if (!online) { $('updated').textContent = 'Connection lost · controls paused'; renderSpectrum(); }
  render();
}

function render() {
  const audio = current?.audio;
  const ready = connected && Boolean(audio?.available);
  $('volume').disabled = !ready || busy;
  $('mute').disabled = !ready || busy;
  $('audio-status').textContent = !connected ? 'Offline' : audio?.available ? 'Connected' : 'Unavailable';
  $('audio-status').className = `badge ${!connected ? 'neutral' : audio?.available ? '' : 'warning'}`;
  if (!dragging) {
    $('volume-value').textContent = audio?.available ? audio.volume : '—';
    $('volume').value = Math.min(100, audio?.volume || 0);
    $('volume').style.setProperty('--position', `${$('volume').value}%`);
    $('volume').setAttribute('aria-valuetext', ready ? `${audio.volume} percent` : 'Unavailable');
  }
  $('audio-status').hidden = ready;
  $('mute').textContent = audio?.muted ? 'Unmute' : 'Mute';
  $('mute').setAttribute('aria-pressed', String(Boolean(audio?.muted)));
  $('volume-note').textContent = !connected ? 'Reconnecting to your Pi. Controls will return automatically.' : !audio?.available ? (audio?.error || 'Waiting for audio state…') : audio.volume > 100 ? 'Saved volume is above 100%. This control sets 0–100%.' : '';
  $('volume-note').hidden = !$('volume-note').textContent;

  for (const id of ['spotify', 'youtube']) {
    const service = current?.services.find(s => s.id === id);
    const player = current?.players?.find(p => p.id === id);
    let label = 'Unknown', style = 'neutral', detail = '';
    if (!connected) { label = 'Offline'; }
    else if (Date.now() < restartUntil[id]) { label = 'Restarting'; style = 'warning'; }
    else if (service && !service.error) {
      if (service.active === 'active') {
        if (player?.available) { label = player.active ? (player.paused ? 'Paused' : 'Playing') : 'Ready'; style = player.active && !player.paused ? '' : 'neutral'; }
        else { label = 'Unavailable'; style = 'warning'; detail = player?.error || 'Waiting for the player'; }
      } else if (['activating', 'deactivating', 'reloading'].includes(service.active)) { label = 'Starting'; style = 'warning'; }
      else if (service.active === 'failed') { label = 'Failed'; style = 'error'; detail = 'Open Service controls below to restart'; }
      else { label = 'Stopped'; detail = 'Open Service controls below to restart'; }
    } else { detail = service?.error || 'Service status unavailable'; }
    $(id + '-status').textContent = label;
    $(id + '-status').className = `badge ${style}`;
    $(id + '-detail').textContent = detail;
    $(id + '-detail').hidden = !detail;
    $(id + '-restart').disabled = !connected || busy || !service || Boolean(service.error) || Date.now() < restartUntil[id];
  }
  renderPlayers();
  const youtube = current?.services.find(s => s.id === 'youtube');
  const youtubePlayer = current?.players?.find(p => p.id === 'youtube');
  const canLoad = connected && !busy && youtube?.active === 'active' && !youtube.error && Date.now() >= restartUntil.youtube && youtubePlayer?.available && youtubePlayer.capabilities?.includes('load');
  $('youtube-url').disabled = !canLoad;
  $('youtube-load').disabled = !canLoad;
  $('youtube-pair').disabled = !connected || busy || youtube?.active !== 'active' || Boolean(youtube?.error) || Date.now() < pairingRetryAt;
  $('youtube-pair').textContent = pairingBusy ? 'Getting code…' : 'Get TV code';
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

$('youtube-pair').addEventListener('click', async () => {
  if (busy || !connected) return;
  hidePairing();
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
    $('pairing-code').textContent = result.code.match(/.{3}/g).join(' ');
    $('pairing-result').hidden = false;
    // Keep codes out of storage and hide them after five minutes or a restart.
    pairingTimer = setTimeout(hidePairing, 5 * 60 * 1000);
  } catch (error) {
    notice(error.name === 'TimeoutError' ? 'YouTube took too long to show a code. Wait a moment and try again.' : error.message || 'Connection lost. Try again.', true);
  } finally {
    pairingBusy = false; busy = false; render();
    setTimeout(render, Math.max(0, pairingRetryAt - Date.now()) + 50);
  }
});
$('pairing-hide').addEventListener('click', hidePairing);

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
    notice(message);
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
  if (await change('api/mute', {muted}, muted ? 'Output muted' : 'Output unmuted')) {
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
    const can = action => !busy && capabilities.includes(action);
    const track = $(id + '-track');
    track.textContent = !connected ? 'Waiting for connection' : player?.title || (player?.active ? 'Title unavailable' : id === 'spotify' ? 'Choose RaspPi in Spotify to start listening' : 'Paste a link below or cast from your phone');
    track.hidden = connected && !available;
    track.classList.toggle('is-idle', !player?.active);
    track.title = player?.title || '';
    if (id === 'spotify') {
      const artist = $('spotify-artist');
      artist.textContent = available && player.active ? player.artist || '' : '';
      artist.title = artist.textContent;
      artist.hidden = !artist.textContent;
      track.parentElement.classList.toggle('has-artist', !artist.hidden);
    }
    const playback = $(id + '-playback');
    playback.dataset.action = player?.paused ? 'play' : 'pause';
    playback.textContent = player?.active && !player.paused ? 'Pause' : 'Play';
    playback.disabled = !can(playback.dataset.action);
    for (const action of ['previous', 'next']) {
      const button = $(id + '-' + action);
      button.disabled = !can(action);
      button.title = id === 'youtube' && !capabilities.includes(action) ? 'YouTube has not exposed a queue to skip through' : '';
    }
    const slider = $(id + '-volume');
    slider.disabled = !can('volume');
    if (!playerDragging.has(id)) {
      const known = available && Number.isInteger(player.volume);
      slider.value = known ? player.volume : 0;
      slider.style.setProperty('--position', `${slider.value}%`);
      slider.setAttribute('aria-valuetext', known ? `${player.volume} percent` : 'Unavailable');
      $(id + '-volume-value').textContent = known ? `${player.volume}%` : '—';
    }
    $(id + '-player-note').textContent = available && player.muted ? 'Muted in YouTube · unmute from the YouTube app' : '';
    $(id + '-player-note').hidden = !$(id + '-player-note').textContent;
  }
}

for (const button of document.querySelectorAll('[data-player]')) {
  button.addEventListener('click', () => change('api/player', {player: button.dataset.player, action: button.dataset.action}, 'Playback command sent'));
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
    tooltip.textContent = `${value}%`;
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
  if (document.hidden) { events = null; connected = false; render(); return; }
  connection(false);
  events = new EventSource(reducedMotion.matches ? 'api/events?spectrum=0' : 'api/events');
  events.addEventListener('spectrum', event => {
    try { renderSpectrum(JSON.parse(event.data)); } catch { renderSpectrum(); }
    clearTimeout(spectrumTimer);
    spectrumTimer = setTimeout(renderSpectrum, 1000);
  });
  events.onmessage = event => {
    try { current = JSON.parse(event.data); } catch { connection(false); return; }
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => connection(false), 16000);
    connection(true);
    $('updated').textContent = `Updated ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
  };
  events.onerror = () => { dragging = false; playerDragging.clear(); connection(false); };
}
document.addEventListener('visibilitychange', connect);
reducedMotion.addEventListener('change', connect);
connect();
