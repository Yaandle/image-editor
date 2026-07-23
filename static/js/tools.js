// All drawing/editing tools. Each tool implements down/move/up.
// Note: geometry is stored in absolute attrs (x/y, cx/cy, etc.) — no SVG
// transform is used for moves, so getBBox() always matches what's on screen.

let currentTool = "select";
let dragState = null;

function setTool(name) {
  currentTool = name;
  doc.selectedId = null;
  document.querySelectorAll(".tool").forEach(b => b.classList.toggle("active", b.dataset.tool === name));
  canvasEl.className = `tool-${name}`;
  renderDoc();
}

function currentStyle() {
  return {
    fill: document.getElementById("fill-color").value,
    stroke: document.getElementById("stroke-color").value,
    "stroke-width": document.getElementById("stroke-width").value,
  };
}

canvasEl.addEventListener("pointerdown", e => tools[currentTool]?.down(e));
canvasEl.addEventListener("pointermove", e => tools[currentTool]?.move(e));
window.addEventListener("pointerup", e => tools[currentTool]?.up(e));
canvasEl.addEventListener("dblclick", e => {
  const id = e.target.dataset.id;
  if (!id) return;
  const { obj } = findObject(id);
  if (obj.type === "text") editTextInline(obj);
});

const tools = {
  select: {
    down(e) {
      const handle = e.target.dataset.handle;
      const id = e.target.dataset.id;

      if (handle === "rotate") {
        const el = canvasEl.querySelector(`[data-id="${doc.selectedIds[0]}"]`);
        const bb = el.getBBox();
        const center = bboxCenter(bb);
        dragState = { mode: "rotate", center, startAngle: getRotation(findObject(doc.selectedIds[0]).obj) };
        return;
      }

      if (handle) {
        const boxes = doc.selectedIds.map(sid => canvasEl.querySelector(`[data-id="${sid}"]`)?.getBBox()).filter(Boolean);
        const gx = Math.min(...boxes.map(b => b.x)), gy = Math.min(...boxes.map(b => b.y));
        const gx1 = Math.max(...boxes.map(b => b.x+b.width)), gy1 = Math.max(...boxes.map(b => b.y+b.height));
        dragState = {
          mode: "resize", handle,
          groupBBox: { x: gx, y: gy, width: gx1-gx, height: gy1-gy },
          starts: doc.selectedIds.map(sid => ({ id: sid, bbox: canvasEl.querySelector(`[data-id="${sid}"]`).getBBox() })),
        };
        return;
      }

      if (id) {
        if (e.shiftKey) {
          doc.selectedIds = doc.selectedIds.includes(id)
            ? doc.selectedIds.filter(x => x !== id)
            : [...doc.selectedIds, id];
        } else if (!doc.selectedIds.includes(id)) {
          doc.selectedIds = [id];
        }
        dragState = { mode: "move", start: toDocPoint(e) };
        renderDoc();
        return;
      }

      // empty canvas: start rubber-band
      if (!e.shiftKey) doc.selectedIds = [];
      dragState = { mode: "marquee", start: toDocPoint(e), baseIds: [...doc.selectedIds] };
      renderDoc();
    },

    move(e) {
      if (!dragState) return;
      if (!doc.selectedIds.length && dragState.mode !== "marquee") return;

      const p = toDocPoint(e);

      if (dragState.mode === "rotate") {
        const { obj } = findObject(doc.selectedIds[0]);
        const angleRad = Math.atan2(p.y - dragState.center.y, p.x - dragState.center.x);
        let deg = (angleRad * 180 / Math.PI) + 90; // +90 so pointer-up = 0deg
        if (e.shiftKey) deg = Math.round(deg / 15) * 15; // snap every 15° when holding shift
        setRotation(obj, deg);
        renderDoc();
        return;
      }

      if (dragState.mode === "move") {
        const dx = p.x - dragState.start.x, dy = p.y - dragState.start.y;
        for (const obj of selectedObjects()) moveObject(obj, dx, dy);
        dragState.start = p;
        renderDoc();
        return;
      }

      if (dragState.mode === "marquee") {
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

      // resize
      const gb = dragState.groupBBox;
      const fx = dragState.handle.includes("w") ? gb.x+gb.width : gb.x;
      const fy = dragState.handle.includes("n") ? gb.y+gb.height : gb.y;
      const newW = Math.max(1, Math.abs(p.x - fx));
      const newH = Math.max(1, Math.abs(p.y - fy));
      const scaleX = (p.x < fx ? -1 : 1) * newW / gb.width;
      const scaleY = (p.y < fy ? -1 : 1) * newH / gb.height;

      for (const { id, bbox } of dragState.starts) {
        const { obj } = findObject(id);
        scaleObjectWithinGroup(obj, bbox, fx, fy, scaleX, scaleY);
      }
      renderDoc();
    },

    up() {
      if (dragState && dragState.mode === "marquee") {
        document.getElementById("marquee-box")?.remove();
      }
      if (dragState) pushUndo();
      dragState = null;
    },
  },

  rect: shapeTool("rect", (a, b) => ({
    x: Math.min(a.x,b.x), y: Math.min(a.y,b.y),
    width: Math.abs(b.x-a.x) || 1, height: Math.abs(b.y-a.y) || 1,
  })),
  ellipse: shapeTool("ellipse", (a, b) => ({
    cx: (a.x+b.x)/2, cy: (a.y+b.y)/2,
    rx: Math.abs(b.x-a.x)/2 || 1, ry: Math.abs(b.y-a.y)/2 || 1,
  })),
  line: shapeTool("line", (a, b) => ({ x1:a.x, y1:a.y, x2:b.x, y2:b.y })),

  pen: {
    points: [],
    down(e) { this.points.push(toDocPoint(e)); this._preview(); },
    move() {}, up() {},
    _preview() {
      const d = this.points.map((p,i) => `${i===0?"M":"L"}${p.x},${p.y}`).join(" ");
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
        const d = this.points.map((p,i) => `${i===0?"M":"L"}${p.x},${p.y}`).join(" ");
        addObject({ id: uid(), type: "path", attrs: { d, fill: "none", ...currentStyle() } });
        pushUndo();
      }
      this.points = [];
      renderDoc();
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
      if (obj.type === "image") await floodFillImage(obj, toDocPoint(e), currentStyle().fill);
      else obj.attrs.fill = currentStyle().fill;
      pushUndo(); renderDoc();
    },
    move() {}, up() {},
  },
};

function scaleObjectWithinGroup(obj, origBBox, originX, originY, scaleX, scaleY) {
  // offset of this object's original position from the group's fixed corner
  const offX = (origBBox.x - Math.min(originX, originX)) ;
  // simpler: compute new x/y by scaling the object's distance from origin
  const newX = originX + (origBBox.x - originX) * scaleX;
  const newY = originY + (origBBox.y - originY) * scaleY;
  const newW = origBBox.width * Math.abs(scaleX);
  const newH = origBBox.height * Math.abs(scaleY);

  if (obj.type === "rect" || obj.type === "image") {
    obj.attrs.x = Math.min(newX, newX + (origBBox.width*scaleX < 0 ? newW : 0));
    obj.attrs.y = Math.min(newY, newY + (origBBox.height*scaleY < 0 ? newH : 0));
    obj.attrs.width = newW; obj.attrs.height = newH;
  } else if (obj.type === "ellipse") {
    obj.attrs.cx = originX + (origBBox.x + origBBox.width/2 - originX) * scaleX;
    obj.attrs.cy = originY + (origBBox.y + origBBox.height/2 - originY) * scaleY;
    obj.attrs.rx = (origBBox.width/2) * Math.abs(scaleX);
    obj.attrs.ry = (origBBox.height/2) * Math.abs(scaleY);
  } else if (obj.type === "line") {
    obj.attrs.x1 = originX + (parseFloat(obj.attrs.x1) - originX) * scaleX;
    obj.attrs.y1 = originY + (parseFloat(obj.attrs.y1) - originY) * scaleY;
    obj.attrs.x2 = originX + (parseFloat(obj.attrs.x2) - originX) * scaleX;
    obj.attrs.y2 = originY + (parseFloat(obj.attrs.y2) - originY) * scaleY;
  }
  // text/path: position-only shift for now, until per-type resize (next rung) lands
  else if (obj.type === "text") {
    obj.attrs.x = originX + (parseFloat(obj.attrs.x) - originX) * scaleX;
    obj.attrs.y = originY + (parseFloat(obj.attrs.y) - originY) * scaleY;
  }
}

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


function shapeTool(type, makeAttrs) {
  return {
    start: null, obj: null,
    down(e) {
      this.start = toDocPoint(e);
      this.obj = addObject({ id: uid(), type, attrs: { ...makeAttrs(this.start, this.start), ...currentStyle() } });
      renderDoc();
    },
    move(e) {
      if (!this.start) return;
      Object.assign(this.obj.attrs, makeAttrs(this.start, toDocPoint(e)));
      renderDoc();
    },
    up() {
      if (this.obj) { doc.selectedId = this.obj.id; pushUndo(); }
      this.start = null; this.obj = null;
      renderDoc();
    },
  };
}

function moveObject(obj, dx, dy) {
  const a = obj.attrs;
  if (obj.type === "rect" || obj.type === "image" || obj.type === "text") { a.x = +a.x+dx; a.y = +a.y+dy; }
  else if (obj.type === "ellipse") { a.cx = +a.cx+dx; a.cy = +a.cy+dy; }
  else if (obj.type === "line") { a.x1=+a.x1+dx; a.y1=+a.y1+dy; a.x2=+a.x2+dx; a.y2=+a.y2+dy; }
  else if (obj.type === "path") {
    a.d = a.d.replace(/(-?\d+\.?\d*)[, ](-?\d+\.?\d*)/g, (_, x, y) => `${(+x)+dx},${(+y)+dy}`);
  }
}

function resizeObject(obj, handle, startBBox, p) {
  if (obj.type === "rect" || obj.type === "image") {
    const x0 = startBBox.x, y0 = startBBox.y, x1 = x0+startBBox.width, y1 = y0+startBBox.height;
    const fx = handle.includes("w") ? x1 : x0, fy = handle.includes("n") ? y1 : y0;
    obj.attrs.x = Math.min(p.x, fx); obj.attrs.y = Math.min(p.y, fy);
    obj.attrs.width = Math.max(1, Math.abs(p.x - fx));
    obj.attrs.height = Math.max(1, Math.abs(p.y - fy));
  } else if (obj.type === "ellipse") {
    const cx = startBBox.x + startBBox.width/2, cy = startBBox.y + startBBox.height/2;
    obj.attrs.rx = Math.max(1, Math.abs(p.x - cx));
    obj.attrs.ry = Math.max(1, Math.abs(p.y - cy));
  }
  // line/path/text: resize handles are a good next rung — skipped for now
}

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

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#",""), 16);
  return [(n>>16)&255, (n>>8)&255, n&255];
}

// Pixel-level flood fill on an imported raster image — a real "paint bucket",
// distinct from the vector fill above which just sets an attribute.
function floodFillImage(obj, point, fillHex) {
  return new Promise(resolve => {
    const localX = point.x - parseFloat(obj.attrs.x);
    const localY = point.y - parseFloat(obj.attrs.y);
    const img = new Image();
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
      const t0 = data.data[start], t1 = data.data[start+1], t2 = data.data[start+2];
      const match = i => {
        const dr=data.data[i]-t0, dg=data.data[i+1]-t1, db=data.data[i+2]-t2;
        return Math.sqrt(dr*dr+dg*dg+db*db) <= TOL;
      };
      const stack = [[px, py]];
      const seen = new Uint8Array(w * h);
      while (stack.length) {
        const [x, y] = stack.pop();
        if (x < 0 || y < 0 || x >= w || y >= h || seen[y*w+x]) continue;
        const i = idx(x, y);
        if (!match(i)) continue;
        seen[y*w+x] = 1;
        data.data[i]=fr; data.data[i+1]=fg; data.data[i+2]=fb; data.data[i+3]=255;
        stack.push([x+1,y],[x-1,y],[x,y+1],[x,y-1]);
      }
      ctx.putImageData(data, 0, 0);
      obj.attrs.href = c.toDataURL("image/png");
      resolve();
    };
    img.src = obj.attrs.href;
  });
}