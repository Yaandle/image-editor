// Toolbar wiring, layers panel, image import, keyboard shortcuts.

document.querySelectorAll(".tool").forEach(btn => btn.addEventListener("click", () => setTool(btn.dataset.tool)));
document.getElementById("btn-undo").addEventListener("click", undo);
document.getElementById("btn-redo").addEventListener("click", redo);

document.getElementById("btn-add-layer").addEventListener("click", () => {
  const layer = { id: uid(), name: `Layer ${doc.layers.length+1}`, visible: true, objects: [] };
  doc.layers.push(layer); doc.activeLayerId = layer.id;
  pushUndo(); renderLayers(); renderDoc();
});

function renderLayers() {
  const list = document.getElementById("layers-list");
  list.innerHTML = "";
  [...doc.layers].reverse().forEach((layer, displayIndex) => {
    const li = document.createElement("li");
    li.className = layer.id === doc.activeLayerId ? "active" : "";
    li.draggable = true;
    li.dataset.layerId = layer.id;
    li.innerHTML = `<span style="flex:1">${layer.name}</span>
      <button data-act="up" title="Move layer up">▲</button>
      <button data-act="down" title="Move layer down">▼</button>
      <button data-act="vis">${layer.visible ? "👁" : "🚫"}</button>
      <button data-act="del">✕</button>`;

    li.addEventListener("click", e => { if (!e.target.dataset.act) { doc.activeLayerId = layer.id; renderLayers(); } });
    li.querySelector('[data-act="vis"]').addEventListener("click", () => {
      layer.visible = !layer.visible; pushUndo(); renderDoc(); renderLayers();
    });
    li.querySelector('[data-act="del"]').addEventListener("click", () => {
      if (doc.layers.length === 1) return;
      doc.layers = doc.layers.filter(l => l.id !== layer.id);
      if (doc.activeLayerId === layer.id) doc.activeLayerId = doc.layers[0].id;
      pushUndo(); renderDoc(); renderLayers();
    });
    // displayIndex 0 is topmost/frontmost in the reversed list, so "up" (toward front) is direction +1
    li.querySelector('[data-act="up"]').addEventListener("click", () => {
      moveLayer(layer.id, 1); pushUndo(); renderDoc(); renderLayers();
    });
    li.querySelector('[data-act="down"]').addEventListener("click", () => {
      moveLayer(layer.id, -1); pushUndo(); renderDoc(); renderLayers();
    });

    // drag-to-reorder
    li.addEventListener("dragstart", e => e.dataTransfer.setData("text/layer-id", layer.id));
    li.addEventListener("dragover", e => e.preventDefault());
    li.addEventListener("drop", e => {
      e.preventDefault();
      const draggedId = e.dataTransfer.getData("text/layer-id");
      if (draggedId === layer.id) return;
      const from = doc.layers.findIndex(l => l.id === draggedId);
      const to = doc.layers.findIndex(l => l.id === layer.id);
      const [moved] = doc.layers.splice(from, 1);
      doc.layers.splice(to, 0, moved);
      pushUndo(); renderDoc(); renderLayers();
    });

    list.appendChild(li);
  });
}

document.getElementById("btn-import").addEventListener("click", () => document.getElementById("file-input").click());
document.getElementById("file-input").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const w = Math.min(img.naturalWidth, doc.width * 0.8);
      const h = w * (img.naturalHeight / img.naturalWidth);
      addObject({ id: uid(), type: "image",
        attrs: { x:(doc.width-w)/2, y:(doc.height-h)/2, width:w, height:h, href:reader.result } });
      pushUndo(); renderDoc();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
  e.target.value = "";
});

window.addEventListener("keydown", e => {
  const tag = document.activeElement.tagName;
  if (tag === "INPUT" || tag === "SELECT") return;
  if (e.ctrlKey && e.key.toLowerCase() === "z") { e.shiftKey ? redo() : undo(); e.preventDefault(); return; }
  if ((e.key === "Escape" || e.key === "Enter") && currentTool === "pen") tools.pen.finish();
  if ((e.key === "Delete" || e.key === "Backspace") && doc.selectedIds.length) {
    for (const id of doc.selectedIds) removeObject(id);
    doc.selectedIds = []; pushUndo(); renderDoc();
    return;
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
  const map = { v:"select", r:"rect", e:"ellipse", l:"line", p:"pen", t:"text", f:"fill" };
  if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
});