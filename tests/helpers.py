"""Shared test helpers: a throw-away data folder + Obsidian vault for each test, and sample data."""
import importlib
import os
import shutil
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


class Env:
    """A fresh Keystone app (Flask test client) whose data/ and vault live in a temp folder."""

    def __init__(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="keystone-test-"))
        self.data = self.tmp / "data"
        self.vault = self.tmp / "vault"
        self.data.mkdir()
        (self.vault / ".obsidian").mkdir(parents=True)
        os.environ["KEYSTONE_DATA_DIR"] = str(self.data)
        from keystone_worklog import app as app_module  # reloaded so module-level paths pick up KEYSTONE_DATA_DIR
        self.app = importlib.reload(app_module)
        self.client = self.app.app.test_client()

    def close(self):
        os.environ.pop("KEYSTONE_DATA_DIR", None)
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- helpers ----
    def put_data(self, data):
        r = self.client.put("/api/data", json=data)
        assert r.status_code == 200, r.get_data(as_text=True)
        return r.get_json()

    def get_data(self):
        return self.client.get("/api/data").get_json()

    def write(self, rel, text):
        p = self.vault / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        return p

    def read(self, rel):
        return (self.vault / rel).read_text(encoding="utf-8")

    def tool(self, name, args=None, **extra):
        r = self.client.post("/api/assistant/tool", json={"name": name, "args": args or {}, **extra})
        return r.get_json()


def period_start(anchor, day):
    """Start of the 14-day pay period containing `day`."""
    k = (day - anchor).days // 14
    return anchor + timedelta(days=14 * k)


def sample_data(vault_path, **settings):
    """Two projects, a few deliverables and one pay period of hours (in the current period)."""
    anchor = date(2026, 1, 4)  # a Sunday
    start = period_start(anchor, date.today())
    rows = lambda h1, h2: [  # noqa: E731
        {"id": "r1", "network": "4001234", "activity": "0010", "code": "RG", "ts": False, "h": h1},
        {"id": "r2", "network": "4005678", "activity": "0020", "code": "RG", "ts": True, "h": h2},
    ]
    return {
        "settings": {"weekStart": "sun", "anchor": anchor.isoformat(), "periodHours": 80, "leaveStart": anchor.isoformat(),
                     "sickRate": 4, "annualRate": 6, "sickStart": 10, "annualStart": 20,
                     "vaultPath": str(vault_path), "vaultFolder": "Keystone", **settings},
        "projects": [{"id": "a", "network": "4001234", "activity": "0010", "name": "Bridge rehab", "budget": "200"},
                     {"id": "b", "network": "4005678", "activity": "0020", "name": "Runway lighting", "budget": "60"}],
        "deliverables": [{"id": "d1", "title": "30% submittal", "projectId": "a", "status": "done", "due": "2026-03-01", "notes": ""},
                         {"id": "d2", "title": "60% submittal", "projectId": "a", "status": "doing", "due": "2026-04-01", "notes": ""}],
        "followups": [{"id": "f1", "from": "Maria", "subject": "Site visit", "received": "2026-03-01", "due": "2026-03-05",
                       "projectId": "a", "status": "open", "notes": "", "body": ""}],
        "periods": {start.isoformat(): {"weeks": [{"rows": rows(["", "8", "8", "8", "8", "8", ""], ["", "", "", "", "", "", ""])},
                                                  {"rows": rows(["", "5", "5", "5", "5", "5", ""], ["", "3", "3", "3", "3", "3", ""])}]}},
    }
