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

function renderDoc() {
  canvasEl.setAttribute("width", doc.width);
  canvasEl.setAttribute("height", doc.height);
  canvasEl.setAttribute("viewBox", `0 0 ${doc.width} ${doc.height}`);
  canvasEl.innerHTML = "";

  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    const g = document.createElementNS(svgNS, "g");
    g.dataset.layerId = layer.id;
    for (const obj of layer.objects) g.appendChild(buildElement(obj));
    canvasEl.appendChild(g);
  }

  // second pass: apply rotation transforms now that bboxes are measurable
  canvasEl.querySelectorAll("[data-pending-rotation]").forEach(el => {
    const deg = el.dataset.pendingRotation;
    const bb = el.getBBox();
    const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
    el.setAttribute("transform", `rotate(${deg} ${cx} ${cy})`);
    delete el.dataset.pendingRotation;
  });

  renderSelectionOverlay();
}

function buildElement(obj) {
  const el = document.createElementNS(svgNS, TAGS[obj.type]);
  for (const [k, v] of Object.entries(obj.attrs)) {
    if (k === "content" || k === "rotation") continue;
    el.setAttribute(k, v);
  }
  if (obj.type === "text") el.textContent = obj.attrs.content ?? "";
  el.dataset.id = obj.id;

  const deg = getRotation(obj);
  if (deg) {
    // apply after the element is in the DOM so getBBox() works — see renderDoc()
    el.dataset.pendingRotation = deg;
  }
  return el;
}

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

  const gx = Math.min(...boxes.map(b => b.x));
  const gy = Math.min(...boxes.map(b => b.y));
  const gx1 = Math.max(...boxes.map(b => b.x + b.width));
  const gy1 = Math.max(...boxes.map(b => b.y + b.height));
  const gb = { x: gx, y: gy, width: gx1 - gx, height: gy1 - gy };

  const box = document.createElementNS(svgNS, "rect");
  box.setAttribute("x", gb.x); box.setAttribute("y", gb.y);
  box.setAttribute("width", gb.width); box.setAttribute("height", gb.height);
  box.setAttribute("class", "selection-box");
  overlay.appendChild(box);

  const corners = [[gb.x, gb.y], [gb.x + gb.width, gb.y], [gb.x, gb.y + gb.height], [gb.x + gb.width, gb.y + gb.height]];
  ["nw", "ne", "sw", "se"].forEach((name, i) => {
    const h = document.createElementNS(svgNS, "circle");
    h.setAttribute("cx", corners[i][0]); h.setAttribute("cy", corners[i][1]); h.setAttribute("r", 5);
    h.setAttribute("class", "selection-handle");
    h.dataset.handle = name;
    overlay.appendChild(h);
  });

  // rotation handle: single-select only
  if (doc.selectedIds.length === 1) {
    const rx = gb.x + gb.width / 2, ry = gb.y - 20;
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
  canvasEl.appendChild(overlay);
}

function toDocPoint(evt) {
  const pt = canvasEl.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  return pt.matrixTransform(canvasEl.getScreenCTM().inverse());
}