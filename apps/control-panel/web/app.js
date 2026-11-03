'use strict';
const $ = id => document.getElementById(id);
let current = null, connected = false, busy = false, dragging = false, events = null, noticeTimer, staleTimer;
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
  const youtube = current?.services.find(s => s.id === 'youtube');
  $('youtube-pair').disabled = !connected || busy || youtube?.active !== 'active' || Boolean(youtube?.error) || Date.now() < pairingRetryAt;
  $('youtube-pair').textContent = pairingBusy ? 'Getting code…' : 'Link phone';
}

$('youtube-pair').addEventListener('click', async () => {
  if (busy || !connected) return;
  hidePairing();
  pairingBusy = true; busy = true; render();
  pairingRetryAt = Date.now() + 15000;
  try {
    const response = await fetch('/api/youtube/pairing', {
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
  if (await change('/api/volume', {volume}, `Volume set to ${volume}%`)) {
    if (current?.audio) current.audio.volume = volume;
    render();
  }
});
$('mute').addEventListener('click', async () => {
  const muted = !current?.audio.muted;
  if (await change('/api/mute', {muted}, muted ? 'Output muted' : 'Output unmuted')) {
    if (current?.audio) current.audio.muted = muted;
    render();
  }
});
for (const button of document.querySelectorAll('[data-service]')) {
  button.addEventListener('click', async () => {
    const id = button.dataset.service;
    if (id === 'youtube') hidePairing();
    if (await change('/api/restart', {service: id}, `${id === 'spotify' ? 'Spotify' : 'YouTube'} restart requested`)) {
      restartUntil[id] = Date.now() + 5000;
      render();
      setTimeout(render, 5100);
    }
  });
}

function connect() {
  if (events) events.close();
  clearTimeout(staleTimer);
  if (document.hidden) { events = null; connected = false; render(); return; }
  connection(false);
  events = new EventSource('/api/events');
  events.onmessage = event => {
    try { current = JSON.parse(event.data); } catch { connection(false); return; }
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => connection(false), 16000);
    connection(true);
    $('updated').textContent = `Updated ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
  };
  events.onerror = () => { dragging = false; connection(false); };
}
document.addEventListener('visibilitychange', connect);
connect();
