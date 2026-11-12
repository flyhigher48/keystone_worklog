"""grep, tasks and backlinks: the exact-search tools behind /grep, /todos and /backlinks (and offered to the LLM too)."""
import json
import unittest

from helpers import Env, sample_data


class GrepTasksTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.env.put_data(sample_data(self.env.vault))
        self.env.write("Projects/Bridge/Design.md", "# Design\n\nBearing type TBD.\n- [ ] Check pads #bridge 📅 2026-11-20\n- [x] Load rating done\n```\n- [ ] not a task (code)\n```\n")
        self.env.write("Projects/Bridge/Site.md", "# Site\n\nSee [[Design]]. Deck joint TBD\n- [ ] Photos due:2026-11-12\n")
        self.env.write("Ideas/Other.md", "# Other\n- [ ] Someday #idea\nnothing TBD here? yes TBD\n")

    def tearDown(self):
        self.env.close()

    def test_grep_literal_by_default_and_scoped(self):
        j = self.env.tool("grep", {"pattern": "tbd"})
        self.assertEqual({(d["path"], d["line"]) for d in j["data"]}, {("Projects/Bridge/Design.md", 3), ("Projects/Bridge/Site.md", 3), ("Ideas/Other.md", 3)})
        self.assertIn("3 matching lines in 3 files", j["result"])
        j = self.env.tool("grep", {"pattern": "TBD", "folder": "Projects/Bridge", "case": True})
        self.assertEqual(len(j["data"]), 2)
        self.assertEqual(self.env.tool("grep", {"pattern": "d.ck"})["data"], [])  # literal: the dot is a dot

    def test_grep_regex_and_its_guards(self):
        j = self.env.tool("grep", {"pattern": r"d.ck joint", "regex": True})
        self.assertEqual([d["path"] for d in j["data"]], ["Projects/Bridge/Site.md"])
        self.assertIn("error", self.env.tool("grep", {"pattern": "(a+)+$", "regex": True}))
        self.assertIn("error", self.env.tool("grep", {"pattern": "([", "regex": True}))
        self.assertIn("error", self.env.tool("grep", {"pattern": "x" * 201}))
        self.assertIn("error", self.env.tool("grep", {"pattern": "  "}))
        self.assertIn("error", self.env.tool("grep", {"pattern": "a", "folder": "../outside"}))

    def test_grep_skips_the_tracker_folder(self):
        self.env.write("Keystone/Timesheet.md", "TBD in a generated note\n")
        self.assertNotIn("Keystone/Timesheet.md", {d["path"] for d in self.env.tool("grep", {"pattern": "TBD"})["data"]})
        self.assertEqual(len(self.env.tool("grep", {"pattern": "TBD", "folder": "Keystone"})["data"]), 1)

    def test_tasks_with_due_dates_tags_and_status(self):
        j = self.env.tool("tasks", {})
        self.assertEqual([d["text"] for d in j["data"]], ["Photos due:2026-11-12", "Check pads #bridge 📅 2026-11-20", "Someday #idea"])
        self.assertEqual(j["data"][0]["due"], "2026-11-12")
        self.assertEqual(j["data"][1]["raw"], "- [ ] Check pads #bridge 📅 2026-11-20")
        self.assertEqual([d["text"] for d in self.env.tool("tasks", {"due_before": "2026-11-15"})["data"]], ["Photos due:2026-11-12"])
        self.assertEqual([d["text"] for d in self.env.tool("tasks", {"tag": "#bridge"})["data"]], ["Check pads #bridge 📅 2026-11-20"])
        self.assertEqual([d["text"] for d in self.env.tool("tasks", {"status": "done"})["data"]], ["Load rating done"])
        self.assertEqual(len(self.env.tool("tasks", {"status": "all", "folder": "Projects"})["data"]), 3)

    def test_backlinks(self):
        j = self.env.tool("backlinks", {"path": "Projects/Bridge/Design.md"})
        self.assertEqual(j["data"], [{"path": "Projects/Bridge/Site.md"}])
        self.assertIn("No notes link", self.env.tool("backlinks", {"path": "Ideas/Other.md"})["result"])

    def test_tasks_skip_the_templates_folder(self):
        self.env.write("Templates/Meeting.md", "# {{title}}\n- [ ] Follow up\n")
        self.assertNotIn("Templates/Meeting.md", {d["path"] for d in self.env.tool("tasks", {})["data"]})

    def test_the_miss_log_is_local_and_bounded(self):
        c = self.env.client
        self.assertEqual(c.post("/api/commands/miss", json={"text": "  "}).status_code, 400)
        r = c.post("/api/commands/miss", json={"text": "what is the airspeed", "kind": "none", "ranked": [{"name": "help", "score": 0.3381}, "junk"]})
        self.assertEqual(r.status_code, 200)
        rows = [json.loads(x) for x in (self.env.data / "commands" / "misses.jsonl").read_text().splitlines()]
        self.assertEqual(rows[0]["text"], "what is the airspeed")
        self.assertEqual(rows[0]["ranked"], [{"name": "help", "score": 0.338}])

    def test_search_and_recent_return_rows_too(self):
        self.assertIn("Projects/Bridge/Site.md", [d["path"] for d in self.env.tool("search_notes", {"query": "deck joint"})["data"]])
        self.assertIn("Ideas/Other.md", [d["path"] for d in self.env.tool("recent_notes", {"days": 1})["data"]])


if __name__ == "__main__":
    unittest.main()
