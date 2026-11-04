const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../youtube/player-control.js'), 'utf8');
function fixture(overrides = {}, origin = 'https://www.youtube.com') {
  const calls = [];
  const player = {getPlayerState: () => 2, getVideoData: () => ({video_id: 'video', title: 'Title'}),
    getVolume: () => 37, setVolume: v => calls.push(['volume', v]),
    getPlaylist: () => ['a', 'b', 'c'], getPlaylistIndex: () => 1,
    playVideo: () => calls.push('play'), pauseVideo: () => calls.push('pause'),
    previousVideo: () => calls.push('previous'), nextVideo: () => calls.push('next'), ...overrides};
  const context = vm.createContext({location: {origin, pathname: '/tv'}, document: {getElementById: () => player}});
  vm.runInContext(source, context);
  return {calls, control: input => context.controlYouTube(input)};
}
test('status is read-only and reports native volume/capabilities', () => {
  const f = fixture(); const s = f.control({action: 'state'});
  assert.equal(s.volume, 37); assert.equal(s.paused, true);
  assert.deepEqual([...s.capabilities], ['volume', 'play', 'previous', 'next']);
  assert.deepEqual(f.calls, []);
});
test('idle receiver cannot start media; unknown queue cannot be skipped', () => {
  const idle = fixture({getVideoData: () => ({})});
  assert.throws(() => idle.control({action: 'play'}));
  const f = fixture({getPlaylist: () => undefined});
  assert.throws(() => f.control({action: 'next'}));
  assert.throws(() => f.control({action: 'previous'}));
  assert.deepEqual(f.calls, []);
});
test('uses native controls and enforces volume range', () => {
  const f = fixture(); f.control({action: 'play'}); f.control({action: 'volume', volume: 0});
  assert.deepEqual(f.calls, ['play', ['volume', 0]]);
  for (const volume of [-1, 101, 1.5, '40']) assert.throws(() => f.control({action: 'volume', volume}));
  assert.throws(() => f.control({action: 'navigate', url: 'https://example.com'}));
});
test('rejects a different browser page before any operation', () => {
  const f = fixture({}, 'https://example.com'); assert.throws(() => f.control({action: 'state'})); assert.deepEqual(f.calls, []);
});
