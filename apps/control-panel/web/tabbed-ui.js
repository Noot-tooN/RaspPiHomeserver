'use strict';
let selectedPlayer = 'spotify';
const playerIDs = ['spotify', 'youtube'];

function selectPlayer(id, focus = false) {
  if (!playerIDs.includes(id)) return;
  selectedPlayer = id;
  for (const player of playerIDs) {
    const selected = player === id, tab = $(player + '-tab');
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(player + '-panel').hidden = !selected;
    titleMotion(player);
  }
  if (focus) $(id + '-tab').focus();
}

function renderShell() {
  for (const id of playerIDs) {
    const player = current?.players?.find(p => p.id === id);
    const playing = connected && player?.available && player.active && !player.paused;
    const name = id === 'spotify' ? 'Spotify' : 'YouTube', tab = $(id + '-tab');
    tab.dataset.playing = String(Boolean(playing));
    tab.setAttribute('aria-label', `${name}${playing ? ', playing' : ''}`);
    tab.title = playing ? 'Playing on RaspPi' : 'View player';
    for (const action of ['back', 'forward']) setControlDisabled($(id + '-' + action), !relativeSeekTarget(id, 0, true));

  }
  const spotify = current?.players?.find(p => p.id === 'spotify');
  document.querySelector('.spotify-handoff').hidden = Boolean(spotify?.active);
}

for (const id of playerIDs) {
  const tab = $(id + '-tab');
  tab.addEventListener('click', () => selectPlayer(id));
  tab.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = playerIDs[1 - playerIDs.indexOf(id)];
    if (event.key === 'Home') next = 'spotify';
    if (event.key === 'End') next = 'youtube';
    if (next) { event.preventDefault(); selectPlayer(next, true); }
  });
  $(id + '-back').addEventListener('click', () => skipPlayer(id, -15));
  $(id + '-forward').addEventListener('click', () => skipPlayer(id, 15));
}

const infoOption = $('youtube-pair'), infoTip = $('pairing-info-tip');
infoOption.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') infoTip.hidden = false; });
infoOption.addEventListener('pointerleave', () => { infoTip.hidden = true; });
$('youtube-pair').addEventListener('focus', () => { infoTip.hidden = false; });
$('youtube-pair').addEventListener('blur', () => { infoTip.hidden = true; });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !infoTip.hidden) { infoTip.hidden = true; event.preventDefault(); }
});

const drawer = $('settings-drawer'), help = $('shortcut-help');
for (const [dialog, openID, closeID] of [[drawer, 'open-settings', 'close-settings'], [help, 'open-help', 'close-help']]) {
  $(openID).addEventListener('click', () => { dialog.showModal(); });
  $(closeID).addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => $(openID).focus({preventScroll: true}));
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
  });
}
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || drawer.open || help.open || document.hidden) return;
  if (event.target.closest('input, textarea, select, button, a, summary, [contenteditable], [role="slider"], [role="tab"]')) return;
  if (event.key.toLowerCase() === 'h' && !event.shiftKey) { event.preventDefault(); $('open-help').click(); return; }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const slider = $(event.shiftKey ? 'volume' : selectedPlayer + '-volume');
    if (slider.disabled) return;
    event.preventDefault();
    const volume = Math.max(0, Math.min(100, Number(slider.value) + (event.key === 'ArrowUp' ? 5 : -5)));
    if (volume !== Number(slider.value)) {
      slider.value = volume;
      slider.dispatchEvent(new Event('input', {bubbles: true}));
      slider.dispatchEvent(new Event('change', {bubbles: true}));
    }
    return;
  }
  let action;
  if (event.key === 'ArrowLeft') action = event.shiftKey ? 'previous' : 'back';
  else if (event.key === 'ArrowRight') action = event.shiftKey ? 'next' : 'forward';
  else if (!event.shiftKey) action = event.code === 'Space' ? 'playback' : event.key.toLowerCase() === 'm' ? 'mute' : null;
  const button = action && $(selectedPlayer + '-' + action);
  if (button && !button.disabled) { event.preventDefault(); button.click(); }
});
selectPlayer(selectedPlayer);
renderShell();


const mobileArtworkLayout = matchMedia('(max-width: 760px)');

// Reuse the live controls when changing layouts: no duplicate sliders/listeners.
const coverPlaybackLayout = matchMedia('(max-width: 760px) and (min-height: 600px)');
function placePlaybackControls() {
  for (const id of playerIDs) {
    const controls = $(id + '-playback-controls');
    const destination = $(id + (!mobileArtworkLayout.matches || coverPlaybackLayout.matches ? '-cover' : '-compact-playback-slot'));
    if (controls.parentNode !== destination) destination.append(controls);
  }
}
coverPlaybackLayout.addEventListener('change', placePlaybackControls);
mobileArtworkLayout.addEventListener('change', placePlaybackControls);
placePlaybackControls();
