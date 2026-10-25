"""SQLite storage for projects and generations (with full lineage: params, workflow, parent)."""
import json
import re
import sqlite3
import threading
import time
from urllib.parse import quote

from . import config

_lock = threading.Lock()
_conn = sqlite3.connect(config.DATA_DIR / "deck.sqlite3", check_same_thread=False)
_conn.row_factory = sqlite3.Row
_conn.executescript(
    """
    CREATE TABLE IF NOT EXISTS projects(
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, created REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS generations(
        id INTEGER PRIMARY KEY,
        project_id INTEGER,
        template TEXT,
        params TEXT,        -- resolved values actually sent (real seeds, LoRA stack, ...)
        workflow TEXT,      -- the exact API workflow queued, for debugging in desktop ComfyUI
        prompt_id TEXT UNIQUE,
        status TEXT,        -- queued | running | done | error | interrupted
        error TEXT,
        outputs TEXT,       -- JSON list of saved files
        parent TEXT,        -- JSON: what this was made from, e.g. {"generation": 12, "frame": "last"}
        created REAL,
        finished REAL);
    CREATE INDEX IF NOT EXISTS gen_project ON generations(project_id, id);
    CREATE TABLE IF NOT EXISTS snippets(    -- saved prompt pieces (subject, camera, style…), shared by all templates
        id INTEGER PRIMARY KEY, category TEXT NOT NULL, name TEXT, text TEXT NOT NULL, created REAL);
    CREATE TABLE IF NOT EXISTS inputs(      -- images sent to ComfyUI's input folder, and the project they were for
        name TEXT PRIMARY KEY, project_id INTEGER, source TEXT, created REAL);
    """
)
_cols = [r[1] for r in _conn.execute("PRAGMA table_info(generations)")]
if "pinned" not in _cols:
    _conn.execute("ALTER TABLE generations ADD COLUMN pinned INTEGER DEFAULT 0")
if "started" not in _cols:  # when ComfyUI began running it; finished - started = run time
    _conn.execute("ALTER TABLE generations ADD COLUMN started REAL")
_cols = [r[1] for r in _conn.execute("PRAGMA table_info(projects)")]
if "folder" not in _cols:  # output folder name, frozen the first time it's needed so it never moves
    _conn.execute("ALTER TABLE projects ADD COLUMN folder TEXT")
if not _conn.execute("SELECT 1 FROM projects LIMIT 1").fetchone():
    _conn.execute("INSERT INTO projects(name, created) VALUES (?, ?)", ("Sandbox", time.time()))
_conn.commit()


def _q(sql, args=()):
    with _lock:
        cur = _conn.execute(sql, args)
        _conn.commit()
        return cur


def _gen(row) -> dict | None:
    if row is None:
        return None
    d = dict(row)
    d.pop("workflow", None)
    d["params"] = json.loads(d["params"] or "{}")
    d["parent"] = json.loads(d["parent"]) if d.get("parent") else None
    outs = json.loads(d["outputs"] or "[]")
    for o in outs:
        o["url"] = (f"/files/projects/{quote(o['path'])}" if o.get("path")
                    else f"/files/generations/{d['id']}/{o['filename']}")
    d["outputs"] = outs
    return d


# ---- projects ---------------------------------------------------------------
def list_projects():
    return [dict(r) for r in _q("SELECT * FROM projects ORDER BY id").fetchall()]


def project_folder(project_id) -> str:
    """Folder name for a project's outputs: its name, made filesystem-safe (plus the id if two
    projects would share a folder). Worked out once, then stored in the project row so later
    projects or renames can't move it. Generations without a project go to "Unsorted"."""
    rows = list_projects()
    p = next((r for r in rows if r["id"] == project_id), None)
    if not p:
        return "Unsorted"
    if p.get("folder"):
        return p["folder"]
    safe = lambda n: re.sub(r"[^\w\- .]", "_", n).strip(" .") or "project"
    name = safe(p["name"])
    taken = {(r["folder"] or "").lower() for r in rows if r["id"] != p["id"]}
    if (sum(1 for r in rows if safe(r["name"]).lower() == name.lower()) > 1 or name.lower() == "unsorted"
            or name.lower() in taken):
        name = f"{name} ({p['id']})"
    _q("UPDATE projects SET folder=? WHERE id=?", (name, p["id"]))
    return name


def create_project(name: str) -> dict:
    cur = _q("INSERT INTO projects(name, created) VALUES (?, ?)", (name, time.time()))
    project_folder(cur.lastrowid)  # freeze its folder now
    return dict(_q("SELECT * FROM projects WHERE id=?", (cur.lastrowid,)).fetchone())


# ---- generations ------------------------------------------------------------
def create_generation(project_id, template, params, workflow, prompt_id, parent=None) -> int:
    cur = _q(
        "INSERT INTO generations(project_id, template, params, workflow, prompt_id, status, outputs, parent, created)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (project_id, template, json.dumps(params), json.dumps(workflow), prompt_id, "queued", "[]",
         json.dumps(parent) if parent else None, time.time()),
    )
    return cur.lastrowid


def get_generation(gid: int):
    return _gen(_q("SELECT * FROM generations WHERE id=?", (gid,)).fetchone())


def get_by_prompt(prompt_id: str):
    return _gen(_q("SELECT * FROM generations WHERE prompt_id=?", (prompt_id,)).fetchone())


def get_workflow(gid: int):
    row = _q("SELECT workflow FROM generations WHERE id=?", (gid,)).fetchone()
    return json.loads(row["workflow"]) if row else None


def list_generations(project_id=None, limit=100, before=None, edit_tab=None, status=None):
    sql, args = "SELECT * FROM generations WHERE 1=1", []
    if edit_tab is not None:  # renders of one saved video edit (params.edit_tab.id)
        sql += " AND json_extract(params, '$.edit_tab.id')=?"
        args.append(edit_tab)
    if status is not None:
        sql += " AND status=?"
        args.append(status)
    if project_id is not None:
        sql += " AND project_id=?"
        args.append(project_id)
    if before is not None:
        sql += " AND id<?"
        args.append(before)
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(limit)
    return [_gen(r) for r in _q(sql, args).fetchall()]


def pending_generations():
    return [_gen(r) for r in _q("SELECT * FROM generations WHERE status IN ('queued','running')").fetchall()]


def update_generation(gid: int, **fields):
    if "outputs" in fields:
        fields["outputs"] = json.dumps(fields["outputs"])
    cols = ", ".join(f"{k}=?" for k in fields)
    _q(f"UPDATE generations SET {cols} WHERE id=?", (*fields.values(), gid))


def add_input(name: str, project_id, source: str = "upload"):
    _q("INSERT OR REPLACE INTO inputs(name, project_id, source, created) VALUES (?,?,?,?)",
       (name, project_id, source, time.time()))


def project_inputs(project_id) -> list[dict]:
    rows = _q("SELECT * FROM inputs WHERE project_id IS ? ORDER BY created DESC", (project_id,)).fetchall()
    return [dict(r) for r in rows]


def list_snippets() -> list[dict]:
    return [dict(r) for r in _q("SELECT * FROM snippets ORDER BY category, created").fetchall()]


def save_snippet(category: str, name: str, text: str, sid: int | None = None) -> dict:
    if sid:
        _q("UPDATE snippets SET category=?, name=?, text=? WHERE id=?", (category, name, text, sid))
    else:
        sid = _q("INSERT INTO snippets(category, name, text, created) VALUES (?,?,?,?)",
                 (category, name, text, time.time())).lastrowid
    return dict(_q("SELECT * FROM snippets WHERE id=?", (sid,)).fetchone())


def delete_snippet(sid: int):
    _q("DELETE FROM snippets WHERE id=?", (sid,))


def recent_finished(limit=15):
    return [_gen(r) for r in _q("SELECT * FROM generations WHERE status IN ('done','error','interrupted') "
                                 "AND finished IS NOT NULL ORDER BY finished DESC LIMIT ?", (limit,)).fetchall()]


def run_times(template: str, limit=10) -> list[float]:
    rows = _q("SELECT finished - COALESCE(started, created) FROM generations WHERE template=? AND status='done' "
              "AND finished IS NOT NULL ORDER BY id DESC LIMIT ?", (template, limit)).fetchall()
    return [r[0] for r in rows if r[0] and r[0] > 0]


def all_generations():
    return [_gen(r) for r in _q("SELECT * FROM generations").fetchall()]


def delete_generation(gid: int):
    _q("DELETE FROM generations WHERE id=?", (gid,))
