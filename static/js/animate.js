// animate.js
// Deterministic enter/exit animation engine — JS-computed opacity/transform/
// filter for a given elapsed time `t`, rather than CSS @keyframes. Two
// consumers share this exact function: the live rAF Play loop below, and
// export.js's GIF capture path for pages with shape/text animations. Both
// need the *identical* state for a given elapsed time, which independently-
// running CSS keyframes sampled by a screenshot can't guarantee frame to
// frame — same root reason (see canvas.js/export.js headers) that animated
// GIFs loaded fresh via <img> don't reliably resume CSS animation state.

// ---- easing ----------------------------------------------------------

const EASINGS = {
  linear: t => t,
  "ease-out": t => 1 - Math.pow(1 - t, 3),
  "ease-in": t => t * t * t,
  "ease-in-out": t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  bounce: t => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
};

// Enter/exit effect catalog — deliberately whole-object effects (fade,
// slide, scale, rotate, blur) rather than the reference tool's per-character
// text effects (typewriter, char-stagger): this engine animates any object
// type (shape/image/text) as one unit via a wrapper <g>, not text runs split
// into spans, so per-glyph effects don't have an equivalent here. Flagged,
// not silently dropped — if per-character text animation is wanted later
// (e.g. once this shares an engine with the video editor), it needs its own
// text-splitting renderer, not just a new entry in this table.
const ANIM_TYPES = [
  { value: "none", label: "None" },
  { value: "fade", label: "Fade" },
  { value: "slide-up", label: "Slide up" },
  { value: "slide-down", label: "Slide down" },
  { value: "slide-left", label: "Slide left" },
  { value: "slide-right", label: "Slide right" },
  { value: "scale-pop", label: "Scale pop" },
  { value: "rotate-in", label: "Rotate in" },
  { value: "blur-in", label: "Blur in" },
];

const EASING_TYPES = [
  { value: "ease-out", label: "Ease out" },
  { value: "ease-in", label: "Ease in" },
  { value: "ease-in-out", label: "Ease in-out" },
  { value: "linear", label: "Linear" },
  { value: "bounce", label: "Bounce" },
];

const SLIDE_DISTANCE = 40; // px, in document units

// Returns { opacity, transform, filter } for effect `type` at progress q
// (0 = fully hidden/offset, 1 = fully shown). "exit" is just this same table
// played with q going 1 -> 0 (see objectAnimState), so there's one effect
// definition per type, not a separate mirrored one for entering vs leaving.
function effectState(type, q) {
  const state = { opacity: 1, transform: "", filter: "" };
  switch (type) {
    case "fade":
      state.opacity = q;
      break;
    case "slide-up":
      state.opacity = q;
      state.transform = `translateY(${(1 - q) * SLIDE_DISTANCE}px)`;
      break;
    case "slide-down":
      state.opacity = q;
      state.transform = `translateY(${-(1 - q) * SLIDE_DISTANCE}px)`;
      break;
    case "slide-left":
      state.opacity = q;
      state.transform = `translateX(${(1 - q) * SLIDE_DISTANCE}px)`;
      break;
    case "slide-right":
      state.opacity = q;
      state.transform = `translateX(${-(1 - q) * SLIDE_DISTANCE}px)`;
      break;
    case "scale-pop":
      state.opacity = q;
      state.transform = `scale(${0.5 + q * 0.5})`;
      break;
    case "rotate-in":
      state.opacity = q;
      state.transform = `rotate(${(1 - q) * -25}deg)`;
      break;
    case "blur-in":
      state.opacity = q;
      state.filter = `blur(${(1 - q) * 8}px)`;
      break;
    default:
      break; // "none" (shouldn't reach here — callers filter these out first)
  }
  return state;
}

// ---- per-object timeline -----------------------------------------------
// One object's cycle: [enter.delay][enter.duration] -> [hold] ->
// [exit.delay][exit.duration] -> (loop back to 0, if doc.animLoop).
// Either phase can be absent (type "none"), in which case that segment
// collapses to zero length and the object just holds at "fully shown"
// through it (enter-only: shows then stays; exit-only: starts shown then
// leaves; neither: never gets a wrapper at all, see canvas.js).

function phaseWindow(phase) {
  if (!phase || phase.type === "none") return { active: false, delay: 0, duration: 0 };
  return { active: true, delay: Math.max(0, phase.delay || 0), duration: Math.max(1, phase.duration || 500) };
}

// Total length of one play-through for `obj`, including the doc-level hold —
// used both to know when a looping object should restart and to size a GIF
// capture's frame count to the animation's own natural length.
function cycleLength(obj, holdMs) {
  if (!obj.anim) return 0;
  const enter = phaseWindow(obj.anim.enter);
  const exit = phaseWindow(obj.anim.exit);
  const enterEnd = enter.active ? enter.delay + enter.duration : 0;
  const holdEnd = enterEnd + Math.max(0, holdMs || 0);
  return exit.active ? holdEnd + exit.delay + exit.duration : holdEnd;
}

// The state to render for `obj` at `elapsedMs` into its cycle. Returns null
// if the object has no animation at all (caller should leave it alone).
function objectAnimState(obj, elapsedMs, holdMs) {
  if (!obj.anim) return null;
  const enter = phaseWindow(obj.anim.enter);
  const exit = phaseWindow(obj.anim.exit);
  if (!enter.active && !exit.active) return null;

  const shown = { opacity: 1, transform: "", filter: "" };
  const enterEnd = enter.active ? enter.delay + enter.duration : 0;
  const holdEnd = enterEnd + Math.max(0, holdMs || 0);
  const exitStart = exit.active ? holdEnd + exit.delay : Infinity;
  const exitEnd = exit.active ? exitStart + exit.duration : Infinity;

  const t = elapsedMs;

  if (enter.active && t < enterEnd) {
    if (t < enter.delay) return effectState(obj.anim.enter.type, 0);
    const raw = Math.min(1, (t - enter.delay) / enter.duration);
    const eased = (EASINGS[obj.anim.enter.easing] || EASINGS["ease-out"])(raw);
    return effectState(obj.anim.enter.type, eased);
  }

  if (t < exitStart) return shown; // holding, fully visible

  if (exit.active && t < exitEnd) {
    const raw = Math.min(1, (t - exitStart) / exit.duration);
    const eased = (EASINGS[obj.anim.exit.easing] || EASINGS["ease-out"])(raw);
    return effectState(obj.anim.exit.type, 1 - eased);
  }

  return exit.active ? effectState(obj.anim.exit.type, 0) : shown; // past the end
}

function applyAnimState(wrapEl, state) {
  if (!wrapEl || !state) return;
  wrapEl.style.opacity = state.opacity;
  wrapEl.style.transform = state.transform || "";
  wrapEl.style.filter = state.filter || "";
}

// Puts every animated object on `pageEl` back to its resting (fully-shown,
// no transform) state — used when stopping playback and before/after a GIF
// capture pass, so a half-animated frame is never left on screen or baked
// into a subsequent static export.
function resetAnimStyles(pageEl) {
  pageEl.querySelectorAll(".anim-wrap").forEach(w => {
    w.style.opacity = ""; w.style.transform = ""; w.style.filter = "";
  });
}

function collectAnimatedObjects(pageDoc) {
  const out = [];
  for (const layer of pageDoc.layers) {
    for (const obj of layer.objects) if (objectHasAnim(obj)) out.push(obj);
  }
  return out;
}

// ---- live playback (rAF) ------------------------------------------------
// Plays the page that was active when Play was pressed, in place on its
// real canvas — "hit play, it runs a render of it," not a separate preview
// surface. Every animated object on that page starts together at Play's
// t=0; each object's own delay/duration/hold/exit governs its motion within
// that one shared clock (doc.animHold/doc.animLoop are page-level so the
// whole page's cast enters/holds/exits on one consistent rhythm, matching
// how a LinkedIn carousel slide's reveal is usually choreographed as a
// single sequence rather than N independent clocks).

let playRAF = null;
let playStart = 0;
let playingPage = null;

function isPlaying() {
  return playRAF != null;
}

function startPlayback() {
  stopPlayback();
  const page = getPage(activePageId);
  if (!page) return;
  const animated = collectAnimatedObjects(page.doc);
  if (!animated.length) { flashStatus("No animated objects on this page — set an Enter/Exit effect first"); return; }

  const holdMs = page.doc.animHold ?? 1500;
  const loop = page.doc.animLoop !== false;
  const cycleMs = Math.max(1, ...animated.map(o => cycleLength(o, holdMs)));

  playingPage = page;
  playStart = performance.now();
  setPlayButtonState(true);

  const tick = now => {
    let elapsed = now - playStart;
    if (elapsed > cycleMs) {
      if (!loop) { stopPlayback(); return; }
      playStart = now;
      elapsed = 0;
    }
    for (const obj of animated) {
      const wrap = page.svgEl.querySelector(`.anim-wrap[data-anim-for="${obj.id}"]`);
      applyAnimState(wrap, objectAnimState(obj, elapsed, holdMs));
    }
    playRAF = requestAnimationFrame(tick);
  };
  playRAF = requestAnimationFrame(tick);
}

function stopPlayback() {
  if (playRAF) cancelAnimationFrame(playRAF);
  playRAF = null;
  playingPage = null;
  setPlayButtonState(false);
  // Reset every mounted page, not just the one that was playing — covers
  // "switched pages mid-play then hit Stop/Export" without extra bookkeeping.
  for (const page of pages) resetAnimStyles(page.svgEl);
}

function togglePlayback() {
  if (isPlaying()) stopPlayback();
  else startPlayback();
}
