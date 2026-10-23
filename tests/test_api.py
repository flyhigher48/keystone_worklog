"""HTTP API: tracker data, daily backups, local-only access, the notes API and its path safety, uploads, settings."""
import os
import stat
import unittest

from helpers import Env, sample_data

PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")


class ApiTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.c = self.env.client

    def tearDown(self):
        self.env.close()

    def test_data_round_trip_and_daily_backup(self):
        data = sample_data(self.env.vault)
        self.env.put_data(data)
        self.assertEqual(self.env.get_data()["projects"][0]["name"], "Bridge rehab")
        backups = self.c.get("/api/backups").get_json()["backups"]
        self.assertEqual(len(backups), 1)
        restored = self.c.get("/api/backups/" + backups[0]["name"]).get_json()
        self.assertEqual(restored["projects"], data["projects"])

    def test_backup_names_are_validated(self):
        self.assertEqual(self.c.get("/api/backups/..%2Fllm.json").status_code, 404)
        self.assertEqual(self.c.get("/api/backups/data-2026-13-99.json").status_code, 404)

    def test_only_answers_this_computer(self):
        self.assertEqual(self.c.get("/api/data", headers={"Host": "evil.example.com"}).status_code, 403)
        self.assertEqual(self.c.get("/api/data", headers={"Host": "127.0.0.1:5000"}).status_code, 200)

    def test_rejects_non_json_writes(self):
        r = self.c.put("/api/data", data="x", content_type="text/plain")
        self.assertEqual(r.status_code, 400)


@unittest.skipUnless(__import__("shutil").which("git"), "git is not installed")
class DataHistoryTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()

    def tearDown(self):
        self.env.close()

    def test_daily_commit_goes_to_a_private_repo_with_only_data_json(self):
        import subprocess
        (self.env.data / "llm.json").write_text('{"profiles": [{"apiKey": "sk-secret"}]}')
        self.env.put_data(sample_data(self.env.vault, dataGit=True))
        self.env.put_data(sample_data(self.env.vault, dataGit=True))  # same day: still one commit
        git = lambda *a: subprocess.run(["git", *a], cwd=self.env.data, capture_output=True, text=True).stdout  # noqa: E731
        self.assertEqual(len(git("log", "--oneline").splitlines()), 1)
        self.assertEqual(git("ls-files").split(), ["data.json"])  # never the API keys
        self.assertTrue(self.env.client.get("/api/backups").get_json()["git"]["repo"])


class NotesApiTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.c = self.env.client
        self.env.put_data(sample_data(self.env.vault))
        self.env.write("Work/Plan.md", "# Plan\n")

    def tearDown(self):
        self.env.close()

    def test_tree_lists_notes_with_mtime_and_skips_hidden(self):
        self.env.write(".obsidian/x.md", "hidden")
        items = self.c.get("/api/notes/tree").get_json()["items"]
        paths = {i["path"]: i for i in items}
        self.assertIn("Work/Plan.md", paths)
        self.assertIn("mtime", paths["Work/Plan.md"])
        self.assertFalse(any(p.startswith(".obsidian") for p in paths))

    def test_write_with_conflict_detection(self):
        j = self.c.get("/api/notes/file?path=Work/Plan.md").get_json()
        ok = self.c.put("/api/notes/file", json={"path": "Work/Plan.md", "content": "# Plan\nv2\n", "base": j["mtime"]})
        self.assertEqual(ok.status_code, 200)
        stale = self.c.put("/api/notes/file", json={"path": "Work/Plan.md", "content": "mine", "base": j["mtime"]})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.get_json()["content"], "# Plan\nv2\n")  # the other version, to choose from

    def test_create_never_overwrites(self):
        r = self.c.put("/api/notes/file", json={"path": "Work/Plan.md", "content": "x", "base": None})
        self.assertEqual(r.status_code, 409)

    def test_paths_are_locked_inside_the_vault(self):
        for bad in ["../outside.md", "/etc/passwd", ".obsidian/app.md", "Work/../../x.md"]:
            r = self.c.get("/api/notes/file?path=" + bad)
            self.assertEqual(r.status_code, 400, bad)
        r = self.c.put("/api/notes/file", json={"path": "script.sh", "content": "x", "base": None})
        self.assertEqual(r.status_code, 400)

    @unittest.skipIf(os.name == "nt", "symlinks need extra rights on Windows")
    def test_symlinks_cannot_escape(self):
        outside = self.env.tmp / "secret"
        outside.mkdir()
        (outside / "s.md").write_text("secret")
        os.symlink(outside, self.env.vault / "link")
        self.assertEqual(self.c.get("/api/notes/file?path=link/s.md").status_code, 400)

    def test_rename_keeps_type_and_delete_moves_to_trash(self):
        r = self.c.post("/api/notes/rename", json={"from": "Work/Plan.md", "to": "Work/Plan v2.md"})
        self.assertEqual(r.get_json()["path"], "Work/Plan v2.md")
        bad = self.c.post("/api/notes/rename", json={"from": "Work/Plan v2.md", "to": "Work/Plan.png"})
        self.assertEqual(bad.status_code, 400)
        self.c.post("/api/notes/delete", json={"path": "Work/Plan v2.md"})
        self.assertFalse((self.env.vault / "Work/Plan v2.md").exists())
        self.assertTrue((self.env.vault / ".trash/Plan v2.md").exists())

    def test_image_upload(self):
        url = "/api/notes/upload?path=Attachments/shot.png"
        first = self.c.post(url, data=PNG, content_type="image/png").get_json()
        second = self.c.post(url, data=PNG, content_type="image/png").get_json()
        self.assertEqual(first["path"], "Attachments/shot.png")
        self.assertEqual(second["path"], "Attachments/shot 1.png")  # never overwrites
        self.assertEqual(self.c.post(url, data=b"x", content_type="text/plain").status_code, 415)
        self.assertEqual(self.c.post("/api/notes/upload?path=evil.md", data=PNG, content_type="image/png").status_code, 400)
        self.assertEqual(self.c.get("/api/notes/raw?path=Attachments/shot.png").status_code, 200)


class SettingsTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.c = self.env.client

    def tearDown(self):
        self.env.close()

    def test_api_keys_are_masked_kept_and_private(self):
        r = self.c.put("/api/assistant/settings", json={"profiles": [{"name": "Cloud", "baseUrl": "https://x/v1/", "apiKey": "sk-secret-abcdef123", "model": "m"}]})
        prof = r.get_json()["profiles"][0]
        self.assertNotIn("sk-secret-abcdef123", r.get_data(as_text=True))
        self.assertTrue(prof["hasKey"])
        self.assertEqual(prof["baseUrl"], "https://x/v1")  # trailing slash trimmed
        # saving again without a key keeps the stored one
        r = self.c.put("/api/assistant/settings", json={"profiles": [{"id": prof["id"], "name": "Cloud", "baseUrl": "https://x/v1", "apiKey": "", "model": "m"}]})
        self.assertTrue(r.get_json()["profiles"][0]["hasKey"])
        if os.name != "nt":
            mode = stat.S_IMODE(os.stat(self.env.data / "llm.json").st_mode)
            self.assertEqual(mode, 0o600)
        # clearKey removes it
        r = self.c.put("/api/assistant/settings", json={"profiles": [{"id": prof["id"], "name": "Cloud", "baseUrl": "https://x/v1", "clearKey": True, "model": "m"}]})
        self.assertFalse(r.get_json()["profiles"][0]["hasKey"])


if __name__ == "__main__":
    unittest.main()
