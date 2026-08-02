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
    for (const obj of layer.objects) g.appendChild(buildElement(obj));
    canvasEl.appendChild(g);
  }

  applyPendingRotations();
  renderSelectionOverlay();

  // panels.js — keeps the Properties panel's width/height inputs reflecting
  // doc.width/doc.height after resize, undo/redo, load, or new-document.
  // Same single-hook approach as syncPropertyPanelToSelection() below.
  syncCanvasPropertiesPanel();

  // canUndo()/canRedo() (document.js) existed but nothing ever called them —
  // the Undo/Redo buttons stayed permanently clickable even with an empty
  // stack. Same single-render-hook pattern as the two syncs above.
  updateUndoRedoButtons();
}

// Splits out of renderDoc() so tools.js can call it standalone after a
// live drag ends without re-running the full document rebuild.
function applyPendingRotations() {
  canvasEl.querySelectorAll("[data-pending-rotation]").forEach(el => {
    const deg = el.dataset.pendingRotation;
    const bb = el.getBBox();
    const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
    el.setAttribute("transform", `rotate(${deg} ${cx} ${cy})`);
    delete el.dataset.pendingRotation;
  });
}

function buildElement(obj) {
  if (obj.type === "image" && !obj.attrs.href && !obj.attrs["xlink:href"]) {
    return buildBrokenImagePlaceholder(obj);
  }

  const el = document.createElementNS(svgNS, TAGS[obj.type]);
  for (const [k, v] of Object.entries(obj.attrs)) {
    if (k === "content" || k === "rotation") continue;
    el.setAttribute(k, v);
  }
  if (obj.type === "text") el.textContent = obj.attrs.content ?? "";
  el.dataset.id = obj.id;
  el.dataset.type = obj.type;

  const deg = getRotation(obj);
  if (deg) {
    // applied after DOM attach so getBBox() reads pre-rotation — see applyPendingRotations()
    el.dataset.pendingRotation = deg;
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
  if (deg) g.dataset.pendingRotation = deg;
  return g;
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