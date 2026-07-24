// document.js
// The scene graph. Objects store raw SVG attributes so the same model
// renders live AND serializes straight to <svg> markup — no separate
// export renderer to keep in sync with the canvas.
//
// Exception: rotation is stored in attrs.rotation but applied as an SVG
// transform at render time (see canvas.js) rather than copied as a raw
// attribute — the only attribute allowed to break the "no transforms" rule.
//
// selectedIds is always an array. Never assign doc.selectedId (singular) —
// that bug has been fixed twice already (setTool, shapeTool.up, pen.finish).

let doc = null;
let undoStack = [];
let redoStack = [];
const MAX_HISTORY = 60;

let _uidCounter = 0;
function uid() {
  _uidCounter = (_uidCounter + 1) % 1e6;
  return Math.random().toString(36).slice(2, 9) + _uidCounter.toString(36);
}

function newDocument(width = 900, height = 600) {
  const layer = { id: uid(), name: "Layer 1", visible: true, objects: [] };
  doc = { width, height, layers: [layer], activeLayerId: layer.id, selectedIds: [] };
  undoStack = [];
  redoStack = [];
  return doc;
}

// ---- selection helpers -----------------------------------------------

function selectedObjects() {
  if (!doc) return [];
  return doc.selectedIds.map(id => findObject(id)?.obj).filter(Boolean);
}

function selectOnly(id) {
  if (!doc) return;
  doc.selectedIds = id ? [id] : [];
}

function toggleSelection(id) {
  if (!doc) return;
  doc.selectedIds = doc.selectedIds.includes(id)
    ? doc.selectedIds.filter(x => x !== id)
    : [...doc.selectedIds, id];
}

function clearSelection() {
  if (!doc) return;
  doc.selectedIds = [];
}

// Drop any selected ids that no longer resolve to a live object.
// Called after object/layer removal so selectedIds never goes stale.
function pruneSelection() {
  if (!doc) return;
  doc.selectedIds = doc.selectedIds.filter(id => !!findObject(id));
}

// ---- layer / object lookup ---------------------------------------------

function activeLayer() {
  if (!doc) return null;
  return doc.layers.find(l => l.id === doc.activeLayerId) || doc.layers[0];
}

// Returns { obj, layer } by reference — mutate obj.attrs directly for
// live-drag previews, but route committed changes through
// updateObjectAttrs() so undo snapshots stay consistent.
function findObject(id) {
  if (!doc) return null;
  for (const layer of doc.layers) {
    const obj = layer.objects.find(o => o.id === id);
    if (obj) return { obj, layer };
  }
  return null;
}

function findLayer(id) {
  if (!doc) return null;
  return doc.layers.find(l => l.id === id) || null;
}

function addObject(obj) {
  activeLayer().objects.push(obj);
  return obj;
}

function removeObject(id) {
  if (!doc) return false;
  for (const layer of doc.layers) {
    const i = layer.objects.findIndex(o => o.id === id);
    if (i >= 0) {
      layer.objects.splice(i, 1);
      pruneSelection();
      return true;
    }
  }
  return false;
}

function removeObjects(ids) {
  ids.forEach(removeObject);
}

// Single sanctioned path for committed attribute edits (property panel,
// tool "up" handlers). Merges patch into obj.attrs in place.
function updateObjectAttrs(id, patch) {
  const found = findObject(id);
  if (!found) return null;
  Object.assign(found.obj.attrs, patch);
  return found.obj;
}

// Deep-clones an object with a new id, nudged so the copy is visible as
// distinct from the original. Caller is responsible for pushUndo() +
// selecting the new object.
function duplicateObject(id, offset = 10) {
  const found = findObject(id);
  if (!found) return null;
  const clone = {
    id: uid(),
    type: found.obj.type,
    attrs: JSON.parse(JSON.stringify(found.obj.attrs))
  };
  nudgeObject(clone, offset, offset);
  found.layer.objects.push(clone);
  return clone;
}

// Shifts an object's position attrs by dx/dy. Handles the attr names that
// differ by object type — rect/image use x/y, ellipse uses cx/cy, line
// uses x1/y1/x2/y2, path/text use a leading "M"/transform-free x/y pair.
function nudgeObject(obj, dx, dy) {
  const a = obj.attrs;
  switch (obj.type) {
    case "rect":
    case "image":
      if (a.x != null) a.x = num(a.x) + dx;
      if (a.y != null) a.y = num(a.y) + dy;
      break;
    case "ellipse":
      if (a.cx != null) a.cx = num(a.cx) + dx;
      if (a.cy != null) a.cy = num(a.cy) + dy;
      break;
    case "line":
      if (a.x1 != null) a.x1 = num(a.x1) + dx;
      if (a.y1 != null) a.y1 = num(a.y1) + dy;
      if (a.x2 != null) a.x2 = num(a.x2) + dx;
      if (a.y2 != null) a.y2 = num(a.y2) + dy;
      break;
    case "text":
      if (a.x != null) a.x = num(a.x) + dx;
      if (a.y != null) a.y = num(a.y) + dy;
      break;
    case "path":
      if (a.d) a.d = translatePathData(a.d, dx, dy);
      break;
  }
}

function num(v) {
  return typeof v === "number" ? v : parseFloat(v) || 0;
}

// Minimal path translator — shifts every absolute coordinate pair in a
// path's "d" string by dx/dy. Assumes pen/pencil tools only emit absolute
// M/L/C commands (true for this app's path writer in tools.js).
function translatePathData(d, dx, dy) {
  return d.replace(/(-?\d*\.?\d+)[,\s]+(-?\d*\.?\d+)/g, (m, x, y) => {
    return `${(parseFloat(x) + dx)},${(parseFloat(y) + dy)}`;
  });
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

// ---- layer CRUD ---------------------------------------------------------

function addLayer(name) {
  const layer = {
    id: uid(),
    name: name || `Layer ${doc.layers.length + 1}`,
    visible: true,
    objects: []
  };
  doc.layers.push(layer);
  doc.activeLayerId = layer.id;
  return layer;
}

// Refuses to remove the last remaining layer — an empty-layers doc breaks
// activeLayer() and every tool that assumes one exists.
function removeLayer(id) {
  if (!doc || doc.layers.length <= 1) return false;
  const i = doc.layers.findIndex(l => l.id === id);
  if (i < 0) return false;
  const removedIds = doc.layers[i].objects.map(o => o.id);
  doc.layers.splice(i, 1);
  if (doc.activeLayerId === id) {
    doc.activeLayerId = doc.layers[Math.max(0, i - 1)].id;
  }
  doc.selectedIds = doc.selectedIds.filter(sid => !removedIds.includes(sid));
  return true;
}

function renameLayer(id, name) {
  const layer = findLayer(id);
  if (!layer) return false;
  layer.name = name;
  return true;
}

function setLayerVisibility(id, visible) {
  const layer = findLayer(id);
  if (!layer) return false;
  layer.visible = visible;
  return true;
}

function setActiveLayer(id) {
  if (!findLayer(id)) return false;
  doc.activeLayerId = id;
  return true;
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
  if (!doc) return;
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

function canUndo() {
  return undoStack.length > 0;
}

function canRedo() {
  return redoStack.length > 0;
}