"""Big vaults: listing and status never open files, folders can be skipped, size and cloud-only limits, isolated reading."""
import unittest
from unittest import mock

from helpers import Env, sample_data  # first: puts this checkout on sys.path
from keystone_worklog import documents as docs
from keystone_worklog import vector_index as vi


class ScaleTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.env.put_data(sample_data(self.env.vault))
        w = self.env.write
        w("Projects/a.md", "# A\n")
        w("Projects/spec.txt", "bearing pads\n")
        w("Projects/run.inp", "*Heading\n")
        w("Projects/data.xyz", "1 2 3\n")
        w("Archive/old spec.txt", "old\n")
        w("Archive/Deep/older.md", "# old\n")
        w("Results/raw/huge.dat", "x" * 3000)
        self.c = self.env.client

    def tearDown(self):
        docs.configure()
        self.env.close()

    def test_listing_and_status_never_open_files(self):
        with mock.patch.object(docs, "looks_like_text", side_effect=AssertionError("opened a file")), \
             mock.patch.object(docs, "extract", side_effect=AssertionError("read a file")):
            items = {i["path"]: i for i in self.c.get("/api/notes/tree").get_json()["items"]}
            self.assertIn("Projects/run.inp", items)  # a known text type: listed by name
            self.assertNotIn("Projects/data.xyz", items)  # an unknown type: only listed once indexing confirmed it's text
            if vi.available:
                st = self.c.get("/api/index/status?model=m1").get_json()
                self.assertIn("scanSeconds", st)
                self.assertEqual(self.c.get("/api/index/files?model=m1").status_code, 200)

    def test_excluded_folders_size_limit_and_cloud_only_files(self):
        self.c.put("/api/assistant/settings", json={"indexExclude": "Archive\n*/raw", "maxFileMB": 0.002})
        s = self.c.get("/api/assistant/settings").get_json()
        self.assertEqual((s["indexExclude"], s["maxFileMB"]), (["Archive", "*/raw"], 1))  # at least 1 MB
        self.env.app.docs_on()
        found = docs.scan(self.env.vault, force=True)
        self.assertNotIn("Archive/old spec.txt", found["docs"])
        self.assertNotIn("Archive/Deep/older.md", found["notes"])
        self.assertNotIn("Results/raw/huge.dat", found["docs"])
        self.assertGreaterEqual(found["skipped"]["excluded"], 2)
        docs.configure(max_mb=1)
        docs.MAX_FILE_MB = 0.001  # 1 KB, to test the limit with a small file
        found = docs.scan(self.env.vault, force=True)
        self.assertNotIn("Results/raw/huge.dat", found["docs"])
        self.assertEqual(found["skipped"]["large"], 1)
        docs.configure()
        with mock.patch.object(docs, "is_cloud_only", lambda st: st.st_size == len("bearing pads\n")):
            found = docs.scan(self.env.vault, force=True)
            self.assertNotIn("Projects/spec.txt", found["docs"])  # online-only: opening it would download it
            self.assertEqual(found["skipped"]["cloud"], 1)
            docs.configure(cloud=True)
            self.assertIn("Projects/spec.txt", docs.scan(self.env.vault, force=True)["docs"])

    def test_scan_is_reused_until_something_changes(self):
        docs.SCAN_TTL = 60
        try:
            first = docs.scan(self.env.vault, force=True)
            self.env.write("Projects/new.txt", "new\n")
            self.assertIs(docs.scan(self.env.vault), first)  # reused
            self.c.put("/api/notes/file", json={"path": "Projects/b.md", "content": "# B\n", "base": None})  # a write through the app…
            self.assertIn("Projects/new.txt", docs.scan(self.env.vault)["docs"])  # …invalidates it
        finally:
            docs.SCAN_TTL = 0

    def test_documents_are_read_in_a_separate_process(self):
        p = self.env.vault / "Projects/run.inp"
        self.assertEqual(docs.extract_isolated(p), docs.extract(p))
        with mock.patch.object(docs, "ISOLATE", False), mock.patch.object(docs, "extract", return_value=[{"heading": "", "text": "in process"}]):
            self.assertEqual(docs.extract_isolated(p)[0]["text"], "in process")

    def test_cross_origin_isolation_headers(self):
        r = self.c.get("/")
        self.assertEqual(r.headers["Cross-Origin-Opener-Policy"], "same-origin")
        self.assertEqual(r.headers["Cross-Origin-Embedder-Policy"], "require-corp")

    def test_embedding_device_setting(self):
        self.assertEqual(self.c.get("/api/assistant/settings").get_json()["embedDevice"], "auto")
        self.c.put("/api/assistant/settings", json={"embedDevice": "cpu"})
        self.assertEqual(self.c.get("/api/assistant/settings").get_json()["embedDevice"], "cpu")
        self.c.put("/api/assistant/settings", json={"embedDevice": "quantum"})
        self.assertEqual(self.c.get("/api/assistant/settings").get_json()["embedDevice"], "cpu")


if __name__ == "__main__":
    unittest.main()
