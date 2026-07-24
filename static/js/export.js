// export.js
// SVG/PNG/JPEG export, plus save/load against the FastAPI backend.

function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  URL.revokeObjectURL(a.href);
}

function serializeSVG() {
  const clone = canvasEl.cloneNode(true);
  clone.querySelector("#selection-overlay")?.remove();
  clone.querySelector("#pen-preview")?.remove();
  clone.querySelector("#pencil-preview")?.remove();
  clone.querySelector("#marquee-box")?.remove();
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new XMLSerializer().serializeToString(clone);
}

function exportSVG() {
  download(new Blob([serializeSVG()], { type: "image/svg+xml" }), `${projectName()}.svg`);
}

function exportRaster(type) {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = doc.width; c.height = doc.height;
    const ctx = c.getContext("2d");
    if (type === "jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.drawImage(img, 0, 0);
    c.toBlob(blob => download(blob, `${projectName()}.${type === "jpeg" ? "jpg" : "png"}`), `image/${type}`, 0.92);
  };
  img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(serializeSVG())));
}

document.querySelectorAll("[data-export]").forEach(btn => {
  btn.addEventListener("click", () => btn.dataset.export === "svg" ? exportSVG() : exportRaster(btn.dataset.export));
});

function projectName() {
  return document.getElementById("project-name").value.trim() || "untitled";
}

async function saveProject() {
  await fetch(`/api/projects/${encodeURIComponent(projectName())}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc),
  });
  refreshProjectList();
}

async function refreshProjectList() {
  const names = await (await fetch("/api/projects")).json();
  document.getElementById("project-list").innerHTML =
    `<option value="">Load…</option>` + names.map(n => `<option>${n}</option>`).join("");
}

document.getElementById("btn-save").addEventListener("click", saveProject);
document.getElementById("project-list").addEventListener("change", async e => {
  if (!e.target.value) return;
  doc = await (await fetch(`/api/projects/${e.target.value}`)).json();
  document.getElementById("project-name").value = e.target.value;
  undoStack = []; redoStack = [];
  renderDoc(); renderLayers();
});
document.getElementById("btn-new").addEventListener("click", () => {
  doc = newDocument(); undoStack = []; redoStack = [];
  renderDoc(); renderLayers();
});