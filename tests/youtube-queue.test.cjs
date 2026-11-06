const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../youtube/queue.js'), 'utf8');
const controlSource = fs.readFileSync(path.join(__dirname, '../youtube/player-control.js'), 'utf8');
const A = 'aaaaaaaaaaa', B = 'bbbbbbbbbbb', C = 'ccccccccccc';
function fixture(options = {}) {
  let id = A, status = 1, now = 1000;
  const calls = [], timers = [], requests = [], storage = options.storage || new Map();
  const p = {getVideoData: () => ({video_id: id}), getPlayerState: () => status,
    getAdState: () => 0, loadVideoById: input => calls.push(input.videoId)};
  const context = vm.createContext({crypto, location: {origin: 'https://www.youtube.com', pathname: '/tv'},
    window: {ytcfg: {get: () => ({client: {clientName: 'TVHTML5'}})}},
    document: {getElementById: () => p}, Date: {now: () => now}, AbortSignal,
    localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
    setInterval: fn => timers.push(fn),
    fetch: async (url, init) => { requests.push({url, body: JSON.parse(init.body)}); return options.fetch ? options.fetch() : {ok: true, json: async () => ({playerOverlays: {playerOverlayRenderer: {autoplay: {playerOverlayAutoplayRenderer: {videoId: C}}}}})}; }
  });
  vm.runInContext(source + '\n' + controlSource, context);
  return {q: context.window.rasppiYouTubeQueue, calls, requests, storage, p,
    control: input => context.controlYouTube(input),
    async tick() { timers[0](); await new Promise(setImmediate); },
    media(video, state = 1) { id = video; status = state; },
    advance(ms) { now += ms; },
    reinstall() { vm.runInContext(source, context); return timers.length; }
  };
}
test('enqueue preserves current playback, advances on ended, and waits for acknowledgement', async () => {
  const f = fixture();
  f.control({action: 'enqueue', videoId: B});
  assert.deepEqual(f.calls, []);
  assert.equal(f.control({action: 'state'}).queue_count, 1);
  assert.ok(f.control({action: 'state'}).capabilities.includes('next'));
  f.media(A, 2); await f.tick(); assert.deepEqual(f.calls, []);
  f.media(A, 0); await f.tick(); await f.tick();
  assert.deepEqual(f.calls, [B]);
  assert.equal(f.q.status().queue_count, 1);
  f.media(B); await f.tick();
  assert.equal(f.q.status().queue_count, 0);
  f.media(B, 0); await f.tick();
  assert.deepEqual(f.calls, [B, C]);
  assert.equal(f.requests[0].body.videoId, B);
});
test('autoplay off still advances explicit queue, but stops when empty', async () => {
  const f = fixture(); f.q.setAutoplay(false); f.q.enqueue(B);
  f.media(A, 0); await f.tick(); f.media(B); await f.tick();
  f.media(B, 0); await f.tick();
  assert.deepEqual(f.calls, [B]); assert.equal(f.requests.length, 0);
});
test('read-only status does not start an already ended video', async () => {
  const f = fixture(); f.media(A, 0);
  f.control({action: 'state'}); await f.tick();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.requests, []);
  f.q.setAutoplay(true); await f.tick(); assert.deepEqual(f.calls, [C]);
});
test('manual Play replaces current video and retains pending queue', async () => {
  const f = fixture(); f.q.enqueue(B); f.q.play(C); f.media(C); await f.tick();
  f.media(C, 0); await f.tick(); assert.deepEqual(f.calls, [C, B]);
});
test('a late recommendation cannot override Play, Enqueue, or disabling autoplay', async () => {
  for (const action of ['play', 'enqueue', 'off', 'pause']) {
    let resolve;
    const f = fixture({fetch: () => new Promise(done => { resolve = done; })});
    f.q.setAutoplay(true); f.media(A, 0); await f.tick();
    if (action === 'play') f.q.play(B);
    if (action === 'enqueue') f.q.enqueue(B);
    if (action === 'off') f.q.setAutoplay(false);
    if (action === 'pause') f.media(A, 2);
    resolve({ok: true, json: async () => ({playerOverlays: {playerOverlayRenderer: {autoplay: {playerOverlayAutoplayRenderer: {videoId: C}}}}})});
    await new Promise(setImmediate);
    assert.ok(!f.calls.includes(C));
  }
});
test('phone takeover clears the old queue and does not start recommendations', async () => {
  const f = fixture(); f.q.enqueue(B); f.media(C); await f.tick(); f.media(C, 0); await f.tick();
  assert.equal(f.q.status().queue_count, 0);
  assert.match(f.q.status().queue_error, /outside this panel/);
  assert.deepEqual(f.calls, []); assert.equal(f.requests.length, 0);
});
test('unavailable recommendations stop with feedback without retrying forever', async () => {
  const f = fixture({fetch: async () => ({ok: true, json: async () => ({})})});
  f.q.setAutoplay(true); f.media(A, 0); await f.tick(); await f.tick();
  assert.equal(f.requests.length, 1); assert.deepEqual(f.calls, []);
  assert.match(f.q.status().queue_error, /no next recommendation/);
});
test('failed video load retains the queue for an explicit retry', async () => {
  const f = fixture(); f.q.enqueue(B); f.media(A, 0); await f.tick();
  f.advance(21000); await f.tick(); await f.tick();
  assert.deepEqual(f.calls, [B]); assert.equal(f.q.status().queue_count, 1);
  assert.match(f.q.status().queue_error, /did not start/);
  f.q.next(); assert.deepEqual(f.calls, [B, B]);
});
test('queue persists through receiver reload including an unacknowledged transition', async () => {
  const f = fixture(); f.q.setAutoplay(false); f.q.enqueue(B); f.media(A, 0); await f.tick();
  const restored = fixture({storage: f.storage}); restored.media(B); await restored.tick();
  assert.equal(restored.q.status().queue_count, 0);
  assert.equal(restored.q.status().autoplay, false);
  restored.media(B, 0); await restored.tick(); assert.deepEqual(restored.calls, []);
  assert.equal(restored.reinstall(), 1);
});
test('same-video queue entries wait for a new playback before advancing again', async () => {
  const f = fixture(); f.q.enqueue(A); f.q.enqueue(B); f.media(A, 0);
  await f.tick(); await f.tick(); assert.deepEqual(f.calls, [A]);
  f.media(A, 1); await f.tick(); f.media(A, 0); await f.tick(); assert.deepEqual(f.calls, [A, B]);
});
test('invalid links, full queues, and non-boolean autoplay never reach playback', () => {
  const f = fixture();
  for (const id of ['', 'https://example.com', 'short', null]) assert.throws(() => f.q.enqueue(id));
  for (const enabled of [undefined, 'true', 1]) assert.throws(() => f.q.setAutoplay(enabled));
  for (let i = 0; i < 50; i++) f.q.enqueue(B);
  assert.throws(() => f.q.enqueue(C)); assert.deepEqual(f.calls, []);
  f.control({action: 'clearqueue'}); assert.equal(f.q.status().queue_count, 0);
});

test('queue exposes titled entries with stable identities and removes just one duplicate', () => {
  const f = fixture(); f.q.enqueue(B, 'First entry'); f.q.enqueue(B, 'Second entry');
  const entries = f.q.status().queue;
  assert.equal(entries[0].title, 'First entry');
  assert.notEqual(entries[0].id, entries[1].id);
  f.control({action: 'removequeue', queueID: entries[1].id});
  assert.equal(f.q.status().queue.length, 1);
  assert.equal(f.q.status().queue[0].id, entries[0].id);
  assert.throws(() => f.q.remove(entries[1].id));
  assert.deepEqual(f.calls, []);
});
test('a starting queue entry cannot be removed while awaiting playback confirmation', async () => {
  const f = fixture(); f.q.enqueue(B); f.media(A, 0); await f.tick();
  const entry = f.q.status().queue[0];
  assert.equal(entry.starting, true);
  assert.throws(() => f.q.remove(entry.id));
  f.media(B); await f.tick(); assert.equal(f.q.status().queue_count, 0);
});
test('autoplay exposes its recommendation before the current video ends', async () => {
  const f = fixture(); f.q.setAutoplay(true); await f.tick();
  assert.equal(f.q.status().recommendation.video_id, C);
  assert.deepEqual(f.calls, []);
  await f.tick(); assert.equal(f.requests.length, 1);
  f.q.enqueue(B); assert.equal(f.q.status().recommendation, null);
  f.q.clear(); assert.equal(f.q.status().recommendation.video_id, C);
  f.media(A, 0); await f.tick(); assert.deepEqual(f.calls, [C]);
});
test('turning autoplay off hides the recommendation', async () => {
  const f = fixture(); f.q.setAutoplay(true); await f.tick();
  f.q.setAutoplay(false);
  assert.equal(f.q.status().recommendation, null);
  f.media(A, 0); await f.tick(); assert.deepEqual(f.calls, []);
});

test('Next plays the visible autoplay recommendation and blocks duplicate navigation until acknowledged', async () => {
  const f = fixture(); f.q.setAutoplay(true); await f.tick();
  assert.ok(f.control({action: 'state'}).capabilities.includes('next'));
  assert.ok(!f.control({action: 'state'}).capabilities.includes('previous'));
  f.control({action: 'next'});
  assert.deepEqual(f.calls, [C]);
  assert.throws(() => f.control({action: 'next'}));
  assert.throws(() => f.control({action: 'previous'}));
  f.media(C); await f.tick();
  assert.ok(f.control({action: 'state'}).capabilities.includes('previous'));
  f.control({action: 'previous'});
  assert.deepEqual(f.calls, [C, A]);
  f.media(A); await f.tick();
  assert.ok(!f.control({action: 'state'}).capabilities.includes('previous'));
});
test('Next prioritizes queued videos over recommendations and respects autoplay off', async () => {
  const f = fixture(); f.q.setAutoplay(true); await f.tick(); f.q.enqueue(B);
  f.control({action: 'next'}); assert.deepEqual(f.calls, [B]);
  f.media(B); await f.tick(); f.q.setAutoplay(false);
  assert.ok(!f.control({action: 'state'}).capabilities.includes('next'));
  assert.throws(() => f.control({action: 'next'}));
  assert.ok(f.control({action: 'state'}).capabilities.includes('previous'));
});
test('Previous walks confirmed history across reloads without changing queued videos', async () => {
  const f = fixture(); f.q.setAutoplay(false); f.q.play(B); f.media(B); await f.tick();
  f.q.play(C); f.media(C); await f.tick(); f.q.enqueue(C);
  const restored = fixture({storage: f.storage}); restored.media(C);
  restored.control({action: 'previous'}); restored.media(B); await restored.tick();
  assert.equal(restored.q.status().queue_count, 1);
  restored.control({action: 'previous'}); restored.media(A); await restored.tick();
  assert.deepEqual(restored.calls, [B, A]);
  assert.throws(() => restored.control({action: 'previous'}));
});
test('failed starts do not add history and failed Previous does not discard history', async () => {
  const f = fixture(); f.q.play(B); f.advance(21000); await f.tick();
  assert.ok(!f.q.status().can_previous);
  f.q.play(B); f.media(B); await f.tick();
  f.q.previous(); f.advance(21000); await f.tick();
  const saved = JSON.parse([...f.storage.values()][0]);
  assert.deepEqual(saved.history, [A]);
});
test('phone takeover clears history and stale recommendations cannot enable Next', async () => {
  const f = fixture(); f.q.play(B); f.media(B); await f.tick();
  assert.ok(f.q.status().can_previous);
  f.media(A);
  assert.equal(f.q.status().recommendation, null);
  assert.equal(f.q.status().can_previous, false);
  assert.equal(f.q.status().can_next, false);
  await f.tick();
  const saved = JSON.parse([...f.storage.values()][0]);
  assert.deepEqual(saved.history, []);
});
test('native playlist navigation remains a fallback, but is blocked while panel navigation is pending', async () => {
  const f = fixture();
  f.p.getPlaylist = () => [A, B, C]; f.p.getPlaylistIndex = () => 1;
  f.p.previousVideo = () => f.calls.push('native-previous'); f.p.nextVideo = () => f.calls.push('native-next');
  f.control({action: 'previous'}); f.control({action: 'next'});
  assert.deepEqual(f.calls, ['native-previous', 'native-next']);
  f.q.play(B);
  assert.throws(() => f.control({action: 'previous'}));
  assert.throws(() => f.control({action: 'next'}));
});

test('playing a selected queue row removes only that entry after confirmation', async () => {
  const f = fixture(); f.q.setAutoplay(false);
  f.q.enqueue(B, 'First'); f.q.enqueue(C, 'Selected'); f.q.enqueue(C, 'Duplicate video');
  const entries = f.q.status().queue;
  f.control({action: 'playqueue', queueID: entries[1].id});
  assert.deepEqual(f.calls, [C]);
  assert.equal(f.q.status().queue.length, 3);
  assert.equal(f.q.status().queue[1].starting, true);
  assert.throws(() => f.control({action: 'playqueue', queueID: entries[0].id}));
  f.media(C); await f.tick();
  assert.deepEqual(Array.from(f.q.status().queue, entry => entry.id), [entries[0].id, entries[2].id]);
  assert.throws(() => f.q.playEntry(entries[1].id));
  f.media(C, 0); await f.tick();
  assert.deepEqual(f.calls, [C, B]);
});

test('failed selected-row playback leaves the queue intact and can be retried', async () => {
  const f = fixture(); f.q.setAutoplay(false); f.q.enqueue(B); f.q.enqueue(C);
  const entry = f.q.status().queue[1];
  f.q.playEntry(entry.id); f.advance(21000); await f.tick();
  assert.equal(f.q.status().queue_count, 2);
  assert.equal(f.q.status().queue[1].starting, false);
  assert.match(f.q.status().queue_error, /did not start/);
  f.q.playEntry(entry.id); assert.deepEqual(f.calls, [C, C]);
});


test('reordering persists exact entry IDs, preserves duplicates and changes next playback', async () => {
  const f=fixture(); f.q.enqueue(B); f.q.enqueue(C); f.q.enqueue(B);
  const ids=Array.from(f.q.status().queue, entry=>entry.id);
  assert.ok(f.control({action:'state'}).capabilities.includes('reorderqueue'));
  f.control({action:'reorderqueue',queueID:ids[2],beforeID:ids[0]});
  assert.deepEqual(Array.from(f.q.status().queue, entry=>entry.id),[ids[2],ids[0],ids[1]]);
  f.control({action:'reorderqueue',queueID:ids[0],beforeID:''});
  assert.deepEqual(Array.from(f.q.status().queue, entry=>entry.id),[ids[2],ids[1],ids[0]]);
  const restored=fixture({storage:f.storage});
  assert.deepEqual(Array.from(restored.q.status().queue, entry=>entry.id),[ids[2],ids[1],ids[0]]);
  restored.q.next();assert.deepEqual(restored.calls,[B]);
  assert.throws(()=>restored.q.move(ids[1],ids[0]),/starting/);
  assert.ok(!restored.control({action:'state'}).capabilities.includes('reorderqueue'));
  restored.media(B);await restored.tick();
  assert.deepEqual(Array.from(restored.q.status().queue, entry=>entry.id),[ids[1],ids[0]]);
});
test('stale or invalid reorder destinations leave the entire queue intact', () => {
  const f=fixture();f.q.enqueue(B);f.q.enqueue(C);
  const ids=Array.from(f.q.status().queue, entry=>entry.id);
  for(const [id,before] of [['gone',ids[0]],[ids[0],'gone'],[ids[0],null],[ids[0],ids[0]]]) {
    assert.throws(()=>f.q.move(id,before),/Queue changed/);
    assert.deepEqual(Array.from(f.q.status().queue, entry=>entry.id),ids);
  }
  assert.deepEqual(f.calls,[]);
});
