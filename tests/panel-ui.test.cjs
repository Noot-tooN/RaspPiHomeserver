const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// Run the real UI state handlers without a network, player, or audio device.
function ui() {
  const elements = new Map(), listeners = {}, sources = [];
  let now = 1000;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, dataset: {}, style: {setProperty() {}}, classList: {toggle() {}, contains() { return false; }},
      textContent: '', value: '0', hidden: false, disabled: true, clientWidth: 300, scrollWidth: 300,
      append() {}, addEventListener() {}, setAttribute(key, value) { this[key] = value; },
      removeAttribute(key) { delete this[key]; }, matches() { return false; }
    });
    return elements.get(id);
  }
  const document = {
    hidden: false, getElementById: element, createElement: () => element(Symbol()),
    querySelectorAll: () => [], addEventListener(name, fn) { (listeners[name] ||= []).push(fn); }
  };
  class EventSource {
    constructor() { this.handlers = {}; sources.push(this); }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    close() { this.closed = true; }
  }
  const context = vm.createContext({document, EventSource, performance: {now: () => now},
    matchMedia: () => ({matches: true, addEventListener() {}}),
    ResizeObserver: class { observe() {} }, setTimeout() {}, clearTimeout() {}, setInterval() {}
  });
  const web = process.env.PANEL_WEB_DIR || path.join(__dirname, '../apps/control-panel/web');
  for (const name of ['player-ui.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(web, name), 'utf8'), context);
  return {element, sources, context, advance(ms) { now += ms; },
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
