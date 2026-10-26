"""Build a self-contained Keystone demo: tracker data + an Obsidian vault full of realistic (fictional) engineering files.

    python scripts/make_demo.py                          # creates ./demo  (data/ + vault/ + meetings.ics)
    python scripts/make_demo.py --llm-from data/llm.json # also copy your AI model profiles into the demo
    python scripts/make_demo.py --force                  # rebuild it from scratch

Run Keystone on it without touching your real data:

    KEYSTONE_DATA_DIR=demo/data keystone-worklog --port 5050      # or: python app.py from a checkout

Dates are relative to today, so the demo always looks current. Needs the [documents] packages
(pypdf is not needed to *write* the PDFs; python-docx, python-pptx and openpyxl are).
"""
import argparse
import json
import random
import shutil
import subprocess
import sys
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path

MARK = ".keystone-demo"
rng = random.Random(42)
TODAY = date.today()


def sunday_of(d):
    return d - timedelta(days=(d.weekday() + 1) % 7)


def iso(d):
    return d.isoformat()


# ---------- US federal holidays (as observed), for LH rows ----------
def federal_holidays(y):
    def nth(m, wd, n):  # wd: 0=Mon
        d = date(y, m, 1)
        d += timedelta(days=(wd - d.weekday()) % 7)
        return d + timedelta(weeks=n - 1)

    def last(m, wd):
        d = date(y, m + 1, 1) - timedelta(days=1) if m < 12 else date(y, 12, 31)
        return d - timedelta(days=(d.weekday() - wd) % 7)

    def obs(d):
        return d - timedelta(days=1) if d.weekday() == 5 else d + timedelta(days=1) if d.weekday() == 6 else d
    days = [obs(date(y, 1, 1)), nth(1, 0, 3), nth(2, 0, 3), last(5, 0), obs(date(y, 6, 19)), obs(date(y, 7, 4)), nth(9, 0, 1),
            nth(10, 0, 2), obs(date(y, 11, 11)), nth(11, 3, 4), obs(date(y, 12, 25))]
    return set(days)


HOLIDAYS = federal_holidays(TODAY.year - 1) | federal_holidays(TODAY.year) | federal_holidays(TODAY.year + 1)

# ---------- tracker data ----------
PROJECTS = [
    {"id": "bridge", "network": "4001234", "activity": "0010", "name": "Girder Bridge rehab", "budget": "400"},
    {"id": "runway", "network": "4005678", "activity": "0020", "name": "Runway lighting", "budget": "160"},
    {"id": "culvert", "network": "4009012", "activity": "0030", "name": "Culvert C-12 replacement", "budget": "100"},
    {"id": "training", "network": "4000001", "activity": "0090", "name": "Training", "budget": ""},
]


def row(p, code="RG", ts=False):
    return {"id": f"r{rng.randrange(10**8):08d}", "network": p["network"] if p else "", "activity": p["activity"] if p else "", "code": code, "ts": ts, "h": [""] * 7}


def make_period(start, last_day, leave_days=None):
    """Two Sun–Sat weeks; weekdays up to last_day get 8 h split across projects. Fridays are telework (TS)."""
    leave_days = leave_days or {}
    weeks = []
    for wi in range(2):
        rows = {}
        for di in range(7):
            d = start + timedelta(days=wi * 7 + di)
            if di in (0, 6) or d > last_day:
                continue
            if d in HOLIDAYS:
                rows.setdefault("LH", row(None, "LH"))["h"][di] = "8"
                continue
            if d in leave_days:
                code, hours = leave_days[d]
                rows.setdefault(code, row(None, code))["h"][di] = str(hours)
                if hours >= 8:
                    continue
            left = 8 - (leave_days.get(d, ("", 0))[1])
            ts = di == 5
            split = {"bridge": rng.choice([4, 4.5, 5, 5.5, 6]), "runway": rng.choice([0, 1, 1.5, 2]), "culvert": rng.choice([1, 1.5, 2])}
            if rng.random() < 0.15:
                split["training"] = 1
            total = sum(split.values())
            scale = left / total
            hours, acc = {}, 0
            for k, v in split.items():
                hours[k] = round(v * scale * 4) / 4
                acc += hours[k]
            hours["bridge"] += left - acc
            for pid, hv in hours.items():
                if hv <= 0:
                    continue
                p = next(x for x in PROJECTS if x["id"] == pid)
                key = pid + ("-ts" if ts else "")
                rows.setdefault(key, row(p, "RG", ts))["h"][di] = str(round(hv * 100) / 100)
        order = ["bridge", "bridge-ts", "runway", "runway-ts", "culvert", "culvert-ts", "training", "training-ts", "LA", "LS", "LH"]
        weeks.append({"rows": [rows[k] for k in order if k in rows] or [row(None)]})
    return {"weeks": weeks}


def tracker_data(vault):
    anchor = sunday_of(TODAY) - timedelta(days=7)          # the current pay period started last Sunday
    periods = {}
    for k in range(6, 0, -1):                                 # six finished pay periods…
        start = anchor - timedelta(days=14 * k)
        leave = {}
        if k == 4:
            leave[start + timedelta(days=5)] = ("LA", 8)        # a Friday of annual leave
        if k == 2:
            leave[start + timedelta(days=9)] = ("LS", 4)        # half a sick day
        per = make_period(start, start + timedelta(days=13), leave)
        if k > 1:                                             # …all submitted except the last one
            at = datetime.combine(start + timedelta(days=13), datetime.min.time()).replace(hour=16).isoformat() + "Z"
            total = sum(float(v or 0) for w in per["weeks"] for r in w["rows"] for v in r["h"])
            per["submitted"] = {"at": at, "total": total}
            per["lastSubmitted"] = {"at": at, "snapshot": json.dumps(per["weeks"])}
        periods[iso(start)] = per
    periods[iso(anchor)] = make_period(anchor, TODAY - timedelta(days=1))  # current period: filled up to yesterday

    def due(n):
        return iso(TODAY + timedelta(days=n))
    deliverables = [
        {"id": "d1", "title": "30% plans – Girder Bridge", "projectId": "bridge", "status": "done", "due": due(-40), "notes": ""},
        {"id": "d2", "title": "Bearing replacement details", "projectId": "bridge", "status": "doing", "due": due(3), "notes": "Pier 3 first; check jacking points."},
        {"id": "d3", "title": "Load rating memo", "projectId": "bridge", "status": "blocked", "due": due(-2), "notes": "Waiting on the girder FE run (girder_v3 didn't converge)."},
        {"id": "d4", "title": "60% plans – Girder Bridge", "projectId": "bridge", "status": "todo", "due": due(24), "notes": ""},
        {"id": "d5", "title": "Photometric calcs – runway edge lights", "projectId": "runway", "status": "doing", "due": due(6), "notes": ""},
        {"id": "d6", "title": "Lighting spec section 34 43 00", "projectId": "runway", "status": "todo", "due": due(15), "notes": ""},
        {"id": "d7", "title": "Culvert C-12 hydraulic memo", "projectId": "culvert", "status": "doing", "due": due(1), "notes": "100-year storm check; county wants it before storm season."},
        {"id": "d8", "title": "Culvert inspection report", "projectId": "culvert", "status": "done", "due": due(-12), "notes": ""},
    ]
    followups = [
        {"id": "f1", "from": "Maria Lopez (County)", "subject": "Culvert C-12 headwall", "received": due(-1), "due": due(1), "projectId": "culvert", "status": "open", "notes": "Confirm whether the 60 in pipe needs a new headwall.", "body": ""},
        {"id": "f2", "from": "Sam Ortiz (Fabricator)", "subject": "RE: bearing pads delivery", "received": due(-3), "due": due(-1), "projectId": "bridge", "status": "open", "notes": "", "body": ""},
        {"id": "f3", "from": "Airport ops", "subject": "Night closure window for lighting work", "received": due(-6), "due": due(4), "projectId": "runway", "status": "waiting", "notes": "", "body": ""},
        {"id": "f4", "from": "QA team", "subject": "Load rating checklist", "received": due(-20), "due": due(-15), "projectId": "bridge", "status": "done", "notes": "", "body": ""},
    ]
    away = [
        {"id": "a1", "kind": "travel", "start": due(8), "end": due(9), "note": "Site visit – Girder Bridge", "fill": False},
        {"id": "a2", "kind": "annual", "start": due(26), "end": due(28), "note": "Family trip", "fill": False},
    ]
    timer_log = [{"id": "t1", "date": due(-1), "network": "4009012", "activity": "0030", "code": "RG", "ts": False, "ms": int(1.7 * 36e5)}]
    settings = {"weekStart": "sun", "anchor": iso(anchor), "periodHours": 80, "leaveStart": iso(anchor - timedelta(days=14 * 6)),
                "sickRate": 4, "annualRate": 6, "sickStart": 52, "annualStart": 196, "vaultPath": str(vault.resolve()), "vaultFolder": "Keystone",
                "schedule": "5x8", "holidays": True, "carryLimit": 240, "captureNote": "Today.md", "dayFormat": "dddd, MMMM D, YYYY", "inboxFolder": "Inbox"}
    return {"settings": settings, "projects": PROJECTS, "deliverables": deliverables, "followups": followups, "away": away,
            "events": [], "timerLog": timer_log, "periods": periods, "timer": None}


# ---------- project plans (Plan tab) ----------
DAY_MIN = 480
PEOPLE = [{"uid": 1, "name": "Me", "initials": "ME", "me": True, "maxUnits": 1},
          {"uid": 2, "name": "Maria Lopez", "initials": "ML", "maxUnits": 1},
          {"uid": 3, "name": "Sam Ortiz", "initials": "SO", "maxUnits": 0.5, "away": [iso(TODAY + timedelta(days=12)), iso(TODAY + timedelta(days=13))]},
          {"uid": 4, "name": "Priya Shah", "initials": "PS", "maxUnits": 1}]
ME, MARIA, SAM, PRIYA = 1, 2, 3, 4


def plan_builder(nwa):
    """(tasks, assignments, add) – add(name, days, parent, preds, pct, people, **fields) appends a task and returns its uid."""
    tasks, assignments = [], []

    def add(name, days=None, parent=None, preds=(), pct=0, people=(), **kw):
        uid = len(tasks) + 1
        t = {"uid": uid, "name": name, "parentUid": parent, "links": [lnk(p) if isinstance(p, int) else p for p in preds],
             "percent": pct, "constraint": {"type": "ASAP"}, "baselines": {}, "notes": kw.pop("notes", ""), "priority": 500, "custom": {}}
        if days is not None:
            t["duration"] = {"minutes": int(days * DAY_MIN), "format": "d"}
            t["milestone"] = days == 0
            t["nwa"] = nwa
        t.update(kw)
        tasks.append(t)
        assignments.extend({"taskUid": uid, "resourceUid": who, "units": units} for who, units in people)
        return uid
    return tasks, assignments, add


def lnk(pred, kind="FS", lag_days=0):
    return {"pred": pred, "type": kind, "lag": {"minutes": int(lag_days * DAY_MIN), "format": "d"}}


def plan_shell(name, project_id, start, tasks, assignments, raid=(), resources=PEOPLE, **kw):
    return {"version": 1, "name": name, "projectId": project_id, "start": iso(start) + "T08:00", "statusDate": None,
            "units": {"minutesPerDay": 480, "minutesPerWeek": 2400, "daysPerMonth": 20}, "calendar": None, "calendarSource": "keystone",
            "tasks": tasks, "resources": [dict(r) for r in resources], "assignments": assignments, "changeLog": [], "raid": list(raid), **kw}


def demo_plan(baseline=False):
    """The Girder Bridge rehab plan: phases, milestones, links, people, progress and a few issues and risks.
    baseline=True gives the original estimates (shorter analysis and design) – saved as baseline 0 so the slip shows."""
    start = sunday_of(TODAY) - timedelta(days=34)              # a Monday five weeks ago
    tasks, assignments, add = plan_builder("4001234|0010")
    p1 = add("Inspection and data")
    a = add("Site inspection", 3, p1, pct=100, people=[(ME, 1), (MARIA, 1)])
    b = add("Survey and as-builts", 4 if baseline else 5, p1, [a], pct=100, people=[(SAM, 1)])
    c = add("Inspection report", 4, p1, [b], pct=100, people=[(ME, 1)])
    m1 = add("Inspection complete", 0, p1, [c], pct=100)
    p2 = add("Analysis")
    d = add("Girder FE model (Abaqus)", 6 if baseline else 8, p2, [m1], pct=70, people=[(ME, 1)], notes="girder_v3 didn't converge – v4 with finer mesh at the bearings.")
    e = add("Load rating", 6, p2, [d], pct=0, people=[(ME, 1), (PRIYA, 0.5)])
    f = add("Bearing replacement design", 5 if baseline else 7, p2, [lnk(m1, "FS", 2)], pct=40, people=[(MARIA, 1)])
    g = add("Load rating memo", 2, p2, [e], pct=0, people=[(ME, 1)], deadline=iso(TODAY + timedelta(days=12)) + "T17:00")
    p3 = add("Design")
    add("30% plans submitted", 0, p3, [m1], pct=100)
    h_ = add("60% plans", 12, p3, [f, lnk(e, "SS", 3)], people=[(MARIA, 1), (PRIYA, 1)])
    i = add("Specifications", 6, p3, [lnk(h_, "FF")], people=[(PRIYA, 1)])
    j = add("Cost estimate", 4, p3, [h_], people=[(SAM, 1)])
    m3 = add("60% plans submitted", 0, p3, [h_, i, j])
    k = add("County review", 15, p3, [m3], people=[], notes="The county takes about three weeks.")
    l_ = add("90% plans", 10, p3, [k], people=[(MARIA, 1), (PRIYA, 1)])
    add("PS&E submitted", 0, p3, [l_, g], deadline=iso(TODAY + timedelta(days=95)) + "T17:00")
    return plan_shell("Girder Bridge rehab", "bridge", start, tasks, assignments, raid=[
                {"id": "r1", "kind": "risk", "title": "FE model may not converge in time for the load rating", "owner": "Me", "due": iso(TODAY + timedelta(days=5)), "status": "open",
                 "probability": 3, "impact": 4, "mitigation": "Fall back to a line-girder rating for the memo.", "taskUids": [d, e], "created": iso(TODAY - timedelta(days=6)), "description": ""},
                {"id": "r2", "kind": "issue", "title": "Bearing pads delivery slipped two weeks", "owner": "Sam Ortiz", "due": iso(TODAY + timedelta(days=2)), "status": "open",
                 "probability": 0, "impact": 3, "mitigation": "", "taskUids": [f], "created": iso(TODAY - timedelta(days=3)), "description": "Fabricator says mid-month at the earliest."},
                {"id": "r3", "kind": "risk", "title": "County review takes longer than three weeks", "owner": "Maria Lopez", "due": "", "status": "monitoring",
                 "probability": 2, "impact": 3, "mitigation": "Pre-submittal meeting with the county.", "taskUids": [k], "created": iso(TODAY - timedelta(days=20)), "description": ""},
                {"id": "r4", "kind": "decision", "title": "Replace bearings at Pier 3 first", "owner": "Me", "due": "", "status": "closed", "closed": iso(TODAY - timedelta(days=10)),
                 "probability": 0, "impact": 0, "mitigation": "", "taskUids": [f], "created": iso(TODAY - timedelta(days=12)), "description": ""}])


def runway_plan(baseline=False):
    """Runway edge lighting: a smaller plan that is behind – the circuit survey is late and the closure window isn't confirmed."""
    start = sunday_of(TODAY) - timedelta(days=13)              # a Monday two weeks ago
    tasks, assignments, add = plan_builder("4005678|0020")
    p1 = add("Existing conditions")
    a = add("Record drawings review", 2, p1, pct=100, people=[(ME, 1)])
    b = add("Existing circuit survey", 4 if baseline else 6, p1, [a], pct=50 if not baseline else 0, people=[(SAM, 1)],
            notes="Night work only – two nights lost to weather.")
    p2 = add("Design")
    c = add("Photometric calcs", 8, p2, [a], pct=70, people=[(ME, 1)])
    d = add("Lighting layout", 5, p2, [b, c], people=[(PRIYA, 1)])
    e = add("Spec section 34 43 00", 4, p2, [lnk(d, "SS", 2)], people=[(ME, 0.5)], deadline=iso(TODAY + timedelta(days=15)) + "T17:00")
    m1 = add("Design complete", 0, p2, [d, e])
    p3 = add("Coordination")
    f = add("Confirm night closure window", 3, p3, [a], pct=30, people=[(MARIA, 0.5)])
    g = add("FAA review", 10, p3, [m1, f], notes="Airport ops forward it to the FAA district office.")
    add("Bid package issued", 0, p3, [g])
    return plan_shell("Runway lighting", "runway", start, tasks, assignments, raid=[
        {"id": "r1", "kind": "issue", "title": "Night closure window not confirmed by airport ops", "owner": "Maria Lopez", "due": iso(TODAY + timedelta(days=4)),
         "status": "open", "probability": 0, "impact": 4, "mitigation": "", "taskUids": [f, g], "created": iso(TODAY - timedelta(days=6)), "description": ""},
        {"id": "r2", "kind": "risk", "title": "Existing cable is direct-buried and needs replacing", "owner": "Sam Ortiz", "due": iso(TODAY + timedelta(days=7)),
         "status": "open", "probability": 2, "impact": 5, "mitigation": "Megger test during the survey; carry an add-alternate in the bid.", "taskUids": [b, d],
         "created": iso(TODAY - timedelta(days=9)), "description": ""}])


def culvert_plan():
    """Culvert C-12 replacement – written as an MS Project XML file to try File → Open an MS Project file."""
    start = sunday_of(TODAY) + timedelta(days=8)               # a Monday next week
    tasks, assignments, add = plan_builder("4009012|0030")
    p1 = add("Hydraulics")
    a = add("100-year storm check", 3, p1, people=[(ME, 1)])
    b = add("Hydraulic memo", 2, p1, [a], people=[(ME, 1)])
    p2 = add("Design")
    c = add("Pipe and headwall design", 5, p2, [b], people=[(MARIA, 1)])
    d = add("Erosion control plan", 3, p2, [lnk(c, "SS", 2)], people=[(PRIYA, 1)])
    e = add("Plans and quantities", 4, p2, [c, d], people=[(MARIA, 1), (PRIYA, 0.5)])
    add("Submit to the county", 0, p2, [e])
    return plan_shell("Culvert C-12 replacement", "culvert", start, tasks, assignments,
                      resources=[r for r in PEOPLE if r["uid"] != SAM])


def bridge_template():
    """A reusable plan for the next bridge rehab: phases, tasks and links but no dates, progress or people (New plan → Template)."""
    tasks, assignments, add = plan_builder("")
    p1 = add("Inspection and data")
    a = add("Site inspection", 3, p1)
    b = add("Survey and as-builts", 5, p1, [a])
    c = add("Inspection report", 4, p1, [b])
    m1 = add("Inspection complete", 0, p1, [c])
    p2 = add("Analysis")
    d = add("FE model", 8, p2, [m1])
    e = add("Load rating", 6, p2, [d])
    f = add("Load rating memo", 2, p2, [e])
    p3 = add("Design")
    g = add("60% plans", 12, p3, [lnk(e, "SS", 3)])
    h_ = add("Specifications", 6, p3, [lnk(g, "FF")])
    m2 = add("60% plans submitted", 0, p3, [g, h_])
    k = add("Agency review", 15, p3, [m2])
    l_ = add("90% plans", 10, p3, [k])
    add("PS&E submitted", 0, p3, [l_, f])
    for t in tasks:
        t.pop("nwa", None)
    return plan_shell("Bridge rehab template", None, sunday_of(TODAY) + timedelta(days=8), tasks, [], resources=PEOPLE[:1], template=True)


# The scheduler lives in the page (static/planner/engine.js). When Node is installed it fills in the dates and
# baselines here too, so the demo opens with grey baseline bars and the MS Project file carries real dates.
STAMP_JS = r"""
import { readFileSync } from 'node:fs';
const E = await import(process.argv[1]);
const { plans, holidays } = JSON.parse(readFileSync(0, 'utf8'));
const y = new Date().getFullYear();
const cal = E.calendarFromSchedule([0, 8, 8, 8, 8, 8, 0, 0, 8, 8, 8, 8, 8, 0], '2026-01-04', Object.fromEntries(holidays.map(d => [d, 'Holiday'])), `${y - 1}-01-01`, `${y + 2}-12-31`);
const stamp = p => { const s = E.schedule({ ...p, calendar: cal }); for (const t of p.tasks) { const r = s.byUid.get(t.uid); t.start = E.fromMin(r.es); t.finish = E.fromMin(r.ef); } return s; };
for (const { plan, baseline } of plans) {
  stamp(plan);
  if (baseline) {
    const b = E.setBaseline({ ...baseline, calendar: cal }, E.schedule({ ...baseline, calendar: cal }), 0);
    const byUid = new Map(b.tasks.map(t => [t.uid, t.baselines]));
    for (const t of plan.tasks) t.baselines = byUid.get(t.uid) || {};
  }
}
process.stdout.write(JSON.stringify(plans.map(p => p.plan)));
"""


def stamp_dates(pairs):
    """[(plan, baseline plan or None)] → the plans with start/finish (and baseline 0) filled in, or unchanged without Node."""
    node = shutil.which("node")
    engine = Path(__file__).resolve().parent.parent / "keystone_worklog" / "static" / "planner" / "engine.js"
    if not node or not engine.exists():
        return [p for p, _ in pairs], False
    payload = json.dumps({"plans": [{"plan": p, "baseline": b} for p, b in pairs], "holidays": sorted(iso(d) for d in HOLIDAYS)})
    r = subprocess.run([node, "--input-type=module", "-e", STAMP_JS, engine.as_uri()], input=payload, capture_output=True, text=True)
    if r.returncode:
        print("Couldn't schedule the demo plans with Node (they still work, without baselines):", r.stderr.strip()[-300:])
        return [p for p, _ in pairs], False
    return json.loads(r.stdout), True


# ---------- documents ----------
def make_pdf(pages):
    """A small PDF with a real text layer (what an OCR'd scan looks like to a reader)."""
    def esc(t):  # the built-in Helvetica only has Latin-1
        t = t.replace("\u2013", "-").replace("\u2014", "-").replace("\u2019", "'").encode("latin-1", "replace").decode("latin-1")
        return t.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    objs = ["<< /Type /Catalog /Pages 2 0 R >>",
            f"<< /Type /Pages /Kids [{' '.join(f'{4 + 2 * i} 0 R' for i in range(len(pages)))}] /Count {len(pages)} >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    for i, text in enumerate(pages):
        lines = text.split("\n")
        stream = "BT /F1 16 Tf 72 730 Td 22 TL (" + esc(lines[0]) + ") Tj T* /F1 11 Tf 15 TL " + " ".join(f"({esc(l)}) Tj T*" for l in lines[1:]) + " ET"
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {5 + 2 * i} 0 R >>")
        objs.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
    out, offsets = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{o}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode() + b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    return out + f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()


def make_docx(path, title, sections, table=None):
    import docx
    d = docx.Document()
    d.add_heading(title, level=0)
    for head, paras in sections:
        d.add_heading(head, level=1)
        for p in paras:
            d.add_paragraph(p)
    if table:
        t = d.add_table(rows=len(table), cols=len(table[0]))
        t.style = "Table Grid"
        for i, r in enumerate(table):
            for j, v in enumerate(r):
                t.cell(i, j).text = str(v)
    d.save(path)


def make_pptx(path, slides):
    import pptx
    prs = pptx.Presentation()
    for title, body, notes in slides:
        s = prs.slides.add_slide(prs.slide_layouts[1])
        s.shapes.title.text = title
        s.placeholders[1].text = body
        if notes:
            s.notes_slide.notes_text_frame.text = notes
    prs.save(path)


def make_xlsx(path, sheets):
    import openpyxl
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name, rows in sheets:
        ws = wb.create_sheet(name)
        for r in rows:
            ws.append(r)
    wb.save(path)


def make_eml(path, frm, to, subject, when, body, attachments=()):
    m = EmailMessage()
    m["From"], m["To"], m["Subject"], m["Date"] = frm, to, subject, when.strftime("%a, %d %b %Y %H:%M:%S -0700")
    m.set_content(body)
    for name, data, sub in attachments:
        m.add_attachment(data, maintype="application", subtype=sub, filename=name)
    path.write_bytes(m.as_bytes())


def outlook_txt(frm, when, subject, body):
    return f"From: {frm}\nSent: {when.strftime('%A, %B %d, %Y %I:%M %p')}\nTo: Hiren\nSubject: {subject}\n\n{body}\n"


ABAQUS_INP = """*Heading
** Girder Bridge rehab – span 2 girder model, {ver}
** Elastomeric bearing pads at pier 3 modelled as springs; jacking load case for bearing replacement
*Preprint, echo=NO, model=NO, history=NO
*Part, name=GIRDER
*Node
{nodes}*Element, type=C3D8R
*Material, name=Steel_A709_50
*Elastic
200000., 0.3
*Plastic
345., 0.
450., 0.15
*Material, name=Elastomer
*Hyperelastic, neo hooke
0.9, 0.002
*Step, name=Jacking, nlgeom=YES, inc=200
*Static
0.05, 1., 1e-08, 0.1
*Cload
JACK_PT, 2, -850000.
*End Step
"""


def abaqus_msg(converged, ver):
    lines = [f" Abaqus 2023 – job girder_{ver}", "", " STEP 1  INCREMENT 1  STEP TIME 0.000E+00", "       CONVERGENCE CHECKS FOR EQUILIBRIUM ITERATION   1"]
    lines += [" ***WARNING: 12 NODES ARE MISSING DEGREE OF FREEDOM CONSTRAINTS. THEY HAVE BEEN IDENTIFIED IN NODE SET WarnNodeMissMassOrInertia."] * 3
    if converged:
        lines += ["", " ITERATION SUMMARY FOR THE INCREMENT: 4 TOTAL ITERATIONS", "", " THE ANALYSIS HAS COMPLETED SUCCESSFULLY"]
    else:
        lines += [" ***WARNING: SOLVER PROBLEM. NUMERICAL SINGULARITY WHEN PROCESSING NODE GIRDER.1043 D.O.F. 2 RATIO = 1.2E+15"] * 4
        lines += [" ***ERROR: TOO MANY ATTEMPTS MADE FOR THIS INCREMENT", " ***ERROR: TIME INCREMENT REQUIRED IS LESS THAN THE MINIMUM SPECIFIED", "", " THE ANALYSIS HAS NOT BEEN COMPLETED"]
    return "\n".join(lines) + "\n"


def abaqus_sta(converged):
    rows = [" SUMMARY OF JOB INFORMATION:", " STEP  INC ATT SEVERE EQUIL TOTAL  TOTAL      STEP       INC OF", "              DISCON ITERS ITERS  TIME/    TIME/LPF    TIME/LPF"]
    t = 0.0
    for inc in range(1, 9 if converged else 5):
        dt = 0.125 if converged else 0.05 / inc
        t += dt
        rows.append(f"   1 {inc:5d}   1     0     {rng.randint(2, 5)}     {rng.randint(2, 5)}  {t:.4f}     {t:.4f}     {dt:.4E}")
    rows.append(" THE ANALYSIS HAS COMPLETED SUCCESSFULLY" if converged else " THE ANALYSIS HAS NOT BEEN COMPLETED")
    return "\n".join(rows) + "\n"


def abaqus_dat(ver):
    head = f" ABAQUS DATA FILE – girder_{ver}\n\n   P R O B L E M   S I Z E\n\n NUMBER OF ELEMENTS IS     48210\n NUMBER OF NODES IS        55902\n\n"
    table = "".join(f"  {i:6d}   {rng.uniform(-3, 3):.4E}  {rng.uniform(-250, 250):.4E}  {rng.uniform(0, 0.002):.4E}\n" for i in range(1, 6000))
    warn = " ***WARNING: THE STRAIN INCREMENT HAS EXCEEDED FIFTY TIMES THE STRAIN TO CAUSE FIRST YIELD AT 3 POINTS\n"
    return head + "   NODE FOOT-   U2           S22          PEEQ\n" + table + warn + table + " THE ANALYSIS HAS COMPLETED SUCCESSFULLY\n"


def write(vault, rel, content):
    p = vault / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        p.write_bytes(content)
    else:
        p.write_text(content, encoding="utf-8")
    return p


def build_vault(v):
    d = lambda n: TODAY + timedelta(days=n)  # noqa: E731
    fmt = lambda x: x.strftime("%Y-%m-%d")  # noqa: E731
    write(v, ".obsidian/templates.json", json.dumps({"folder": "Templates"}))
    write(v, "Templates/Meeting.md", "---\ntype: meeting\ndate: {{date}}\n---\n# {{title}}\n\n**Attendees:** \n\n## Notes\n\n## Action items\n- [ ] \n")
    write(v, "Templates/Daily.md", "# {{date}}\n\n## Focus\n\n## Notes\n")
    write(v, "Home.md", "# Home\nWork vault for bridge, airfield and drainage projects.\n\n- [[Girder Bridge rehab]]\n- [[Runway Lighting]]\n- [[Culvert C-12]]\n- Analysis models live in `Analysis/`, one folder per model.\n- New files go in `Inbox/` and get filed from there.\n")

    # --- Girder Bridge rehab ---
    gb = "Projects/Girder Bridge rehab"
    write(v, f"{gb}/Girder Bridge rehab.md", "# Girder Bridge rehab\nRehabilitation of the three-span steel girder bridge on County Road 12: bearing replacement at pier 3, deck repair and a load rating.\n\nNetwork 4001234 / activity 0010. County contract 26-114.\n\n## Contacts\n- Maria Lopez – county PM\n- Sam Ortiz – bearing fabricator\n\n## Status\n- [x] 30% plans\n- [ ] Bearing replacement details\n- [ ] Load rating memo\n")
    write(v, f"{gb}/Bearing replacement.md", "# Bearing replacement\nReplace the elastomeric bearing pads at pier 3. Jack the girders no more than 1/8 inch, one girder line at a time.\n\n## Open questions\n- Jacking points: stiffener check needed at each girder end.\n- Pad thickness 2 in laminated, 60 durometer.\n")
    write(v, f"{gb}/Deck repair.md", "# Deck repair\nRemove unsound concrete to sound material, patch with Class AA concrete. Estimate 340 sq ft of partial-depth repair on span 2.\n")
    write(v, f"{gb}/Specs/Girder Bridge special provisions.pdf", make_pdf([
        "SPECIAL PROVISIONS\nGirder Bridge Rehabilitation, County Road 12\nContract 26-114\nIssued for bid",
        "Section 412 – Concrete Deck Repair\nRemove unsound concrete to sound material by chipping hammer no heavier than 35 lb.\nPatch with Class AA concrete; wet cure for 7 days.",
        "Section 564 – Bearing Replacement\nReplace the elastomeric bearing pads at pier 3 with laminated pads, 60 durometer.\nJack the girders no more than 1/8 inch. Submit a jacking procedure 14 days before work.",
        "Section 620 – Traffic Control\nNight lane closures only, between 9 PM and 5 AM.\nOne lane open at all times; flaggers required during jacking."]))
    make_docx(v / f"{gb}/Scope of work.docx", "Scope of work – Girder Bridge rehab", [
        ("Scope", ["Replace the bearings at pier 3 of the Girder Bridge.", "Repair the deck on span 2 and prepare a load rating."]),
        ("Schedule", ["30% plans complete. 60% plans due next month.", "Night closures between May and June."])],
        [["Item", "Hours", "Cost"], ["Bearing replacement design", "120", "$18,000"], ["Deck repair", "80", "$12,000"], ["Load rating", "90", "$13,500"]])
    make_xlsx(v / f"{gb}/Budget tracker.xlsx", [("Budget", [["Task", "Hours", "Owner", "Status"], ["Bearing details", 120, "Hiren", "In progress"], ["Deck repair", 80, "Maria", "Not started"],
                                                            ["Load rating", 90, "Hiren", "Blocked"], ["Scour analysis", 64, "Priya", "Done"]]),
                                                 ("Notes", [["Contingency held at 10 percent"], ["Rates per 2026 agreement"]])])

    # --- Runway lighting ---
    rw = "Projects/Runway Lighting"
    write(v, f"{rw}/Runway Lighting.md", "# Runway Lighting\nReplace the runway 9-27 edge lights with LED fixtures and new constant-current regulators.\n\nNetwork 4005678 / activity 0020.\n\n- Night closures need airport ops approval.\n- Photometrics per FAA AC 150/5340-30.\n")
    write(v, f"{rw}/Lighting spec notes.md", "# Lighting spec notes\nSection 34 43 00: L-861 elevated edge lights, 200 ft spacing, CCR sized for 6.6 A.\n")
    make_pptx(v / f"{rw}/Runway lighting kickoff.pptx", [
        ("Runway 9-27 edge lighting", "LED retrofit of 112 elevated edge lights\nNew CCRs in the airfield lighting vault", "Mention the night closure windows."),
        ("Schedule", "Design: this quarter\nConstruction: next summer, night work only", ""),
        ("Risks", "Closure windows\nLong lead time on CCRs", "Ask ops for the NOTAM process.")])

    # --- Culvert C-12 ---
    cv = "Projects/Culvert C-12"
    write(v, f"{cv}/README.md", "# Culvert C-12\nReplacement of culvert C-12 under County Road 12: hydraulics, inspection reports and county correspondence.\n")
    write(v, f"{cv}/Culvert C-12.md", "# Culvert C-12\nThe existing 48 inch CMP is undersized for the 100-year storm. Proposed: 60 inch RCP with new headwalls.\n\nNetwork 4009012 / activity 0030.\n")
    write(v, f"{cv}/Hydraulics/Culvert C-12 hydraulic calcs.pdf", make_pdf([
        "Culvert C-12 Hydraulic Calculations\nDesign storm: 100-year, 24-hour\nPeak flow 212 cfs",
        "Existing 48 in CMP: headwater 8.9 ft, overtops the road at 180 cfs.\nProposed 60 in RCP: headwater 6.1 ft at 212 cfs, no overtopping."]))

    # --- meetings, mail, analysis, scripts ---
    meetings = [(d(-34), "County kickoff", "Kickoff with the county for the Girder Bridge and culvert C-12. County wants the culvert memo before storm season."),
                (d(-21), "Bearing pad coordination", "Sam confirmed laminated pads, 60 durometer. Lead time 6 weeks."),
                (d(-14), "Runway lighting design review", "Ops prefers closures Tue–Thu nights. CCR sizing to be checked."),
                (d(-7), "Load rating check-in", "Girder FE model v3 did not converge at the jacking step – numerical singularity at node 1043."),
                (d(-3), "County meeting", "Discussed the culvert headwall and the bearing jacking procedure. Action: send the hydraulic memo.")]
    for when, title, text in meetings:
        write(v, f"Meetings/{fmt(when)} {title}.md", f"---\ntype: meeting\ndate: {fmt(when)}\n---\n# {title}\n\n## Notes\n{text}\n\n## Action items\n- [ ] Follow up\n")
    write(v, "Mail/Mail.md", "# Mail\nSaved emails (.eml or text) about any project, one file per email.\n")
    make_eml(v / "Mail/Culvert sizing.eml", "Maria Lopez <maria.lopez@county.example>", "hiren@example.com", "Culvert C-12 sizing",
             datetime.combine(d(-9), datetime.min.time()).replace(hour=9, minute=15),
             "Hi,\nThe county wants the culvert memo by Friday, ahead of storm season.\nThanks, Maria",
             [("C-12 design memo.pdf", make_pdf(["Culvert C-12 design memo\nThe 48 inch pipe is undersized for the 100-year storm."]), "pdf")])
    write(v, "Mail/RE bearing pads delivery.txt", outlook_txt("Sam Ortiz", datetime.combine(d(-3), datetime.min.time()).replace(hour=16, minute=10), "RE: bearing pads delivery",
                                                             "The fabricator says the pads ship next week, so the jacking crew can start on the 16th."))
    af = "Analysis/Girder FE"
    write(v, "Analysis/README.md", "# Analysis\nFinite element models, one folder per model. Keep each Abaqus job's .inp, .msg, .sta, .dat and .odb together.\n")
    nodes = "".join(f"{i}, {i * 0.25:.2f}, 0., 0.\n" for i in range(1, 400))
    for ver, ok in (("v2", True), ("v3", False)):
        write(v, f"{af}/girder_{ver}.inp", ABAQUS_INP.format(ver=ver, nodes=nodes))
        write(v, f"{af}/girder_{ver}.msg", abaqus_msg(ok, ver))
        write(v, f"{af}/girder_{ver}.sta", abaqus_sta(ok))
        write(v, f"{af}/girder_{ver}.odb", b"\x00\x01ODB binary results\x00" * 500)
    write(v, f"{af}/girder_v2.dat", abaqus_dat("v2"))
    write(v, "Scripts/loads.py", '"""Load cases for the girder model."""\nimport math\n\n\ndef dead_load(span, w):\n    """Midspan moment of a simply supported span (kip-ft)."""\n    return w * span ** 2 / 8\n\n\ndef jacking_force(reaction, factor=1.3):\n    """Jacking force with the 30 % allowance from Section 564."""\n    return reaction * factor\n\n\nclass LoadCase:\n    def __init__(self, name, factor):\n        self.name, self.factor = name, factor\n')
    write(v, "Scripts/scour.ipynb", json.dumps({"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [
        {"cell_type": "markdown", "metadata": {}, "source": ["# Scour depth at pier 3\n", "HEC-18 contraction scour, 100-year flow."]},
        {"cell_type": "code", "metadata": {}, "execution_count": 1, "source": ["y1, y0 = 6.2, 4.8\n", "ys = y1 - y0\n", "print(f'contraction scour {ys:.1f} ft')"],
         "outputs": [{"output_type": "stream", "name": "stdout", "text": ["contraction scour 1.4 ft\n"]}]}]}, indent=1))

    # --- today's captures ---
    heading = TODAY.strftime("%A, %B %-d, %Y") if sys.platform != "win32" else TODAY.strftime("%A, %B %#d, %Y")
    write(v, "Today.md", f"# Today\n\nQuick captures from Keystone, one section per day (newest first).\n\n## {heading}\n- 09:10 Call Maria about the culvert headwall #culvert\n- [ ] 11:30 Check jacking points on the girders @task due:fri\n")

    # --- the inbox: files to be filed ---
    ib = "Inbox"
    write(v, f"{ib}/girder_v4.inp", ABAQUS_INP.format(ver="v4 – refined mesh at the pier 3 bearings", nodes=nodes))
    write(v, f"{ib}/girder_v4.msg", abaqus_msg(True, "v4"))
    write(v, f"{ib}/girder_v4.sta", abaqus_sta(True))
    write(v, f"{ib}/RE culvert headwall.txt", outlook_txt("Maria Lopez", datetime.combine(d(-1), datetime.min.time()).replace(hour=15, minute=2), "RE: culvert headwall",
                                                          "The county asks whether the C-12 culvert upgrade to a 60 inch pipe also needs a new headwall before the storm season."))
    write(v, f"{ib}/bearing shop drawing review.txt", "Shop drawing review – laminated elastomeric bearing pads for pier 3, 2 in thick, 60 durometer.\nCheck the jacking points on the girders and the anchor bolt layout. Returned: approved as noted.\n")
    write(v, f"{ib}/Culvert C-12 inspection photos log.pdf", make_pdf([
        "Culvert C-12 Inspection Log\nInlet: headwall cracked, 2 ft scour hole at the apron.\nBarrel: 48 in CMP, invert corroded through at 3 locations.\nOutlet: riprap displaced."]))
    make_docx(v / f"{ib}/Pier 3 RFI response.docx", "RFI 07 response – pier 3 bearings", [
        ("Question", ["Contractor asks whether the girders may be jacked 1/4 inch at pier 3."]),
        ("Response", ["No. Jack no more than 1/8 inch per Section 564 of the special provisions. Submit the jacking procedure."])])
    write(v, f"{ib}/runway edge light photometrics.csv", "Fixture,Station,Intensity_cd,Required_cd,Pass\n" + "".join(
        f"L-861-{i:03d},{i * 200},{rng.randint(55, 75)},50,yes\n" for i in range(1, 30)))
    write(v, f"{ib}/grocery list.txt", "milk\neggs\nbread\ncoffee\n")


def meetings_ics(path):
    def dt(day, hh, mm=0):
        return f"{(TODAY + timedelta(days=day)).strftime('%Y%m%d')}T{hh:02d}{mm:02d}00"
    start = sunday_of(TODAY) - timedelta(days=14)
    events = [
        ("standup", "Daily stand-up", f"{start.strftime('%Y%m%d')}T090000", f"{start.strftime('%Y%m%d')}T091500", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR", "Teams"),
        ("review", "Girder Bridge design review", dt(0, 14), dt(0, 15, 30), "", "Room 4"),
        ("county", "County coordination call – culvert C-12", dt(1, 11), dt(1, 12), "", "Phone"),
        ("runway", "Runway lighting submittal review", dt(3, 10), dt(3, 11, 30), "", "Airport ops"),
        ("training", "Abaqus contact modelling training", dt(5, 13), dt(5, 16), "", "Online"),
    ]
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Keystone demo//EN"]
    for uid, title, s, e, rrule, loc in events:
        lines += ["BEGIN:VEVENT", f"UID:{uid}@demo", f"SUMMARY:{title}", f"DTSTART:{s}", f"DTEND:{e}", f"LOCATION:{loc}"] + ([rrule] if rrule else []) + ["END:VEVENT"]
    lines.append("END:VCALENDAR")
    path.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dest", type=Path, default=Path(__file__).resolve().parent.parent / "demo", help="output folder (default: ./demo)")
    ap.add_argument("--force", action="store_true", help="replace an existing demo folder")
    ap.add_argument("--llm-from", type=Path, help="copy AI model profiles from this llm.json (e.g. data/llm.json)")
    ap.add_argument("--no-git", action="store_true", help="don't make the demo vault a git repository")
    args = ap.parse_args()
    dest = args.dest.resolve()
    if dest.exists():
        if not (dest / MARK).exists():
            sys.exit(f"{dest} exists and isn't a Keystone demo folder – refusing to touch it.")
        if not args.force:
            sys.exit(f"{dest} already exists. Use --force to rebuild it.")
        shutil.rmtree(dest)
    data, vault = dest / "data", dest / "vault"
    data.mkdir(parents=True)
    vault.mkdir()
    (dest / MARK).write_text("Created by scripts/make_demo.py – safe to delete.\n")
    try:
        build_vault(vault)
    except ImportError as e:
        sys.exit(f"Missing package ({e.name}). Install the document packages first: pip install python-docx python-pptx openpyxl")
    (data / "data.json").write_text(json.dumps(tracker_data(vault), indent=2), encoding="utf-8")
    meetings_ics(dest / "meetings.ics")
    (data / "plans").mkdir()
    plans, stamped = stamp_dates([(demo_plan(), demo_plan(baseline=True)), (runway_plan(), runway_plan(baseline=True)), (culvert_plan(), None), (bridge_template(), None)])
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    for pid, plan in zip(["p_0000b01d", "p_00009a1f", None, "p_0000c3e1"], plans):
        if pid:
            plan.update(id=pid, rev=1, updated=now)
            (data / "plans" / f"{pid}.json").write_text(json.dumps(plan, indent=1), encoding="utf-8")
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from keystone_worklog.msproject import to_mspdi
    (dest / "Culvert C-12 schedule.xml").write_text(to_mspdi(plans[2]), encoding="utf-8")
    if args.llm_from:
        s = json.loads(args.llm_from.read_text(encoding="utf-8"))
        s["semantic"], s["documents"] = True, True
        f = data / "llm.json"
        f.write_text(json.dumps(s, indent=2), encoding="utf-8")
        f.chmod(0o600)
    if not args.no_git and shutil.which("git"):
        (vault / ".gitignore").write_text(".trash/\n.obsidian/workspace*.json\n*.odb\n", encoding="utf-8")
        g = ["git", "-c", "user.name=Keystone demo", "-c", "user.email=demo@localhost"]
        subprocess.run(["git", "init", "-q"], cwd=vault, check=True)
        subprocess.run([*g, "add", "-A"], cwd=vault, check=True)
        subprocess.run([*g, "commit", "-qm", "Demo vault"], cwd=vault, check=True)
    n = sum(1 for p in vault.rglob("*") if p.is_file() and ".git" not in p.parts)
    print(f"Demo ready in {dest}\n  data/   tracker data{' + AI profiles' if args.llm_from else ''}\n  vault/  {n} files ({len(list((vault / 'Inbox').iterdir()))} in Inbox/)\n  meetings.ics  to try Board → Calendar → Import calendar\n  data/plans/   2 project plans + a template (Plan tab){'' if stamped else ' – install Node.js for baselines'}\n  Culvert C-12 schedule.xml  to try Plan → Open an MS Project file\n\n"
          f"Run it (your real data is not touched):\n  KEYSTONE_DATA_DIR={data} keystone-worklog --port 5050\n")


if __name__ == "__main__":
    main()
