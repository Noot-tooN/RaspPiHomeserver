'use strict';

// Stable keys update one incident across status polls.
const notifications = (() => {
  const entries = new Map();
  const timers = new Map();
  const seen = new Map();
  const $n = id => document.getElementById(id);
  let sequence = 0;
  const storageKey = 'rasppi.warningHistory.v1';
  try {
    for (const [key, signature] of JSON.parse(sessionStorage.getItem(storageKey + '.dismissedRestarts') || '[]')) seen.set(key, signature);
    for (const entry of JSON.parse(sessionStorage.getItem(storageKey) || '[]')) {
      if (!(entry?.warnings?.length || entry?.warning || entry?.level === 'error') || typeof entry.key !== 'string' || !Number.isSafeInteger(entry.order)) continue;
      // Earlier sessions stored just the first warning, without its own timestamp.
      entry.warnings ??= entry.warning ? [{message: entry.warning, at: entry.active && entry.message === entry.warning ? entry.at : null}] : [];
      delete entry.warning;
      entries.set(entry.key, entry);
      seen.set(entry.key, entry.signature);
      sequence = Math.max(sequence, entry.order);
    }
  } catch { /* Storage can be unavailable in private browsing. */ }
  function saveWarnings() {
    try {
      const dismissedRestarts = [...seen].filter(([key]) => key.startsWith('restart:') && !entries.has(key));
      sessionStorage.setItem(storageKey + '.dismissedRestarts', JSON.stringify(dismissedRestarts));
      sessionStorage.setItem(storageKey, JSON.stringify([...entries.values()].filter(retained)));
    } catch { /* Keep the in-page notifications when storage is unavailable. */ }
  }
  function mount() {
    const host = $n('notification-toasts');
    const parent = ['notifications-drawer', 'settings-drawer', 'shortcut-help'].map($n).find(dialog => dialog?.open) || document.body;
    if (parent && host.parentNode !== parent) parent.append(host);
    const announcement = $n('notification-announcement');
    if (parent && announcement.parentNode !== parent) parent.append(announcement);
  }
  function retained(entry) {
    return entry.warnings.length > 0 || entry.level === 'error';
  }
  function remove(key) {
    entries.delete(key);
    clearTimeout(timers.get(key)); timers.delete(key);
    // Retain a polled signature so the next identical snapshot stays dismissed.
    if (/^(action|history):/.test(key)) seen.delete(key);
  }
  function dismiss(key, fromHistory) {
    const entry = entries.get(key);
    if (!entry) return;
    if (fromHistory) remove(key);
    else {
      entry.toast = false;
      clearTimeout(timers.get(key)); timers.delete(key);
    }
    saveWarnings();
    render();
  }
  function put(key, value) {
    key ??= `action:${sequence + 1}`;
    const signature = JSON.stringify([value.title, value.message, value.level, value.active, value.version, value.requestedAt]);
    if (seen.get(key) === signature) return;
    seen.set(key, signature);
    const previous = entries.get(key);
    const continuing = previous?.active && previous.requestedAt === value.requestedAt;
    if (previous && retained(previous) && !continuing) {
      const historyKey = `history:${previous.order}`;
      entries.set(historyKey, {...previous, key: historyKey, active: false});
    }
    const at = Date.now();
    const warnings = continuing ? previous.warnings.slice() : [];
    const last = warnings.at(-1);
    if (value.active && ['warning', 'error'].includes(value.level) &&
        (last?.message !== value.message || last?.level !== value.level)) {
      warnings.push({message: value.message, level: value.level, at});
    }
    const entry = {...value, key, signature, warnings, at, since: continuing ? previous.since ?? previous.at : at,
      order: ++sequence, toast: continuing && retained(previous) ? previous.toast : true};
    entries.set(key, entry);
    clearTimeout(timers.get(key));
    if (!retained(entry) && (value.level === 'success' || value.level === 'info')) {
      timers.set(key, setTimeout(() => dismiss(key), 7000));
    }
    while (entries.size > 30) {
      const oldest = [...entries.values()].filter(item => !item.active && !retained(item)).sort((a, b) => a.order - b.order)[0];
      if (!oldest) break;
      remove(oldest.key);
    }
    saveWarnings();
    $n('notification-announcement').textContent = `${entry.title}. ${entry.message}`;
    render();
  }
  function resolve(key, message = 'This issue has cleared.') {
    const entry = entries.get(key);
    if (!entry?.active) return;
    put(key, {...entry, title: `${entry.title.replace(/ · resolved$/, '')} · resolved`, message, level: 'success', active: false, version: 'resolved'});
  }
  function timestamp(at) {
    const date = new Date(at);
    const time = document.createElement('time');
    time.dateTime = date.toISOString();
    time.textContent = date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    time.title = date.toLocaleString();
    return time;
  }
  function warningRow(warning) {
    const row = document.createElement('li');
    if (warning.at != null) row.append(timestamp(warning.at));
    const text = document.createElement('p');
    text.textContent = warning.message;
    row.append(text);
    return row;
  }
  function card(entry, toast) {
    const item = document.createElement('article');
    item.className = `notification-card ${entry.level || 'info'}`;
    item.dataset.key = entry.key;
    const heading = document.createElement('div'); heading.className = 'notification-heading';
    const title = document.createElement(toast ? 'h3' : 'h4'); title.textContent = entry.title;
    heading.append(title);
    if (toast || !entry.active) {
      const close = document.createElement('button'); close.className = 'button icon-button notification-dismiss';
      close.type = 'button'; close.textContent = '×';
      close.setAttribute('aria-label', `${toast ? 'Hide notification' : 'Dismiss from history'}: ${entry.title}`);
      close.addEventListener('click', () => {
        const focused = document.activeElement === close;
        dismiss(entry.key, !toast);
        if (!toast && focused) {
          const clear = $n('clear-notifications');
          (clear.disabled ? $n('close-notifications') : clear).focus();
        }
      });
      heading.append(close);
    }
    const text = document.createElement('p');
    const original = entry.warnings[0];
    text.textContent = toast && original && original.message !== entry.message ? `${original.message} ${entry.message}` : entry.message;
    item.append(heading, text);
    if (!toast) {
      const time = document.createElement('p'); time.className = 'notification-time';
      if (entry.active) time.textContent = 'Since ';
      time.append(timestamp(entry.active ? entry.since ?? entry.at : entry.at));
      item.append(time);
      // The current warning is already visible in the card body.
      const warnings = entry.warnings.at(-1)?.message === entry.message ? entry.warnings.slice(0, -1) : entry.warnings;
      if (warnings.length) {
        const list = document.createElement('ol'); list.className = 'notification-warnings';
        list.setAttribute('aria-label', 'Earlier warnings');
        list.append(warningRow(warnings[0]));
        item.append(list);
        if (warnings.length > 1) {
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          summary.textContent = `${warnings.length - 1} more warning${warnings.length === 2 ? '' : 's'}`;
          const more = document.createElement('ol'); more.className = 'notification-warnings';
          for (const warning of warnings.slice(1)) more.append(warningRow(warning));
          details.append(summary, more); item.append(details);
        }
      }
    }
    return item;
  }
  function render() {
    mount();
    const sorted = [...entries.values()].sort((a, b) => b.at - a.at || b.order - a.order);
    const current = sorted.filter(e => e.active), history = sorted.filter(e => !e.active);
    // Keep focused controls stable while polling updates another incident.
    const visible = sorted.filter(e => e.toast)
      .filter((entry, index) => index < 3 || entry.warnings.length > 0);
    for (const [host, values, toast] of [[$n('notification-toasts'), visible, true], [$n('notification-current'), current, false], [$n('notification-history'), history, false]]) {
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
    const active = current.length;
    $n('current-issues-section').hidden = !active;
    $n('history-section').hidden = !history.length;
    $n('notification-count').textContent = String(active || sorted.length);
    $n('notification-count').hidden = !sorted.length;
    $n('open-notifications').setAttribute('aria-label', `Notifications, ${active} current issues, ${sorted.length} recent messages`);
    $n('notifications-empty').hidden = Boolean(sorted.length);
    $n('clear-notifications').disabled = !history.length;
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
        active: restart.status !== 'completed', requestedAt: restart.requested_at, version: restart.status});
    }
    const youtube = state?.players?.find(p => p.id === 'youtube');
    if (youtube?.queue_error) put('queue', {title: 'YouTube queue', message: youtube.queue_error, level: 'error', active: true});
    else if (youtube?.available) resolve('queue', 'The queue error has cleared.');
    for (const [key, entry] of entries) if (key.startsWith('health:') && entry.active && !present.has(key)) resolve(key, 'The player and its audio dependencies are responding again.');
  }
  $n('clear-notifications').addEventListener('click', () => {
    for (const [key, entry] of entries) if (!entry.active) remove(key);
    saveWarnings();
    render();
  });
  render();
  return {put, resolve, sync, mount, render};
})();
