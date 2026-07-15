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
      if (handle) {
        const el = canvasEl.querySelector(`[data-id="${doc.selectedId}"]`);
        dragState = { mode: "resize", handle, bbox: el.getBBox() };
        return;
      }
      doc.selectedId = id || null;
      if (id) dragState = { mode: "move", start: toDocPoint(e) };
      renderDoc();
    },
    move(e) {
      if (!dragState || !doc.selectedId) return;
      const { obj } = findObject(doc.selectedId);
      const p = toDocPoint(e);
      if (dragState.mode === "move") {
        moveObject(obj, p.x - dragState.start.x, p.y - dragState.start.y);
        dragState.start = p;
      } else {
        resizeObject(obj, dragState.handle, dragState.bbox, p);
      }
      renderDoc();
    },
    up() { if (dragState) pushUndo(); dragState = null; },
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