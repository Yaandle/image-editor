// The scene graph. Objects store raw SVG attributes so the same model
// renders live AND serializes straight to <svg> markup — no separate
// export renderer to keep in sync with the canvas.

let doc = null;
let undoStack = [];
let redoStack = [];
const MAX_HISTORY = 60;

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function newDocument(width = 900, height = 600) {
  const layer = { id: uid(), name: "Layer 1", visible: true, objects: [] };
  return { width, height, layers: [layer], activeLayerId: layer.id, selectedId: null };
}

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

function addObject(obj) {
  activeLayer().objects.push(obj);
  return obj;
}

function removeObject(id) {
  for (const layer of doc.layers) {
    const i = layer.objects.findIndex(o => o.id === id);
    if (i >= 0) { layer.objects.splice(i, 1); return; }
  }
}

// snapshot-based undo/redo — simple and cheap at prototype scale
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