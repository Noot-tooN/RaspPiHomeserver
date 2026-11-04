(() => {
  const frequencies = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const presets = {
    Normal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    Bassy: [2, 4, 3, 1, 0, 0, 0, 0, 0, 0],
    Vocal: [-2, -2, -1, -1, 0, 1, 3, 2, 0, 0],
    Bright: [0, 0, 0, 0, 0, 0, 1, 2, 3, 2],
  };
  const menu = document.getElementById('preset');
  const note = document.getElementById('eq-note');
  const hint = note.textContent;
  const chart = document.getElementById('bands');
  for (const name of Object.keys(presets)) menu.add(new Option(name, name));
  const custom = new Option('Custom', 'Custom');
  custom.disabled = true;
  menu.add(custom);

  function signed(gain) {
    return gain > 0 ? '+' + gain : String(gain).replace('-', '−');
  }
  const controls = frequencies.map(frequency => {
    const band = document.createElement('label');
    band.className = 'band';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '-6';
    slider.max = '6';
    slider.step = '1';
    slider.setAttribute('aria-label', frequency + ' Hz gain');
    slider.setAttribute('aria-orientation', 'vertical');
    const freq = document.createElement('span');
    freq.className = 'freq';
    freq.textContent = frequency >= 1000 ? frequency / 1000 + 'k' : frequency;
    const output = document.createElement('output');
    output.className = 'gain';
    band.append(slider, freq, output);
    chart.append(band);
    slider.addEventListener('input', () => { revision++; render(read()); });
    slider.addEventListener('change', () => sync(read()));
    return {slider, output};
  });

  function read() {
    return controls.map(({slider}) => Number(slider.value));
  }
  function render(gains) {
    controls.forEach(({slider, output}, i) => {
      slider.value = gains[i];
      output.value = signed(gains[i]);
      slider.setAttribute('aria-valuetext', output.value + ' dB');
    });
    const match = Object.entries(presets).find(([, curve]) => curve.every((n, i) => n === gains[i]));
    menu.value = match ? match[0] : 'Custom';
  }
  function enable(enabled) {
    menu.disabled = !enabled;
    for (const {slider} of controls) slider.disabled = !enabled;
  }

  let pending = false;
  let queued = null;
  let revision = 0;
  async function sync(gains) {
    if (pending) {
      if (gains) queued = gains;
      return;
    }
    pending = true;
    const sentRevision = revision;
    try {
      const options = gains ? {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Requested-With': 'rasppi-control-panel'},
        body: JSON.stringify({gains}),
      } : {};
      const response = await fetch('api/equalizer', options);
      if (!response.ok) throw new Error();
      const applied = (await response.json()).gains;
      if (!queued && revision === sentRevision) render(applied);
      note.textContent = hint;
      enable(true);
    } catch {
      enable(false);
      note.textContent = 'Equalizer unavailable. Reopen Settings to retry.';
    } finally {
      pending = false;
      if (queued) {
        const next = queued;
        queued = null;
        sync(next);
      }
    }
  }

  render(presets.Normal);
  enable(false);
  menu.addEventListener('change', () => {
    render(presets[menu.value]);
    sync(read());
  });
  document.getElementById('open-settings').addEventListener('click', () => sync());
})();
