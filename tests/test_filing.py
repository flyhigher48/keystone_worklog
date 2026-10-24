"""Filing the inbox: the vault map, folder suggestions (similar files + same job name), moving files, undo and git."""
import shutil
import subprocess
import unittest

from helpers import Env, sample_data  # first: puts this checkout on sys.path
from keystone_worklog import assistant
from keystone_worklog import vector_index as vi
from test_vector_index import fake_vector


class FilingTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.env.put_data(sample_data(self.env.vault, inboxFolder="Inbox"))
        w = self.env.write
        w("Projects/Girder Bridge/Girder Bridge.md", "# Girder Bridge\nRehabilitation of the girder bridge: bearings, deck repair, pier 3.\n")
        w("Projects/Girder Bridge/Bearing replacement.md", "# Bearing replacement\nElastomeric bearing pads at pier 3, jacking the girders.\n")
        w("Projects/Drainage/README.md", "# Drainage\nCulvert sizing and storm drainage for the county.\n")
        w("Projects/Drainage/Culvert C-12.md", "# Culvert C-12\nThe culvert pipe is undersized for the 100-year storm event.\n")
        w("Analysis/Girder FE/girder_v2.inp", "*Heading\n** girder model v2\n")
        w("Analysis/Girder FE/girder_v2.msg", " ***WARNING: old run\n")
        w("Inbox/bearing pad delivery.txt", "From: Sam\nSubject: bearing pads\n\nThe elastomeric bearing pads for pier 3 ship next week; jacking the girders starts on the 16th.\n")
        w("Inbox/culvert memo.txt", "Culvert pipe undersized for the storm event; the county wants the drainage memo.\n")
        w("Inbox/girder_v3.inp", "*Heading\n** girder model v3\n")
        w("Inbox/girder_v3.msg", " ***ERROR: TOO MANY ATTEMPTS\n")
        self.c = self.env.client

    def tearDown(self):
        self.env.close()

    def tools(self):
        return self.env.app.ai_tools()

    def index_all(self):
        while True:
            files = self.c.post("/api/index/next", json={"model": "m1", "limit": 8}).get_json()["files"]
            if not files:
                return
            for f in files:
                self.c.post("/api/index/upsert", json={"model": "m1", "path": f["path"], "mtime": f["mtime"],
                                                       "chunks": [{**x, "vector": fake_vector(x["embed"])} for x in f["chunks"]]})

    def test_vault_map(self):
        r = self.env.tool("vault_map", {})["result"]
        self.assertIn("Projects/Girder Bridge/ — 2 notes", r)
        self.assertIn("about: Rehabilitation of the girder bridge", r)  # from its folder note
        self.assertIn("about: Culvert sizing and storm drainage", r)  # from README.md
        self.assertIn("Inbox/ — 4 files (INBOX", r)
        self.assertIn("Analysis/Girder FE/ — 2 files", r)
        self.assertIn("No 'Filing rules' note yet.", r)
        self.env.write("Filing rules.md", "# Filing rules\nAbaqus jobs go in Analysis/<project>.\n")
        self.assertIn("Filing rules note: Filing rules.md", self.env.tool("vault_map", {"depth": 1})["result"])

    def test_same_job_name_wins_without_an_index(self):
        r = self.tools().folder_suggestions("Inbox/girder_v3.inp")
        self.assertEqual(r["suggestions"][0]["folder"], "Analysis/Girder FE")
        self.assertIn("has girder_v2.inp", r["suggestions"][0]["why"])
        self.assertEqual(assistant.Tools._job_stem("Bridge spec rev B (2).pdf"), "bridge spec rev b")
        self.assertEqual(assistant.Tools._job_stem("girder_v3.inp"), "girder")

    def test_keyword_fallback_before_indexing(self):
        r = self.tools().folder_suggestions("Inbox/culvert memo.txt")
        self.assertFalse(r["byContent"])
        self.assertEqual(r["suggestions"][0]["folder"], "Projects/Drainage")

    @unittest.skipUnless(vi.available, "LanceDB is not installed")
    def test_similar_content_and_inbox_table(self):
        self.index_all()
        r = self.tools().folder_suggestions("Inbox/bearing pad delivery.txt")
        self.assertTrue(r["byContent"])
        self.assertEqual(r["suggestions"][0]["folder"], "Projects/Girder Bridge")
        self.assertTrue(any(w.startswith("similar to") for w in r["suggestions"][0]["why"]))
        self.assertNotIn("Inbox", [s["folder"] for s in r["suggestions"]])  # never "file it where it already is"
        t = self.c.post("/api/inbox/suggest", json={}).get_json()
        rows = {x["path"]: x for x in t["files"]}
        self.assertEqual(set(rows), {"Inbox/bearing pad delivery.txt", "Inbox/culvert memo.txt", "Inbox/girder_v3.inp", "Inbox/girder_v3.msg"})
        self.assertEqual(rows["Inbox/girder_v3.msg"]["suggestions"][0]["folder"], "Analysis/Girder FE")  # kept with its job
        self.assertEqual(rows["Inbox/girder_v3.msg"]["group"], ["girder_v3.inp"])
        self.assertEqual(rows["Inbox/culvert memo.txt"]["suggestions"][0]["folder"], "Projects/Drainage")
        self.assertIn("Projects/Girder Bridge", self.env.tool("suggest_folder", {"path": "Inbox/bearing pad delivery.txt"})["result"])

    @unittest.skipUnless(vi.available, "LanceDB is not installed")
    def test_one_strong_match_beats_a_big_folder_of_weak_ones(self):
        for i in range(14):
            self.env.write(f"Meetings/Meeting {i}.md", f"# Meeting {i}\nweekly meeting notes about the schedule, girders item {i}\n")
        self.env.write("Specs/Bearings.md", "# Bearings\nlaminated elastomeric bearing pads at the pier, jacking points on girders\n")
        self.env.write("Inbox/pad submittal.txt", "laminated elastomeric bearing pads pier jacking points submittal\n")
        self.index_all()
        r = self.tools().folder_suggestions("Inbox/pad submittal.txt")
        self.assertEqual(r["suggestions"][0]["folder"], "Specs")
        self.assertNotEqual(r["confidence"], "none")
        self.env.write("Inbox/grocery list.txt", "milk eggs bread\n")
        self.index_all()
        self.assertIn(self.tools().folder_suggestions("Inbox/grocery list.txt")["confidence"], ("none", "low"))

    def test_move_files_preview_apply_undo(self):
        moves = [{"from": "Inbox/girder_v3.inp", "to": "Analysis/Girder FE/", "reason": "same job as v2", "confidence": "high"},
                 {"from": "Inbox/girder_v3.msg", "to": "Analysis/Girder FE"},
                 {"from": "Inbox/culvert memo.txt", "to": "Projects/Drainage/Memos/culvert memo.txt"}]
        pv = self.env.tool("move_files", {"moves": moves}, mode="preview")["preview"]
        self.assertEqual(pv["kind"], "moves")
        self.assertEqual([m["to"] for m in pv["moves"]], ["Analysis/Girder FE/girder_v3.inp", "Analysis/Girder FE/girder_v3.msg", "Projects/Drainage/Memos/culvert memo.txt"])
        self.assertEqual([m["newFolder"] for m in pv["moves"]], [False, False, True])
        self.assertEqual(pv["moves"][0]["confidence"], "high")
        j = self.env.tool("move_files", {"moves": moves}, mode="apply")
        self.assertIn("Moved 3 file(s)", j["result"])
        self.assertTrue((self.env.vault / "Projects/Drainage/Memos/culvert memo.txt").is_file())
        self.assertFalse((self.env.vault / "Inbox/girder_v3.inp").exists())
        u = self.c.post("/api/assistant/undo", json={"id": j["undoId"]}).get_json()
        self.assertEqual(len(u["paths"]), 6)
        self.assertTrue((self.env.vault / "Inbox/girder_v3.inp").is_file())
        self.assertTrue((self.env.vault / "Inbox/culvert memo.txt").is_file())

    def test_moves_never_overwrite_or_leave_the_vault(self):
        self.env.write("Projects/Drainage/culvert memo.txt", "already here")
        bad = [
            ([{"from": "Inbox/culvert memo.txt", "to": "Projects/Drainage/"}], "already exists"),
            ([{"from": "Inbox/culvert memo.txt", "to": "../outside/"}], "outside the vault|off limits"),
            ([{"from": "Inbox/culvert memo.txt", "to": "Projects/memo.pdf"}], "change its type"),
            ([{"from": "Inbox/culvert memo.txt", "to": "Keystone/"}], "managed by the tracker"),
            ([{"from": "Inbox/nope.txt", "to": "Projects/"}], "not found"),
            ([{"from": "Inbox/girder_v3.inp", "to": "A/"}, {"from": "Inbox/girder_v3.inp", "to": "A/"}], "not found|already exists"),
        ]
        for moves, msg in bad:
            r = self.env.tool("move_files", {"moves": moves}, mode="preview")
            self.assertRegex(r.get("error", ""), msg)
        r = self.c.post("/api/files/move", json={"moves": [{"from": "Inbox/culvert memo.txt", "to": "Projects/Drainage/"}]})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.env.read("Projects/Drainage/culvert memo.txt"), "already here")

    def test_review_table_endpoint_moves_and_commits_only_tracked_files(self):
        if not shutil.which("git"):
            self.skipTest("git is not installed")
        self.c.post("/api/assistant/git/init", json={})
        big = self.env.vault / "Inbox/girder_v3.odb"
        big.write_bytes(b"\x00binary results")
        subprocess.run(["git", "rm", "-q", "--cached", "Inbox/girder_v3.msg"], cwd=self.env.vault)
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "untrack msg"], cwd=self.env.vault)
        r = self.c.post("/api/files/move", json={"moves": [{"from": "Inbox/girder_v3.inp", "to": "Analysis/Girder FE/"},
                                                          {"from": "Inbox/girder_v3.msg", "to": "Analysis/Girder FE/"},
                                                          {"from": "Inbox/girder_v3.odb", "to": "Analysis/Girder FE/"}]}).get_json()
        self.assertEqual(len(r["moved"]), 3)
        self.assertTrue(r["commit"])
        tracked = subprocess.run(["git", "ls-files"], cwd=self.env.vault, capture_output=True, text=True).stdout.split("\n")
        self.assertIn("Analysis/Girder FE/girder_v3.inp", tracked)  # tracked before: its move is committed
        self.assertNotIn("Analysis/Girder FE/girder_v3.odb", tracked)  # never added to git just by moving it
        self.assertNotIn("Analysis/Girder FE/girder_v3.msg", tracked)

    @unittest.skipUnless(vi.available, "LanceDB is not installed")
    def test_files_that_keep_changing_are_indexed_once_per_pass(self):
        j = self.c.post("/api/index/next", json={"model": "m1", "limit": 50, "settle": 60}).get_json()
        self.assertEqual(j["settling"], 0)  # new files are indexed straight away, even if they were just written
        self.index_all()
        self.env.write("Inbox/girder_v3.msg", " ***ERROR: TOO MANY ATTEMPTS\n ***WARNING: still running\n")  # a job that's still writing
        j = self.c.post("/api/index/next", json={"model": "m1", "limit": 50, "settle": 60}).get_json()
        self.assertEqual((j["files"], j["settling"], j["remaining"]), ([], 1, 1))  # changed again just now: wait until it settles
        j = self.c.post("/api/index/next", json={"model": "m1", "limit": 50, "skip": ["Inbox/girder_v3.msg"]}).get_json()
        self.assertNotIn("Inbox/girder_v3.msg", [f["path"] for f in j["files"]])


if __name__ == "__main__":
    unittest.main()
