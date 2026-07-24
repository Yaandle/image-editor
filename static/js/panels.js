// panels.js
// Toolbar wiring, layers panel, image import, keyboard shortcuts.
//
// Layer mutations route through document.js's layer-CRUD helpers
// (addLayer/removeLayer/renameLayer/setLayerVisibility/setActiveLayer) —
// this file should never mutate doc.layers directly.

document.querySelectorAll(".tool").forEach(btn => btn.addEventListener("click", () => setTool(btn.dataset.tool)));
document.getElementById("btn-undo").addEventListener("click", undo);
document.getElementById("btn-redo").addEventListener("click", redo);

document.getElementById("btn-add-layer").addEventListener("click", () => {
  addLayer();
  pushUndo(); renderLayers(); renderDoc();
});

ensurePanelStyles();

// ---------------------------------------------------------------------
// bug #3 fix (kept): layer delete/visibility toggle was breaking because
// the whole <li> was draggable="true", so a small mouse move during what
// the user meant as a click on ▲/▼/👁/✕ could register as a dragstart
// instead. Fix: only a dedicated drag-handle icon is draggable; the <li>
// itself is not. Drop handler validates indices via moveLayerToIndex()
// (document.js) instead of splicing directly with unchecked indices.
//
// renderLayers() rebuilds the whole list and rebinds every listener on
// each call — fine at prototype scale (small layer counts), same
// tradeoff already accepted for undo/redo snapshotting. Not a target
// for a diffing rewrite unless asked.
// ---------------------------------------------------------------------

function renderLayers() {
  const list = document.getElementById("layers-list");
  list.innerHTML = "";
  [...doc.layers].reverse().forEach((layer) => {
    const li = document.createElement("li");
    li.className = layer.id === doc.activeLayerId ? "active" : "";
    li.draggable = false; // only the handle below is draggable
    li.dataset.layerId = layer.id;
    li.innerHTML = `<span class="drag-handle" title="Drag to reorder" draggable="true">⠿</span>
      <span class="layer-name" title="Double-click to rename">${escapeHtml(layer.name)}</span>
      <button data-act="up" title="Move layer up">▲</button>
      <button data-act="down" title="Move layer down">▼</button>
      <button data-act="vis" title="Toggle visibility">${layer.visible ? "👁" : "🚫"}</button>
      <button data-act="del" title="Delete layer">✕</button>`;

    li.addEventListener("click", e => {
      if (!e.target.dataset.act) { setActiveLayer(layer.id); renderLayers(); }
    });

    li.querySelector(".layer-name").addEventListener("dblclick", e => {
      e.stopPropagation();
      startLayerRename(li, layer);
    });

    li.querySelector('[data-act="vis"]').addEventListener("click", () => {
      setLayerVisibility(layer.id, !layer.visible);
      pushUndo(); renderDoc(); renderLayers();
    });
    li.querySelector('[data-act="del"]').addEventListener("click", () => {
      if (removeLayer(layer.id)) { pushUndo(); renderDoc(); renderLayers(); }
    });
    // displayIndex 0 is topmost/frontmost in the reversed list, so "up" (toward front) is direction +1
    li.querySelector('[data-act="up"]').addEventListener("click", () => {
      if (moveLayer(layer.id, 1)) { pushUndo(); renderDoc(); renderLayers(); }
    });
    li.querySelector('[data-act="down"]').addEventListener("click", () => {
      if (moveLayer(layer.id, -1)) { pushUndo(); renderDoc(); renderLayers(); }
    });

    // drag-to-reorder — handle only, not the whole row
    const handle = li.querySelector(".drag-handle");
    handle.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/layer-id", layer.id);
      e.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragover", e => e.preventDefault());
    li.addEventListener("drop", e => {
      e.preventDefault();
      const draggedId = e.dataTransfer.getData("text/layer-id");
      if (!draggedId || draggedId === layer.id) return;
      const from = doc.layers.findIndex(l => l.id === draggedId);
      const to = doc.layers.findIndex(l => l.id === layer.id);
      if (moveLayerToIndex(from, to)) { pushUndo(); renderDoc(); renderLayers(); }
    });

    list.appendChild(li);
  });
}

// Inline rename: swaps the label span for a text input, commits on
// blur/Enter, cancels on Escape without touching the model.
function startLayerRename(li, layer) {
  const span = li.querySelector(".layer-name");
  const input = document.createElement("input");
  input.className = "layer-rename-input";
  input.value = layer.name;
  span.replaceWith(input);
  input.focus(); input.select();

  const commit = () => {
    const name = input.value.trim();
    if (name) { renameLayer(layer.id, name); pushUndo(); }
    renderLayers();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.removeEventListener("blur", commit); renderLayers(); }
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------
// image import — file picker + drag-and-drop onto canvas, one shared path
// ---------------------------------------------------------------------

document.getElementById("btn-import").addEventListener("click", () => document.getElementById("file-input").click());
document.getElementById("file-input").addEventListener("change", e => {
  const file = e.target.files[0];
  if (file) importImageFile(file);
  e.target.value = "";
});

canvasEl.addEventListener("dragover", e => e.preventDefault());
canvasEl.addEventListener("drop", e => {
  e.preventDefault();
  const file = e.dataTransfer.files?.[0];
  if (file) importImageFile(file);
});

function importImageFile(file) {
  if (!file.type.startsWith("image/")) {
    flashStatus(`"${file.name}" isn't an image file`);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const w = Math.min(img.naturalWidth, doc.width * 0.8);
      const h = w * (img.naturalHeight / img.naturalWidth);
      const obj = addObject({
        id: uid(), type: "image",
        attrs: { x: (doc.width - w) / 2, y: (doc.height - h) / 2, width: w, height: h, href: reader.result }
      });
      selectOnly(obj.id);
      pushUndo(); renderDoc();
    };
    img.onerror = () => flashStatus(`Couldn't load "${file.name}"`);
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// Minimal, non-blocking status message — avoids alert() interrupting flow.
// Reuses a single element so rapid failures don't stack toasts.
function flashStatus(msg) {
  let el = document.getElementById("status-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "status-toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("visible");
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(() => el.classList.remove("visible"), 2200);
}

// ---------------------------------------------------------------------
// keyboard shortcuts
// ---------------------------------------------------------------------

window.addEventListener("keydown", e => {
  const tag = document.activeElement.tagName;
  if (tag === "INPUT" || tag === "SELECT") return;

  if (e.ctrlKey && e.key.toLowerCase() === "z") { e.shiftKey ? redo() : undo(); e.preventDefault(); return; }

  if (e.ctrlKey && e.key.toLowerCase() === "d") { // duplicate selection
    if (doc.selectedIds.length) {
      const newIds = doc.selectedIds.map(id => duplicateObject(id)?.id).filter(Boolean);
      doc.selectedIds = newIds;
      pushUndo(); renderDoc();
    }
    e.preventDefault(); return;
  }

  if (e.ctrlKey && e.key.toLowerCase() === "a") { // select all (active tool must be select)
    if (currentTool === "select") {
      doc.selectedIds = allObjectIds();
      renderDoc();
    }
    e.preventDefault(); return;
  }

  if (e.key === "Escape" && currentTool === "select" && doc.selectedIds.length && !dragState) {
    clearSelection(); renderDoc(); return;
  }

  if ((e.key === "Delete" || e.key === "Backspace") && doc.selectedIds.length) {
    removeObjects(doc.selectedIds);
    clearSelection(); pushUndo(); renderDoc();
    return;
  }

  // Arrow-key nudge — 1px, Shift+arrow for 10px. Keyboard-only object
  // movement; there was previously no non-pointer way to reposition anything.
  const arrowDeltas = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrowDeltas[e.key] && doc.selectedIds.length) {
    const mult = e.shiftKey ? 10 : 1;
    const [dx, dy] = arrowDeltas[e.key];
    for (const obj of selectedObjects()) nudgeObject(obj, dx * mult, dy * mult);
    pushUndo(); renderDoc();
    e.preventDefault(); return;
  }

  if (e.ctrlKey && e.key === "]") { // bring forward
    for (const id of doc.selectedIds) bringForward(id);
    pushUndo(); renderDoc(); e.preventDefault(); return;
  }
  if (e.ctrlKey && e.key === "[") { // send backward
    for (const id of doc.selectedIds) sendBackward(id);
    pushUndo(); renderDoc(); e.preventDefault(); return;
  }
  if (e.ctrlKey && e.shiftKey && e.key === "]") { // bring to front
    for (const id of doc.selectedIds) bringToFront(id);
    pushUndo(); renderDoc(); e.preventDefault(); return;
  }
  if (e.ctrlKey && e.shiftKey && e.key === "[") { // send to back
    for (const id of doc.selectedIds) sendToBack(id);
    pushUndo(); renderDoc(); e.preventDefault(); return;
  }

  // Alt+Up/Down: move which layer is active (navigation), distinct from
  // the ▲/▼ buttons in the panel which reorder a layer's stacking position.
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    const i = doc.layers.findIndex(l => l.id === doc.activeLayerId);
    const j = e.key === "ArrowUp" ? i + 1 : i - 1;
    if (j >= 0 && j < doc.layers.length) { setActiveLayer(doc.layers[j].id); renderLayers(); }
    e.preventDefault(); return;
  }

  // v=select r=rect e=ellipse l=line p=pen(anchor) b=pencil(free-draw) t=text f=fill
  const map = { v: "select", r: "rect", e: "ellipse", l: "line", p: "pen", b: "pencil", t: "text", f: "fill" };
  if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
});

// ---------------------------------------------------------------------
// neo-morphism styling for panel chrome — consistent with canvas.js's
// --nm-* custom properties, injected once from whichever file loads first
// ---------------------------------------------------------------------

function ensurePanelStyles() {
  if (document.getElementById("inkkit-panel-styles")) return;
  const style = document.createElement("style");
  style.id = "inkkit-panel-styles";
  style.textContent = `

  `;
  document.head.appendChild(style);
}