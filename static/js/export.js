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
  img.onerror = () => flashStatus("Export failed — couldn't render canvas to image");
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = doc.width; c.height = doc.height;
    const ctx = c.getContext("2d");
    // JPEG has no alpha channel — fill white first so transparent regions
    // don't render black. PNG/SVG paths skip this and keep transparency.
    if (type === "jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.drawImage(img, 0, 0);
    c.toBlob(blob => {
      if (!blob) { flashStatus("Export failed — couldn't encode image"); return; }
      download(blob, `${projectName()}.${type === "jpeg" ? "jpg" : "png"}`);
    }, `image/${type}`, 0.92);
  };
  img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(serializeSVG())));
}

document.querySelectorAll("[data-export]").forEach(btn => {
  btn.addEventListener("click", () => btn.dataset.export === "svg" ? exportSVG() : exportRaster(btn.dataset.export));
});

function projectName() {
  return document.getElementById("project-name").value.trim() || "untitled";
}

// True once anything has actually been added or drawn — a fresh
// newDocument() is a single empty layer with no objects. Used to skip
// the confirm dialog on New/Load when there's nothing to lose.
function isDocEmpty() {
  return doc.layers.length <= 1 && doc.layers.every(l => l.objects.length === 0);
}

async function saveProject() {
  const btn = document.getElementById("btn-save");
  setBusy(btn, true, "Saving…");
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectName())}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc),
    });
    if (!res.ok) throw new Error(`Save failed (${res.status})`);
    flashStatus(`Saved "${projectName()}"`);
    await refreshProjectList();
  } catch (err) {
    flashStatus(err.message || "Save failed");
  } finally {
    setBusy(btn, false, "Save");
  }
}

async function refreshProjectList() {
  try {
    const res = await fetch("/api/projects");
    if (!res.ok) throw new Error("Couldn't load project list");
    const names = await res.json();
    document.getElementById("project-list").innerHTML =
      `<option value="">LOAD…</option>` + names.map(n => `<option>${escapeAttr(n)}</option>`).join("");
    setConnected(true);
  } catch (err) {
    setConnected(false);
    flashStatus(err.message || "Couldn't refresh project list");
  }
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Minimal busy-state toggle — prevents double-submit on slow save/load.
// Reuses whatever label the button already had via a data attribute so
// we don't need a second source of truth for "idle" text.
function setBusy(btn, busy, label) {
  btn.disabled = busy;
  if (!btn.dataset.idleLabel) btn.dataset.idleLabel = btn.textContent;
  btn.textContent = busy ? label : btn.dataset.idleLabel;
}

document.getElementById("btn-save").addEventListener("click", saveProject);

document.getElementById("project-list").addEventListener("change", async e => {
  const name = e.target.value;
  if (!name) return;
  if (!isDocEmpty() && !confirm("Load this project? Unsaved changes will be lost.")) {
    e.target.value = "";
    return;
  }
  // Note: don't use setBusy() here — writing textContent on a <select>
  // destroys its <option> children. Disable only.
  const select = e.target;
  select.disabled = true;
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`Couldn't load "${name}" (${res.status})`);
    const loaded = await res.json();
    if (!loaded || !Array.isArray(loaded.layers)) throw new Error(`"${name}" isn't a valid project file`);
    doc = loaded;
    document.getElementById("project-name").value = name;
    resetHistory();
    renderDoc(); renderLayers();
  } catch (err) {
    flashStatus(err.message || "Load failed");
    select.value = "";
  } finally {
    select.disabled = false;
  }
});

document.getElementById("btn-new").addEventListener("click", () => {
  if (!isDocEmpty() && !confirm("Start a new document? Unsaved changes will be lost.")) return;
  doc = newDocument(); // newDocument() resets history itself
  document.getElementById("project-name").value = "untitled";
  renderDoc(); renderLayers();
});

// ---------------------------------------------------------------------
// status bar — red dot until the backend answers, green once connected
// ---------------------------------------------------------------------

function setConnected(ok) {
  document.getElementById("status-dot")?.classList.toggle("connected", ok);
  const text = document.getElementById("status-text");
  if (text) text.textContent = ok ? "CONNECTED" : "OFFLINE";
}