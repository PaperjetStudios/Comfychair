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


def migrate(conn):
    """Make or bring up to date the schema. Safe to run again on a database that is already current."""
    conn.executescript(
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
    cols = [r[1] for r in conn.execute("PRAGMA table_info(generations)")]
    if "pinned" not in cols:
        conn.execute("ALTER TABLE generations ADD COLUMN pinned INTEGER DEFAULT 0")
    if "started" not in cols:  # when ComfyUI began running it; finished - started = run time
        conn.execute("ALTER TABLE generations ADD COLUMN started REAL")
    cols = [r[1] for r in conn.execute("PRAGMA table_info(projects)")]
    if "folder" not in cols:  # output folder name, frozen the first time it's needed so it never moves
        conn.execute("ALTER TABLE projects ADD COLUMN folder TEXT")
    if "sort" not in cols:  # the project picker's order (Settings → Projects); starts as the order they were made in
        conn.execute("ALTER TABLE projects ADD COLUMN sort INTEGER")
    if not conn.execute("SELECT 1 FROM projects LIMIT 1").fetchone():
        conn.execute("INSERT INTO projects(name, created) VALUES (?, ?)", ("Sandbox", time.time()))
    conn.execute("UPDATE projects SET sort=id WHERE sort IS NULL")
    conn.commit()


migrate(_conn)


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
    return [dict(r) for r in _q("SELECT * FROM projects ORDER BY sort, id").fetchall()]


def get_project(project_id) -> dict | None:
    row = _q("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    return dict(row) if row else None


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


def create_project(name: str, after: int | None = None) -> dict:
    """A new project, last in the order (or right after project `after`)."""
    with _lock:
        row = _conn.execute("SELECT sort FROM projects WHERE id=?", (after,)).fetchone() if after is not None else None
        if row:
            sort = row[0] + 1
            _conn.execute("UPDATE projects SET sort=sort+1 WHERE sort>=?", (sort,))
        else:
            sort = (_conn.execute("SELECT MAX(sort) FROM projects").fetchone()[0] or 0) + 1
        cur = _conn.execute("INSERT INTO projects(name, created, sort) VALUES (?, ?, ?)", (name, time.time(), sort))
        _conn.commit()
    project_folder(cur.lastrowid)  # freeze its folder now
    return get_project(cur.lastrowid)


def rename_project(project_id: int, name: str):
    """Only the name: the folder was frozen when the project was made, so its files and links stay put."""
    _q("UPDATE projects SET name=? WHERE id=?", (name, project_id))


def order_projects(ids: list[int]):
    """Put the projects in this order (ids must name every project once)."""
    with _lock:
        have = {r[0] for r in _conn.execute("SELECT id FROM projects")}
        if set(ids) != have or len(ids) != len(have):
            raise ValueError("The order must list every project once")
        _conn.executemany("UPDATE projects SET sort=? WHERE id=?", [(n, i) for n, i in enumerate(ids)])
        _conn.commit()


def project_counts() -> dict[int, int]:
    """How many generations each project has."""
    return {r[0]: r[1] for r in _q("SELECT project_id, COUNT(*) FROM generations GROUP BY project_id").fetchall()}


def delete_project(project_id: int) -> list[dict]:
    """Remove a project and its generations from the database (its files are projects.py's job).
    Refuses with ValueError if it's the last project or has a run waiting or running. Returns the
    generations that were removed, so their files can go too."""
    with _lock:
        if not _conn.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
            raise LookupError("No such project")
        if _conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0] <= 1:
            raise ValueError("That's the only project: make another one before deleting it")
        if _conn.execute("SELECT 1 FROM generations WHERE project_id=? AND status IN ('queued','running') LIMIT 1",
                         (project_id,)).fetchone():
            raise ValueError("A run in this project is waiting or running: stop it or let it finish first")
        gens = [_gen(r) for r in _conn.execute("SELECT * FROM generations WHERE project_id=?", (project_id,)).fetchall()]
        _conn.execute("DELETE FROM generations WHERE project_id=?", (project_id,))
        _conn.execute("UPDATE inputs SET project_id=NULL WHERE project_id=?", (project_id,))  # the images stay in the picker's "all"
        _conn.execute("DELETE FROM projects WHERE id=?", (project_id,))
        _conn.commit()
    return gens


def copy_generations(src_project: int, dst_project: int, fix) -> dict[int, int]:
    """Copy a project's finished generations (not ones still waiting or running) into another project,
    oldest first, in one transaction. fix(row, ids) gets each new row (a dict of columns, JSON as text)
    and the old id → new id map once every row is in, and returns the columns to change. Returns the map."""
    with _lock:
        rows = [dict(r) for r in _conn.execute("SELECT * FROM generations WHERE project_id=? AND status NOT IN "
                                                "('queued','running') ORDER BY id", (src_project,)).fetchall()]
        ids = {}
        try:
            for r in rows:
                old = r.pop("id")
                r.update(project_id=dst_project, prompt_id=f"copy-{old}-{time.time_ns()}")
                cur = _conn.execute(f"INSERT INTO generations({', '.join(r)}) VALUES ({', '.join('?' * len(r))})", tuple(r.values()))
                ids[old] = r["id"] = cur.lastrowid
            for r in rows:
                if ch := fix(r, ids):
                    _conn.execute(f"UPDATE generations SET {', '.join(f'{k}=?' for k in ch)} WHERE id=?", (*ch.values(), r["id"]))
            _conn.commit()
        except BaseException:
            _conn.rollback()
            raise
    return ids


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
