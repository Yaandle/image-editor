// tools.js
// All drawing/editing tools. Each tool implements down/move/up.
//
// Geometry is stored in absolute attrs (x/y, cx/cy, etc.) — no SVG
// transform is used for moves or resizes, so getBBox() always matches
// what's on screen. Rotation remains the sole transform exception
// (handled in canvas.js).

let currentTool = "select";
let dragState = null;
let dragDidChange = false; // tracks whether a drag actually mutated anything, to avoid no-op undo pushes

// Crop mode — a transient editing state layered on top of the select tool
// rather than its own tool, so it never has to duplicate select's pointer
// plumbing. { id, bounds: the image's original x/y/width/height (crop rect
// can't exceed these), rect: the crop rect being dragged }. Not part of doc —
// only applyCrop()'s resulting attribute change is undoable, cropping itself
// can be freely cancelled.
let cropState = null;

function setTool(name) {
  currentTool = name;
  tools.pen.cancel?.();
  if (cropState) { cropState = null; renderDoc(); } // switching tools abandons an in-progress crop
  clearSelection();
  document.querySelectorAll(".tool").forEach(b => b.classList.toggle("active", b.dataset.tool === name));
  // Tool state is shared across every page (spec: "shares the same tool
  // state and color picker"), so the cursor affordance should be too — every
  // page's svg gets the class, not just the currently-active one.
  for (const page of pages) page.svgEl.className = `tool-${name}`;
  renderDoc();
}

function currentStyle() {
  return {
    fill: document.getElementById("fill-color").value,
    stroke: document.getElementById("stroke-color").value,
    "stroke-width": document.getElementById("stroke-width").value,
  };
}

// ---------------------------------------------------------------------
// property panel reactivity (bug #2 fix): currentStyle() above already
// reads these three inputs for newly-created objects, but nothing ever
// routed a change on them back onto an existing selection —
// updateObjectAttrs() (document.js) was written for exactly this and was
// never actually called anywhere. "input" applies the change live, so a
// drag on the colour input previews instantly; "change" is where we
// commit to undo history — the same live/commit split already used by
// the hue slider and hex field in colorPicker.js.
//
// Only the single attribute that actually fired is patched, not the
// whole currentStyle() bundle — so nudging stroke-width can't also
// silently stomp a fill of "none" back to whatever hex happens to be
// sitting in the (native, non-"none"-capable) fill-color input.
// ---------------------------------------------------------------------

function applyPropertyChange(attrName, value, commit) {
  if (!doc || !doc.selectedIds.length) return;
  for (const id of doc.selectedIds) updateObjectAttrs(id, { [attrName]: value });
  renderDoc();
  if (commit) pushUndo();
}

document.getElementById("fill-color").addEventListener("input", e => applyPropertyChange("fill", e.target.value, false));
document.getElementById("fill-color").addEventListener("change", e => applyPropertyChange("fill", e.target.value, true));
document.getElementById("stroke-color").addEventListener("input", e => applyPropertyChange("stroke", e.target.value, false));
document.getElementById("stroke-color").addEventListener("change", e => applyPropertyChange("stroke", e.target.value, true));
document.getElementById("stroke-width").addEventListener("input", e => applyPropertyChange("stroke-width", e.target.value, false));
document.getElementById("stroke-width").addEventListener("change", e => applyPropertyChange("stroke-width", e.target.value, true));

// The other half of "object state and UI state remain synchronised":
// makes the panel reflect the *selected* object's actual style instead of
// stale/default values. Called from canvas.js's renderSelectionOverlay()
// after every selection change — single-select reflects that object,
// multi-select reflects the first member (matching how an edit then
// applies uniformly to the whole selection). Skips a field when the
// object's value is "none" — a native <input type="color"> has no way to
// represent that; see bug #3, which moves the no-fill state into
// colorPicker.js's picker instead.
function syncPropertyPanelToSelection() {
  if (!doc || !doc.selectedIds.length) return;
  const obj = selectedObjects()[0];
  if (!obj) return;

  const fillEl = document.getElementById("fill-color");
  const strokeEl = document.getElementById("stroke-color");
  const widthEl = document.getElementById("stroke-width");

  if (obj.attrs.fill && obj.attrs.fill !== "none" && fillEl.value !== obj.attrs.fill) {
    fillEl.value = obj.attrs.fill;
  }
  if (obj.attrs.stroke && obj.attrs.stroke !== "none" && strokeEl.value !== obj.attrs.stroke) {
    strokeEl.value = obj.attrs.stroke;
  }
  if (obj.attrs["stroke-width"] != null && String(widthEl.value) !== String(obj.attrs["stroke-width"])) {
    widthEl.value = obj.attrs["stroke-width"];
  }
}

// Shows/hides the Arrange card (any selection) and Adjustments+Crop cards
// (image selections only), and keeps the adjustment sliders reflecting the
// first selected object's actual values — same "first member, skip whatever
// input currently has focus" convention as syncPropertyPanelToSelection()
// above. Called unconditionally from canvas.js's renderDoc() (not just when
// a selection exists) so these cards actually hide again once you deselect —
// renderSelectionOverlay() only runs its sync hook when there IS a selection.
function syncSelectionDependentPanels() {
  const ids = doc?.selectedIds || [];
  const arrangeCard = document.getElementById("prop-arrange");
  if (arrangeCard) arrangeCard.hidden = ids.length === 0;

  const adjustCard = document.getElementById("prop-adjustments");
  const firstObj = ids.length ? selectedObjects()[0] : null;
  const isImage = firstObj?.type === "image";
  if (adjustCard) adjustCard.hidden = !isImage;
  if (!isImage) return;

  const fields = {
    "adj-brightness": firstObj.attrs.brightness ?? 100,
    "adj-contrast": firstObj.attrs.contrast ?? 100,
    "adj-saturate": firstObj.attrs.saturate ?? 100,
    "adj-grayscale": firstObj.attrs.grayscale ?? 0,
  };
  for (const [id, val] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = val;
  }
  const invertEl = document.getElementById("adj-invert");
  if (invertEl) invertEl.checked = (firstObj.attrs.invert ?? 0) >= 50;

  const cropControls = document.getElementById("crop-controls");
  if (cropControls) cropControls.hidden = !!firstObj.animated;
  const startBtn = document.getElementById("btn-start-crop");
  const activeControls = document.getElementById("crop-active-controls");
  if (startBtn) startBtn.hidden = !!cropState;
  if (activeControls) activeControls.hidden = !cropState;
}

function currentAdjustmentValues() {
  return {
    brightness: document.getElementById("adj-brightness").value,
    contrast: document.getElementById("adj-contrast").value,
    saturate: document.getElementById("adj-saturate").value,
    grayscale: document.getElementById("adj-grayscale").value,
    invert: document.getElementById("adj-invert").checked ? 100 : 0,
  };
}

// Same live(input)/commit(change) split as applyPropertyChange() — only
// applies to image objects within the selection, silently skipping others.
function applyAdjustment(commit) {
  if (!doc || !doc.selectedIds.length) return;
  const v = currentAdjustmentValues();
  for (const id of doc.selectedIds) {
    const { obj } = findObject(id) || {};
    if (obj?.type === "image") updateObjectAttrs(id, v);
  }
  renderDoc();
  if (commit) pushUndo();
}

["adj-brightness", "adj-contrast", "adj-saturate", "adj-grayscale"].forEach(id => {
  document.getElementById(id).addEventListener("input", () => applyAdjustment(false));
  document.getElementById(id).addEventListener("change", () => applyAdjustment(true));
});
document.getElementById("adj-invert").addEventListener("change", () => applyAdjustment(true));

document.getElementById("btn-reset-adjustments").addEventListener("click", () => {
  document.getElementById("adj-brightness").value = 100;
  document.getElementById("adj-contrast").value = 100;
  document.getElementById("adj-saturate").value = 100;
  document.getElementById("adj-grayscale").value = 0;
  document.getElementById("adj-invert").checked = false;
  applyAdjustment(true);
});

// Multi-page: these were bound once to the single static #canvas element.
// Now every page owns its own <svg> (pages.js), so pages.js calls
// bindPageEvents(svgEl) once per page at creation time instead. Handler
// bodies are unchanged from the single-canvas version — pointerdown just
// additionally (a) activates that page as the one tools/undo apply to, and
// (b) captures the pointer so a drag that strays past this page's visual
// boundary still targets this page's doc, not whatever page is physically
// underneath the cursor once pages are stacked vertically.
function bindPageEvents(svgEl) {
  svgEl.addEventListener("pointerdown", e => {
    activatePageFromEvent(e);
    svgEl.setPointerCapture(e.pointerId);
    tools[currentTool]?.down(e);
  });
  svgEl.addEventListener("pointermove", e => {
    updateHoverCursor(e);
    tools[currentTool]?.move(e);
  });
  svgEl.addEventListener("dblclick", e => {
    activatePageFromEvent(e);
    const id = e.target.dataset.id;
    if (currentTool === "pen") { tools.pen.finish(); return; }
    if (!id) return;
    const { obj } = findObject(id);
    if (obj.type === "text") editTextInline(obj);
  });
}
window.addEventListener("pointerup", e => tools[currentTool]?.up(e));
window.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    if (currentTool === "pen" && tools.pen.points.length) { tools.pen.cancel(); return; }
    if (dragState) { cancelDrag(); return; }
    if (cropState) { cropState = null; renderDoc(); return; }
  }
  if (e.key === "Enter" && currentTool === "pen") tools.pen.finish();
});

// Cursor feedback: crosshair for draw tools, resize/rotate cursor when
// hovering a handle, grab cursor over a selected object body. The static
// per-tool cursor rules live in style.css (#canvas.tool-*).
function updateHoverCursor(e) {
  if (currentTool !== "select") return;
  const cursor = e.target?.dataset?.cursor;
  // e.currentTarget (the page svg this listener is bound to), not the bare
  // `canvasEl` global — hovering a non-active page shouldn't wait for a
  // click to get its own cursor feedback.
  e.currentTarget.style.cursor = cursor || (e.target?.dataset?.id ? "move" : "default");
}

// Reverts to the state at drag-start without touching the undo stack —
// used by Escape-to-cancel so an aborted drag doesn't leave a phantom
// snapshot or a half-applied transform.
function cancelDrag() {
  if (dragState?.snapshot) {
    doc = JSON.parse(dragState.snapshot);
    // Multi-page: reassigning `doc` here breaks its aliasing with the active
    // page's stored record (pages.js) — without this, the page record would
    // keep the half-finished drag state even though the visible canvas
    // reverted, and it would resurface next time you switched pages or saved.
    syncActivePageDoc();
  }
  document.getElementById("marquee-box")?.remove();
  dragState = null;
  dragDidChange = false;
  renderDoc();
}

// ---------------------------------------------------------------------
// pencil path builder — shared by preview and commit so they can never
// visually diverge. Smoothing toggle: quadratic-Bézier midpoint
// smoothing vs raw jagged line segments (MS Paint style).
// ---------------------------------------------------------------------

let penSmoothing = true; // toggled via panels.js — see "smoothing toggle hookup" note

function buildPencilPath(points) {
  if (points.length < 2) return "";
  if (!penSmoothing) {
    return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  }
  // Quadratic Bézier midpoint smoothing: each raw point becomes a control
  // point, with the curve passing through the midpoint of each consecutive
  // pair. Endpoints (first/last) are pinned exactly so the stroke starts
  // and ends where the pointer actually did.
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i], p1 = points[i + 1];
    const midX = (p0.x + p1.x) / 2, midY = (p0.y + p1.y) / 2;
    d += ` Q${p0.x},${p0.y} ${midX},${midY}`;
  }
  const last = points[points.length - 1];
  d += ` L${last.x},${last.y}`; // final segment pinned to true endpoint
  return d;
}

// ---------------------------------------------------------------------
// select tool
// ---------------------------------------------------------------------

const tools = {
  select: {
    down(e) {
      if (cropState) {
        const cropHandle = e.target.dataset.cropHandle;
        if (cropHandle) dragState = { mode: "crop-resize", handle: cropHandle, rect: { ...cropState.rect } };
        return; // clicks elsewhere while cropping are absorbed, not routed to normal select behavior
      }

      const handle = e.target.dataset.handle;
      const id = e.target.dataset.id;
      const snapshot = JSON.stringify(doc); // cheap pre-drag snapshot, only used if Escape cancels

      if (handle === "rotate") {
        const el = canvasEl.querySelector(`[data-id="${doc.selectedIds[0]}"]`);
        const bb = el.getBBox();
        const center = bboxCenter(bb);
        dragState = { mode: "rotate", center, startAngle: getRotation(findObject(doc.selectedIds[0]).obj), snapshot };
        return;
      }

      if (handle) {
        const boxes = doc.selectedIds.map(sid => canvasEl.querySelector(`[data-id="${sid}"]`)?.getBBox()).filter(Boolean);
        const gx = Math.min(...boxes.map(b => b.x)), gy = Math.min(...boxes.map(b => b.y));
        const gx1 = Math.max(...boxes.map(b => b.x + b.width)), gy1 = Math.max(...boxes.map(b => b.y + b.height));
        dragState = {
          mode: "resize", handle,
          groupBBox: { x: gx, y: gy, width: gx1 - gx, height: gy1 - gy },
          starts: doc.selectedIds.map(sid => ({ id: sid, bbox: canvasEl.querySelector(`[data-id="${sid}"]`).getBBox() })),
          snapshot,
        };
        return;
      }

      if (id) {
        if (e.shiftKey) {
          toggleSelection(id);
        } else if (!doc.selectedIds.includes(id)) {
          selectOnly(id);
        }
        dragState = { mode: "move", start: toDocPoint(e), snapshot };
        renderDoc();
        return;
      }

      // empty canvas: start rubber-band. A click that never moves resolves
      // to a plain deselect in up() rather than pushing a marquee undo step.
      if (!e.shiftKey) clearSelection();
      dragState = { mode: "marquee", start: toDocPoint(e), baseIds: [...doc.selectedIds], moved: false, snapshot };
      renderDoc();
    },

    move(e) {
      if (!dragState) return;

      if (dragState.mode === "crop-resize") {
        const p = toDocPoint(e);
        const b = cropState.bounds;
        const clampedX = clamp(p.x, b.x, b.x + b.width);
        const clampedY = clamp(p.y, b.y, b.y + b.height);
        const r = { ...dragState.rect };
        if (dragState.handle.includes("w")) { r.width += r.x - clampedX; r.x = clampedX; }
        if (dragState.handle.includes("e")) { r.width = clampedX - r.x; }
        if (dragState.handle.includes("n")) { r.height += r.y - clampedY; r.y = clampedY; }
        if (dragState.handle.includes("s")) { r.height = clampedY - r.y; }
        if (r.width < 0) { r.x += r.width; r.width = -r.width; }
        if (r.height < 0) { r.y += r.height; r.height = -r.height; }
        cropState.rect = { x: r.x, y: r.y, width: Math.max(4, r.width), height: Math.max(4, r.height) };
        renderDoc();
        return;
      }

      if (!doc.selectedIds.length && dragState.mode !== "marquee") return;

      const p = toDocPoint(e);

      if (dragState.mode === "rotate") {
        const { obj } = findObject(doc.selectedIds[0]);
        const angleRad = Math.atan2(p.y - dragState.center.y, p.x - dragState.center.x);
        let deg = (angleRad * 180 / Math.PI) + 90; // +90 so pointer-up = 0deg
        if (e.shiftKey) deg = Math.round(deg / 15) * 15; // snap every 15° when holding shift
        setRotation(obj, deg);
        dragDidChange = true;
        renderDoc();
        return;
      }

      if (dragState.mode === "move") {
        const dx = p.x - dragState.start.x, dy = p.y - dragState.start.y;
        if (dx || dy) dragDidChange = true;
        for (const obj of selectedObjects()) moveObject(obj, dx, dy);
        dragState.start = p;
        renderDoc();
        applySnapGuides();
        return;
      }

      if (dragState.mode === "marquee") {
        dragState.moved = true;
        const rect = normalizeRect(dragState.start, p);
        drawMarquee(rect);
        const hitIds = allObjectIds().filter(id => {
          const el = canvasEl.querySelector(`[data-id="${id}"]`);
          return el && rectsIntersect(rect, el.getBBox());
        });
        doc.selectedIds = [...new Set([...dragState.baseIds, ...hitIds])];
        renderSelectionOverlay();
        return;
      }

      // resize — see scaleObjectWithinGroup() for the bug-#1 fix (corner sign
      // handling per handle direction + live bounds clamping against doc size)
      const gb = dragState.groupBBox;
      const fx = dragState.handle.includes("w") ? gb.x + gb.width : gb.x;
      const fy = dragState.handle.includes("n") ? gb.y + gb.height : gb.y;

      // clamp the pointer itself to the canvas first — this is the cheapest
      // point to stop overflow, before any per-object math runs
      const clampedX = Math.min(Math.max(p.x, 0), doc.width);
      const clampedY = Math.min(Math.max(p.y, 0), doc.height);

      let newW = Math.max(1, Math.abs(clampedX - fx));
      let newH = Math.max(1, Math.abs(clampedY - fy));

      // Shift: constrain resize to the group's original aspect ratio —
      // matches MS Paint / most editors' proportional-resize modifier.
      if (e.shiftKey && gb.width && gb.height) {
        const ratio = gb.width / gb.height;
        if (newW / newH > ratio) newW = newH * ratio; else newH = newW / ratio;
      }

      // Which side of the anchor counts as "flipped" depends on which
      // handle is being dragged, not just which side the pointer is on.
      // nw/sw anchor sits on the *right* edge (fx = gb.x + gb.width), so
      // their non-flipped drag direction is pointer-left-of-anchor — the
      // opposite of ne/se, whose anchor is on the left. Same story for
      // nw/ne vs sw/se on the y-axis. The old code used one fixed
      // direction for every handle, which only happens to match "se"
      // (anchor on the near side for both axes) — hence "only
      // bottom-right works" and the other three corners flipping/clipping
      // instead of resizing.
      const westHandle = dragState.handle.includes("w");
      const northHandle = dragState.handle.includes("n");
      const flippedX = westHandle ? clampedX > fx : clampedX < fx;
      const flippedY = northHandle ? clampedY > fy : clampedY < fy;
      const scaleX = (flippedX ? -1 : 1) * newW / gb.width;
      const scaleY = (flippedY ? -1 : 1) * newH / gb.height;

      dragDidChange = true;
      for (const { id, bbox } of dragState.starts) {
        const { obj } = findObject(id);
        scaleObjectWithinGroup(obj, bbox, fx, fy, scaleX, scaleY);
      }
      renderDoc();
    },

    up() {
      if (dragState?.mode === "crop-resize") {
        dragState = null; // crop rect isn't undo-tracked itself — only applyCrop()'s result is
        return;
      }
      if (dragState?.mode === "marquee") {
        document.getElementById("marquee-box")?.remove();
      }
      // Only commit to undo history if the drag actually changed something —
      // a bare click or a marquee that never grew is a no-op, not a step.
      if (dragState && dragDidChange) pushUndo();
      dragState = null;
      dragDidChange = false;
      clearSnapGuides();
    },
  },

  rect: shapeTool("rect", (a, b, shiftKey) => {
    let w = b.x - a.x, h = b.y - a.y;
    if (shiftKey) { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
    return {
      x: Math.min(a.x, a.x + w), y: Math.min(a.y, a.y + h),
      width: Math.abs(w) || 1, height: Math.abs(h) || 1,
    };
  }),
  ellipse: shapeTool("ellipse", (a, b, shiftKey) => {
    let rx = Math.abs(b.x - a.x) / 2 || 1, ry = Math.abs(b.y - a.y) / 2 || 1;
    if (shiftKey) { const r = Math.max(rx, ry); rx = r; ry = r; }
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, rx, ry };
  }),
  line: shapeTool("line", (a, b, shiftKey) => {
    let x2 = b.x, y2 = b.y;
    if (shiftKey) {
      // snap to nearest 45° — matches the rotate-handle's 15° snap in spirit
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      x2 = a.x + Math.cos(angle) * dist;
      y2 = a.y + Math.sin(angle) * dist;
    }
    return { x1: a.x, y1: a.y, x2, y2 };
  }),

  // -------------------------------------------------------------------
  // pen — click-to-place-anchor, straight-line segments (Illustrator-style)
  // Finish via double-click, Enter, or Escape (cancel).
  // -------------------------------------------------------------------
  pen: {
    points: [],
    down(e) { this.points.push(toDocPoint(e)); this._preview(); },
    move() {}, up() {},
    _preview() {
      const d = this.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
      let el = canvasEl.querySelector("#pen-preview");
      if (!el) {
        el = document.createElementNS(svgNS, "path");
        el.id = "pen-preview";
        el.setAttribute("fill", "none");
        el.setAttribute("stroke", currentStyle().stroke);
        el.setAttribute("stroke-width", currentStyle()["stroke-width"]);
        canvasEl.appendChild(el);
      }
      el.setAttribute("d", d);
    },
    finish() {
      if (this.points.length >= 2) {
        const d = this.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
        // fill must come after the currentStyle() spread, not before —
        // currentStyle().fill was silently overwriting "none" here, so
        // every pen stroke ended up auto-filled with the current fill
        // colour instead of staying an open path.
        const obj = addObject({ id: uid(), type: "path", attrs: { ...currentStyle(), d, fill: "none" } });
        selectOnly(obj.id);
        pushUndo();
      }
      this.points = [];
      document.getElementById("pen-preview")?.remove();
      renderDoc();
    },
    cancel() {
      this.points = [];
      document.getElementById("pen-preview")?.remove();
    },
  },

  // -------------------------------------------------------------------
  // pencil — free-draw, continuous path following the pointer while
  // dragging. Separate tool from pen (own shortcut, see panels.js).
  // Smoothing toggle: quadratic-Bézier midpoint smoothing vs raw jagged
  // line segments (MS Paint style). Both preview and commit share
  // buildPencilPath() so they can never visually diverge.
  // -------------------------------------------------------------------
  pencil: {
    isDrawing: false,
    points: [],
    minDist: 3, // doc-space units; skips pushing a point closer than this to the last one

    down(e) {
      this.isDrawing = true;
      this.points = [toDocPoint(e)];
      this._preview();
    },

    move(e) {
      if (!this.isDrawing) return;
      const p = toDocPoint(e);
      const last = this.points[this.points.length - 1];
      const dx = p.x - last.x, dy = p.y - last.y;
      if (dx * dx + dy * dy < this.minDist * this.minDist) return; // too close, skip
      this.points.push(p);
      this._preview();
    },

    up(e) {
      if (!this.isDrawing) return;
      this.isDrawing = false;
      // always capture the true final pointer position, even if it was
      // within minDist of the last sampled point — fixes strokes falling
      // short of where the cursor actually stopped
      if (e) {
        const p = toDocPoint(e);
        const last = this.points[this.points.length - 1];
        if (p.x !== last.x || p.y !== last.y) this.points.push(p);
      }
      if (this.points.length >= 2) {
        const d = buildPencilPath(this.points);
        // same clobbering bug as pen.finish() — fill must be forced after
        // the spread, otherwise the current fill colour silently wins.
        const obj = addObject({ id: uid(), type: "path", attrs: { ...currentStyle(), d, fill: "none" } });
        selectOnly(obj.id);
        pushUndo();
      }
      this.points = [];
      document.getElementById("pencil-preview")?.remove();
      renderDoc();
    },

    _preview() {
      const d = buildPencilPath(this.points);
      let el = canvasEl.querySelector("#pencil-preview");
      if (!el) {
        el = document.createElementNS(svgNS, "path");
        el.id = "pencil-preview";
        el.setAttribute("fill", "none");
        el.setAttribute("stroke", currentStyle().stroke);
        el.setAttribute("stroke-width", currentStyle()["stroke-width"]);
        canvasEl.appendChild(el);
      }
      el.setAttribute("d", d);
    },
  },

  text: {
    down(e) {
      const p = toDocPoint(e);
      const obj = addObject({
        id: uid(), type: "text",
        attrs: { x: p.x, y: p.y, "font-size": 24, fill: currentStyle().fill, content: "Text" },
      });
      pushUndo(); renderDoc(); editTextInline(obj);
    },
    move() {}, up() {},
  },

  fill: {
    async down(e) {
      const id = e.target.dataset.id;
      if (!id) return;
      const { obj } = findObject(id);
      if (obj.type === "image") {
        // Flood-fill rasterizes via canvas 2D drawImage(), which only ever
        // samples a GIF's current frame — running it on an animated import
        // would silently bake that one frame in as a static PNG and kill the
        // animation. Refuse instead of corrupting it quietly.
        if (obj.animated) {
          flashStatus("Can't bucket-fill an animated GIF — it would freeze it to one frame");
          return;
        }
        await floodFillImage(obj, toDocPoint(e), currentStyle().fill);
      } else {
        obj.attrs.fill = currentStyle().fill;
      }
      pushUndo(); renderDoc();
    },
    move() {}, up() {},
  },
};

// ---------------------------------------------------------------------
// bug #1 fix: group resize — correct sign handling per corner direction,
// plus live clamping against doc bounds so shapes can't grow past the
// canvas edge. Clamping happens upstream in select.move() (pointer clamp);
// this function additionally clamps its own output as a second guard,
// since scaleX/scaleY can still be extreme if a single object's own
// bbox starts very close to an edge.
// ---------------------------------------------------------------------

function scaleObjectWithinGroup(obj, origBBox, originX, originY, scaleX, scaleY) {
  const newX = originX + (origBBox.x - originX) * scaleX;
  const newY = originY + (origBBox.y - originY) * scaleY;
  const newW = origBBox.width * Math.abs(scaleX);
  const newH = origBBox.height * Math.abs(scaleY);

  if (obj.type === "rect" || obj.type === "image") {
    const minX = scaleX < 0 ? newX - newW : newX;
    const minY = scaleY < 0 ? newY - newH : newY;
    obj.attrs.x = clamp(minX, 0, doc.width - newW);
    obj.attrs.y = clamp(minY, 0, doc.height - newH);
    obj.attrs.width = clamp(newW, 1, doc.width);
    obj.attrs.height = clamp(newH, 1, doc.height);

  } else if (obj.type === "ellipse") {
    const cx = originX + (origBBox.x + origBBox.width / 2 - originX) * scaleX;
    const cy = originY + (origBBox.y + origBBox.height / 2 - originY) * scaleY;
    const rx = clamp((origBBox.width / 2) * Math.abs(scaleX), 1, doc.width / 2);
    const ry = clamp((origBBox.height / 2) * Math.abs(scaleY), 1, doc.height / 2);
    obj.attrs.cx = clamp(cx, rx, doc.width - rx);
    obj.attrs.cy = clamp(cy, ry, doc.height - ry);
    obj.attrs.rx = rx;
    obj.attrs.ry = ry;

  } else if (obj.type === "line") {
    obj.attrs.x1 = clamp(originX + (parseFloat(obj.attrs.x1) - originX) * scaleX, 0, doc.width);
    obj.attrs.y1 = clamp(originY + (parseFloat(obj.attrs.y1) - originY) * scaleY, 0, doc.height);
    obj.attrs.x2 = clamp(originX + (parseFloat(obj.attrs.x2) - originX) * scaleX, 0, doc.width);
    obj.attrs.y2 = clamp(originY + (parseFloat(obj.attrs.y2) - originY) * scaleY, 0, doc.height);

  } else if (obj.type === "text") {
    obj.attrs.x = clamp(originX + (parseFloat(obj.attrs.x) - originX) * scaleX, 0, doc.width);
    obj.attrs.y = clamp(originY + (parseFloat(obj.attrs.y) - originY) * scaleY, 0, doc.height);
  }
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

// ---------------------------------------------------------------------
// marquee / hit-test helpers
// ---------------------------------------------------------------------

function normalizeRect(a, b) {
  return {
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
  };
}

function rectsIntersect(a, b) {
  return !(b.x > a.x + a.width || b.x + b.width < a.x || b.y > a.y + a.height || b.y + b.height < a.y);
}

function allObjectIds() {
  return doc.layers.filter(l => l.visible).flatMap(l => l.objects.map(o => o.id));
}

function drawMarquee(rect) {
  let el = document.getElementById("marquee-box");
  if (!el) {
    el = document.createElementNS(svgNS, "rect");
    el.id = "marquee-box";
    el.setAttribute("class", "marquee-box");
    canvasEl.appendChild(el);
  }
  el.setAttribute("x", rect.x); el.setAttribute("y", rect.y);
  el.setAttribute("width", rect.width); el.setAttribute("height", rect.height);
}

// ---------------------------------------------------------------------
// shape tool factory (rect / ellipse / line)
// makeAttrs(start, current, shiftKey) — shiftKey enables square/circle/
// 45°-line constraint, matching MS Paint's shape-tool modifier behavior.
// ---------------------------------------------------------------------

function shapeTool(type, makeAttrs) {
  return {
    start: null, obj: null,
    down(e) {
      this.start = toDocPoint(e);
      this.obj = addObject({ id: uid(), type, attrs: { ...makeAttrs(this.start, this.start, false), ...currentStyle() } });
      renderDoc();
    },
    move(e) {
      if (!this.start) return;
      Object.assign(this.obj.attrs, makeAttrs(this.start, toDocPoint(e), e.shiftKey));
      renderDoc();
    },
    up() {
      if (this.obj) { selectOnly(this.obj.id); pushUndo(); }
      this.start = null; this.obj = null;
      renderDoc();
    },
  };
}

// ---------------------------------------------------------------------
// move (drag)
// ---------------------------------------------------------------------

function moveObject(obj, dx, dy) {
  nudgeObject(obj, dx, dy); // shared with document.js's duplicateObject() — one path for position math
}

// ---------------------------------------------------------------------
// text editing
// ---------------------------------------------------------------------

function editTextInline(obj) {
  const el = canvasEl.querySelector(`[data-id="${obj.id}"]`);
  const bb = el.getBoundingClientRect();
  const input = document.createElement("input");
  input.className = "text-editor";
  input.value = obj.attrs.content;
  input.style.left = bb.left + "px"; input.style.top = bb.top + "px";
  input.style.fontSize = obj.attrs["font-size"] + "px";
  document.body.appendChild(input);
  input.focus(); input.select();
  const commit = () => {
    obj.attrs.content = input.value || "Text";
    input.remove(); pushUndo(); renderDoc();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); });
}

// ---------------------------------------------------------------------
// raster flood fill
// ---------------------------------------------------------------------

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function floodFillImage(obj, point, fillHex) {
  return new Promise(resolve => {
    const localX = point.x - parseFloat(obj.attrs.x);
    const localY = point.y - parseFloat(obj.attrs.y);
    const img = new Image();
    img.onerror = () => resolve();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);

      const sx = w / parseFloat(obj.attrs.width), sy = h / parseFloat(obj.attrs.height);
      const px = Math.floor(localX * sx), py = Math.floor(localY * sy);
      if (px < 0 || py < 0 || px >= w || py >= h) return resolve();

      const data = ctx.getImageData(0, 0, w, h);
      const [fr, fg, fb] = hexToRgb(fillHex);
      const TOL = 40;
      const idx = (x, y) => (y * w + x) * 4;
      const start = idx(px, py);
      const t0 = data.data[start], t1 = data.data[start + 1], t2 = data.data[start + 2];
      const match = i => {
        const dr = data.data[i] - t0, dg = data.data[i + 1] - t1, db = data.data[i + 2] - t2;
        return Math.sqrt(dr * dr + dg * dg + db * db) <= TOL;
      };
      const stack = [[px, py]];
      const seen = new Uint8Array(w * h);
      while (stack.length) {
        const [x, y] = stack.pop();
        if (x < 0 || y < 0 || x >= w || y >= h || seen[y * w + x]) continue;
        const i = idx(x, y);
        if (!match(i)) continue;
        seen[y * w + x] = 1;
        data.data[i] = fr; data.data[i + 1] = fg; data.data[i + 2] = fb; data.data[i + 3] = 255;
        stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
      }
      ctx.putImageData(data, 0, 0);
      obj.attrs.href = c.toDataURL("image/png");
      resolve();
    };
    img.src = obj.attrs.href;
  });
}

// ---------------------------------------------------------------------
// crop
// ---------------------------------------------------------------------

function startCrop() {
  if (doc.selectedIds.length !== 1) { flashStatus("Select a single image to crop"); return; }
  const { obj } = findObject(doc.selectedIds[0]) || {};
  if (!obj || obj.type !== "image") return;
  if (obj.animated) { flashStatus("Can't crop an animated GIF — it would freeze it to one frame"); return; }
  const bounds = { x: num(obj.attrs.x), y: num(obj.attrs.y), width: num(obj.attrs.width), height: num(obj.attrs.height) };
  cropState = { id: obj.id, bounds, rect: { ...bounds } };
  renderDoc();
}

function cancelCrop() {
  cropState = null;
  renderDoc();
}

// Rasterizes just the cropped pixel region and replaces the image in place —
// destructive on the pixels (like the fill tool), but that's what "crop"
// means in MS Paint/Photoshop too. Maps the crop rect from doc space back to
// source-image pixel space using the image's current display scale.
function applyCrop() {
  if (!cropState) return;
  const { id, rect } = cropState;
  const found = findObject(id);
  if (!found) { cropState = null; return; }
  const { obj } = found;

  const img = new Image();
  img.onload = () => {
    const scaleX = img.naturalWidth / num(obj.attrs.width);
    const scaleY = img.naturalHeight / num(obj.attrs.height);
    const sx = (rect.x - num(obj.attrs.x)) * scaleX;
    const sy = (rect.y - num(obj.attrs.y)) * scaleY;
    const sw = rect.width * scaleX, sh = rect.height * scaleY;

    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw));
    c.height = Math.max(1, Math.round(sh));
    c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);

    obj.attrs.href = c.toDataURL("image/png");
    obj.attrs.x = rect.x; obj.attrs.y = rect.y;
    obj.attrs.width = rect.width; obj.attrs.height = rect.height;
    cropState = null;
    pushUndo(); renderDoc();
    flashStatus("Cropped");
  };
  img.onerror = () => { flashStatus("Crop failed — couldn't reload the image"); cropState = null; renderDoc(); };
  img.src = obj.attrs.href;
}

// ---------------------------------------------------------------------
// align / distribute / flip — all operate on the current selection and
// share the same building blocks (getObjectBBox, groupBBox, nudgeObject)
// used elsewhere for resize/marquee, rather than introducing new geometry.
// ---------------------------------------------------------------------

// Single selection aligns to the canvas bounds (there's nothing else to align
// relative to); 2+ selected align to the selection's own combined bbox —
// the standard multi-select align convention most editors use.
function alignSelection(edge) {
  const ids = doc.selectedIds;
  const items = ids.map(id => ({ id, bbox: getObjectBBox(id) })).filter(x => x.bbox);
  if (!items.length) return;

  const ref = items.length === 1
    ? { x: 0, y: 0, width: doc.width, height: doc.height }
    : groupBBox(items.map(i => i.bbox));

  for (const { id, bbox } of items) {
    const { obj } = findObject(id);
    let dx = 0, dy = 0;
    switch (edge) {
      case "left":    dx = ref.x - bbox.x; break;
      case "hcenter": dx = (ref.x + ref.width / 2) - (bbox.x + bbox.width / 2); break;
      case "right":   dx = (ref.x + ref.width) - (bbox.x + bbox.width); break;
      case "top":     dy = ref.y - bbox.y; break;
      case "vcenter": dy = (ref.y + ref.height / 2) - (bbox.y + bbox.height / 2); break;
      case "bottom":  dy = (ref.y + ref.height) - (bbox.y + bbox.height); break;
    }
    nudgeObject(obj, dx, dy);
  }
  pushUndo(); renderDoc();
}

// Evenly spaces 3+ objects between the two extreme objects along an axis;
// the extremes themselves stay put (standard "distribute" behavior).
function distributeSelection(axis) {
  const ids = doc.selectedIds;
  if (ids.length < 3) { flashStatus("Select at least 3 objects to distribute"); return; }
  const items = ids.map(id => ({ id, bbox: getObjectBBox(id) })).filter(x => x.bbox);
  if (items.length < 3) return;

  const centerOf = bbox => axis === "h" ? bbox.x + bbox.width / 2 : bbox.y + bbox.height / 2;
  const sorted = [...items].sort((a, b) => centerOf(a.bbox) - centerOf(b.bbox));
  const span = centerOf(sorted[sorted.length - 1].bbox) - centerOf(sorted[0].bbox);
  const step = span / (sorted.length - 1);
  const startCenter = centerOf(sorted[0].bbox);

  sorted.forEach((item, i) => {
    if (i === 0 || i === sorted.length - 1) return;
    const { obj } = findObject(item.id);
    const delta = (startCenter + step * i) - centerOf(item.bbox);
    if (axis === "h") nudgeObject(obj, delta, 0); else nudgeObject(obj, 0, delta);
  });
  pushUndo(); renderDoc();
}

// Mirrors each selected object's own content around its own center (so an
// image or letterform actually flips, not just its bounding box). For 2+
// objects, additionally mirrors each one's position around the shared group
// center — otherwise a multi-object "flip" would leave every shape in place
// and only flip their insides, which isn't what Photoshop/Canva mean by
// flipping a selection.
function flipSelection(axis) {
  const ids = doc.selectedIds;
  const items = ids.map(id => ({ id, bbox: getObjectBBox(id) })).filter(x => x.bbox);
  if (!items.length) return;

  const gb = groupBBox(items.map(i => i.bbox));
  const groupCx = gb.x + gb.width / 2, groupCy = gb.y + gb.height / 2;

  for (const { id, bbox } of items) {
    const { obj } = findObject(id);
    toggleFlip(obj, axis);
    if (items.length > 1) {
      if (axis === "h") nudgeObject(obj, 2 * (groupCx - (bbox.x + bbox.width / 2)), 0);
      else nudgeObject(obj, 0, 2 * (groupCy - (bbox.y + bbox.height / 2)));
    }
  }
  pushUndo(); renderDoc();
}

// ---------------------------------------------------------------------
// smart snap guides — Canva/Figma-style: while moving a selection, snap to
// the canvas's center and edges and show a temporary guide line. Scoped to
// canvas-relative snapping only (not object-to-object) to keep this
// contained; a real "align to other shapes" pass can build on the same
// drawSnapGuides()/clearSnapGuides() plumbing later if wanted.
// ---------------------------------------------------------------------

const SNAP_THRESHOLD = 6; // doc-space units

function applySnapGuides() {
  if (currentTool !== "select" || dragState?.mode !== "move") return;
  const items = doc.selectedIds.map(getObjectBBox).filter(Boolean);
  if (!items.length) return;
  const gb = groupBBox(items);

  const vTargets = [0, doc.width / 2, doc.width];
  const hTargets = [0, doc.height / 2, doc.height];
  const vPoints = [gb.x, gb.x + gb.width / 2, gb.x + gb.width];
  const hPoints = [gb.y, gb.y + gb.height / 2, gb.y + gb.height];

  let snapDx = 0, vAt = null;
  outerV: for (const vp of vPoints) {
    for (const vt of vTargets) {
      if (Math.abs(vp - vt) <= SNAP_THRESHOLD) { snapDx = vt - vp; vAt = vt; break outerV; }
    }
  }
  let snapDy = 0, hAt = null;
  outerH: for (const hp of hPoints) {
    for (const ht of hTargets) {
      if (Math.abs(hp - ht) <= SNAP_THRESHOLD) { snapDy = ht - hp; hAt = ht; break outerH; }
    }
  }

  if (snapDx || snapDy) {
    for (const obj of selectedObjects()) moveObject(obj, snapDx, snapDy);
    renderDoc(); // re-render at the corrected, snapped position before drawing guides
  }
  drawSnapGuides(vAt, hAt);
}

function drawSnapGuides(vAt, hAt) {
  clearSnapGuides();
  if (vAt == null && hAt == null) return;
  const g = document.createElementNS(svgNS, "g");
  g.id = "snap-guides";
  if (vAt != null) {
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", vAt); line.setAttribute("y1", 0);
    line.setAttribute("x2", vAt); line.setAttribute("y2", doc.height);
    line.setAttribute("class", "snap-guide");
    g.appendChild(line);
  }
  if (hAt != null) {
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", 0); line.setAttribute("y1", hAt);
    line.setAttribute("x2", doc.width); line.setAttribute("y2", hAt);
    line.setAttribute("class", "snap-guide");
    g.appendChild(line);
  }
  canvasEl.appendChild(g);
}

function clearSnapGuides() {
  document.getElementById("snap-guides")?.remove();
}
