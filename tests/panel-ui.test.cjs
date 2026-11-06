const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// Run the real UI state handlers without a network, player, or audio device.
function ui(shell = false, visualizer = false) {
  const elements = new Map(), listeners = {}, sources = [], timers = new Map();
  let timerID = 0;
  let now = 1000;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, dataset: {}, style: {setProperty() {}}, classList: {toggle() {}, contains() { return false; }},
      children: [], textContent: '', value: '0', hidden: false, disabled: true, clientWidth: 300, scrollWidth: 300,
      handlers: {}, clicks: 0, contains(other) { return other === this; }, focus() { document.activeElement = this; }, click() { this.clicks++; for (const fn of this.handlers.click || []) fn({}); },
      dispatchEvent(event) { for (const fn of this.handlers[event.type] || []) fn(event); },
      showModal() { this.open = true; }, close() { this.open = false; for (const fn of this.handlers.close || []) fn({}); },
      getClientRects() { return [{}]; }, setPointerCapture(id) { this.capture = id; }, hasPointerCapture(id) { return this.capture === id; }, releasePointerCapture() { this.capture = null; }, append(...children) { for (const child of children) this.insertBefore(child, null); },
      insertBefore(child, before) { if (child.parentNode) child.remove(); const index = before ? this.children.indexOf(before) : this.children.length; this.children.splice(index, 0, child); child.parentNode = this; },
      remove() { if (this.parentNode) { const parent = this.parentNode; parent.children.splice(parent.children.indexOf(this), 1); this.parentNode = null; } }, addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }, setAttribute(key, value) { this[key] = value; },
      removeAttribute(key) { delete this[key]; }, matches() { return false; }
    });
    return elements.get(id);
  }
  const document = {
    hidden: false, getElementById: element, createElement: () => element(Symbol()),
    querySelector: element, querySelectorAll: () => [], addEventListener(name, fn) { (listeners[name] ||= []).push(fn); }
  };
  class EventSource {
    constructor(url) { this.url = url; this.handlers = {}; sources.push(this); }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    close() { this.closed = true; }
  }
  const context = vm.createContext({document, Event, EventSource, URLSearchParams, window: {location: {search: visualizer ? "?visualizer=1" : ""}, addEventListener() {}}, performance: {now: () => now},
    matchMedia: () => ({matches: true, addEventListener() {}}),
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {}, ResizeObserver: class { observe() {} }, setTimeout(fn, delay) { timers.set(++timerID, {fn, delay}); return timerID; }, clearTimeout(id) { timers.delete(id); }, setInterval() {}
  });
  const web = process.env.PANEL_WEB_DIR || path.join(__dirname, '../apps/control-panel/web');
  for (const name of ['player-ui.js', 'app.js', ...(shell ? ['tabbed-ui.js'] : [])]) vm.runInContext(fs.readFileSync(path.join(web, name), 'utf8'), context);
  return {element, sources, context,
    flushDelay(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); } },
    key(key, options = {}) { const event = {key, code: key === ' ' ? 'Space' : key, target: {closest: () => false}, preventDefault() { this.defaultPrevented = true; }, ...options}; for (const fn of listeners.keydown || []) fn(event); return event; },
    advance(ms) { now += ms; },
    visibility(hidden) { document.hidden = hidden; listeners.visibilitychange.forEach(fn => fn()); },
    receive(state, source = sources.at(-1)) { source.onmessage({data: JSON.stringify(state)}); }
  };
}
function snapshot() {
  return {audio: {available: true, volume: 73}, services: ['spotify', 'youtube'].map(id => ({id, active: 'active'})),
    players: ['spotify', 'youtube'].map(id => ({id, available: true, active: true, paused: false,
      volume: 65, title: 'Current title', artist: 'Current artist', artwork_url: 'https://i.scdn.co/image/example',
      track_id: 'spotify:track:example', video_id: 'abcdefghijk', position_ms: 60000, duration_ms: 240000,
      capabilities: ['volume', 'mute', 'seek', 'pause', 'load']}))};
}
test('tab switches retain media and pause controls until a fresh snapshot arrives', () => {
  const page = ui();
  assert.equal(page.element('connection-text').textContent, 'Connecting');
  assert.equal(page.element('volume-note').textContent, '');
  page.receive(snapshot()); page.advance(2000);
  page.visibility(true);
  assert.equal(page.sources[0].closed, true);
  assert.equal(page.element('connection-text').textContent, 'Updates paused');
  for (const id of ['spotify', 'youtube']) {
    assert.equal(page.element(id + '-track').textContent, 'Current title');
    assert.equal(page.element(id + '-artist').textContent, 'Current artist');
    assert.equal(page.element(id + '-artwork').dataset.url, 'https://i.scdn.co/image/example');
    assert.equal(page.element(id + '-volume').value, 65);
    assert.equal(page.element(id + '-seek').value, '62');
    assert.equal(page.element(id + '-seek').disabled, true);
    assert.equal(page.element(id + '-mute').disabled, true);
  }
  page.advance(30000); page.visibility(false);
  assert.equal(page.element('connection-text').textContent, 'Reconnecting');
  assert.equal(page.element('spotify-seek').value, '62');
  assert.equal(page.element('volume').disabled, true);
  const fresh = snapshot(); fresh.players[0].position_ms = 95000;
  page.receive(fresh);
  assert.equal(page.element('connection-text').textContent, 'Connected');
  assert.equal(page.element('spotify-seek').value, '95');
  assert.equal(page.element('volume').disabled, false);
});
test('disconnect reports once and late events from a closed stream cannot change the UI', () => {
  const page = ui(); page.receive(snapshot());
  const old = page.sources[0];
  page.visibility(true); page.visibility(false);
  page.receive(snapshot()); old.onerror();
  const stale = snapshot(); stale.audio.volume = 1;
  page.receive(stale, old);
  assert.equal(page.element('connection-text').textContent, 'Connected');
  assert.equal(page.element('volume-value').textContent, 73);
  page.sources.at(-1).onerror();
  assert.equal(page.element('connection-text').textContent, 'Reconnecting');
  assert.equal(page.element('volume-note').textContent, '');
  assert.equal(page.element('spotify-status').textContent, 'Playing');
  assert.equal(page.element('spotify-volume').value, 65);
  assert.equal(page.element('youtube-volume').disabled, true);
});

test('relative seeking interpolates playback, clamps boundaries, and preserves media identity', () => {
  const page = ui(); page.receive(snapshot()); page.advance(2000);
  const target = seconds => JSON.parse(vm.runInContext(`JSON.stringify(relativeSeekTarget('youtube', ${seconds}))`, page.context));
  assert.deepEqual(target(15), {player: 'youtube', action: 'seek', position_ms: 77000, media_id: 'abcdefghijk'});
  assert.equal(target(-100).position_ms, 0);
  assert.equal(target(1000).position_ms, 240000);
  const paused = snapshot(); paused.players[1].paused = true; page.receive(paused); page.advance(9000);
  assert.equal(target(15).position_ms, 75000);
  for (const patch of [{live: true}, {available: false}, {active: false}, {capabilities: []}, {duration_ms: 0}, {video_id: ''}]) {
    const state = snapshot(); Object.assign(state.players[1], patch); page.receive(state);
    assert.equal(target(15), null);
  }
  page.receive(snapshot()); page.visibility(true);
  assert.equal(target(15), null);
});
test('seek completion cannot overwrite a newly selected video', async () => {
  const page = ui(); page.receive(snapshot());
  vm.runInContext('let finishSeek; change = () => new Promise(resolve => { finishSeek = resolve; });', page.context);
  const pending = vm.runInContext("skipPlayer('youtube', 15)", page.context);
  const next = snapshot(); next.players[1].video_id = 'newvideo123'; next.players[1].position_ms = 3000;
  page.receive(next);
  vm.runInContext('finishSeek(true)', page.context); await pending;
  assert.equal(page.element('youtube-seek').value, '3');
});
test('keyboard controls select the right action and respect typing, dialogs, and disabled controls', () => {
  const page = ui(true); page.receive(snapshot());
  // Stub playback actions here; real seek request behavior is exercised separately.
  for (const action of ['playback', 'mute', 'back', 'forward', 'previous', 'next']) {
    page.element('spotify-' + action).disabled = false;
    page.element('spotify-' + action).handlers.click = [];
  }
  for (const [key, options, action] of [[' ', {}, 'playback'], ['m', {}, 'mute'], ['ArrowLeft', {}, 'back'], ['ArrowRight', {}, 'forward'], ['ArrowLeft', {shiftKey: true}, 'previous'], ['ArrowRight', {shiftKey: true}, 'next']]) {
    assert.equal(page.key(key, options).defaultPrevented, true);
    assert.equal(page.element('spotify-' + action).clicks, 1);
  }
  assert.equal(page.key(' ', {target: {closest: () => true}}).defaultPrevented, undefined);
  assert.equal(page.key('ArrowRight', {ctrlKey: true}).defaultPrevented, undefined);
  assert.equal(page.key('ArrowRight', {repeat: true}).defaultPrevented, undefined);
  page.element('spotify-forward').disabled = true;
  assert.equal(page.key('ArrowRight').defaultPrevented, undefined);
  page.key('h'); assert.equal(page.element('shortcut-help').open, true);
  assert.equal(page.key(' ').defaultPrevented, undefined);
  page.element('shortcut-help').close();
  vm.runInContext("selectPlayer('youtube')", page.context);
  assert.equal(page.element('youtube-tab')['aria-selected'], 'true');
  assert.equal(page.element('spotify-panel').hidden, true);
  page.element('youtube-playback').handlers.click = [];
  page.key(' '); assert.equal(page.element('youtube-playback').clicks, 1);
  assert.equal(page.element('spotify-playback').clicks, 1);
});

test('routine playback badges are invisible but failures remain visible', () => {
  const page = ui(); const state = snapshot();
  page.receive(state);
  assert.equal(page.element('spotify-status').style.visibility, 'hidden');
  state.players[0].paused = true; page.receive(state);
  assert.equal(page.element('spotify-status').style.visibility, 'hidden');
  state.services[0].active = 'failed'; page.receive(state);
  assert.equal(page.element('spotify-status').style.visibility, 'visible');
  assert.equal(page.element('spotify-status').textContent, 'Failed');
});

test('spectrum applies a fixed response curve, releases smoothly, and resets when playback stops', () => {
  const page = ui(false, true); page.receive(snapshot());
  vm.runInContext('reducedMotion.matches = false;', page.context);
  vm.runInContext("renderSpectrum({spotify:{status:'live',bands:Array(24).fill(80)}})", page.context);
  assert.ok(Math.abs(vm.runInContext("spectrumBars.spotify[0].level", page.context) - Math.pow(65 / 75, 1.25)) < .0001);
  page.advance(100);
  vm.runInContext("renderSpectrum({spotify:{status:'live',bands:Array(24).fill(20)}})", page.context);
  assert.ok(vm.runInContext("spectrumBars.spotify[0].level > .2", page.context));
  page.advance(500);
  vm.runInContext("renderSpectrum({spotify:{status:'live',bands:Array(24).fill(NaN)}})", page.context);
  assert.ok(vm.runInContext("Number.isFinite(spectrumBars.spotify[0].level)", page.context));
  vm.runInContext('renderSpectrum()', page.context);
  assert.equal(vm.runInContext("spectrumBars.spotify[0].level", page.context), 0);
  assert.equal(vm.runInContext("spectrumBars.spotify[0].fill.style.height", page.context), 'max(2px, 0%)');
  assert.equal(vm.runInContext("spectrumBars.spotify.length", page.context), 48);
  vm.runInContext("renderSpectrum({spotify:{status:'live',bands:[0,100,...Array(22).fill(0)]}})", page.context);
  assert.ok(Math.abs(vm.runInContext("spectrumBars.spotify[1].level", page.context) - 23 / 47) < .0001);
  vm.runInContext('renderSpectrum()', page.context);
  vm.runInContext("renderSpectrum({spotify:{status:'live',bands:Array(24).fill(10)}})", page.context);
  assert.equal(vm.runInContext("spectrumBars.spotify[0].level", page.context), 0);
  vm.runInContext("renderSpectrum({spotify:{status:'live',bands:Array(24).fill(200)}})", page.context);
  assert.equal(vm.runInContext("spectrumBars.spotify[0].level", page.context), 1);
  page.advance(500);
  vm.runInContext("renderSpectrum({spotify:{status:'live',bands:Array(24).fill(0)}})", page.context);
  assert.ok(vm.runInContext("spectrumBars.spotify[0].level < .03", page.context));
});



test('queue composer remains visible independently of phone-link help and player tabs', () => {
  const page = ui(true); page.receive(snapshot());
  page.context.fetch = () => { throw new Error('No request until pairing is selected'); };
  assert.equal(page.element('youtube-link-form').hidden, false);
  assert.equal(page.element('youtube-pairing-pane').hidden, false);
  page.element('youtube-tab').click();
  page.element('youtube-pair').handlers.pointerenter[0]({pointerType:'mouse'});
  assert.equal(page.element('pairing-info-tip').hidden, false);
  page.key('Escape');
  assert.equal(page.element('pairing-info-tip').hidden, true);
  assert.equal(page.element('youtube-link-form').hidden, false);
  vm.runInContext("notice('Invalid link', true)", page.context);
  assert.equal(page.element('youtube-action-feedback').textContent, 'Invalid link');
  page.element('spotify-tab').click();
  vm.runInContext("notice('Spotify feedback')", page.context);
  assert.equal(page.element('notice').textContent, 'Spotify feedback');
  page.element('youtube-tab').click();
});

test('phone code reserves digit positions and only fetches on request, with bounded refresh', async () => {
  const page = ui(true); page.receive(snapshot());
  let finish, requests = 0;
  page.context.AbortSignal = {timeout: () => undefined};
  page.context.fetch = () => { requests++; return new Promise(resolve => { finish = resolve; }); };
  const button = page.element('youtube-pair');
  assert.equal(page.element('pairing-code').textContent, '··· ··· ··· ···');
  assert.equal(page.element('pairing-status').textContent.includes('expired'), false);
  assert.equal(requests, 0);
  const pending = button.handlers.click[0]();
  assert.equal(requests, 1);
  assert.equal(page.element('pairing-result')['aria-busy'], 'true');
  assert.equal(page.element('pairing-code').textContent, '··· ··· ··· ···');
  await button.handlers.click[0]();
  assert.equal(requests, 1);
  finish({ok: true, json: async () => ({code: '123456789012'})});
  await pending;
  assert.equal(page.element('pairing-code').textContent, '123 456 789 012');
  assert.equal(page.element('pairing-result')['aria-busy'], 'false');
  assert.equal(button.hidden, false);
  await button.handlers.click[0]();
  assert.equal(requests, 1);
  vm.runInContext('pairingRetryAt = 0', page.context);
  const refreshed = button.handlers.click[0]();
  assert.equal(requests, 2);
  finish({ok: true, json: async () => ({code: '987654321000'})});
  await refreshed;
  assert.equal(page.element('pairing-code').textContent, '987 654 321 000');
  vm.runInContext('hidePairing()', page.context);
  assert.equal(page.element('pairing-code').textContent, '··· ··· ··· ···');
  assert.equal(page.element('youtube-link-form').hidden, false);
});

test('pairing failure offers a bounded retry; info focus never requests a code', async () => {
  const page = ui(true); page.receive(snapshot());
  page.context.AbortSignal = {timeout: () => undefined};
  let requests = 0;
  page.context.fetch = async () => { requests++; return {ok:false,json:async()=>({error:'Receiver unavailable'})}; };
  page.element('youtube-pair').handlers.focus[0]();
  assert.equal(requests, 0);
  await page.element('youtube-pair').handlers.click[0]();
  assert.equal(page.element('pairing-code').textContent, '··· ··· ··· ···');
  assert.equal(page.element('pairing-status').textContent, 'Receiver unavailable');
  assert.equal(page.element('youtube-pair').hidden, false);
  assert.equal(page.element('youtube-pair').disabled, true);
  await page.element('youtube-pair').handlers.click[0]();
  assert.equal(requests, 1);
});


test('mute request keeps available controls visually stable while blocking duplicate commands', async () => {
  const page = ui(true); page.receive(snapshot());
  page.context.AbortSignal = {timeout: () => undefined};
  let finish, requests = 0;
  page.context.fetch = () => { requests++; return new Promise(resolve => { finish = resolve; }); };
  const pending = vm.runInContext("change('api/player', {player:'youtube',action:'mute'}, null)", page.context);
  for (const id of ['spotify-playback','youtube-playback','youtube-mute','youtube-seek','youtube-back','youtube-volume','volume','youtube-url']) {
    assert.equal(page.element(id).disabled, true, id);
    assert.equal(page.element(id).dataset.pending, 'true', id);
  }
  assert.equal(page.element('youtube-previous').dataset.pending, 'false');
  assert.equal(await vm.runInContext("change('api/player', {player:'youtube',action:'mute'}, null)", page.context), false);
  assert.equal(requests, 1);
  // A new server snapshot during the pending command must retain that distinction.
  const state = snapshot(); state.players[1].muted = true; state.players[1].capabilities.push('unmute');
  page.receive(state);
  assert.equal(page.element('youtube-mute').dataset.pending, 'true');
  assert.equal(page.element('youtube-detail').hidden, true);
  assert.equal(page.element('youtube-mute')['aria-pressed'], 'true');
  finish({ok:true,json:async()=>({})}); await pending;
  assert.equal(page.element('youtube-mute').disabled, false);
  assert.equal(page.element('youtube-mute').dataset.pending, 'false');
  assert.equal(page.element('youtube-action-feedback').textContent, '');
  assert.equal(page.element('notice').textContent, '');
});

test('failed mute restores controls and keeps the error visible', async () => {
  const page = ui(true); page.receive(snapshot());
  page.context.AbortSignal = {timeout: () => undefined};
  page.context.fetch = async () => ({ok:false,json:async()=>({error:'Mute failed'})});
  assert.equal(await vm.runInContext("change('api/player', {player:'spotify',action:'mute'}, null)", page.context), false);
  assert.equal(page.element('spotify-mute').disabled, false);
  assert.equal(page.element('spotify-mute').dataset.pending, 'false');
  assert.equal(page.element('notice').textContent, 'Mute failed');
});


test('volume shortcuts target the selected player or master and respect limits and focus', async () => {
  const page = ui(true); page.receive(snapshot());
  vm.runInContext('var requests = []; change = async (path, payload) => { requests.push({path, ...payload}); return true; };', page.context);
  const requests = () => JSON.parse(vm.runInContext('JSON.stringify(requests)', page.context));
  assert.equal(page.key('ArrowUp').defaultPrevented, true);
  await new Promise(setImmediate);
  assert.deepEqual(requests().at(-1), {path: 'api/player', player: 'spotify', action: 'volume', volume: 70});
  page.key('ArrowDown', {shiftKey: true});
  await new Promise(setImmediate);
  assert.deepEqual(requests().at(-1), {path: 'api/volume', volume: 68});
  vm.runInContext("selectPlayer('youtube')", page.context);
  page.receive(snapshot());
  page.element('youtube-volume').value = 98;
  page.key('ArrowUp');
  await new Promise(setImmediate);
  assert.deepEqual(requests().at(-1), {path: 'api/player', player: 'youtube', action: 'volume', volume: 100});
  let count = requests().length;
  page.key('ArrowUp');
  assert.equal(requests().length, count);
  page.element('youtube-volume').value = 2;
  page.key('ArrowDown');
  await new Promise(setImmediate);
  assert.equal(requests().at(-1).volume, 0);
  count = requests().length;
  for (const options of [{target: {closest: () => true}}, {ctrlKey: true}, {repeat: true}]) {
    assert.equal(page.key('ArrowUp', options).defaultPrevented, undefined);
  }
  page.element('youtube-volume').disabled = true;
  assert.equal(page.key('ArrowUp').defaultPrevented, undefined);
  page.element('settings-drawer').open = true;
  assert.equal(page.key('ArrowDown', {shiftKey: true}).defaultPrevented, undefined);
  assert.equal(requests().length, count);
});

test('YouTube composer only enqueues, including Enter submission, and enforces capacity', async () => {
  const page = ui(true), state = snapshot();
  const youtube = state.players.find(p => p.id === 'youtube');
  youtube.capabilities.push('enqueue', 'autoplay', 'clearqueue');
  youtube.queue_count = 2; youtube.autoplay = true;
  page.receive(state);
  vm.runInContext('var requests = []; change = async (path, payload) => { requests.push(payload); return true; };', page.context);
  assert.equal(page.element('youtube-autoplay')['aria-checked'], 'true');
  const form = page.element('youtube-link-form');
  for (const action of [undefined, 'enqueue']) {
    page.element('youtube-url').value = 'https://youtu.be/abcdefghijk';
    await form.handlers.submit[0]({preventDefault() {}, submitter: {value: action}});
    assert.equal(vm.runInContext('requests.at(-1).action', page.context), 'enqueue');
    assert.equal(page.element('youtube-url').value, '');
  }
  page.element('youtube-autoplay').click();
  assert.equal(vm.runInContext('requests.at(-1).enabled', page.context), false);
  page.element('youtube-clearqueue').click();
  assert.equal(vm.runInContext('requests.at(-1).action', page.context), 'clearqueue');
  youtube.queue_count = 50; page.receive(state);
  assert.equal(page.element('youtube-enqueue').disabled, true);
  page.element('youtube-url').value = 'https://youtu.be/abcdefghijk';
  const count = vm.runInContext('requests.length', page.context);
  await form.handlers.submit[0]({preventDefault() {}, submitter: {value: 'enqueue'}});
  assert.equal(vm.runInContext('requests.length', page.context), count);
});

test('shared Up next prioritizes queued videos without mixing recommendations into the queue', () => {
  const page = ui(true), state = snapshot();
  const youtube = state.players.find(p => p.id === 'youtube');
  youtube.capabilities.push('enqueue', 'autoplay', 'clearqueue', 'removequeue');
  youtube.autoplay = true;
  youtube.recommendation = {video_id: 'ccccccccccc', title: 'Recommended next'};
  youtube.queue = [{id: '00000000-0000-4000-8000-000000000001', video_id: 'aaaaaaaaaaa', title: '<strong>Real title</strong>'}];
  youtube.queue_count = 1;
  page.receive(state);
  const list = page.element('youtube-queue-list'), row = list.children[0];
  assert.equal(list.children.length, 1);
  assert.equal(page.element('youtube-up-next-title').textContent, '<strong>Real title</strong>');
  assert.equal(page.element('youtube-up-next-detail').textContent, 'Next · From your queue');
  assert.equal(page.element('youtube-recommendation-row').hidden, true);
  assert.equal(row.children[1].children[1].children[1].textContent, 'Next');
  assert.equal(row.children[1].children[1].children[0].textContent, '<strong>Real title</strong>');
  page.receive(state); assert.equal(list.children[0], row);
  vm.runInContext('var requests = []; change = async (path, payload) => { requests.push(payload); return true; };', page.context);
  row.children[2].click();
  assert.equal(vm.runInContext('requests.at(-1).queue_id', page.context), youtube.queue[0].id);
  youtube.queue = []; youtube.queue_count = 0; page.receive(state);
  assert.equal(list.children.length, 0);
  assert.equal(page.element('youtube-up-next-title').textContent, 'Recommended next');
  assert.equal(page.element('youtube-up-next-detail').textContent, 'Next · YouTube recommendation');
  assert.equal(page.element('youtube-recommendation-row').hidden, false);
  assert.equal(page.element('youtube-queue-empty').hidden, true);
  youtube.autoplay = false; page.receive(state);
  assert.equal(list.children.length, 0);
  assert.equal(page.element('youtube-up-next-title').textContent, 'Nothing queued');
  assert.equal(page.element('youtube-up-next-artwork').hidden, true);
  youtube.autoplay = true; youtube.recommendation = null; youtube.autoplay_pending = true; page.receive(state);
  assert.equal(page.element('youtube-up-next')['aria-busy'], 'true');
  assert.equal(page.element('youtube-up-next-title').textContent, 'Finding a recommendation…');
  assert.equal(list.children.length, 0);
  youtube.autoplay_pending = false; page.receive(state);
  assert.equal(page.element('youtube-up-next')['aria-busy'], 'false');
});


test('Spotify Up next updates metadata and clears old artwork when the next track becomes unknown', () => {
  const page = ui(true), state = snapshot();
  const spotify = state.players[0];
  spotify.next_track = {title: 'Another track', artist: 'Another artist', artwork_url: 'https://i.scdn.co/image/next'};
  page.receive(state);
  assert.equal(page.element('spotify-up-next-title').textContent, 'Another track');
  assert.equal(page.element('spotify-up-next-detail').textContent, 'Next · Another artist');
  const image = page.element('spotify-up-next-artwork');
  image.handlers.load[0]();
  assert.equal(image.hidden, false);
  page.receive(state);
  assert.equal(image.hidden, false);
  page.visibility(true); page.visibility(false);
  assert.equal(page.element('spotify-up-next-title').textContent, 'Another track');
  spotify.next_track = null; page.receive(state);
  assert.equal(page.element('spotify-up-next-title').textContent, 'Nothing up next');
  assert.equal(page.element('spotify-up-next-detail').textContent, '');
  assert.equal(image.hidden, true);
  assert.equal(image.src, undefined);
});


test('YouTube navigation buttons and Shift-arrow shortcuts follow receiver capabilities', () => {
  const page = ui(true), state = snapshot(), youtube = state.players[1];
  youtube.capabilities.push('next', 'previous'); page.receive(state);
  vm.runInContext("selectPlayer('youtube')", page.context);
  assert.equal(page.element('youtube-next').disabled, false);
  assert.equal(page.element('youtube-previous').disabled, false);
  assert.equal(page.key('ArrowRight', {shiftKey: true}).defaultPrevented, true);
  assert.equal(page.key('ArrowLeft', {shiftKey: true}).defaultPrevented, true);
  assert.equal(page.element('youtube-next').clicks, 1);
  assert.equal(page.element('youtube-previous').clicks, 1);
  youtube.capabilities = []; page.receive(state);
  assert.equal(page.key('ArrowRight', {shiftKey: true}).defaultPrevented, undefined);
  assert.equal(page.element('youtube-previous').title, 'No previous video available yet');
});

test('cover connection cue is delayed, survives repeated errors, and clears on recovery', () => {
  const page = ui(); page.receive(snapshot());
  const cover = page.element('spotify-cover');
  const image = page.element('spotify-artwork');
  image.currentSrc = image.dataset.url; image.dispatchEvent({type: 'load'});
  page.sources.at(-1).onerror();
  assert.equal(cover.dataset.connecting, 'false');
  page.receive(snapshot()); page.flushDelay(250);
  assert.equal(cover.dataset.connecting, 'false', 'a short disconnect never shows the cue');
  page.sources.at(-1).onerror(); page.sources.at(-1).onerror();
  page.flushDelay(250);
  assert.equal(cover.dataset.connecting, 'true');
  assert.equal(page.element('spotify-spectrum').dataset.frozen, 'true');
  assert.equal(page.element('spotify-track').textContent, 'Current title');
  assert.equal(page.element('spotify-artwork').dataset.url, 'https://i.scdn.co/image/example');
  page.receive(snapshot());
  assert.equal(cover.dataset.connecting, 'false');
  assert.equal(page.element('spotify-spectrum').dataset.frozen, 'false');
  page.sources.at(-1).onerror(); page.visibility(true); page.flushDelay(250);
  assert.equal(cover.dataset.connecting, 'false', 'hidden tabs do not animate');
});

test('disconnected spectrum retains its last levels until fresh state returns', () => {
  const page = ui(false, true); page.receive(snapshot());
  vm.runInContext("reducedMotion.matches = false; renderSpectrum({spotify:{status:'live',bands:Array(24).fill(80)}})", page.context);
  const height = vm.runInContext('spectrumBars.spotify[0].fill.style.height', page.context);
  page.sources.at(-1).onerror();
  vm.runInContext('renderSpectrum()', page.context);
  assert.equal(vm.runInContext('spectrumBars.spotify[0].fill.style.height', page.context), height);
  page.receive(snapshot());
  vm.runInContext('renderSpectrum()', page.context);
  assert.equal(vm.runInContext('spectrumBars.spotify[0].level', page.context), 0);
});

test('empty covers animate immediately while artwork waits 250ms', () => {
  const page = ui();
  assert.equal(page.element('spotify-cover').dataset.connecting, 'true', 'initial empty cover starts immediately');
  page.receive(snapshot());
  const image = page.element('spotify-artwork');
  image.currentSrc = image.dataset.url; image.dispatchEvent({type: 'load'});
  page.sources.at(-1).onerror();
  assert.equal(page.element('spotify-cover').dataset.connecting, 'false');
  assert.equal(page.element('youtube-cover').dataset.connecting, 'true', 'unloaded artwork remains a placeholder');
  page.flushDelay(250);
  assert.equal(page.element('spotify-cover').dataset.connecting, 'true');
  page.receive(snapshot());
  image.dispatchEvent({type: 'error'});
  page.sources.at(-1).onerror();
  assert.equal(page.element('spotify-cover').dataset.connecting, 'true', 'failed artwork needs no overlay delay');
});

test('YouTube cover prefers high resolution and keeps its fallback across snapshots', () => {
  const page = ui(), state = snapshot();
  state.players[1].artwork_url = 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg';
  page.receive(state);
  const image = page.element('youtube-artwork');
  assert.equal(image.src, 'https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg');
  image.currentSrc = image.src; image.dispatchEvent({type: 'error'});
  assert.equal(image.src, 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg');
  page.receive(state);
  assert.equal(image.src, 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg');
  image.currentSrc = image.src; image.naturalWidth = 320; image.dispatchEvent({type: 'load'});
  assert.equal(image.hidden, false);
  state.players[1].artwork_url = 'https://i.ytimg.com/vi/lmnopqrstuv/hqdefault.jpg';
  page.receive(state);
  assert.equal(image.src, 'https://i.ytimg.com/vi/lmnopqrstuv/maxresdefault.jpg');
  image.currentSrc = image.src; image.naturalWidth = 120; image.dispatchEvent({type: 'load'});
  assert.equal(image.src, 'https://i.ytimg.com/vi/lmnopqrstuv/mqdefault.jpg');
  image.currentSrc = image.src; image.dispatchEvent({type: 'error'});
  assert.equal(image.hidden, true);
  assert.equal(image.dataset.fallback, '');
});

test('mobile cover controls move intact between overlay, short-screen fallback and desktop', () => {
  const page = ui(true); page.receive(snapshot());
  for (const [mobile, overlay, suffix] of [[true, true, '-cover'], [true, false, '-compact-playback-slot'], [false, false, '-cover'], [true, true, '-cover']]) {
    vm.runInContext(`mobileArtworkLayout.matches = ${mobile}; coverPlaybackLayout.matches = ${overlay}; placePlaybackControls();`, page.context);
    for (const id of ['spotify', 'youtube']) {
      const destination = page.element(id + suffix), controls = page.element(id + '-playback-controls');
      assert.equal(controls.parentNode, destination);
      assert.equal(destination.children.filter(child => child === controls).length, 1);
      assert.equal(page.element(id + '-seek').value, '60');
      assert.equal(page.element(id + '-volume').value, 65);
      assert.equal(page.element(id + '-mute').disabled, false);
    }
  }
});

test('visualizer defaults off without allocating bars or subscribing to spectrum', () => {
  const page = ui();
  assert.equal(page.element('spotify-spectrum').hidden, true);
  assert.equal(page.element('youtube-spectrum').hidden, true);
  assert.equal(vm.runInContext('spectrumBars.spotify.length', page.context), 0);
  vm.runInContext('reducedMotion.matches = false; connect();', page.context);
  assert.equal(page.sources.at(-1).url, 'api/events?spectrum=0');
  const enabled = ui(false, true);
  assert.equal(enabled.element('spotify-spectrum').hidden, false);
  assert.equal(vm.runInContext('spectrumBars.spotify.length', enabled.context), 48);
  vm.runInContext('reducedMotion.matches = false; connect();', enabled.context);
  assert.equal(enabled.sources.at(-1).url, 'api/events');
});

test('combined upcoming section stays visible when queue controls are unavailable', () => {
  const page = ui(), state = snapshot(); page.receive(state);
  assert.equal(page.element('youtube-queue').hidden, false);
  state.players[1].capabilities.push('enqueue'); page.receive(state);
  assert.equal(page.element('youtube-queue').hidden, false);
  state.players[1].capabilities = []; state.players[1].queue_count = 1; page.receive(state);
  assert.equal(page.element('youtube-queue').hidden, false);
});

test('clicking a queue row plays its entry ID without a second remove request', () => {
  const page = ui(true), state = snapshot();
  const youtube = state.players[1]; youtube.capabilities.push('playqueue', 'removequeue');
  youtube.queue = [{id: '00000000-0000-4000-8000-000000000001', video_id: 'abcdefghijk', title: 'First'}];
  youtube.queue_count = 1; page.receive(state);
  vm.runInContext('var requests = []; change = async (path, payload) => { requests.push(payload); return true; };', page.context);
  const play = page.element('youtube-queue-list').children[0].children[1];
  play.click();
  assert.equal(vm.runInContext('requests.length', page.context), 1);
  assert.equal(vm.runInContext('requests[0].action', page.context), 'playqueue');
  assert.equal(vm.runInContext('requests[0].queue_id', page.context), youtube.queue[0].id);
  youtube.queue[0].starting = true; page.receive(state); play.click();
  assert.equal(vm.runInContext('requests.length', page.context), 1);
  assert.equal(play['aria-busy'], 'true');
});

function reorderPage() {
  const page = ui(true), state = snapshot(), youtube = state.players[1];
  youtube.capabilities.push('reorderqueue', 'enqueue', 'playqueue');
  youtube.queue = ['a','b','c'].map((title, index) => ({id: `00000000-0000-4000-8000-00000000000${index+1}`, video_id: title.repeat(11), title}));
  youtube.queue_count = 3; page.receive(state);
  vm.runInContext('var requests = []; change = async (path, payload) => { requests.push(payload); return true; };', page.context);
  const list = page.element('youtube-queue-list'); list.scrollTop = 0;
  list.getBoundingClientRect = () => ({top:0, bottom:128, height:128});
  list.children.forEach((row,index) => { row.getBoundingClientRect = () => ({top:index*64-list.scrollTop, height:64}); });
  return {page,state,list,requests:()=>JSON.parse(vm.runInContext('JSON.stringify(requests)',page.context))};
}
test('reorder handle arrows move by stable ID and never invoke play or volume', async () => {
  const {page,state,list,requests} = reorderPage();
  const handle = list.children[1].children[0]; let prevented = 0, stopped = 0;
  await handle.handlers.keydown[0]({key:'ArrowUp',preventDefault(){prevented++;},stopPropagation(){stopped++;}});
  assert.equal(prevented,1); assert.equal(stopped,1);
  assert.deepEqual(requests(),[{player:'youtube',action:'reorderqueue',queue_id:state.players[1].queue[1].id,before_id:state.players[1].queue[0].id}]);
  page.flushDelay(3000); // Receiver did not acknowledge the move; allow retry.
  await handle.handlers.keydown[0]({key:'ArrowDown',preventDefault(){},stopPropagation(){}});
  assert.equal(requests()[1].before_id,'');
  state.players[1].capabilities=[];page.receive(state);
  await handle.handlers.keydown[0]({key:'ArrowUp',preventDefault(){},stopPropagation(){}});
  assert.equal(requests().length,2);
});
test('mouse and touch reorder commit only after dragging and drop, with cancellation on concurrent updates', async () => {
  for (const pointerType of ['mouse','touch']) {
    const {page,state,list,requests} = reorderPage();
    const handle = list.children[2].children[0];
    const event = y => ({pointerType,pointerId:1,button:0,clientY:y,preventDefault(){}});
    handle.handlers.pointerdown[0](event(150));
    handle.handlers.pointermove[0](event(148));
    assert.equal(requests().length,0);
    handle.handlers.pointermove[0](event(20));
    assert.equal(list.children[0].style.transform,'translateY(64px)');
    assert.equal(list.children[1].style.transform,'translateY(64px)');
    assert.equal(list.children[2].dataset.next,'true');
    assert.equal(list.children[0].dataset.next,'false');
    assert.equal(requests().length,0);
    await handle.handlers.pointerup[0](event(20));
    assert.equal(requests().length,1);
    assert.equal(requests()[0].queue_id,state.players[1].queue[2].id);
    assert.equal(requests()[0].before_id,state.players[1].queue[0].id);
    assert.equal(list.children[0].children[1].children[1].children[0].textContent,'c');
    page.flushDelay(3000);
    handle.handlers.pointerdown[0](event(150));handle.handlers.pointermove[0](event(20));
    state.players[1].queue.shift();state.players[1].queue_count=2;page.receive(state);
    await handle.handlers.pointerup[0](event(20));
    assert.equal(requests().length,1);
    assert.equal(handle.capture,null);
  }
});
test('dragging near list edge scrolls; pointer cancellation never sends a move', () => {
  const {list,requests}=reorderPage(),handle=list.children[0].children[0];
  handle.handlers.pointerdown[0]({pointerId:1,button:0,clientY:20,preventDefault(){}});
  handle.handlers.pointermove[0]({pointerId:1,clientY:150});
  assert.ok(list.scrollTop>0);
  handle.handlers.pointercancel[0]();
  handle.handlers.pointerup[0]({pointerId:1,clientY:150});
  assert.equal(requests().length,0);
});


test('queue drag preview reverses and cancellation restores order without playing', () => {
  const {page,list,requests} = reorderPage(), handle = list.children[2].children[0];
  const event = y => ({pointerId:1,button:0,clientY:y,preventDefault(){}});
  handle.handlers.pointerdown[0](event(150));
  handle.handlers.pointermove[0](event(20));
  assert.equal(list.children[0].style.transform,'translateY(64px)');
  handle.handlers.pointermove[0](event(85));
  vm.runInContext('previewQueueDrop(false)',page.context);
  assert.equal(list.children[0].style.transform,'translateY(0px)');
  assert.equal(list.children[1].style.transform,'translateY(64px)');
  assert.equal(list.children[0].dataset.next,'true');
  handle.handlers.pointercancel[0]();
  assert.ok(list.children.every(row => row.style.transform === ''));
  assert.equal(list.children[0].children[1].children[1].children[1].textContent,'Next');
  assert.equal(requests().length,0);
});

test('drop projection persists until acknowledgement and rolls back on failure', async () => {
  const {page,state,list} = reorderPage();
  const ids = state.players[1].queue.map(entry => entry.id);
  await vm.runInContext(`moveQueueEntry('${ids[2]}','${ids[0]}')`,page.context);
  assert.equal(list.children[0].children[1].children[1].children[0].textContent,'c');
  page.receive(state); // A stale snapshot must not undo the projected move.
  assert.equal(list.children[0].children[1].children[1].children[0].textContent,'c');
  state.players[1].queue.unshift(state.players[1].queue.pop()); page.receive(state);
  assert.equal(list.children[0].children[0].disabled,false);
  vm.runInContext('change = async () => false',page.context);
  await vm.runInContext(`moveQueueEntry('${ids[2]}','')`,page.context);
  assert.equal(list.children[0].children[1].children[1].children[0].textContent,'c');
  assert.equal(list.children[0].children[1].children.length,2); // Artwork and text only, no trailing play icon.
});

test('YouTube feedback expires after success but keeps errors visible', () => {
  const page = ui(true); page.receive(snapshot());
  vm.runInContext("selectPlayer('youtube'); notice('Added to queue')",page.context);
  assert.equal(page.element('youtube-action-feedback').hidden,false);
  page.flushDelay(4000);
  assert.equal(page.element('youtube-action-feedback').hidden,true);
  vm.runInContext("notice('Added to queue'); notice('Could not add video',true)",page.context);
  page.flushDelay(4000);
  assert.equal(page.element('youtube-action-feedback').hidden,false);
  assert.equal(page.element('youtube-action-feedback').textContent,'Could not add video');
});

test('YouTube Autoplay remains available in settings while Spotify is selected', () => {
  const page = ui(true), state = snapshot(), youtube = state.players[1];
  youtube.capabilities.push('autoplay'); youtube.autoplay = false;
  page.receive(state);
  page.element('settings-drawer').showModal();
  assert.equal(page.element('spotify-panel').hidden,false);
  assert.equal(page.element('youtube-autoplay').disabled,false);
  vm.runInContext('var requests = []; change = async (path,payload) => { requests.push(payload); return true; }',page.context);
  page.element('youtube-autoplay').click();
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(requests[0])',page.context)),{player:'youtube',action:'autoplay',enabled:true});
  youtube.autoplay = true; page.receive(state);
  assert.equal(page.element('youtube-autoplay')['aria-checked'],'true');
  youtube.capabilities = []; page.receive(state);
  assert.equal(page.element('youtube-autoplay').disabled,true);
  page.element('youtube-autoplay').click();
  assert.equal(vm.runInContext('requests.length',page.context),1);
});

test('settings errors appear inside the drawer instead of behind it', () => {
  const page = ui(true); page.receive(snapshot());
  vm.runInContext("selectPlayer('youtube')",page.context);
  page.element('settings-drawer').showModal();
  vm.runInContext("notice('Could not update Autoplay',true)",page.context);
  assert.equal(page.element('settings-feedback').hidden,false);
  assert.equal(page.element('settings-feedback').textContent,'Could not update Autoplay');
  assert.equal(page.element('youtube-action-feedback').textContent,'');
  page.flushDelay(4000);
  assert.equal(page.element('settings-feedback').hidden,false);
});

test('initial HTML puts controls on the cover and keeps Checking hidden before scripts run', () => {
  const html = fs.readFileSync(path.join(process.env.PANEL_WEB_DIR || path.join(__dirname, '../apps/control-panel/web'), 'index.html'), 'utf8');
  const stack = [], parents = new Map(), attrs = new Map();
  const voidTags = new Set(['meta','link','input','img','br','hr','use','path','circle','line','polygon']);
  // Inspect the shipped markup, rather than the DOM after layout relocation.
  for (const match of html.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*?)(\/?)>/gi)) {
    const [,closing,tag,attributes,selfClosing] = match;
    if (closing) { if (stack.at(-1)?.tag === tag) stack.pop(); continue; }
    const id = attributes.match(/\bid="([^"]+)"/)?.[1];
    if (id) { parents.set(id,stack.map(entry => entry.id).filter(Boolean)); attrs.set(id,attributes); }
    if (!selfClosing && !voidTags.has(tag)) stack.push({tag,id});
  }
  for (const id of ['spotify','youtube']) {
    assert.ok(parents.get(id+'-playback-controls').includes(id+'-cover'));
    assert.ok(!parents.get(id+'-playback-controls').includes(id+'-up-next'));
    assert.match(attrs.get(id+'-status'),/\bhidden\b/);
  }
});

test('Spotify next-track row invokes Next and disables when the preview or capability is unavailable', () => {
  const page = ui(true), state = snapshot(), spotify = state.players[0];
  spotify.capabilities.push('next'); spotify.next_track = {title:'Next song',artist:'Artist'};
  page.receive(state);
  vm.runInContext('var requests = []; change = async (path,payload) => { requests.push(payload); return true; }',page.context);
  const row = page.element('spotify-up-next-play');
  assert.equal(row.disabled,false); row.click();
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(requests[0])',page.context)),{player:'spotify',action:'next'});
  spotify.next_track = null; page.receive(state); assert.equal(row.disabled,true); row.click();
  spotify.next_track = {title:'Next song'}; spotify.capabilities = []; page.receive(state);
  assert.equal(row.disabled,true); row.click();
  spotify.capabilities = ['next']; page.receive(state); page.sources.at(-1).onerror();
  assert.equal(row.disabled,true); row.click();
  assert.equal(vm.runInContext('requests.length',page.context),1);
});

test('both players reuse empty-slot decorations and YouTube advances them after occupied rows', () => {
  const page = ui(true), state = snapshot(), youtube = state.players[1];
  page.receive(state);
  const spotifySlots = page.element('spotify-empty-slots'), youtubeSlots = page.element('youtube-empty-slots');
  assert.equal(spotifySlots.children.length,6);
  assert.equal(youtubeSlots.children.length,6);
  assert.equal(spotifySlots.children[0].innerHTML,youtubeSlots.children[0].innerHTML);
  assert.match(spotifySlots.children[0].innerHTML,/Empty slot/);
  const first = youtubeSlots.children[0];
  youtube.queue = ['a','b'].map((title,index)=>({id:String(index),title,video_id:title.repeat(11)}));
  page.receive(state);
  assert.equal(youtubeSlots.style.top,'calc(var(--queue-row-height) * 2)');
  assert.equal(youtubeSlots.children[0],first);
  youtube.queue = []; youtube.autoplay = true; youtube.recommendation = {title:'Recommended',video_id:'ccccccccccc'};
  page.receive(state);
  assert.equal(youtubeSlots.style.top,'calc(var(--queue-row-height) * 1)');
});

test('queue removal and clearing do not request inline success messages', () => {
  const {page,state,list} = reorderPage();
  state.players[1].capabilities.push('removequeue','clearqueue'); page.receive(state);
  vm.runInContext('var messages = []; change = async (path,payload,message) => { messages.push(message); return true; }',page.context);
  list.children[0].children[2].click(); page.element('youtube-clearqueue').click();
  assert.equal(vm.runInContext('messages.length',page.context),2);
  assert.equal(vm.runInContext('messages.every(message => message === undefined)',page.context),true);
});
