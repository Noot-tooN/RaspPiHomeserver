const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// Run the real UI state handlers without a network, player, or audio device.
function ui(shell = false) {
  const elements = new Map(), listeners = {}, sources = [];
  let now = 1000;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, dataset: {}, style: {setProperty() {}}, classList: {toggle() {}, contains() { return false; }},
      textContent: '', value: '0', hidden: false, disabled: true, clientWidth: 300, scrollWidth: 300,
      handlers: {}, clicks: 0, contains(other) { return other === this; }, focus() { document.activeElement = this; }, click() { this.clicks++; for (const fn of this.handlers.click || []) fn({}); },
      dispatchEvent(event) { for (const fn of this.handlers[event.type] || []) fn(event); },
      showModal() { this.open = true; }, close() { this.open = false; for (const fn of this.handlers.close || []) fn({}); },
      getClientRects() { return [{}]; }, append() {}, addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }, setAttribute(key, value) { this[key] = value; },
      removeAttribute(key) { delete this[key]; }, matches() { return false; }
    });
    return elements.get(id);
  }
  const document = {
    hidden: false, getElementById: element, createElement: () => element(Symbol()),
    querySelector: element, querySelectorAll: () => [], addEventListener(name, fn) { (listeners[name] ||= []).push(fn); }
  };
  class EventSource {
    constructor() { this.handlers = {}; sources.push(this); }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    close() { this.closed = true; }
  }
  const context = vm.createContext({document, Event, EventSource, window: {addEventListener() {}}, performance: {now: () => now},
    matchMedia: () => ({matches: true, addEventListener() {}}),
    ResizeObserver: class { observe() {} }, setTimeout() {}, clearTimeout() {}, setInterval() {}
  });
  const web = process.env.PANEL_WEB_DIR || path.join(__dirname, '../apps/control-panel/web');
  for (const name of ['player-ui.js', 'app.js', ...(shell ? ['tabbed-ui.js'] : [])]) vm.runInContext(fs.readFileSync(path.join(web, name), 'utf8'), context);
  return {element, sources, context,
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
  const page = ui();
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



test('link is selected by default and remains open on Escape and tab changes', () => {
  const page = ui(true); page.receive(snapshot());
  page.context.fetch = () => { throw new Error('No request until pairing is selected'); };
  assert.equal(page.element('youtube-open-link')['aria-checked'], 'true');
  assert.equal(page.element('youtube-link-form').hidden, false);
  assert.equal(page.element('youtube-pairing-pane').hidden, true);
  page.element('youtube-tab').click();
  page.element('youtube-open-pairing').handlers.pointerenter[0]({pointerType:'mouse'});
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
  assert.equal(page.element('youtube-open-link')['aria-checked'], 'true');
});

test('pairing radio requests once, keeps one pane open, and reuses its code', async () => {
  const page = ui(true); page.receive(snapshot());
  let finish, requests = 0;
  page.context.AbortSignal = {timeout: () => undefined};
  page.context.fetch = () => { requests++; return new Promise(resolve => { finish = resolve; }); };
  const pending = page.element('youtube-open-pairing').handlers.click[0]();
  assert.equal(requests, 1);
  assert.equal(page.element('youtube-open-link')['aria-checked'], 'false');
  assert.equal(page.element('youtube-open-pairing')['aria-checked'], 'true');
  assert.equal(page.element('pairing-placeholder').hidden, false);
  await page.element('youtube-open-pairing').handlers.click[0]();
  assert.equal(requests, 1);
  page.element('youtube-open-link').handlers.click[0]();
  finish({ok: true, json: async () => ({code: '123456789012'})});
  await pending;
  assert.equal(page.element('youtube-link-form').hidden, false);
  assert.equal(page.element('youtube-pairing-pane').hidden, true);
  await page.element('youtube-open-pairing').handlers.click[0]();
  assert.equal(requests, 1);
  assert.equal(page.element('pairing-code').textContent, '123 456 789 012');
  assert.equal(page.element('pairing-placeholder').hidden, true);
  assert.equal(page.element('youtube-pair').hidden, true);
  vm.runInContext('hidePairing()', page.context);
  assert.equal(page.element('pairing-code').textContent, '');
  assert.equal(requests, 1);
});

test('pairing failure offers a bounded retry; info focus never requests a code', async () => {
  const page = ui(true); page.receive(snapshot());
  page.context.AbortSignal = {timeout: () => undefined};
  let requests = 0;
  page.context.fetch = async () => { requests++; return {ok:false,json:async()=>({error:'Receiver unavailable'})}; };
  page.element('youtube-open-pairing').handlers.focus[0]();
  assert.equal(requests, 0);
  await page.element('youtube-open-pairing').handlers.click[0]();
  assert.equal(page.element('pairing-placeholder').hidden, true);
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
