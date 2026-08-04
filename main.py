import json
import re

from fastapi import Body, FastAPI, HTTPException, WebSocket
from fastapi.staticfiles import StaticFiles
from pathlib import Path

APP_DIR = Path(__file__).parent
STATIC_DIR = APP_DIR / "static"
PROJECTS_DIR = APP_DIR / "projects"
PROJECTS_DIR.mkdir(exist_ok=True)

# Project names become filenames — allow a safe charset only, so a name
# like "../../etc/passwd" can never escape PROJECTS_DIR.
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$")

app = FastAPI(title="imagekit")


def project_path(name: str) -> Path:
    if not NAME_RE.fullmatch(name):
        raise HTTPException(400, "invalid project name")
    return PROJECTS_DIR / f"{name}.json"


@app.get("/api/projects")
def list_projects():
    return sorted(p.stem for p in PROJECTS_DIR.glob("*.json"))


@app.get("/api/projects/{name}")
def load_project(name: str):
    path = project_path(name)
    if not path.exists():
        raise HTTPException(404, "project not found")
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        raise HTTPException(500, "project file is corrupted")


@app.post("/api/projects/{name}")
def save_project(name: str, doc: dict = Body(...)):
    project_path(name).write_text(json.dumps(doc, indent=2))
    return {"ok": True}


@app.delete("/api/projects/{name}")
def delete_project(name: str):
    path = project_path(name)
    if path.exists():
        path.unlink()
    return {"ok": True}


# imagekit itself never opens a WebSocket (project save/load is plain
# fetch()) — this only exists so a stray WS handshake from a browser
# extension or dev tool doesn't fall through to StaticFiles below, which
# only handles "http" scope and raises an unhandled AssertionError on
# "websocket" scope. Registered before the static mount so it wins the
# route match for any path when the connection is actually a WebSocket.
@app.websocket("/{path:path}")
async def reject_websocket(websocket: WebSocket, path: str):
    await websocket.close(code=1000)


# mounted last so /api/* routes above take priority
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765)
