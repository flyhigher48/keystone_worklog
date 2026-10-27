"""Team costs: reading ERP exports, the cost ledger (replace by posting date, undo), people & rates, and status snapshots."""
import base64
import io
import json
import os
import stat
import unittest
from datetime import date, datetime

from helpers import Env  # first: puts this checkout on sys.path
from keystone_worklog import costs

HEAD = ["Posting Date", "Work Date", "Employee Name", "Hours", "Pay Amount", "Fringe Amount", "Network", "Activity"]


def xlsx(rows, title=None):
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Charges"
    if title:
        ws.append([title])
        ws.append([])
    for r in rows:
        ws.append(r)
    wb.create_sheet("Notes").append(["nothing here"])
    buf = io.BytesIO()
    wb.save(buf)
    return base64.b64encode(buf.getvalue()).decode()


def line(d, post, hours=8, pay=500.0, name="LOPEZ, MARIA"):
    return {"date": d, "post": post, "name": name, "hours": hours, "pay": pay, "fringe": round(pay * 0.31, 2), "nwa": "4001234|0010"}


class ReadTest(unittest.TestCase):
    def test_excel_with_a_title_row_dates_and_numbers(self):
        b64 = xlsx([HEAD, [datetime(2026, 10, 17), date(2026, 10, 12), "LOPEZ, MARIA", 8, 520.0, 161.2, "4001234", "0010"]], title="Labor report")
        t = costs.read_table("export.xlsx", b64)
        self.assertEqual(t["sheets"], ["Charges", "Notes"])
        self.assertEqual(t["sheet"], "Charges")
        self.assertEqual(t["rows"][0], ["Labor report"])
        self.assertEqual(t["rows"][1], [])
        self.assertEqual(t["rows"][2], HEAD)
        self.assertEqual(t["rows"][3], ["2026-10-17", "2026-10-12", "LOPEZ, MARIA", 8, 520.0, 161.2, "4001234", "0010"])
        self.assertEqual(costs.read_table("export.xlsx", b64, sheet="Notes")["rows"], [["nothing here"]])

    def test_csv_semicolons_and_pasted_tabs(self):
        csv_text = "Posting Date;Hours;Pay\n10/17/2026;8;1.234,50\n"
        t = costs.read_table("x.csv", base64.b64encode(csv_text.encode("cp1252")).decode())
        self.assertEqual(t["rows"], [["Posting Date", "Hours", "Pay"], ["10/17/2026", "8", "1.234,50"]])
        t = costs.read_table(text="Work Date\tHours\n10/12/2026\t8\n\n")
        self.assertEqual(t["rows"], [["Work Date", "Hours"], ["10/12/2026", "8"]])

    def test_files_that_cant_be_read(self):
        with self.assertRaisesRegex(costs.CostError, "xls"):
            costs.read_table("old.xls", base64.b64encode(b"\xd0\xcf\x11\xe0junk").decode())
        with self.assertRaisesRegex(costs.CostError, "Excel"):
            costs.read_table("broken.xlsx", base64.b64encode(b"PK\x03\x04junk").decode())
        with self.assertRaises(costs.CostError):
            costs.read_table("empty.csv", "")


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.c = self.env.client

    def tearDown(self):
        self.env.close()

    def imp(self, lines, lo, hi, pid="bridge"):
        r = self.c.post("/api/costs/import", json={"source": "export.xlsx", "layout": "Mine", "groups": [{"projectId": pid, "covers": {"from": lo, "to": hi}, "lines": lines}]})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        return r.get_json()["batches"][0]

    def test_a_newer_export_replaces_the_period_it_covers_and_undo_brings_it_back(self):
        sep = [line("2026-09-14", "2026-09-19"), line("2026-09-21", "2026-09-26"), line("2026-09-28", "2026-10-03")]
        b1 = self.imp(sep, "2026-09-01", "2026-10-03")
        self.assertEqual((b1["rows"], b1["replaced"]), (3, 0))
        # the October export re-runs from Sep 20: the Sep 26 and Oct 3 postings are replaced (with a reversal), Sep 19 stays
        octo = [line("2026-09-21", "2026-09-26"), line("2026-09-28", "2026-10-03", hours=-8, pay=-500), line("2026-09-28", "2026-10-03", hours=6, pay=375), line("2026-10-05", "2026-10-10")]
        b2 = self.imp(octo, "2026-09-20", "2026-10-10")
        self.assertEqual((b2["rows"], b2["replaced"]), (4, 2))
        led = self.c.get("/api/costs/bridge").get_json()
        self.assertEqual(led["postedThrough"], "2026-10-10")
        self.assertEqual(sorted((x["post"], x["hours"]) for x in led["lines"]), [("2026-09-19", 8), ("2026-09-26", 8), ("2026-10-03", -8), ("2026-10-03", 6), ("2026-10-10", 8)])
        self.assertEqual(len(led["batches"]), 2)
        # only the latest import can be undone; undoing it restores exactly what it replaced
        r = self.c.post("/api/costs/bridge/undo", json={"batch": b1["id"]})
        self.assertEqual(r.status_code, 400)
        r = self.c.post("/api/costs/bridge/undo", json={"batch": b2["id"]}).get_json()
        self.assertEqual((r["removed"], r["restored"], r["postedThrough"]), (4, 2, "2026-10-03"))
        led = self.c.get("/api/costs/bridge").get_json()
        self.assertEqual(sorted(x["post"] for x in led["lines"]), ["2026-09-19", "2026-09-26", "2026-10-03"])
        trash = sorted(p.name for p in (self.env.data / "costs" / ".trash").iterdir())
        self.assertIn(f"bridge-{b2['id']}-undone.json", trash)    # the undone lines are kept, never deleted
        self.assertIn(f"bridge-{b2['id']}-restored.json", trash)

    def test_bad_imports_are_refused(self):
        r = self.c.post("/api/costs/import", json={"groups": [{"projectId": "../x", "covers": {"from": "2026-01-01", "to": "2026-01-31"}, "lines": []}]})
        self.assertEqual(r.status_code, 400)
        r = self.c.post("/api/costs/import", json={"groups": [{"projectId": "bridge", "covers": {"from": "2026-02-01", "to": "2026-01-01"}, "lines": []}]})
        self.assertIn("covers", r.get_json()["error"])
        r = self.c.post("/api/costs/import", json={"groups": [{"projectId": "bridge", "covers": {"from": "2026-01-01", "to": "2026-01-31"}, "lines": [{"date": "soon"}]}]})
        self.assertIn("date", r.get_json()["error"])
        self.assertEqual(self.c.post("/api/costs/import", json={"groups": []}).status_code, 400)

    def test_lines_keep_only_known_fields_and_pay_files_are_private(self):
        self.imp([{**line("2026-09-14", "2026-09-19"), "evil": "x" * 10, "desc": "y" * 500, "row": 7}], "2026-09-01", "2026-09-30")
        x = self.c.get("/api/costs/bridge").get_json()["lines"][0]
        self.assertNotIn("evil", x)
        self.assertEqual(len(x["desc"]), 200)
        self.assertEqual(x["row"], 7)
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE((self.env.data / "costs" / "bridge.json").stat().st_mode), 0o600)
        s = self.c.get("/api/costs").get_json()["projects"]
        self.assertEqual([(p["projectId"], p["lines"], p["postedThrough"]) for p in s], [("bridge", 1, "2026-09-30")])

    def test_parse_endpoint(self):
        r = self.c.post("/api/costs/parse", json={"text": "Hours,Pay\n8,500\n"})
        self.assertEqual(r.get_json()["rows"], [["Hours", "Pay"], ["8", "500"]])
        self.assertEqual(self.c.post("/api/costs/parse", json={"filename": "x.xls", "data": base64.b64encode(b"\xd0\xcf\x11\xe0").decode()}).status_code, 400)


class PeopleAndStatusTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.c = self.env.client

    def tearDown(self):
        self.env.close()

    def test_people_and_rates_save_with_conflict_detection(self):
        doc = self.c.get("/api/people").get_json()
        self.assertEqual((doc["rev"], doc["people"]), (0, []))
        doc["people"] = [{"id": "pe_1", "name": "Maria Lopez", "aliases": ["LOPEZ, MARIA"]}]
        doc["rates"] = [{"who": "pe_1", "base": 65, "from": "2026-07-05"}]
        r = self.c.put("/api/people", json={"doc": doc, "baseRev": 0})
        self.assertEqual(r.get_json()["rev"], 1)
        r = self.c.put("/api/people", json={"doc": doc, "baseRev": 0})  # another tab still on rev 0
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.get_json()["doc"]["people"][0]["name"], "Maria Lopez")
        self.assertEqual(self.c.put("/api/people", json={"doc": {"people": "nope"}}).status_code, 400)
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE((self.env.data / "people.json").stat().st_mode), 0o600)

    def test_status_snapshots(self):
        plan = {"name": "P", "tasks": [{"uid": 1, "name": "A"}], "resources": [], "assignments": []}
        pid = self.c.post("/api/plans", json={"plan": plan}).get_json()["id"]
        snap = {"id": "s_2026-10-23", "date": "2026-10-23", "statusDate": "2026-10-23", "rag": {"overall": "amber"}, "finish": "2026-12-22"}
        self.assertEqual(self.c.put(f"/api/plans/{pid}/status", json={"snapshot": snap}).get_json()["count"], 1)
        self.assertEqual(self.c.put(f"/api/plans/{pid}/status", json={"snapshot": {**snap, "rag": {"overall": "red"}}}).get_json()["count"], 1)  # same id: updated
        self.c.put(f"/api/plans/{pid}/status", json={"snapshot": {**snap, "id": "s_2026-10-16", "date": "2026-10-16"}})
        snaps = self.c.get(f"/api/plans/{pid}/status").get_json()["snapshots"]
        self.assertEqual([(s["date"], s["rag"]["overall"]) for s in snaps], [("2026-10-16", "amber"), ("2026-10-23", "red")])
        listed = next(p for p in self.c.get("/api/plans").get_json()["plans"] if p["id"] == pid)
        self.assertEqual(listed["lastStatus"], {"date": "2026-10-23", "rag": "red"})  # and the .status.json isn't listed as a plan
        self.assertEqual(len(self.c.get("/api/plans").get_json()["plans"]), 1)
        self.assertEqual(self.c.put(f"/api/plans/{pid}/status", json={"snapshot": {"id": "bad", "date": "x"}}).status_code, 400)
        self.assertEqual(self.c.post(f"/api/plans/{pid}/status/remove", json={"id": "s_2026-10-16"}).status_code, 200)
        doc = json.loads((self.env.data / "plans" / f"{pid}.status.json").read_text())
        self.assertEqual([s["id"] for s in doc["snapshots"]], ["s_2026-10-23"])
        self.assertEqual([s["id"] for s in doc["removed"]], ["s_2026-10-16"])  # kept, not deleted
        self.c.post(f"/api/plans/{pid}/delete", json={})
        self.assertFalse((self.env.data / "plans" / f"{pid}.status.json").exists())
        self.assertTrue(any(p.name.endswith(".status.json") for p in (self.env.data / "plans" / ".trash").iterdir()))

    def test_daily_backup_includes_people_and_ledgers(self):
        self.c.put("/api/people", json={"doc": {"people": [{"id": "pe_1", "name": "A"}], "rates": [], "costModels": [], "layouts": []}})
        self.c.post("/api/costs/import", json={"groups": [{"projectId": "bridge", "covers": {"from": "2026-09-01", "to": "2026-09-30"}, "lines": [line("2026-09-14", "2026-09-19")]}]})
        self.env.put_data({"settings": {}, "projects": []})
        folders = [p for p in (self.env.data / "backups").iterdir() if p.name.startswith("costs-")]
        self.assertEqual(len(folders), 1)
        self.assertEqual(sorted(p.name for p in folders[0].iterdir()), ["bridge.json", "people.json"])


if __name__ == "__main__":
    unittest.main()
