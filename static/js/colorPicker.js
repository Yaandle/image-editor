// colorPicker.js — embeddable HSV color picker, ported from vidhtml.html reference.
// createColorPicker(containerEl, { initialColor, onChange, onCommit })
//
// Three swatch rows below the SV/hue/hex controls, matching the reference:
//   Recent  — auto-populated ~250ms after a color settles (localStorage, ambient history)
//   Palette — fixed brand presets (not user-editable)
//   Saved   — colors explicitly pinned via "+ Add Current" (localStorage — see §7 tradeoff:
//             per-browser, not portable via .vkit)

const RECENT_KEY = 'vidkit_recent_colors';
const MAX_RECENT = 9;
const SAVED_KEY = 'vidkit_saved_colors';
const MAX_SAVED = 50;
const RECENT_SAVE_DEBOUNCE_MS = 250;

const PALETTE = [
  '#E24B4A', '#BA7517', '#639922', '#0F6E56', '#185FA5',
  '#7F77DD', '#D4537E', '#2C2C2A', '#FFFFFF',
];

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60)       [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else              [r, g, b] = [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function hexToRgb(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
  return {
    r: parseInt(hex.substring(0, 2), 16),
    g: parseInt(hex.substring(2, 4), 16),
    b: parseInt(hex.substring(4, 6), 16),
  };
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function loadList(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}
function saveList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch {}
}

export function createColorPicker(containerEl, { initialColor = '#ffffff', onChange = () => {}, onCommit = () => {}, onNone = () => {} } = {}) {
  containerEl.innerHTML = '';
  containerEl.classList.add('vk-colorpicker');

  const rgb0 = hexToRgb(initialColor);
  let { h, s, v } = rgbToHsv(rgb0.r, rgb0.g, rgb0.b);
  let currentHex = initialColor;
  let isNone = false; // true once the "None" swatch is picked — getColor() reflects this
  let recentSaveTimer = null;

  // ── Trigger swatch + popover shell ──────────────────────────────────────
  const swatchBtn = document.createElement('button');
  swatchBtn.type = 'button';
  swatchBtn.className = 'vk-cp-swatch';
  swatchBtn.style.background = currentHex;
  containerEl.appendChild(swatchBtn);

  const popover = document.createElement('div');
  popover.className = 'vk-cp-popover';
  popover.style.display = 'none';
  document.body.appendChild(popover);   

  function positionPopover() {
    const r = swatchBtn.getBoundingClientRect();
    popover.style.left = `${r.left}px`;
    popover.style.top = `${r.bottom + 8}px`;
    }

    swatchBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = popover.style.display !== 'none';
    document.querySelectorAll('.vk-cp-popover').forEach(p => { p.style.display = 'none'; });
    if (open) {
        popover.style.display = 'none';
    } else {
        positionPopover();
        popover.style.display = 'block';
    }
    });

  document.addEventListener('click', (e) => {
  if (!containerEl.contains(e.target) && !popover.contains(e.target)) {
    popover.style.display = 'none';
  }
});


  // ── SV area (gradient overlay + thumb, ported from .sv-area/.sv-gradient) ─
  const svArea = document.createElement('div');
  svArea.className = 'vk-cp-sv';
  const svGradient = document.createElement('div');
  svGradient.className = 'vk-cp-sv-gradient';
  const svThumb = document.createElement('div');
  svThumb.className = 'vk-cp-sv-thumb';
  svArea.appendChild(svGradient);
  svArea.appendChild(svThumb);
  popover.appendChild(svArea);

  // ── Hue — native range input, matches reference ──────────────────────────
  const hueInput = document.createElement('input');
  hueInput.type = 'range';
  hueInput.min = '0'; hueInput.max = '360'; hueInput.step = '1';
  hueInput.className = 'vk-cp-hue';
  popover.appendChild(hueInput);

  // ── Hex input ─────────────────────────────────────────────────────────────
  const hexRow = document.createElement('div');
  hexRow.className = 'vk-cp-hex-row';
  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.className = 'vk-cp-hex-input';
  hexRow.appendChild(hexInput);
  popover.appendChild(hexRow);

  // ── Eyedropper — sits directly under the SV gradient box ────────────────
  const eyedropperBtn = document.createElement('button');
  eyedropperBtn.type = 'button';
  eyedropperBtn.className = 'vk-cp-eyedropper-btn';
  eyedropperBtn.setAttribute('aria-label', 'Pick color from screen');
  eyedropperBtn.title = 'Pick a color from anywhere on screen';
  eyedropperBtn.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 60 60" fill="currentColor">
      <g>
        <path d="M8.212,49.758c-0.391-0.391-1.023-0.391-1.414,0l-2.5,2.5c-0.856,0.855-1.328,1.995-1.328,3.207
          c0,1.211,0.472,2.351,1.328,3.207S6.293,60,7.505,60c1.211,0,2.351-0.472,3.207-1.328c1.768-1.77,1.768-4.646,0-6.414L8.212,49.758
          z"/>
        <path d="M55.164,10.403c2.243-2.245,2.498-5.845,0.578-8.196C54.598,0.805,52.901,0,51.087,0c-1.606,0-3.112,0.622-4.242,1.751
          l-3.526,3.527c-1.119,1.119-3.069,1.119-4.187,0l-0.583-0.583c-0.839-0.837-2.299-0.837-3.134,0.001L31.48,8.632
          c-0.419,0.419-0.649,0.976-0.649,1.567c0,0.593,0.23,1.149,0.649,1.568l1.968,1.968L18.183,29l-0.999,0.999
          c-1.562,1.562-2.727,3.501-3.395,5.688c-0.258,0.845-0.623,1.655-1.066,2.418c-0.028,0.048-0.048,0.099-0.076,0.146
          c-0.022,0.036-0.05,0.069-0.072,0.105c-0.224,0.363-0.462,0.718-0.724,1.055c-0.289,0.37-0.6,0.723-0.932,1.055l-4.413,4.413
          l5.656,5.656l4.375-4.374c1.354-1.353,3.037-2.355,4.87-2.898c1.289-0.383,2.501-0.979,3.618-1.721
          c0.748-0.496,1.46-1.046,2.097-1.683L37.982,29h0l5.366-5.365l1.967,1.967c0.419,0.42,0.976,0.65,1.568,0.65
          c0.592,0,1.148-0.23,1.567-0.649l3.936-3.936c0.864-0.864,0.864-2.271,0-3.136l-0.581-0.581c-0.56-0.56-0.867-1.303-0.867-2.094
          s0.308-1.534,0.867-2.093L55.164,10.403z M35.153,29H21.011l13.851-13.851l7.071,7.071L35.153,29z"/>
      </g>
    </svg>`;
  if (!window.EyeDropper) {
    eyedropperBtn.disabled = true;
    eyedropperBtn.title = 'Eyedropper not supported in this browser';
  }
  popover.appendChild(eyedropperBtn);

  eyedropperBtn.addEventListener('click', async () => {
    if (!window.EyeDropper) return;
    try {
      const dropper = new EyeDropper();
      const { sRGBHex } = await dropper.open();
      setFromHex(sRGBHex, true); // commit=true — deliberate pick, same as a swatch click
    } catch {
      // AbortError on user cancel (Esc / click-away) — intentionally silent
    }
  });

  
  // ── Recent / Palette / Saved rows ────────────────────────────────────────
  function addSection(title) {
    const lbl = document.createElement('div');
    lbl.className = 'vk-cp-section-label';
    lbl.textContent = title;
    popover.appendChild(lbl);
    const row = document.createElement('div');
    row.className = 'vk-cp-swatch-row';
    popover.appendChild(row);
    return row;
  }
  const recentRow  = addSection('Recent');
  const paletteRow = addSection('Palette');
  const savedRow   = addSection('Saved');
  const noneRow = addSection('None');
  const noneSwatchBtn = document.createElement('button');
  noneSwatchBtn.className = 'vk-cp-color-swatch vk-cp-none-swatch';
  noneSwatchBtn.title = 'No color';
  noneSwatchBtn.textContent = '⌀';
  noneSwatchBtn.addEventListener('click', () => {
    isNone = true;
    swatchBtn.classList.add('is-none');
    onNone();
    popover.style.display = 'none';
  });
  noneRow.appendChild(noneSwatchBtn);


  const addCurrentBtn = document.createElement('button');
  addCurrentBtn.type = 'button';
  addCurrentBtn.className = 'vk-cp-add-btn';
  addCurrentBtn.textContent = '+ Add Current';
  popover.appendChild(addCurrentBtn);

  function makeSwatch(hex, onClick) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'vk-cp-color-swatch';
    sw.style.background = hex;
    sw.title = hex;
    sw.addEventListener('click', onClick);
    return sw;
  }

  function renderRecent() {
    recentRow.innerHTML = '';
    for (const hex of loadList(RECENT_KEY)) recentRow.appendChild(makeSwatch(hex, () => setFromHex(hex, true)));
  }
  function renderSaved() {
    savedRow.innerHTML = '';
    for (const hex of loadList(SAVED_KEY)) savedRow.appendChild(makeSwatch(hex, () => setFromHex(hex, true)));
  }
  function renderPalette() {
    paletteRow.innerHTML = '';
    for (const hex of PALETTE) paletteRow.appendChild(makeSwatch(hex, () => setFromHex(hex, true)));
  }

  function pushRecent(hex) {
    let list = loadList(RECENT_KEY).filter(c => c.toLowerCase() !== hex.toLowerCase());
    list.unshift(hex);
    if (list.length > MAX_RECENT) list.length = MAX_RECENT;
    saveList(RECENT_KEY, list);
    renderRecent();
  }

  function pushSaved(hex) {
    let list = loadList(SAVED_KEY).filter(c => c.toLowerCase() !== hex.toLowerCase());
    list.unshift(hex);
    if (list.length > MAX_SAVED) list.length = MAX_SAVED;
    saveList(SAVED_KEY, list);
    renderSaved();
  }

  // ── Render / emit ─────────────────────────────────────────────────────────
  function updateVisuals() {
    svGradient.style.background =
      `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h}, 100%, 50%))`;
    svThumb.style.left = `${s * 100}%`;
    svThumb.style.top  = `${(1 - v) * 100}%`;
    hueInput.value = h;
    swatchBtn.classList.remove('is-none');
  }

  function emit(commitToExternal) {
    isNone = false; // emit() always represents picking a real colour, not "None"
    const rgb = hsvToRgb(h, s, v);
    currentHex = rgbToHex(rgb.r, rgb.g, rgb.b);
    swatchBtn.style.background = currentHex;
    hexInput.value = currentHex;
    updateVisuals();
    onChange(currentHex);

    // Ambient recent-history bookkeeping — debounced like the reference,
    // independent of whether this particular emit is an external commit.
    clearTimeout(recentSaveTimer);
    recentSaveTimer = setTimeout(() => pushRecent(currentHex), RECENT_SAVE_DEBOUNCE_MS);

    if (commitToExternal) onCommit(currentHex);
  }

  function setFromHex(hex, commit) {
    const rgb = hexToRgb(hex);
    ({ h, s, v } = rgbToHsv(rgb.r, rgb.g, rgb.b));
    emit(commit);
  }

  // ── SV drag — pointer capture, ported from reference ─────────────────────
  function setSV(clientX, clientY) {
    const r = svArea.getBoundingClientRect();
    s = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    v = Math.min(1, Math.max(0, 1 - (clientY - r.top) / r.height));
    emit(false);
  }
  svArea.addEventListener('pointerdown', (e) => {
    svArea.setPointerCapture(e.pointerId);
    setSV(e.clientX, e.clientY);
  });
  svArea.addEventListener('pointermove', (e) => { if (e.buttons) setSV(e.clientX, e.clientY); });
  svArea.addEventListener('pointerup', () => emit(true)); // commit on release — required by §6's wiring

  hueInput.addEventListener('input',  () => { h = parseFloat(hueInput.value); emit(false); });
  hueInput.addEventListener('change', () => emit(true)); // native range fires 'change' on release

  hexInput.addEventListener('change', () => {
    const val = hexInput.value.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(val)) setFromHex(val.startsWith('#') ? val : `#${val}`, true);
    else hexInput.value = currentHex;
  });

  addCurrentBtn.addEventListener('click', () => pushSaved(currentHex));


  renderRecent();
  renderPalette();
  renderSaved();
  emit(false); // initial paint, no external commit

  return {
    setColor: hex => setFromHex(hex, false),
    getColor: () => isNone ? 'none' : currentHex,
    destroy: () => { containerEl.innerHTML = ''; popover.remove(); },
  };
}
