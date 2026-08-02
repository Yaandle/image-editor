// export.js
// SVG/PNG/JPEG/GIF export, plus save/load against the FastAPI backend, plus
// the multi-page Download dialog. The topbar's SVG/PNG/JPEG buttons keep
// their original single-canvas behavior unchanged — they just now export
// "whichever page is active" instead of "the only page." The Download button
// is the new flexible flow: any file type (including GIF), any subset of
// pages.

function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  URL.revokeObjectURL(a.href);
}

function serializeSVGFrom(svgEl) {
  const clone = svgEl.cloneNode(true);
  clone.querySelector("#selection-overlay")?.remove();
  clone.querySelector("#pen-preview")?.remove();
  clone.querySelector("#pencil-preview")?.remove();
  clone.querySelector("#marquee-box")?.remove();
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new XMLSerializer().serializeToString(clone);
}

// Kept as its own name (rather than inlining canvasEl everywhere) since
// exportSVG()/exportRaster() below and existing call sites already expect it.
function serializeSVG() {
  return serializeSVGFrom(canvasEl);
}

function exportSVG() {
  download(new Blob([serializeSVG()], { type: "image/svg+xml" }), `${projectName()}.svg`);
}

// type: "png" | "jpeg". JPEG has no alpha channel, so it's always flattened
// against a matte colour — the page's own background if one's set, else
// white (same fallback the pre-multi-page version hardcoded). PNG stays
// transparent unless a background is set.
function rasterizePage(page, type) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error("Export failed — couldn't render canvas to image"));
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = page.doc.width; c.height = page.doc.height;
      const ctx = c.getContext("2d");
      if (type === "jpeg") {
        ctx.fillStyle = page.doc.background || "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
      }
      ctx.drawImage(img, 0, 0);
      c.toBlob(blob => {
        if (!blob) { reject(new Error("Export failed — couldn't encode image")); return; }
        resolve(blob);
      }, `image/${type}`, 0.92);
    };
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(serializeSVGFrom(page.svgEl))));
  });
}

function exportRaster(type) {
  const page = getPage(activePageId);
  rasterizePage(page, type)
    .then(blob => download(blob, `${projectName()}.${type === "jpeg" ? "jpg" : "png"}`))
    .catch(err => flashStatus(err.message || "Export failed"));
}

document.querySelectorAll("[data-export]").forEach(btn => {
  btn.addEventListener("click", () => btn.dataset.export === "svg" ? exportSVG() : exportRaster(btn.dataset.export));
});

function projectName() {
  return document.getElementById("project-name").value.trim() || "untitled";
}

function slugifyPageName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "page";
}

// True once anything has actually been added or drawn anywhere in the
// project — used to skip the confirm dialog on New/Load when there's nothing
// to lose. A brand-new project is exactly one page with one empty layer;
// having added a second page (even blank) already counts as "something to
// lose," since New/Load throw the whole page set away, not just one page's
// content.
function isDocEmpty() {
  if (pages.length > 1) return false;
  const d = pages[0]?.doc;
  return !d || (d.layers.length <= 1 && d.layers.every(l => l.objects.length === 0));
}

// Project files now hold every page, not just one doc — the backend
// (main.py) doesn't care, it just persists whatever JSON it's given, so no
// server-side change was needed for this. Old single-doc project files (pre
// multi-page) are upgraded transparently on load, below.
function serializeProject() {
  syncActivePageDoc(); // flush the live `doc` back into pages[] before reading it
  return {
    version: 2,
    activePageId,
    pages: pages.map(p => ({ id: p.id, name: p.name, doc: p.doc })),
  };
}

async function saveProject() {
  const btn = document.getElementById("btn-save");
  setBusy(btn, true, "Saving…");
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectName())}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(serializeProject()),
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
    let projectData;
    if (loaded && Array.isArray(loaded.layers)) {
      // Legacy single-doc project file, from before multi-page existed —
      // wrap it as a one-page project rather than rejecting it.
      projectData = { activePageId: null, pages: [{ id: uid(), name: "Page 1", doc: loaded }] };
    } else if (loaded && Array.isArray(loaded.pages) && loaded.pages.length) {
      projectData = loaded;
    } else {
      throw new Error(`"${name}" isn't a valid project file`);
    }
    loadProjectData(projectData);
    document.getElementById("project-name").value = name;
  } catch (err) {
    flashStatus(err.message || "Load failed");
    select.value = "";
  } finally {
    select.disabled = false;
  }
});

document.getElementById("btn-new").addEventListener("click", () => {
  if (!isDocEmpty() && !confirm("Start a new document? Unsaved changes will be lost.")) return;
  resetToSinglePage(); // pages.js — tears down every page, makes one fresh blank one, resets history
  document.getElementById("project-name").value = "untitled";
  renderAllPages(); renderLayers();
});

// ---------------------------------------------------------------------
// status bar — red dot until the backend answers, green once connected
// ---------------------------------------------------------------------

function setConnected(ok) {
  document.getElementById("status-dot")?.classList.toggle("connected", ok);
  const text = document.getElementById("status-text");
  if (text) text.textContent = ok ? "CONNECTED" : "OFFLINE";
}

// ---------------------------------------------------------------------
// Download dialog — file type + page selector (Feature 3). Native <dialog>,
// no new modal system needed. Only checked pages are included in the output.
// Single page selected behaves like a normal single-image/GIF export;
// multiple pages + GIF play out sequentially (each page's animation finishes
// before the next page's starts) into one file; multiple pages + PNG/JPEG/SVG
// download as separate sequentially-triggered files (one per page) — there's
// no single-file container for multiple raster/vector images without adding
// a zip writer, which felt like more machinery than a carousel workflow
// needs; flagged here rather than silently picked.
// ---------------------------------------------------------------------

document.getElementById("btn-download").addEventListener("click", openDownloadDialog);
document.getElementById("download-cancel").addEventListener("click", () => {
  document.getElementById("download-dialog").close();
});
document.getElementById("download-type").addEventListener("change", e => {
  document.getElementById("download-gif-options").style.display = e.target.value === "gif" ? "" : "none";
});

function openDownloadDialog() {
  const list = document.getElementById("download-pages");
  list.innerHTML = "<legend>Pages</legend>" + pages.map(p =>
    `<label class="prop-checkbox"><input type="checkbox" value="${escapeAttr(p.id)}" checked> ${escapeHtml(p.name)}</label>`
  ).join("");
  document.getElementById("download-gif-options").style.display =
    document.getElementById("download-type").value === "gif" ? "" : "none";
  document.getElementById("download-dialog").showModal();
}

document.getElementById("download-form").addEventListener("submit", async e => {
  e.preventDefault();
  const type = document.getElementById("download-type").value;
  const seconds = parseFloat(document.getElementById("download-gif-seconds").value) || 2.5;
  const checkedIds = [...document.querySelectorAll("#download-pages input[type=checkbox]:checked")].map(cb => cb.value);
  const selectedPages = pages.filter(p => checkedIds.includes(p.id));
  if (!selectedPages.length) { flashStatus("Select at least one page"); return; }

  document.getElementById("download-dialog").close();
  const btn = document.getElementById("download-confirm");
  setBusy(btn, true, "Working…");
  try {
    await runDownload(type, selectedPages, { seconds });
  } catch (err) {
    flashStatus(err.message || "Export failed");
  } finally {
    setBusy(btn, false, "Download");
  }
});

async function runDownload(type, selectedPages, opts) {
  if (type === "svg") {
    for (const p of selectedPages) {
      download(new Blob([serializeSVGFrom(p.svgEl)], { type: "image/svg+xml" }), `${projectName()}-${slugifyPageName(p.name)}.svg`);
    }
    flashStatus(`Downloaded ${selectedPages.length} SVG${selectedPages.length > 1 ? "s" : ""}`);
    return;
  }
  if (type === "png" || type === "jpeg") {
    for (const p of selectedPages) {
      const blob = await rasterizePage(p, type);
      download(blob, `${projectName()}-${slugifyPageName(p.name)}.${type === "jpeg" ? "jpg" : "png"}`);
    }
    flashStatus(`Downloaded ${selectedPages.length} image${selectedPages.length > 1 ? "s" : ""}`);
    return;
  }
  if (type === "gif") {
    await downloadGifForPages(selectedPages, opts);
    return;
  }
}

// ---------------------------------------------------------------------
// GIF capture — samples each selected page's *live* rendering at a fixed
// rate for a fixed duration (rather than parsing the source GIF's real frame
// timing, which the Image API doesn't expose) and appends the frames into
// one GifWriter (gifEncoder.js), in page order, so multi-page export plays
// each page out fully before advancing — matching the spec's "sequential
// playback across pages, not simultaneous."
//
// One <img> is created per page (not per sampled frame) and left to decode
// and animate on its own; drawImage() against that *same, already-playing*
// element at different instants captures whatever frame it's progressed to
// by then. Creating a fresh Image per snapshot would always show frame 0 —
// this is the actual mechanism that makes "live" capture possible at all.
// ---------------------------------------------------------------------

const GIF_SAMPLE_FPS = 10;

async function downloadGifForPages(selectedPages, { seconds }) {
  const width = Math.max(...selectedPages.map(p => p.doc.width));
  const height = Math.max(...selectedPages.map(p => p.doc.height));
  const writer = new GifWriter(width, height, { loop: 0 });

  for (let i = 0; i < selectedPages.length; i++) {
    const page = selectedPages[i];
    flashStatus(`Encoding "${page.name}" (${i + 1}/${selectedPages.length})…`);
    const capture = await capturePageFrames(page, { fps: GIF_SAMPLE_FPS, seconds });
    const offX = Math.round((width - capture.width) / 2);
    const offY = Math.round((height - capture.height) / 2);
    const matte = page.doc.background || "#ffffff";
    for (const frame of capture.frames) {
      const composed = composeFrameOntoCanvas(frame, capture.width, capture.height, width, height, offX, offY, matte);
      writer.addFrame(composed, capture.delayMs);
    }
  }

  flashStatus("Finishing GIF…");
  download(writer.finish(), `${projectName()}.gif`);
  flashStatus(`Downloaded ${projectName()}.gif`);
}

// Pages with no animated object only need one frame, held for the full
// duration — sampling N identical frames would just bloat the file for no
// visual difference.
async function capturePageFrames(page, { fps, seconds }) {
  const hasAnimated = page.doc.layers.some(l => l.objects.some(o => o.animated));
  const w = page.doc.width, h = page.doc.height;
  const matte = page.doc.background || "#ffffff";

  const img = await loadImageOffscreen(serializeSVGFrom(page.svgEl));
  const raster = document.createElement("canvas");
  raster.width = w; raster.height = h;
  const ctx = raster.getContext("2d");

  function grabFrame() {
    ctx.fillStyle = matte;
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  const frames = [];
  if (!hasAnimated) {
    frames.push(grabFrame());
    img.remove();
    return { frames, delayMs: seconds * 1000, width: w, height: h };
  }

  const frameCount = Math.max(1, Math.round(seconds * fps));
  const delayMs = 1000 / fps;
  for (let i = 0; i < frameCount; i++) {
    frames.push(grabFrame());
    await new Promise(r => setTimeout(r, delayMs));
  }
  img.remove();
  return { frames, delayMs, width: w, height: h };
}

function loadImageOffscreen(svgMarkup) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.style.cssText = "position:fixed; left:-99999px; top:0; visibility:hidden;";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't rasterize a page for GIF export"));
    document.body.appendChild(img);
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgMarkup)));
  });
}

// Only does real work when a page's size differs from the shared GIF canvas
// size (mixed-size pages in one multi-page export) — centers the smaller
// frame on a matte-filled canvas of the target size.
function composeFrameOntoCanvas(srcImageData, srcW, srcH, dstW, dstH, offX, offY, matte) {
  if (srcW === dstW && srcH === dstH && offX === 0 && offY === 0) return srcImageData;
  const c = document.createElement("canvas");
  c.width = dstW; c.height = dstH;
  const ctx = c.getContext("2d");
  ctx.fillStyle = matte;
  ctx.fillRect(0, 0, dstW, dstH);
  const tmp = document.createElement("canvas");
  tmp.width = srcW; tmp.height = srcH;
  tmp.getContext("2d").putImageData(srcImageData, 0, 0);
  ctx.drawImage(tmp, offX, offY);
  return ctx.getImageData(0, 0, dstW, dstH);
}