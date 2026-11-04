'use strict';
const $ = id => document.getElementById(id);
let current = null, connected = false, busy = false, dragging = false, events = null, noticeTimer, staleTimer;
const playerDragging = new Set();
const restartUntil = {spotify: 0, youtube: 0};
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
  if (!online) $('updated').textContent = 'Connection lost · controls paused';
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
  $('muted-label').hidden = !audio?.available || !audio.muted;
  $('mute').textContent = audio?.muted ? 'Unmute output' : 'Mute output';
  $('mute').setAttribute('aria-pressed', String(Boolean(audio?.muted)));
  $('volume-note').textContent = !connected ? 'Reconnecting to your Pi. Controls will return automatically.' : !audio?.available ? (audio?.error || 'Waiting for audio state…') : audio.volume > 100 ? 'Saved volume is above 100%. This control sets 0–100%.' : 'Volume and mute are saved automatically';

  for (const id of ['spotify', 'youtube']) {
    const service = current?.services.find(s => s.id === id);
    let label = 'Unknown', style = 'neutral', detail = 'Service status unavailable';
    if (!connected) { label = 'Offline'; detail = 'Waiting for connection'; }
    else if (Date.now() < restartUntil[id]) { label = 'Restarting'; style = 'warning'; detail = 'Restart requested. Checking service…'; }
    else if (service && !service.error) {
      if (service.active === 'active') { label = 'Running'; style = ''; detail = id === 'spotify' ? 'Spotify Connect service is running' : 'YouTube receiver service is running'; }
      else if (['activating', 'deactivating', 'reloading'].includes(service.active)) { label = 'Starting / stopping'; style = 'warning'; detail = 'The app is changing state'; }
      else if (service.active === 'failed') { label = 'Failed'; style = 'error'; detail = 'The service stopped with an error. Try restarting it.'; }
      else { label = 'Stopped'; style = 'neutral'; detail = 'Restart to bring this service online'; }
    } else if (service?.error) { detail = service.error; }
    $(id + '-status').textContent = label;
    $(id + '-status').className = `badge ${style}`;
    $(id + '-detail').textContent = detail;
    $(id + '-restart').disabled = !connected || busy || !service || Boolean(service.error) || Date.now() < restartUntil[id];
  }
  renderPlayers();
  const youtube = current?.services.find(s => s.id === 'youtube');
  const youtubePlayer = current?.players?.find(p => p.id === 'youtube');
  const canLoad = connected && !busy && youtubePlayer?.available && youtubePlayer.capabilities?.includes('load');
  $('youtube-url').disabled = !canLoad;
  $('youtube-load').disabled = !canLoad;
  $('youtube-pair').disabled = !connected || busy || youtube?.active !== 'active' || Boolean(youtube?.error) || Date.now() < pairingRetryAt;
  $('youtube-pair').textContent = pairingBusy ? 'Getting code…' : 'Link phone';
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
    const available = connected && player?.available;
    const capabilities = available ? player.capabilities || [] : [];
    const can = action => !busy && capabilities.includes(action);
    $(id + '-track').textContent = !connected ? 'Waiting for connection' : !available ? (player?.error || 'Player unavailable') : player.title || (id === 'spotify' ? 'Choose RaspPi in Spotify' : 'Cast a video to RaspPi');
    const playback = $(id + '-playback');
    playback.dataset.action = player?.paused ? 'play' : 'pause';
    playback.textContent = player?.active && !player.paused ? 'Pause' : 'Play';
    playback.disabled = !can(playback.dataset.action);
    for (const action of ['previous', 'next']) $(id + '-' + action).disabled = !can(action);
    const slider = $(id + '-volume');
    slider.disabled = !can('volume');
    if (!playerDragging.has(id)) {
      const known = available && Number.isInteger(player.volume);
      slider.value = known ? player.volume : 0;
      slider.style.setProperty('--position', `${slider.value}%`);
      slider.setAttribute('aria-valuetext', known ? `${player.volume} percent` : 'Unavailable');
      $(id + '-volume-value').textContent = known ? `${player.volume}%` : '—';
    }
    $(id + '-player-note').textContent = !available ? 'Controls return when the player is available.' : player.muted ? 'Muted in YouTube. Unmute from the YouTube app.' : !player.active ? `Choose something in ${id === 'spotify' ? 'Spotify' : 'YouTube'} to enable playback controls.` : id === 'youtube' && !capabilities.includes('next') && !capabilities.includes('previous') ? 'YouTube has not exposed a playlist to skip through.' : 'Player volume is separate from the master volume.';
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
  if (document.hidden) { events = null; connected = false; render(); return; }
  connection(false);
  events = new EventSource('api/events');
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
connect();
