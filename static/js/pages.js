// pages.js
// Multi-page canvas: each page is its own independent doc (own objects, own
// background) stacked vertically below one another, Figma-frames style.
// Tool state and the color picker stay global/shared (see tools.js,
// index.html's colorPicker wiring) — only `doc`/`canvasEl` swap per page.
//
// Core idea: document.js/canvas.js/tools.js were all written against bare
// globals (`doc`, `canvasEl`, `undoStack`, etc.) rather than parameters. Doing
// a real per-page-scoped rewrite of every function that reads those would
// touch nearly every file for no functional gain. Instead, each page keeps
// its own { doc, svgEl } record here, and switching the active page just
// reassigns the *same* bare globals everything else already reads — every
// existing function (renderDoc, pushUndo, findObject, tool handlers, ...)
// works completely unchanged, operating on "whichever page is active" exactly
// like it operated on "the one doc" before pages existed.

let pages = [];
let activePageId = null;

function getPage(id) {
  return pages.find(p => p.id === id) || null;
}

// ---------------------------------------------------------------------
// active-page context switching
// ---------------------------------------------------------------------

// Reassigns the bare doc/canvasEl globals and refreshes lastCommitted —
// nothing else. Used both by switchActivePage() (real user-facing page
// switch) and internally by renderAllPages()'s render-then-restore loop,
// where re-deriving lastCommitted from the (unchanged) doc is always a safe
// no-op since no edits happen mid-render.
function switchToPageContextOnly(id) {
  syncActivePageDoc();
  const page = getPage(id);
  if (!page) return;
  doc = page.doc;
  canvasEl = page.svgEl;
  lastCommitted = JSON.stringify(doc);
  activePageId = id;
}

// Writes the live `doc` back into its page record. Needed because `doc` is
// reassigned by value when switching pages — without this, edits made since
// the last switch would be lost the moment you switch away.
function syncActivePageDoc() {
  if (activePageId == null) return;
  const page = getPage(activePageId);
  if (page) page.doc = doc;
}

// The user-facing page switch: also refreshes the layers panel (it always
// reflects the active page only) and the page-chrome highlight/labels.
function switchActivePage(id) {
  if (id === activePageId) return;
  switchToPageContextOnly(id);
  renderLayers();
  renderPageChrome();
}

// Used by undo()/redo() (document.js) to jump to wherever a history entry
// actually happened, without the redundant renderLayers() call they already
// make themselves right after.
function goToPageForHistory(pageId) {
  if (pageId !== activePageId) {
    switchToPageContextOnly(pageId);
    scrollPageIntoView(pageId);
    renderPageChrome();
  }
}

function activatePageFromEvent(e) {
  const page = pages.find(p => p.svgEl === e.currentTarget);
  if (page && page.id !== activePageId) switchActivePage(page.id);
}

function scrollPageIntoView(id) {
  getPage(id)?.wrapEl.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---------------------------------------------------------------------
// page CRUD
// ---------------------------------------------------------------------

// Builds the persistent DOM for one page (label + its own <svg>) and mounts
// it into #page-stack. The <svg> is created once and never torn down/rebuilt
// for the life of the page — critical for GIF playback, since recreating the
// element would restart any animated <image> inside it from frame 0.
function mountNewPage(id, name, docData) {
  const wrap = document.createElement("div");
  wrap.className = "page-wrap";
  wrap.dataset.pageId = id;

  const label = document.createElement("div");
  label.className = "page-label";
  wrap.appendChild(label);

  const svgEl = document.createElementNS(svgNS, "svg");
  svgEl.setAttribute("class", "page-canvas");
  wrap.appendChild(svgEl);

  document.getElementById("page-stack").appendChild(wrap);

  const page = { id, name, doc: docData, svgEl, wrapEl: wrap, labelEl: label };

  bindPageEvents(svgEl); // tools.js — pointerdown/pointermove/dblclick
  // Clicking the label chrome (not just the drawing surface) also activates
  // the page — capture:true so this fires before the svg's own listener.
  wrap.addEventListener("pointerdown", () => {
    if (page.id !== activePageId) switchActivePage(page.id);
  }, { capture: true });

  return page;
}

function initPages() {
  pages = [];
  activePageId = null;
  const page = mountNewPage(uid(), "Page 1", makeBlankDoc());
  pages.push(page);
  switchToPageContextOnly(page.id);
  resetHistory();
  renderPageChrome();
}

function addPage(name) {
  const page = mountNewPage(uid(), name || `Page ${pages.length + 1}`, makeBlankDoc());
  pages.push(page);
  // Page add/remove/reorder are deliberately NOT part of the undo/redo
  // history: that history only ever snapshots a single page's `doc` (see
  // document.js), so there's no way to represent "this page didn't exist"
  // in a snapshot without a different history model entirely. Flagged, not
  // silently faked — Ctrl+Z affects object edits, not page structure.
  switchActivePage(page.id);
  renderAllPages();
  scrollPageIntoView(page.id);
  flashStatus(`Added "${page.name}"`);
}

function removePage(id) {
  if (pages.length <= 1) { flashStatus("Can't delete the only page"); return; }
  const idx = pages.findIndex(p => p.id === id);
  if (idx < 0) return;
  const [removed] = pages.splice(idx, 1);
  removed.wrapEl.remove();
  if (activePageId === id) {
    const next = pages[Math.max(0, idx - 1)];
    switchToPageContextOnly(next.id);
  }
  // Any undo/redo entries still tagged with this page's id become inert —
  // document.js's undo()/redo() skip entries whose page no longer exists
  // rather than crashing.
  renderAllPages();
  flashStatus(`Deleted "${removed.name}"`);
}

function resetToSinglePage() {
  destroyAllPages();
  const page = mountNewPage(uid(), "Page 1", makeBlankDoc());
  pages = [page];
  switchToPageContextOnly(page.id);
  resetHistory();
}

function destroyAllPages() {
  for (const p of pages) p.wrapEl.remove();
  pages = [];
  activePageId = null;
}

// Loads a whole project (see export.js's serializeProject()/load handler).
// `data.pages` is [{ id, name, doc }]; legacy single-doc project files are
// wrapped into this shape by the caller before reaching here.
function loadProjectData(data) {
  destroyAllPages();
  pages = data.pages.map(p => mountNewPage(p.id || uid(), p.name || `Page ${pages.length + 1}`, p.doc));
  const targetId = data.activePageId && getPage(data.activePageId) ? data.activePageId : pages[0].id;
  switchToPageContextOnly(targetId);
  resetHistory();
  renderAllPages();
}

// ---------------------------------------------------------------------
// rendering — draws every page (each page's own <image> GIFs keep animating
// on their own regardless; nothing here drives that, the browser does), then
// restores the true active-page context so the shared panels (canvas size,
// fill/stroke, layers) reflect the page you're actually on, not whichever
// page happened to render last in the loop.
// ---------------------------------------------------------------------

function renderAllPages() {
  // Deliberately NOT switchToPageContextOnly() here: that calls
  // syncActivePageDoc(), which writes the bare `doc` into
  // getPage(activePageId).doc — correct when `doc` still belongs to
  // activePageId, but by the end of the loop below `doc` belongs to
  // whichever page rendered last. Calling it here would silently overwrite
  // the real active page's record with a different page's doc. Nothing in
  // this render-only pass ever needs syncing anyway — the loop only *reads*
  // page.doc into the global, it never edits it.
  const active = getPage(activePageId);
  for (const page of pages) {
    doc = page.doc;
    canvasEl = page.svgEl;
    renderDoc();
  }
  if (active) {
    doc = active.doc;
    canvasEl = active.svgEl;
    lastCommitted = JSON.stringify(doc);
  }
  renderDoc();
  renderLayers();
  renderPageChrome();
}

// ---------------------------------------------------------------------
// page chrome — label, rename, delete, drag-reorder. Rebuilt wholesale on
// every call (cheap: it's a handful of DOM nodes, not the svg), same
// tradeoff panels.js's renderLayers() already makes for the layers list.
// ---------------------------------------------------------------------

function renderPageChrome() {
  pages.forEach(page => {
    page.wrapEl.classList.toggle("active-page", page.id === activePageId);
    page.labelEl.innerHTML = `
      <span class="page-drag-handle" draggable="true" title="Drag to reorder">⠿</span>
      <span class="page-name" title="Double-click to rename">${escapeHtml(page.name)}</span>
      <button data-act="page-del" title="${pages.length <= 1 ? "Can't delete the only page" : "Delete page"}"${pages.length <= 1 ? " disabled" : ""}>✕</button>
    `;

    page.labelEl.querySelector(".page-name").addEventListener("dblclick", e => {
      e.stopPropagation();
      startPageRename(page);
    });
    page.labelEl.querySelector('[data-act="page-del"]').addEventListener("click", () => removePage(page.id));

    const handle = page.labelEl.querySelector(".page-drag-handle");
    handle.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/page-id", page.id);
      e.dataTransfer.effectAllowed = "move";
    });
    page.wrapEl.ondragover = e => e.preventDefault();
    page.wrapEl.ondrop = e => {
      e.preventDefault();
      const draggedId = e.dataTransfer.getData("text/page-id");
      if (!draggedId || draggedId === page.id) return;
      if (movePageToIndex(pages.findIndex(p => p.id === draggedId), pages.findIndex(p => p.id === page.id))) {
        renderPageChrome();
      }
    };
  });
}

function movePageToIndex(fromIndex, toIndex) {
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return false;
  if (fromIndex >= pages.length || toIndex >= pages.length) return false;
  const [moved] = pages.splice(fromIndex, 1);
  pages.splice(toIndex, 0, moved);
  const stack = document.getElementById("page-stack");
  pages.forEach(p => stack.appendChild(p.wrapEl)); // re-append in new order — appendChild moves, doesn't duplicate
  return true;
}

function startPageRename(page) {
  const span = page.labelEl.querySelector(".page-name");
  const input = document.createElement("input");
  input.className = "page-rename-input";
  input.value = page.name;
  span.replaceWith(input);
  input.focus(); input.select();

  const commit = () => {
    const name = input.value.trim();
    if (name) page.name = name;
    renderPageChrome();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.removeEventListener("blur", commit); renderPageChrome(); }
  });
}

document.getElementById("btn-add-page").addEventListener("click", () => addPage());
