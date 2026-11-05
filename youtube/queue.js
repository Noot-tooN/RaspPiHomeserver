// Runs in the dedicated TV receiver on the Pi, including when no panel is open.
// Re-evaluating this file from the control helper must not install another timer.
(() => {
  if (location.origin !== 'https://www.youtube.com' || !/^\/tv(?:\/|$)/.test(location.pathname) || window.rasppiYouTubeQueue) return;
  const key = 'rasppi.youtube.queue.v1';
  const validID = id => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
  let saved;
  try { saved = JSON.parse(localStorage.getItem(key)); } catch {}
  const state = {
    items: Array.isArray(saved?.items) ? saved.items.slice(0, 50).map(item => {
      if (validID(item)) return {id: crypto.randomUUID(), video_id: item, title: ''};
      if (!validID(item?.video_id) || !/^[a-f0-9-]{36}$/.test(item.id)) return null;
      return {id: item.id, video_id: item.video_id, title: typeof item.title === 'string' ? item.title.slice(0, 300) : ''};
    }).filter(Boolean) : [],
    autoplay: typeof saved?.autoplay === 'boolean' ? saved.autoplay : true,
    currentID: validID(saved?.currentID) ? saved.currentID : '',
  };
  let error = '', generation = 0, fetching = false;
  let suggested = null, suggestedFor = '', attempted = '';
  let pending = saved?.pending && validID(saved.pending.id) && Number.isFinite(saved.pending.at)
    ? {id: saved.pending.id, from: validID(saved.pending.from) ? saved.pending.from : '', entryID: typeof saved.pending.entryID === 'string' ? saved.pending.entryID : '', at: saved.pending.at} : null;
  const player = () => document.getElementById('ytlr-player__player-container-player');
  const videoID = p => p?.getVideoData?.()?.video_id || '';
  const ready = p => p && typeof p.loadVideoById === 'function' && typeof p.getPlayerState === 'function';
  const save = () => {
    try { localStorage.setItem(key, JSON.stringify({...state, pending})); }
    catch { error = 'Queue could not be saved. It will last until the receiver restarts.'; }
  };
  function start(p, id, entryID = '') {
    const from = videoID(p);
    // Advance the queue only after the new video is observed playing.
    p.loadVideoById({videoId: id, startSeconds: 0});
    generation++;
    suggested = null; suggestedFor = ''; attempted = '';
    state.currentID = id;
    pending = {id, from, entryID, at: Date.now()};
    error = '';
    save();
  }
  async function recommendation(id) {
    const context = window.ytcfg?.get('INNERTUBE_CONTEXT');
    if (!context) throw new Error('Recommendations are unavailable. Add another link to continue.');
    const response = await fetch('/youtubei/v1/next', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({context, videoId: id}), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Could not get a recommendation. Add another link to continue.');
    let data;
    try { data = await response.json(); }
    catch { throw new Error('Could not read a recommendation. Add another link to continue.'); }
    // Use YouTube's explicit Up next selection, never an arbitrary search result.
    const upNext = data.playerOverlays?.playerOverlayRenderer?.autoplay?.playerOverlayAutoplayRenderer;
    const next = upNext?.videoId;
    if (!validID(next) || next === id) throw new Error('YouTube has no next recommendation. Add another link to continue.');
    const title = upNext.videoTitle?.simpleText || upNext.videoTitle?.runs?.map(run => run.text || '').join('') || '';
    return {video_id: next, title: typeof title === 'string' ? title.trim().slice(0, 300) : ''};
  }
  async function tick() {
    const p = player();
    if (!ready(p) || !state.currentID) return;
    const id = videoID(p), status = p.getPlayerState();
    if (pending) {
      if (id === pending.id && [1, 2, 3].includes(status)) {
        if (pending.entryID && state.items[0]?.id === pending.entryID) state.items.shift();
        pending = null;
        save();
      } else if (id && id !== pending.from && id !== pending.id) {
        // A phone took over while our video was starting.
        pending = null;
      } else {
        if (Date.now() - pending.at > 20000) {
          pending = null;
          state.currentID = '';
          error = 'Video did not start. Use Next to retry the queue, or play another link.';
          save();
        }
        return;
      }
    }
    if (id && id !== state.currentID) {
      generation++;
      state.items = [];
      state.currentID = '';
      suggested = null; suggestedFor = '';
      error = 'Queue cleared because playback changed outside this panel.';
      save();
      return;
    }
    if (id !== state.currentID || ![0, 1, 2, 3].includes(status) || p.getAdState?.() > 0) return;
    if (state.items.length) {
      if (status === 0) {
        try { start(p, state.items[0].video_id, state.items[0].id); }
        catch { state.currentID = ''; error = 'Could not start the next video. Use Next to retry.'; save(); }
      }
      return;
    }
    if (!state.autoplay) return;
    if (suggested && suggestedFor === id) {
      if (status === 0) start(p, suggested.video_id);
      return;
    }
    const version = generation, attempt = `${id}:${version}`;
    if (fetching || attempted === attempt) return;
    attempted = attempt;
    fetching = true;
    try {
      const next = await recommendation(id);
      if (version !== generation || !state.autoplay || state.items.length || videoID(p) !== id) return;
      suggested = next;
      suggestedFor = id;
      if (p.getPlayerState() === 0) start(p, next.video_id);
    } catch (failure) {
      if (version === generation) { error = failure.message || 'Autoplay is unavailable.'; }
    } finally { fetching = false; }
  }

  window.rasppiYouTubeQueue = {
    status() {
      return {queue_count: state.items.length,
        queue: state.items.map(item => ({...item, starting: pending?.entryID === item.id})),
        recommendation: state.autoplay && !state.items.length && suggestedFor === state.currentID ? suggested : null,
        autoplay_pending: state.autoplay && !state.items.length && !!state.currentID && (!attempted || fetching),
        autoplay: state.autoplay, queue_error: error};
    },
    play(id) {
      if (!validID(id) || !ready(player())) throw new Error('Invalid video or receiver unavailable');
      start(player(), id);
    },
    enqueue(id, title = '') {
      const p = player();
      if (!validID(id) || !ready(p)) throw new Error('Invalid video or receiver unavailable');
      if (state.items.length >= 50) throw new Error('Queue is full (50 videos)');
      state.items.push({id: crypto.randomUUID(), video_id: id, title: typeof title === 'string' ? title.trim().slice(0, 300) : ''});
      generation++;
      error = '';
      if (!pending) state.currentID = videoID(p);
      save();
      if (!pending && (!validID(videoID(p)) || p.getPlayerState() === 0)) start(p, state.items[0].video_id, state.items[0].id);
    },
    next() {
      const p = player();
      if (!state.items.length || !ready(p)) throw new Error('Queue is empty');
      if (pending) throw new Error('A video is already starting');
      start(p, state.items[0].video_id, state.items[0].id);
    },
    remove(entryID) {
      const index = state.items.findIndex(item => item.id === entryID);
      if (index < 0) throw new Error('Queue entry no longer exists');
      if (pending?.entryID === entryID) throw new Error('This video is already starting');
      generation++;
      state.items.splice(index, 1);
      error = '';
      save();
    },
    clear() {
      generation++;
      state.items = [];
      if (pending) pending.entryID = '';
      error = '';
      save();
    },
    setAutoplay(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('Invalid autoplay setting');
      generation++;
      state.autoplay = enabled;
      suggested = null; suggestedFor = ''; attempted = '';
      if (enabled && ready(player()) && validID(videoID(player())) && !pending) state.currentID = videoID(player());
      error = '';
      save();
    },
  };
  // All mutations above are synchronous; the recommendation fetch checks its
  // generation again so a newer Play/Enqueue/cast action always wins.
  setInterval(() => { tick().catch(() => { error = 'Queue is temporarily unavailable.'; }); }, 1000);
})();
