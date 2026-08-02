// canvas.js
// Renders the document model into the live <svg id="canvas">.
// This *is* the exportable artwork — what you see is what you export.
//
// Architecture invariant: objects store raw SVG attributes and are copied
// straight onto the element. Rotation is the sole exception — it's applied
// as a transform in a second pass, after DOM attach, so getBBox() reads
// correctly before rotation is applied.

const svgNS = "http://www.w3.org/2000/svg";
// Multi-page: was `const canvasEl = document.getElementById("canvas")` when
// there was exactly one <svg> in the whole app. Now every page has its own
// <svg> (pages.js), and canvasEl means "whichever page's svg is currently
// active" — pages.js reassigns it on every page switch. Every function below
// still just reads bare `canvasEl`, unchanged from before pages existed.
let canvasEl = null;
const TAGS = { rect: "rect", ellipse: "ellipse", line: "line", path: "path", text: "text", image: "image" };

// All chrome/overlay styling lives in style.css and reads the shared
// design tokens — this file only assigns class names.

function renderDoc() {
  canvasEl.setAttribute("width", doc.width);
  canvasEl.setAttribute("height", doc.height);
  canvasEl.setAttribute("viewBox", `0 0 ${doc.width} ${doc.height}`);
  // Zoom (pages.js's viewZoom) is applied as a CSS size, not a CSS transform —
  // transform wouldn't affect layout, so the page-stack wouldn't reflow/scroll
  // correctly as you zoom. Setting the rendered CSS size while the SVG's own
  // width/height attrs (above) stay at the true doc size means viewBox does
  // the scaling — and since toDocPoint()/toScreenPoint() already go through
  // getScreenCTM(), which reflects whatever size the browser is actually
  // rendering the element at, zoom needs zero changes to any pointer math.
  canvasEl.style.width = (doc.width * viewZoom) + "px";
  canvasEl.style.height = (doc.height * viewZoom) + "px";
  canvasEl.innerHTML = "";

  // Background fill (doc.background) — a plain rect, not a layer object:
  // regenerated from doc.background every render rather than stored in
  // layers, so it never shows up in selection/hit-testing/allObjectIds() and
  // never needs special-casing in undo (it's just data on doc, like width).
  if (doc.background) {
    const bg = document.createElementNS(svgNS, "rect");
    bg.setAttribute("x", 0); bg.setAttribute("y", 0);
    bg.setAttribute("width", doc.width); bg.setAttribute("height", doc.height);
    bg.setAttribute("fill", doc.background);
    bg.setAttribute("data-role", "background");
    bg.style.pointerEvents = "none";
    canvasEl.appendChild(bg);
  }

  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    const g = document.createElementNS(svgNS, "g");
    g.dataset.layerId = layer.id;
    if (layer.id === doc.activeLayerId) g.dataset.activeLayer = "true";
    for (const obj of layer.objects) g.appendChild(wrapForAnim(buildElement(obj), obj));
    canvasEl.appendChild(g);
  }

  applyPendingTransforms();
  renderSelectionOverlay();
  renderCropOverlay();

  // panels.js — keeps the Properties panel's width/height inputs reflecting
  // doc.width/doc.height after resize, undo/redo, load, or new-document.
  // Same single-hook approach as syncPropertyPanelToSelection() below.
  syncCanvasPropertiesPanel();

  // canUndo()/canRedo() (document.js) existed but nothing ever called them —
  // the Undo/Redo buttons stayed permanently clickable even with an empty
  // stack. Same single-render-hook pattern as the two syncs above.
  updateUndoRedoButtons();

  // tools.js — shows/hides the Arrange/Adjustments/Crop cards. Deliberately
  // called here (every render) rather than only from renderSelectionOverlay,
  // since that function early-returns when the selection is empty and these
  // cards need to hide again in exactly that case.
  syncSelectionDependentPanels();

  // panels.js — Animate card (per-object enter/exit config). Own hook
  // rather than folding into syncSelectionDependentPanels() since it shows
  // for every object type, not just images like Adjustments/Crop.
  syncAnimPanel();
}

// Splits out of renderDoc() so tools.js can call it standalone after a
// live drag ends without re-running the full document rebuild.
//
// Rotation and flip (flipH/flipV) are the only two things this app renders
// as SVG transforms rather than raw attributes (see the file header) — both
// applied here, together, anchored at the same pre-transform bbox center so
// flipping and rotating an object compose around one shared pivot instead of
// each fighting over their own. Order is flip-then-rotate (translate to
// origin, scale for the flip, rotate, translate back) — reads right-to-left.
function applyPendingTransforms() {
  canvasEl.querySelectorAll("[data-pending-transform]").forEach(el => {
    const bb = el.getBBox();
    const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
    const deg = el.dataset.pendingRot || 0;
    const sx = el.dataset.pendingFlipH ? -1 : 1;
    const sy = el.dataset.pendingFlipV ? -1 : 1;
    el.setAttribute("transform", `translate(${cx} ${cy}) rotate(${deg}) scale(${sx} ${sy}) translate(${-cx} ${-cy})`);
    delete el.dataset.pendingTransform;
    delete el.dataset.pendingRot;
    delete el.dataset.pendingFlipH;
    delete el.dataset.pendingFlipV;
  });
}

// Attrs that are stored as raw data on the object but never copied straight
// onto the SVG element as-is — either because they're computed into a
// different attribute (ADJUSTMENT_KEYS -> "filter", flipH/flipV -> the
// transform pass) or because they're handled specially elsewhere (content,
// rotation).
const ADJUSTMENT_KEYS = ["brightness", "contrast", "saturate", "grayscale", "invert"];
const ADJUSTMENT_DEFAULTS = { brightness: 100, contrast: 100, saturate: 100, grayscale: 0, invert: 0 };
const NON_ATTR_KEYS = ["content", "rotation", "flipH", "flipV", ...ADJUSTMENT_KEYS];

// Builds the CSS filter() string for an image's adjustment sliders. Using
// CSS filter functions (not a hand-built <filter> def with feColorMatrix
// chains) because SVG's `filter` presentation attribute accepts them
// directly in every modern browser — and because it's a live filter, not a
// rasterization, an animated GIF underneath keeps animating with the
// adjustment applied. Returns null when every value is still at its default,
// so unadjusted images don't carry a no-op filter attribute.
function buildAdjustmentFilter(attrs) {
  const v = { ...ADJUSTMENT_DEFAULTS };
  for (const k of ADJUSTMENT_KEYS) if (attrs[k] != null) v[k] = num(attrs[k]);
  const isDefault = ADJUSTMENT_KEYS.every(k => v[k] === ADJUSTMENT_DEFAULTS[k]);
  if (isDefault) return null;
  return `brightness(${v.brightness}%) contrast(${v.contrast}%) saturate(${v.saturate}%) grayscale(${v.grayscale}%) invert(${v.invert}%)`;
}

function buildElement(obj) {
  if (obj.type === "image" && !obj.attrs.href && !obj.attrs["xlink:href"]) {
    return buildBrokenImagePlaceholder(obj);
  }

  const el = document.createElementNS(svgNS, TAGS[obj.type]);
  for (const [k, v] of Object.entries(obj.attrs)) {
    if (NON_ATTR_KEYS.includes(k)) continue;
    el.setAttribute(k, v);
  }
  if (obj.type === "text") el.textContent = obj.attrs.content ?? "";
  if (obj.type === "image") {
    const filter = buildAdjustmentFilter(obj.attrs);
    if (filter) el.setAttribute("filter", filter);
  }
  el.dataset.id = obj.id;
  el.dataset.type = obj.type;

  const deg = getRotation(obj);
  const flip = getFlip(obj);
  if (deg || flip.h || flip.v) {
    // applied after DOM attach so getBBox() reads pre-transform — see applyPendingTransforms()
    el.dataset.pendingTransform = "1";
    if (deg) el.dataset.pendingRot = deg;
    if (flip.h) el.dataset.pendingFlipH = "1";
    if (flip.v) el.dataset.pendingFlipV = "1";
  }
  return el;
}

// MS Paint never silently drops broken content — show a dashed box with a
// label instead of nothing, at the object's stored x/y/width/height.
function buildBrokenImagePlaceholder(obj) {
  const g = document.createElementNS(svgNS, "g");
  g.setAttribute("class", "broken-image-placeholder");
  g.dataset.id = obj.id;
  g.dataset.type = "image";

  const x = num(obj.attrs.x ?? 0), y = num(obj.attrs.y ?? 0);
  const w = num(obj.attrs.width ?? 100), h = num(obj.attrs.height ?? 100);

  const rect = document.createElementNS(svgNS, "rect");
  rect.setAttribute("x", x); rect.setAttribute("y", y);
  rect.setAttribute("width", w); rect.setAttribute("height", h);
  g.appendChild(rect);

  const label = document.createElementNS(svgNS, "text");
  label.setAttribute("x", x + w / 2);
  label.setAttribute("y", y + h / 2);
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("dominant-baseline", "middle");
  label.textContent = "missing image";
  g.appendChild(label);

  const deg = getRotation(obj);
  if (deg) { g.dataset.pendingTransform = "1"; g.dataset.pendingRot = deg; }
  return g;
}

// Wraps an object's rendered element in a <g class="anim-wrap"> when (and
// only when) it actually has an enter/exit animation assigned — animate.js
// applies opacity/transform/filter to this wrapper during Play/GIF capture,
// deliberately never to the object's own element. Reason: rotation/flip
// (applyPendingTransforms, above) already put an SVG transform ATTRIBUTE on
// that element, and a CSS transform PROPERTY on the same element would win
// over it per spec, silently discarding the rotation/flip. A separate
// ancestor node sidesteps the conflict entirely — animate.js only ever
// touches the wrapper's *style*, never its attributes. Objects with no
// animation skip the wrapper altogether, so the common case (nothing
// animated) adds zero extra DOM.
function wrapForAnim(el, obj) {
  if (!objectHasAnim(obj)) return el;
  const wrap = document.createElementNS(svgNS, "g");
  wrap.setAttribute("class", "anim-wrap");
  wrap.dataset.animFor = obj.id;
  wrap.appendChild(el);
  return wrap;
}

// num() is defined once, in document.js — was duplicated verbatim here too.

// ---- selection overlay ---------------------------------------------------

function renderSelectionOverlay() {
  document.getElementById("selection-overlay")?.remove();
  if (!doc.selectedIds.length) return;

  const overlay = document.createElementNS(svgNS, "g");
  overlay.id = "selection-overlay";

  const boxes = doc.selectedIds.map(id => {
    const el = canvasEl.querySelector(`[data-id="${id}"]`);
    return el ? el.getBBox() : null;
  }).filter(Boolean);
  if (!boxes.length) return;

  // tools.js — keeps the fill/stroke/stroke-width panel in sync with
  // whatever's actually selected (bug #2). This is the one function every
  // selection-changing code path already funnels through (full renderDoc()
  // as well as the marquee's live renderSelectionOverlay() calls during
  // drag), so it's a single hook instead of one per call site.
  syncPropertyPanelToSelection();

  if (boxes.length > 1) {
    for (const bb of boxes) {
      const box = document.createElementNS(svgNS, "rect");
      box.setAttribute("x", bb.x); box.setAttribute("y", bb.y);
      box.setAttribute("width", bb.width); box.setAttribute("height", bb.height);
      box.setAttribute("class", "selection-box-member");
      overlay.appendChild(box);
    }
  }

  const gb = groupBBox(boxes);

  const box = document.createElementNS(svgNS, "rect");
  box.setAttribute("x", gb.x); box.setAttribute("y", gb.y);
  box.setAttribute("width", gb.width); box.setAttribute("height", gb.height);
  box.setAttribute("class", "selection-box");
  overlay.appendChild(box);

  appendResizeHandles(overlay, gb);

  // rotation handle: single-select only — rotating a multi-select group
  // around one shared pivot isn't supported yet, flagged not fixed
  if (doc.selectedIds.length === 1) {
    appendRotationHandle(overlay, gb);
  }

  canvasEl.appendChild(overlay);
}

function groupBBox(boxes) {
  const gx = Math.min(...boxes.map(b => b.x));
  const gy = Math.min(...boxes.map(b => b.y));
  const gx1 = Math.max(...boxes.map(b => b.x + b.width));
  const gy1 = Math.max(...boxes.map(b => b.y + b.height));
  return { x: gx, y: gy, width: gx1 - gx, height: gy1 - gy };
}

// Cursor hints let tools.js set the right resize cursor on hover without
// re-deriving handle geometry itself.
const HANDLE_CURSORS = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize" };

const HANDLE_SIZE = 8; // square white handles with blue borders — design system

function appendResizeHandles(overlay, gb) {
  const corners = {
    nw: [gb.x, gb.y],
    ne: [gb.x + gb.width, gb.y],
    sw: [gb.x, gb.y + gb.height],
    se: [gb.x + gb.width, gb.y + gb.height]
  };
  for (const name of Object.keys(corners)) {
    const [cx, cy] = corners[name];
    const h = document.createElementNS(svgNS, "rect");
    h.setAttribute("x", cx - HANDLE_SIZE / 2); h.setAttribute("y", cy - HANDLE_SIZE / 2);
    h.setAttribute("width", HANDLE_SIZE); h.setAttribute("height", HANDLE_SIZE);
    h.setAttribute("class", "selection-handle");
    h.dataset.handle = name;
    h.dataset.cursor = HANDLE_CURSORS[name];
    overlay.appendChild(h);
  }
}

function appendRotationHandle(overlay, gb) {
  const rx = gb.x + gb.width / 2, ry = gb.y - 24;
  const line = document.createElementNS(svgNS, "line");
  line.setAttribute("x1", gb.x + gb.width / 2); line.setAttribute("y1", gb.y);
  line.setAttribute("x2", rx); line.setAttribute("y2", ry);
  line.setAttribute("class", "rotation-stem");
  overlay.appendChild(line);

  const rh = document.createElementNS(svgNS, "circle");
  rh.setAttribute("cx", rx); rh.setAttribute("cy", ry); rh.setAttribute("r", 5);
  rh.setAttribute("class", "rotation-handle");
  rh.dataset.handle = "rotate";
  overlay.appendChild(rh);
}

// ---- crop overlay ---------------------------------------------------------
// cropState (tools.js) is a transient editing mode, not part of doc — it
// never gets pushed to undo history; only applyCrop()'s resulting attribute
// change does. Rendered as its own overlay group, same pattern as
// renderSelectionOverlay(), rebuilt every renderDoc() call.

function renderCropOverlay() {
  document.getElementById("crop-overlay")?.remove();
  if (!cropState) return;

  const { bounds, rect } = cropState;
  const g = document.createElementNS(svgNS, "g");
  g.id = "crop-overlay";

  // Dim the parts of the image's original bounds that fall outside the crop
  // rect — four bars around it rather than a punch-hole clipPath, simpler
  // for this scope and there's no nested clipping elsewhere to reuse.
  const dim = (x, y, w, h) => {
    if (w <= 0.01 || h <= 0.01) return;
    const r = document.createElementNS(svgNS, "rect");
    r.setAttribute("x", x); r.setAttribute("y", y);
    r.setAttribute("width", w); r.setAttribute("height", h);
    r.setAttribute("class", "crop-dim");
    g.appendChild(r);
  };
  dim(bounds.x, bounds.y, bounds.width, rect.y - bounds.y);
  dim(bounds.x, rect.y + rect.height, bounds.width, (bounds.y + bounds.height) - (rect.y + rect.height));
  dim(bounds.x, rect.y, rect.x - bounds.x, rect.height);
  dim(rect.x + rect.width, rect.y, (bounds.x + bounds.width) - (rect.x + rect.width), rect.height);

  const border = document.createElementNS(svgNS, "rect");
  border.setAttribute("x", rect.x); border.setAttribute("y", rect.y);
  border.setAttribute("width", rect.width); border.setAttribute("height", rect.height);
  border.setAttribute("class", "crop-border");
  g.appendChild(border);

  const corners = {
    nw: [rect.x, rect.y], ne: [rect.x + rect.width, rect.y],
    sw: [rect.x, rect.y + rect.height], se: [rect.x + rect.width, rect.y + rect.height],
  };
  for (const name of Object.keys(corners)) {
    const [cx, cy] = corners[name];
    const h = document.createElementNS(svgNS, "rect");
    h.setAttribute("x", cx - HANDLE_SIZE / 2); h.setAttribute("y", cy - HANDLE_SIZE / 2);
    h.setAttribute("width", HANDLE_SIZE); h.setAttribute("height", HANDLE_SIZE);
    h.setAttribute("class", "crop-handle");
    h.dataset.cropHandle = name;
    h.dataset.cursor = HANDLE_CURSORS[name];
    g.appendChild(h);
  }

  canvasEl.appendChild(g);
}

// ---- geometry helpers for tools.js ---------------------------------------

// Pre-rotation bbox of a single object — resize math needs the unrotated
// box even when the object has a rotation applied, since the transform is
// stripped from getBBox()'s own coordinate space by design (SVG bboxes are
// local-space, pre-transform, already). Exposed here so tools.js doesn't
// have to know about the pending-rotation dance.
function getObjectBBox(id) {
  const el = canvasEl.querySelector(`[data-id="${id}"]`);
  return el ? el.getBBox() : null;
}

// Screen (client) coordinates → document/SVG coordinates. Every tool's
// pointer handler starts here.
function toDocPoint(evt) {
  const pt = canvasEl.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  return pt.matrixTransform(canvasEl.getScreenCTM().inverse());
}

// Document coordinates → screen (client) coordinates — needed for
// positioning HTML overlays (e.g. an in-place text-edit <input>) exactly
// atop an SVG element.
function toScreenPoint(x, y) {
  const pt = canvasEl.createSVGPoint();
  pt.x = x; pt.y = y;
  return pt.matrixTransform(canvasEl.getScreenCTM());
}