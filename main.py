from fastapi import FastAPI, Body, HTTPException
from fastapi.staticfiles import StaticFiles
from pathlib import Path
import json

APP_DIR = Path(__file__).parent
STATIC_DIR = APP_DIR / "static"
PROJECTS_DIR = APP_DIR / "projects"
PROJECTS_DIR.mkdir(exist_ok=True)

app = FastAPI(title="inkkit")

@app.get("/api/projects")
def list_projects():
    return sorted(p.stem for p in PROJECTS_DIR.glob("*.json"))

@app.get("/api/projects/{name}")
def load_project(name: str):
    path = PROJECTS_DIR / f"{name}.json"
    if not path.exists():
        raise HTTPException(404, "project not found")
    return json.loads(path.read_text())

@app.post("/api/projects/{name}")
def save_project(name: str, doc: dict = Body(...)):
    (PROJECTS_DIR / f"{name}.json").write_text(json.dumps(doc, indent=2))
    return {"ok": True}

@app.delete("/api/projects/{name}")
def delete_project(name: str):
    path = PROJECTS_DIR / f"{name}.json"
    if path.exists():
        path.unlink()
    return {"ok": True}

# mounted last so /api/* routes above take priority
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8100)