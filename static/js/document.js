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
//
// Multi-page note: `doc` is still a single bare global, same as before pages
// existed — it's just that it now always means "whichever page is active."
// pages.js owns the `pages` array + `activePageId` and reassigns this bare
// `doc` (plus `canvasEl` in canvas.js) when the active page changes. Every
// function below is untouched by that — they only ever see "the current
// doc," exactly like pre-multi-page code.

let doc = null;
let undoStack = [];
let redoStack = [];
const MAX_HISTORY = 60;

let _uidCounter = 0;
function uid() {
  _uidCounter = (_uidCounter + 1) % 1e6;
  return Math.random().toString(36).slice(2, 9) + _uidCounter.toString(36);
}

// Pure factory — builds a fresh doc object but does NOT make it live and does
// NOT touch history. Used by pages.js for every page (initial boot, "+ Add
// Page", project load) so adding a page never wipes another page's undo
// history. `background` is the page's matte fill: null/"none" = transparent,
// else a hex string — used both for on-canvas rendering (canvas.js) and as
// the flatten colour for JPEG/GIF export (export.js), which have no alpha
// channel.
function makeBlankDoc(width = 900, height = 600) {
  const layer = { id: uid(), name: "Layer 1", visible: true, objects: [] };
  return { width, height, background: null, layers: [layer], activeLayerId: layer.id, selectedIds: [] };
}

// Clears undo/redo and re-baselines lastCommitted to the current doc.
// Must be called whenever doc is replaced wholesale (new document, project
// load) — export.js uses this instead of touching the stacks directly.
function resetHistory() {
  undoStack = [];
  redoStack = [];
  lastCommitted = doc ? JSON.stringify(doc) : null;
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
  // animated (GIF import tag, see panels.js) lives outside attrs since it's
  // not a real SVG attribute — copy it explicitly or a duplicated GIF loses
  // its "don't flood-fill me" flag.
  if (found.obj.animated) clone.animated = true;
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

// flipH/flipV — the other transform exception alongside rotation (see
// canvas.js's applyPendingTransforms). Stored as plain booleans on attrs;
// canvas.js excludes them from the raw attribute copy and folds them into
// the same transform string as rotation instead.
function getFlip(obj) {
  return { h: !!obj.attrs.flipH, v: !!obj.attrs.flipV };
}

function toggleFlip(obj, axis) {
  if (axis === "h") obj.attrs.flipH = !obj.attrs.flipH;
  else obj.attrs.flipV = !obj.attrs.flipV;
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

// ---- canvas-level operations ----------------------------------------------
// Distinct from the per-object transforms above (nudgeObject/setRotation/
// etc.) — these operate on doc.width/doc.height itself and shift every
// object in every layer together, e.g. a "Canvas Size" dialog.

const ANCHOR_OFFSETS = {
  nw:     (dw, dh) => [0, 0],
  n:      (dw, dh) => [dw / 2, 0],
  ne:     (dw, dh) => [dw, 0],
  w:      (dw, dh) => [0, dh / 2],
  center: (dw, dh) => [dw / 2, dh / 2],
  e:      (dw, dh) => [dw, dh / 2],
  sw:     (dw, dh) => [0, dh],
  s:      (dw, dh) => [dw / 2, dh],
  se:     (dw, dh) => [dw, dh],
};

// Resizes the canvas without scaling content — objects keep their absolute
// size and are shifted only enough to stay anchored at the chosen reference
// point as the canvas grows/shrinks around them (Photoshop's Canvas Size
// dialog). Content that ends up outside the new bounds isn't deleted — it's
// still in the doc (recoverable via undo, or by growing the canvas again),
// the <svg> root just clips it visually since SVG's default overflow is
// hidden. Distinct from "Scale image", which will resize content itself.
// hex: a "#rrggbb" string, or null/"none" for transparent. Reused as-is by
// the Canvas properties panel's background swatch (panels.js) — same
// createColorPicker() component fill/stroke already use, just a third wired
// instance, not a new picker system.
function setBackground(hex) {
  if (!doc) return;
  doc.background = hex && hex !== "none" ? hex : null;
}

function resizeCanvas(newWidth, newHeight, anchor = "center") {
  if (!doc || !(newWidth > 0) || !(newHeight > 0)) return false;
  const dw = newWidth - doc.width, dh = newHeight - doc.height;
  const offsetFn = ANCHOR_OFFSETS[anchor] || ANCHOR_OFFSETS.center;
  const [dx, dy] = offsetFn(dw, dh);
  if (dx || dy) {
    for (const layer of doc.layers) {
      for (const obj of layer.objects) nudgeObject(obj, dx, dy);
    }
  }
  doc.width = newWidth;
  doc.height = newHeight;
  return true;
}

// ---- undo/redo -----------------------------------------------------------
// snapshot-based — simple and cheap at prototype scale, capped at
// MAX_HISTORY. Known not to scale to large documents; flagged, not fixed.
//
// Call sites invoke pushUndo() AFTER mutating doc, so what gets pushed onto
// the undo stack is lastCommitted — the state as of the *previous* commit —
// not the current serialization. (Pushing the post-edit state made the first
// undo a silent no-op: the popped snapshot equalled the live doc.)
//
// Multi-page: history is ONE global timeline across every page (chosen over
// per-page histories so Ctrl+Z always undoes your last action regardless of
// which page it was on, like Figma). A bare doc snapshot alone can't say
// which page it belongs to, so each stack entry is now { pageId, snapshot }
// instead of a bare string — same stacks, same MAX_HISTORY cap, same
// JSON-snapshot strategy, just one extra field. undo()/redo() jump to
// whichever page an entry belongs to (pages.js's goToPageForHistory) before
// restoring it, and skip — rather than crash on — entries whose page has
// since been deleted (page add/remove/reorder themselves aren't part of this
// history; see pages.js).

let lastCommitted = null;

function pushUndo() {
  if (!doc) return;
  if (lastCommitted != null) {
    undoStack.push({ pageId: activePageId, snapshot: lastCommitted });
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
  }
  lastCommitted = JSON.stringify(doc);
  redoStack = [];
}

function undo() {
  while (undoStack.length) {
    const entry = undoStack.pop();
    if (!getPage(entry.pageId)) continue; // its page was deleted since this was recorded — inert, skip
    redoStack.push({ pageId: activePageId, snapshot: JSON.stringify(doc) });
    goToPageForHistory(entry.pageId);
    doc = JSON.parse(entry.snapshot);
    lastCommitted = JSON.stringify(doc);
    syncActivePageDoc();
    renderDoc(); renderLayers();
    return;
  }
}

function redo() {
  while (redoStack.length) {
    const entry = redoStack.pop();
    if (!getPage(entry.pageId)) continue;
    undoStack.push({ pageId: activePageId, snapshot: JSON.stringify(doc) });
    goToPageForHistory(entry.pageId);
    doc = JSON.parse(entry.snapshot);
    lastCommitted = JSON.stringify(doc);
    syncActivePageDoc();
    renderDoc(); renderLayers();
    return;
  }
}

function canUndo() {
  return undoStack.length > 0;
}

function canRedo() {
  return redoStack.length > 0;
}