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
  const context = vm.createContext({window: {}, location: {origin, pathname: '/tv'}, document: {getElementById: () => player}});
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

test('explicit load starts a validated video even when idle; polling does not', () => {
  const loaded = [];
  const f = fixture({getVideoData: () => ({}), loadVideoById: input => loaded.push(input)});
  assert.ok(f.control({action: 'state'}).capabilities.includes('load'));
  assert.equal(loaded.length, 0);
  assert.equal(f.control({action: 'load', videoId: '-abcdefghij'}).accepted, true);
  assert.equal(loaded[0].videoId, '-abcdefghij');
  assert.equal(loaded[0].startSeconds, 0);
  for (const videoId of [undefined, '', 'short', 'https://youtu.be/abcdefghijk', 'abcdefghij;', 123]) {
    assert.throws(() => f.control({action: 'load', videoId}));
  }
  assert.equal(loaded.length, 1);
  const unavailable = fixture();
  assert.throws(() => unavailable.control({action: 'load', videoId: 'abcdefghijk'}));
  assert.deepEqual(unavailable.calls, []);
});


test('empty TV titles still expose the current validated video ID for metadata lookup', () => {
  const f = fixture({getVideoData: () => ({video_id: 'gnLwexnUp2o', title: ''})});
  const state = f.control({action: 'state'});
  assert.equal(state.video_id, 'gnLwexnUp2o');
  assert.equal(state.title, '');
  assert.deepEqual(f.calls, []);
  const invalid = fixture({getVideoData: () => ({video_id: 'https://example.com', title: ''})});
  assert.equal(invalid.control({action: 'state'}).video_id, '');
});

test('seek is bounded, uses milliseconds, and refuses stale or live media', () => {
  const seeks = [];
  const f = fixture({getVideoData: () => ({video_id: 'abcdefghijk', title: 'Track'}),
    getDuration: () => 200, getCurrentTime: () => 12.5, seekTo: (...args) => seeks.push(args)});
  const state = f.control({action: 'state'});
  assert.equal(state.position_ms, 12500);
  assert.equal(state.duration_ms, 200000);
  assert.ok(state.capabilities.includes('seek'));
  for (const input of [{positionMs: -1}, {positionMs: 200001}, {positionMs: 1.1}, {positionMs: 5000, expectedVideoId: 'other'}]) {
    assert.throws(() => f.control({action: 'seek', expectedVideoId: 'abcdefghijk', ...input}));
  }
  f.control({action: 'seek', positionMs: 25000, expectedVideoId: 'abcdefghijk'});
  assert.deepEqual(seeks, [[25, true]]);
  const live = fixture({getVideoData: () => ({video_id: 'abcdefghijk', isLive: true}), getDuration: () => 200, getCurrentTime: () => 10, seekTo: () => assert.fail('live seek')});
  assert.equal(live.control({action: 'state'}).duration_ms, null);
  assert.throws(() => live.control({action: 'seek', positionMs: 5000, expectedVideoId: 'abcdefghijk'}));
});
test('native mute toggles without changing volume or playback', () => {
  let muted = false;
  const f = fixture({isMuted: () => muted, mute: () => {muted=true;}, unMute: () => {muted=false;}});
  f.control({action: 'mute'});
  assert.equal(f.control({action: 'state'}).muted, true);
  f.control({action: 'unmute'});
  assert.equal(f.control({action: 'state'}).muted, false);
  assert.deepEqual(f.calls, []);
});
