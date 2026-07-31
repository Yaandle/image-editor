# imagekit

A browser-based image editor inspired by MS Paint and Photoshop.

Features:
- Canvas drawing tools
- Object selection and manipulation
- Layers
- Image properties
- Colour controls
- Export system

```
┌──────────────────────────────────────────────────────────────┐
│ toolbar                                                      │
├───────────────┬────────────────────────┬─────────────────────┤
│               │                        │                     │
│   Layers      │                        │    Properties       │
│   / Assets    │       Canvas           │                     │
│               │                        │                     │
│               │                        │                     │
├───────────────┴────────────────────────┴─────────────────────┤
│ status / tools / actions                                     │
└──────────────────────────────────────────────────────────────┘
```

## Stack

- **Backend** — Python 3.11+, FastAPI, uvicorn
- **Frontend** — Vanilla JavaScript ES modules, HTML5 Canvas, CSS
- **Communication** — JSON over WebSocket

## Install

```cmd
python -m venv imageeditor_venv

# Windows
imageeditor_venv\Scripts\activate

# macOS/Linux
source imageeditor_venv/bin/activate

pip install -r requirements.txt
```

> Tested on Windows. Cross-platform support expected but not fully verified.

## Run

```cmd
python main.py
```

Open:

```
http://localhost:8765
```

# Project Structure

```
image-editor/
│
├── main.py
├── requirements.txt
├── projects/
│
└── static/
    ├── index.html
    ├── style.css
    │
    └── js/
        ├── app.js
        ├── canvas.js
        ├── colorPicker.js
        ├── document.js
        ├── export.js
        ├── panels.js
        └── tools.js
```

## App Directory

| File | Responsibility |
|------|---------------|
| `main.py` | FastAPI entrypoint, static serving, API routes |
| `static/index.html` | Editor layout and UI shell |
| `static/style.css` | Application styling and panels |
| `static/js/app.js` | Application state and event wiring |
| `static/js/canvas.js` | Canvas renderer, object drawing, selection, transforms |
| `static/js/tools.js` | Drawing tools, shapes, selection tools |
| `static/js/colorPicker.js` | Colour picker, fill/stroke controls |
| `static/js/document.js` | Document state, layers, project data |
| `static/js/panels.js` | Properties panel and layer panel UI |
| `static/js/export.js` | Image export functionality |
| `projects/` | Saved project files |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+C` / `Ctrl+V` | Copy / Paste selection |
| `Ctrl+D` | Duplicate selection |
| `Ctrl+A` | Select all |
| `Delete` | Delete selected object |
| `Ctrl+S` | Save project |
| `Arrows` / `Shift+Arrows` | Nudge 1px / 10px |
| `Ctrl+[` / `Ctrl+]` | Send backward / bring forward (`+Shift` = to back/front) |
| `V R E L P B T F` | Tool shortcuts |

## Theming

Dark (default) and light themes, toggled from the topbar (◐) and persisted
to `localStorage`. All components read shared CSS variables — the token
sheet in `static/style.css` matches vidkit's design system.
```