'use strict';

// Session-only history. Stable keys update one incident, not one alert per poll.
const notifications = (() => {
  const entries = new Map();
  const timers = new Map();
  const seen = new Map();
  const $n = id => document.getElementById(id);
  let sequence = 0;
  function mount() {
    const host = $n('notification-toasts');
    const parent = ['notifications-drawer', 'settings-drawer', 'shortcut-help'].map($n).find(dialog => dialog?.open) || document.body;
    if (parent && host.parentNode !== parent) parent.append(host);
    const announcement = $n('notification-announcement');
    if (parent && announcement.parentNode !== parent) parent.append(announcement);
  }
  function dismiss(key) {
    const entry = entries.get(key);
    if (!entry) return;
    entry.toast = false;
    clearTimeout(timers.get(key)); timers.delete(key);
    render();
  }
  function put(key, value) {
    const signature = JSON.stringify([value.title, value.message, value.level, value.active, value.version]);
    if (seen.get(key) === signature) return;
    seen.set(key, signature);
    const entry = {...value, key, signature, at: Date.now(), order: ++sequence, toast: true};
    entries.set(key, entry);
    clearTimeout(timers.get(key));
    // Keep unresolved errors on screen until dismissed. Everything stays in
    // the history until cleared; polling never reopens a dismissed incident.
    if (value.level === 'success' || value.level === 'info') {
      timers.set(key, setTimeout(() => dismiss(key), 7000));
    }
    while (entries.size > 30) {
      const oldest = [...entries.values()].filter(item => !item.active).sort((a, b) => a.order - b.order)[0];
      if (!oldest) break;
      clearTimeout(timers.get(oldest.key)); timers.delete(oldest.key); entries.delete(oldest.key);
      if (oldest.key.startsWith('action:')) seen.delete(oldest.key);
    }
    $n('notification-announcement').textContent = `${entry.title}. ${entry.message}`;
    render();
  }
  function resolve(key, message = 'This issue has cleared.') {
    const entry = entries.get(key);
    if (!entry?.active) return;
    put(key, {...entry, title: `${entry.title.replace(/ · resolved$/, '')} · resolved`, message, level: 'success', active: false, version: 'resolved'});
  }
  function card(entry, toast) {
    const item = document.createElement('article');
    item.className = `notification-card ${entry.level || 'info'}`;
    item.dataset.key = entry.key;
    const heading = document.createElement('div'); heading.className = 'notification-heading';
    const title = document.createElement('h3'); title.textContent = entry.title;
    heading.append(title);
    if (toast) {
      const close = document.createElement('button'); close.className = 'button icon-button notification-dismiss';
      close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', `Dismiss notification: ${entry.title}`);
      close.addEventListener('click', () => dismiss(entry.key)); heading.append(close);
    }
    const text = document.createElement('p'); text.textContent = entry.message;
    item.append(heading, text);
    if (!toast) {
      const time = document.createElement('p'); time.className = 'notification-time';
      time.textContent = `${entry.active ? 'Current issue · ' : ''}${new Date(entry.at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
      item.append(time);
    }
    return item;
  }
  function render() {
    mount();
    const sorted = [...entries.values()].sort((a, b) => Number(b.active) - Number(a.active) || b.order - a.order);
    const toasts = $n('notification-toasts'), list = $n('notification-list');
    // Keep focused controls stable while polling updates another incident.
    for (const [host, values, toast] of [[toasts, sorted.filter(e => e.toast).sort((a, b) => b.order - a.order).slice(0, 3), true], [list, sorted, false]]) {
      const keys = new Set(values.map(e => e.key));
      for (const child of [...host.children]) if (!keys.has(child.dataset.key)) child.remove();
      values.forEach((entry, index) => {
        let node = [...host.children].find(child => child.dataset.key === entry.key);
        if (!node || node.dataset.signature !== entry.signature) {
          const replacement = card(entry, toast); replacement.dataset.signature = entry.signature;
          if (node) { host.insertBefore(replacement, node); node.remove(); } else host.append(replacement);
          node = replacement;
        }
        if (host.children[index] !== node) host.insertBefore(node, host.children[index] || null);
      });
    }
    const active = sorted.filter(e => e.active).length;
    $n('notification-count').textContent = String(active || sorted.length);
    $n('notification-count').hidden = !sorted.length;
    $n('open-notifications').setAttribute('aria-label', `Notifications, ${active} current issues, ${sorted.length} recent messages`);
    $n('notifications-empty').hidden = Boolean(sorted.length);
    $n('clear-notifications').disabled = !sorted.some(e => !e.active);
  }
  function sync(state) {
    const present = new Set();
    for (const service of state?.services || []) {
      const d = service.diagnostic;
      if (d) {
        const key = `health:${d.scope || service.id}`; present.add(key);
        put(key, {title: d.scope === 'audio' ? 'Shared audio' : service.name || service.id,
          message: [d.summary && `${d.summary}.`, d.detail, d.recovery_detail, d.last_failure && `Most recent failure: ${d.last_failure}`].filter(Boolean).join(' '),
          level: d.level || 'warning', active: true, version: d.code});
      }
      const restart = service.restart;
      if (restart) put(`restart:${service.id}`, {title: `${service.name || service.id} restart`,
        message: restart.message, level: restart.status === 'completed' ? 'success' : restart.status === 'pending' ? 'info' : 'error',
        active: restart.status !== 'completed', version: `${restart.requested_at}:${restart.status}`});
    }
    const youtube = state?.players?.find(p => p.id === 'youtube');
    if (youtube?.queue_error) put('queue', {title: 'YouTube queue', message: youtube.queue_error, level: 'error', active: true});
    else if (youtube?.available) resolve('queue', 'The queue error has cleared.');
    for (const [key, entry] of entries) if (key.startsWith('health:') && entry.active && !present.has(key)) resolve(key, 'The player and its audio dependencies are responding again.');
  }
  $n('clear-notifications').addEventListener('click', () => {
    for (const [key, entry] of entries) if (!entry.active) { entries.delete(key); if (key.startsWith('action:')) seen.delete(key); clearTimeout(timers.get(key)); timers.delete(key); }
    render();
  });
  return {put, resolve, sync, mount, render};
})();
