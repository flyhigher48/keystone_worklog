"""The assistant's vault tools: search/read, preview → apply, guards, move, undo, git commits."""
import os
import shutil
import subprocess
import unittest

from helpers import Env, sample_data


class ToolsTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.env.put_data(sample_data(self.env.vault))
        self.env.write("Work/Load check.md", "# Load check\n\n## Calculation\n$$M = wL^2/8$$\n\n## Notes\n- Checked\n")
        self.env.write("Work/County meeting.md", "# County meeting\n\nThey want the drainage memo early.\n")
        self.env.write("Ideas/Scratch.md", "# Scratch\n")
        self.env.write("Ideas/Links.md", "See [[Scratch]].\n")

    def tearDown(self):
        self.env.close()

    def apply(self, name, args):
        pv = self.env.tool(name, args, mode="preview")
        self.assertNotIn("error", pv, pv)
        return self.env.tool(name, args, mode="apply", previewDiff=pv["preview"]["diff"])

    def test_search_read_and_list(self):
        r = self.env.tool("search_notes", {"query": "drainage memo"})["result"]
        self.assertIn("[[County meeting]]", r.splitlines()[0])
        r = self.env.tool("read_note", {"path": "Work/Load check", "start_line": 3, "end_line": 4})["result"]
        self.assertIn("lines 3-4 of 7", r)
        self.assertIn("Folders: Ideas/, Keystone/, Work/", self.env.tool("list_folder", {})["result"])

    def test_append_under_heading(self):
        res = self.apply("append_to_note", {"path": "Work/Load check.md", "under_heading": "Calculation", "text": "Assumed w = 18 kN/m."})
        self.assertIn("Done:", res["result"])
        self.assertIn("$$M = wL^2/8$$\nAssumed w = 18 kN/m.\n\n## Notes", self.env.read("Work/Load check.md"))

    def test_stale_preview_is_not_applied(self):
        args = {"path": "Work/Load check.md", "text": "x"}
        pv = self.env.tool("append_to_note", args, mode="preview")
        self.env.write("Work/Load check.md", "# changed elsewhere\n")
        r = self.env.tool("append_to_note", args, mode="apply", previewDiff=pv["preview"]["diff"])
        self.assertIn("changed after the preview", r["error"])

    def test_edit_needs_a_unique_exact_match(self):
        self.assertIn("not found", self.env.tool("edit_note", {"path": "Work/Load check.md", "old_text": "nope", "new_text": "x"}, mode="preview")["error"])
        self.assertIn("appears", self.env.tool("edit_note", {"path": "Work/Load check.md", "old_text": "#", "new_text": "x"}, mode="preview")["error"])

    def test_guards(self):
        self.assertIn("already exists", self.env.tool("create_note", {"path": "Ideas/Scratch", "content": "x"}, mode="preview")["error"])
        self.assertIn("managed by the tracker", self.env.tool("create_note", {"path": "Keystone/x", "content": "x"}, mode="preview")["error"])
        r = self.env.tool("edit_note", {"path": "Keystone/Projects/Bridge rehab.md", "old_text": "budget-hours:: 200", "new_text": "budget-hours:: 9"}, mode="preview")
        self.assertIn("generated block", r["error"])
        self.assertIn("Unknown tool", self.env.tool("delete_note", {"path": "Ideas/Scratch.md"})["error"])
        self.assertIn("off limits", self.env.tool("read_note", {"path": "../../etc/passwd"})["error"])

    def test_move_reports_backlinks_and_undo_restores(self):
        res = self.apply("move_note", {"from_path": "Ideas/Scratch.md", "to_path": "Work/Scratch.md"})
        self.assertEqual(res["backlinks"], ["Ideas/Links.md"])
        self.assertTrue((self.env.vault / "Work/Scratch.md").exists())
        self.env.client.post("/api/assistant/undo", json={"id": res["undoId"]})
        self.assertTrue((self.env.vault / "Ideas/Scratch.md").exists())

    def test_undo_create_parks_the_note_in_trash(self):
        res = self.apply("create_note", {"path": "Work/New.md", "content": "# New"})
        self.env.client.post("/api/assistant/undo", json={"id": res["undoId"]})
        self.assertFalse((self.env.vault / "Work/New.md").exists())
        self.assertTrue((self.env.vault / ".trash/New.md").exists())

    def test_recent_notes(self):
        r = self.env.tool("recent_notes", {"days": 1})["result"]
        self.assertIn("Work/Load check.md", r)
        self.assertIn("(tracker note)", r)


@unittest.skipUnless(shutil.which("git"), "git is not installed")
class GitCommitTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.env.put_data(sample_data(self.env.vault))
        self.env.write("Work/A.md", "# A\n")
        self.env.write("Work/B.md", "# B\n")
        self.git("init", "-q")
        self.git("add", "-A")
        self.git("commit", "-qm", "start")

    def tearDown(self):
        self.env.close()

    def git(self, *args):
        return subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@t", *args], cwd=self.env.vault, capture_output=True, text=True, check=True).stdout

    def test_commits_only_the_files_it_changed(self):
        self.env.write("Work/B.md", "# B\nmy unsaved work\n")  # the user's own uncommitted change
        pv = self.env.tool("append_to_note", {"path": "Work/A.md", "text": "added"}, mode="preview")
        res = self.env.tool("append_to_note", {"path": "Work/A.md", "text": "added"}, mode="apply", previewDiff=pv["preview"]["diff"])
        self.assertTrue(res["commit"])
        self.assertEqual(self.git("show", "--name-only", "--format=", "HEAD").split(), ["Work/A.md"])
        self.assertIn("M Work/B.md", self.git("status", "--short"))


if __name__ == "__main__":
    unittest.main()
