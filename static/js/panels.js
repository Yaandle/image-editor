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
  [...doc.layers].reverse().forEach(layer => {
    const li = document.createElement("li");
    li.className = layer.id === doc.activeLayerId ? "active" : "";
    li.innerHTML = `<span style="flex:1">${layer.name}</span>
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
  if ((e.key === "Delete" || e.key === "Backspace") && doc.selectedId) {
    removeObject(doc.selectedId); doc.selectedId = null; pushUndo(); renderDoc();
  }
  const map = { v:"select", r:"rect", e:"ellipse", l:"line", p:"pen", t:"text", f:"fill" };
  if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
});