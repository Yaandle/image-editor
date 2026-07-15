// Renders the document model into the live <svg id="canvas">.
// This *is* the exportable artwork — what you see is what you export.

const svgNS = "http://www.w3.org/2000/svg";
const canvasEl = document.getElementById("canvas");
const TAGS = { rect:"rect", ellipse:"ellipse", line:"line", path:"path", text:"text", image:"image" };

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
  renderSelectionOverlay();
}

function buildElement(obj) {
  const el = document.createElementNS(svgNS, TAGS[obj.type]);
  for (const [k, v] of Object.entries(obj.attrs)) {
    if (k === "content") continue;
    el.setAttribute(k, v);
  }
  if (obj.type === "text") el.textContent = obj.attrs.content ?? "";
  el.dataset.id = obj.id;
  return el;
}

function renderSelectionOverlay() {
  document.getElementById("selection-overlay")?.remove();
  if (!doc.selectedId) return;
  const el = canvasEl.querySelector(`[data-id="${doc.selectedId}"]`);
  if (!el) return;
  const bb = el.getBBox();

  const overlay = document.createElementNS(svgNS, "g");
  overlay.id = "selection-overlay";
  const box = document.createElementNS(svgNS, "rect");
  box.setAttribute("x", bb.x); box.setAttribute("y", bb.y);
  box.setAttribute("width", bb.width); box.setAttribute("height", bb.height);
  box.setAttribute("class", "selection-box");
  overlay.appendChild(box);

  const corners = [[bb.x,bb.y],[bb.x+bb.width,bb.y],[bb.x,bb.y+bb.height],[bb.x+bb.width,bb.y+bb.height]];
  ["nw","ne","sw","se"].forEach((name, i) => {
    const h = document.createElementNS(svgNS, "circle");
    h.setAttribute("cx", corners[i][0]); h.setAttribute("cy", corners[i][1]); h.setAttribute("r", 5);
    h.setAttribute("class", "selection-handle");
    h.dataset.handle = name;
    overlay.appendChild(h);
  });
  canvasEl.appendChild(overlay);
}

function toDocPoint(evt) {
  const pt = canvasEl.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  return pt.matrixTransform(canvasEl.getScreenCTM().inverse());
}