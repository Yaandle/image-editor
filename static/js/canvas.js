// canvas.js
// Renders the document model into the live <svg id="canvas">.
// This *is* the exportable artwork — what you see is what you export.
//
// Architecture invariant: objects store raw SVG attributes and are copied
// straight onto the element. Rotation is the sole exception — it's applied
// as a transform in a second pass, after DOM attach, so getBBox() reads
// correctly before rotation is applied.

const svgNS = "http://www.w3.org/2000/svg";
const canvasEl = document.getElementById("canvas");
const TAGS = { rect: "rect", ellipse: "ellipse", line: "line", path: "path", text: "text", image: "image" };

// Neo-morphism surface tokens — injected once. Soft, low-contrast, dual
// shadow (light + dark) rather than the old neo-brutalist hard border.
// Kept here since canvas.js owns the canvas chrome; panels.js/tools.js
// reference these same custom properties for handles/toolbar consistency.
function ensureCanvasStyles() {
  if (document.getElementById("inkkit-canvas-styles")) return;
  const style = document.createElement("style");
  style.id = "inkkit-canvas-styles";
  style.textContent = `
    :root {
      --nm-bg: #e8e6e3;
      --nm-surface: #ececea;
      --nm-shadow-dark: #c7c5c2;
      --nm-shadow-light: #ffffff;
      --nm-accent: #5b8def;
      --nm-accent-soft: rgba(91, 141, 239, 0.25);
      --nm-handle-fill: #f4f3f1;
      --nm-handle-stroke: #b9b7b3;
      --nm-radius: 10px;
    }
    #canvas-frame {
      background: var(--nm-bg);
      border-radius: var(--nm-radius);
      box-shadow: 8px 8px 16px var(--nm-shadow-dark), -8px -8px 16px var(--nm-shadow-light);
      padding: 16px;
      display: inline-block;
    }
    #canvas {
      background-color: #ffffff;
      background-image:
        linear-gradient(45deg, #f0f0ef 25%, transparent 25%),
        linear-gradient(-45deg, #f0f0ef 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #f0f0ef 75%),
        linear-gradient(-45deg, transparent 75%, #f0f0ef 75%);
      background-size: 16px 16px;
      background-position: 0 0, 0 8px, 8px -8px, -8px 0px;
      border-radius: 4px;
      display: block;
    }
    .selection-box {
      fill: none;
      stroke: var(--nm-accent);
      stroke-width: 1.5;
      stroke-dasharray: 4 3;
      pointer-events: none;
      vector-effect: non-scaling-stroke;
    }
    .selection-box-member {
      fill: none;
      stroke: var(--nm-accent);
      stroke-width: 1;
      stroke-dasharray: 2 2;
      opacity: 0.6;
      pointer-events: none;
      vector-effect: non-scaling-stroke;
    }
    .selection-handle {
      fill: var(--nm-handle-fill);
      stroke: var(--nm-handle-stroke);
      stroke-width: 1;
      filter: drop-shadow(1px 1px 1px rgba(0,0,0,0.15));
      cursor: pointer;
    }
    .selection-handle:hover {
      fill: var(--nm-accent-soft);
      stroke: var(--nm-accent);
    }
    .rotation-stem {
      stroke: var(--nm-handle-stroke);
      stroke-width: 1;
      stroke-dasharray: 2 2;
      pointer-events: none;
      vector-effect: non-scaling-stroke;
    }
    .rotation-handle {
      fill: var(--nm-handle-fill);
      stroke: var(--nm-accent);
      stroke-width: 1;
      filter: drop-shadow(1px 1px 1px rgba(0,0,0,0.15));
      cursor: grab;
    }
    .rotation-handle:hover { fill: var(--nm-accent-soft); }
    .rotation-handle:active { cursor: grabbing; }
    .broken-image-placeholder rect {
      fill: #f4f3f1;
      stroke: #c7c5c2;
      stroke-width: 1;
      stroke-dasharray: 4 2;
    }
    .broken-image-placeholder text {
      fill: #9a9894;
      font-size: 11px;
      font-family: system-ui, sans-serif;
    }
  `;
  document.head.appendChild(style);
}

function renderDoc() {
  ensureCanvasStyles();

  canvasEl.setAttribute("width", doc.width);
  canvasEl.setAttribute("height", doc.height);
  canvasEl.setAttribute("viewBox", `0 0 ${doc.width} ${doc.height}`);
  canvasEl.innerHTML = "";

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

function num(v) {
  return typeof v === "number" ? v : parseFloat(v) || 0;
}

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

function appendResizeHandles(overlay, gb) {
  const corners = {
    nw: [gb.x, gb.y],
    ne: [gb.x + gb.width, gb.y],
    sw: [gb.x, gb.y + gb.height],
    se: [gb.x + gb.width, gb.y + gb.height]
  };
  for (const name of Object.keys(corners)) {
    const [cx, cy] = corners[name];
    const h = document.createElementNS(svgNS, "circle");
    h.setAttribute("cx", cx); h.setAttribute("cy", cy); h.setAttribute("r", 5);
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