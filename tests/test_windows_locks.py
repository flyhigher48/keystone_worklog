"""Windows file locks (OneDrive, antivirus): retried writes, a quiet index state file, and the index kept out of synced folders."""
import importlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from helpers import Env, sample_data  # first: puts this checkout on sys.path
from keystone_worklog import fsutil
from keystone_worklog import vector_index as vi
from test_vector_index import fake_vector


class LockTest(unittest.TestCase):
    def test_replace_retries_while_the_file_is_locked(self):
        d = Path(tempfile.mkdtemp())
        real, calls = os.replace, []

        def flaky(src, dst):
            calls.append(1)
            if len(calls) < 3:
                raise PermissionError(13, "Access is denied")  # what Windows says while OneDrive holds the file
            return real(src, dst)
        with mock.patch("os.replace", flaky):
            fsutil.write_text(d / "state.json", '{"ok": 1}')
        self.assertEqual((d / "state.json").read_text(), '{"ok": 1}')
        self.assertEqual(len(calls), 3)
        self.assertEqual([p.name for p in d.iterdir()], ["state.json"])  # no temp files left behind

    def test_gives_up_with_the_error_after_the_retries(self):
        d = Path(tempfile.mkdtemp())
        with mock.patch("os.replace", side_effect=PermissionError(13, "Access is denied")):
            with self.assertRaises(PermissionError):
                fsutil.write_text(d / "x.json", "{}", retry=0.1)
        self.assertEqual(list(d.iterdir()), [])

    def test_cloud_folders_are_recognised(self):
        with mock.patch.dict(os.environ, {"OneDrive": "/home/me/OneDrive - Contoso"}):
            self.assertTrue(fsutil.in_cloud_folder("/home/me/OneDrive - Contoso/Documents/keystone/data"))
        self.assertTrue(fsutil.in_cloud_folder("C:/Users/me/OneDrive/Documents/data"))
        self.assertFalse(fsutil.in_cloud_folder("/home/me/projects/keystone/data"))


@unittest.skipUnless(vi.available, "LanceDB is not installed")
class QuietStateTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.env.put_data(sample_data(self.env.vault))
        for i in range(12):
            self.env.write(f"Notes/n{i}.md", f"# Note {i}\ntext {i}\n")
        self.c = self.env.client

    def tearDown(self):
        self.env.close()

    def test_state_is_not_rewritten_for_every_file_and_a_locked_save_is_not_fatal(self):
        writes = []
        real = fsutil.write_text

        def counting(path, *a, **k):
            if Path(path).name == "index_state.json":
                writes.append(1)
            return real(path, *a, **k)
        with mock.patch.object(fsutil, "write_text", counting):
            n = 0
            while True:
                files = self.c.post("/api/index/next", json={"model": "m1", "limit": 8}).get_json()["files"]
                if not files:
                    break
                for f in files:
                    r = self.c.post("/api/index/upsert", json={"model": "m1", "path": f["path"], "mtime": f["mtime"],
                                                              "chunks": [{**x, "vector": fake_vector(x["embed"])} for x in f["chunks"]]})
                    self.assertEqual(r.status_code, 200)
                    n += 1
        self.assertGreater(n, 15)
        self.assertLess(len(writes), n // 2)  # saved now and then, not after every file
        with mock.patch.object(fsutil, "write_text", side_effect=PermissionError(13, "Access is denied")):
            self.env.app.INDEX.flush()  # still locked after the retries: kept in memory, no crash
        self.env.app.INDEX.flush()
        self.assertTrue((self.env.app.INDEX_DIR / "index_state.json").is_file())
        self.assertEqual(self.c.get("/api/index/status?model=m1").get_json()["stale"], 0)


class IndexDirTest(unittest.TestCase):
    def test_index_moves_out_of_a_synced_data_folder(self):
        tmp = Path(tempfile.mkdtemp())
        data = tmp / "OneDrive - Contoso" / "keystone" / "data"
        data.mkdir(parents=True)
        env = {"KEYSTONE_DATA_DIR": str(data), "OneDrive": str(tmp / "OneDrive - Contoso"), "LOCALAPPDATA": str(tmp / "Local")}
        with mock.patch.dict(os.environ, env):
            os.environ.pop("KEYSTONE_INDEX_DIR", None)
            from keystone_worklog import app as app_module
            app = importlib.reload(app_module)
            self.assertTrue(str(app.INDEX_DIR).startswith(str(tmp / "Local" / "keystone-worklog")))
            with mock.patch.dict(os.environ, {"KEYSTONE_INDEX_DIR": str(tmp / "mine")}):
                self.assertEqual(app.index_dir(), tmp / "mine")
        with mock.patch.dict(os.environ, {"KEYSTONE_DATA_DIR": str(tmp / "plain")}):
            app = importlib.reload(app_module)
            self.assertEqual(app.INDEX_DIR, tmp / "plain" / "index")


if __name__ == "__main__":
    unittest.main()
