// document.js
// The scene graph. Objects store raw SVG attributes so the same model
// renders live AND serializes straight to <svg> markup — no separate
// export renderer to keep in sync with the canvas.
//
// Exception: rotation is stored in attrs.rotation but applied as an SVG
// transform at render time (see canvas.js) rather than copied as a raw
// attribute — the only attribute allowed to break the "no transforms" rule.

let doc = null;
let undoStack = [];
let redoStack = [];
const MAX_HISTORY = 60;

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function newDocument(width = 900, height = 600) {
  const layer = { id: uid(), name: "Layer 1", visible: true, objects: [] };
  return { width, height, layers: [layer], activeLayerId: layer.id, selectedIds: [] };
}

// ---- selection helpers -----------------------------------------------

function selectedObjects() {
  return doc.selectedIds.map(id => findObject(id)?.obj).filter(Boolean);
}

function selectOnly(id) {
  doc.selectedIds = id ? [id] : [];
}

function toggleSelection(id) {
  doc.selectedIds = doc.selectedIds.includes(id)
    ? doc.selectedIds.filter(x => x !== id)
    : [...doc.selectedIds, id];
}

function clearSelection() {
  doc.selectedIds = [];
}

// ---- layer / object lookup ---------------------------------------------

function activeLayer() {
  return doc.layers.find(l => l.id === doc.activeLayerId) || doc.layers[0];
}

function findObject(id) {
  for (const layer of doc.layers) {
    const obj = layer.objects.find(o => o.id === id);
    if (obj) return { obj, layer };
  }
  return null;
}

function findLayer(id) {
  return doc.layers.find(l => l.id === id) || null;
}

function addObject(obj) {
  activeLayer().objects.push(obj);
  return obj;
}

function removeObject(id) {
  for (const layer of doc.layers) {
    const i = layer.objects.findIndex(o => o.id === id);
    if (i >= 0) { layer.objects.splice(i, 1); return true; }
  }
  return false;
}

// ---- rotation ------------------------------------------------------------

function getRotation(obj) {
  return obj.attrs.rotation ? parseFloat(obj.attrs.rotation) : 0;
}

function setRotation(obj, deg) {
  obj.attrs.rotation = deg;
}

function bboxCenter(bbox) {
  return { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
}

// ---- object z-order --------------------------------------------------

function bringForward(id) {
  const found = findObject(id);
  if (!found) return;
  const { obj, layer } = found;
  const i = layer.objects.indexOf(obj);
  if (i < layer.objects.length - 1) {
    layer.objects.splice(i, 1);
    layer.objects.splice(i + 1, 0, obj);
  }
}

function sendBackward(id) {
  const found = findObject(id);
  if (!found) return;
  const { obj, layer } = found;
  const i = layer.objects.indexOf(obj);
  if (i > 0) {
    layer.objects.splice(i, 1);
    layer.objects.splice(i - 1, 0, obj);
  }
}

function bringToFront(id) {
  const found = findObject(id);
  if (!found) return;
  const { obj, layer } = found;
  layer.objects.splice(layer.objects.indexOf(obj), 1);
  layer.objects.push(obj);
}

function sendToBack(id) {
  const found = findObject(id);
  if (!found) return;
  const { obj, layer } = found;
  layer.objects.splice(layer.objects.indexOf(obj), 1);
  layer.objects.unshift(obj);
}

// ---- layer reorder -----------------------------------------------------
// direction: -1 moves toward back (index 0), +1 moves toward front

function moveLayer(layerId, direction) {
  const i = doc.layers.findIndex(l => l.id === layerId);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= doc.layers.length) return false;
  [doc.layers[i], doc.layers[j]] = [doc.layers[j], doc.layers[i]];
  return true;
}

// Move a layer to an explicit array index — used by drag-to-reorder in
// panels.js, which needs from/to positions validated before splicing.
function moveLayerToIndex(fromIndex, toIndex) {
  if (
    fromIndex < 0 || toIndex < 0 ||
    fromIndex >= doc.layers.length || toIndex >= doc.layers.length ||
    fromIndex === toIndex
  ) return false;
  const [moved] = doc.layers.splice(fromIndex, 1);
  doc.layers.splice(toIndex, 0, moved);
  return true;
}

// ---- undo/redo -----------------------------------------------------------
// snapshot-based — simple and cheap at prototype scale, capped at
// MAX_HISTORY. Known not to scale to large documents; flagged, not fixed.

function pushUndo() {
  undoStack.push(JSON.stringify(doc));
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(doc));
  doc = JSON.parse(undoStack.pop());
  renderDoc(); renderLayers();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(doc));
  doc = JSON.parse(redoStack.pop());
  renderDoc(); renderLayers();
}