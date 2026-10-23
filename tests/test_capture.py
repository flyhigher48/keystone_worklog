"""Quick capture into Today.md: one heading per day, newest first, entries appended inside their day."""
import unittest

from keystone_worklog import assistant
from helpers import Env, sample_data


class SectionHelpersTest(unittest.TestCase):
    def test_new_days_go_on_top_and_entries_stay_in_their_day(self):
        t = "# Today\n\nIntro.\n"
        t = assistant.ensure_heading(t, "Friday, October 23, 2026")
        t = assistant.append_under_heading(t, "Friday, October 23, 2026", "- 09:00 one")
        t = assistant.append_under_heading(t, "Friday, October 23, 2026", "- 09:05 two")
        t = assistant.ensure_heading(t, "Saturday, October 24, 2026")
        t = assistant.append_under_heading(t, "Saturday, October 24, 2026", "- 10:00 next day")
        t = assistant.append_under_heading(t, "Friday, October 23, 2026", "- 18:00 late add")
        self.assertEqual(t, "# Today\n\nIntro.\n\n## Saturday, October 24, 2026\n- 10:00 next day\n\n"
                            "## Friday, October 23, 2026\n- 09:00 one\n- 09:05 two\n- 18:00 late add\n")

    def test_oldest_first_appends_at_the_end(self):
        t = assistant.ensure_heading("## Mon\n- a\n", "Tue", newest_first=False)
        self.assertEqual(assistant.append_under_heading(t, "Tue", "- b"), "## Mon\n- a\n\n## Tue\n- b\n")

    def test_existing_heading_is_left_alone_and_code_fences_are_ignored(self):
        t = "```\n## Fri\n```\n"
        self.assertIn("\n## Fri\n", assistant.ensure_heading(t, "Fri")[len(t) - 1:])  # the fenced one doesn't count
        t2 = "## Fri\n- a\n"
        self.assertEqual(assistant.ensure_heading(t2, "Fri"), t2)

    def test_missing_heading_raises(self):
        with self.assertRaises(assistant.ToolError):
            assistant.append_under_heading("# x\n", "Nope", "- a")


class CaptureEndpointTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.env.put_data(sample_data(self.env.vault))

    def tearDown(self):
        self.env.close()

    def capture(self, heading, line):
        return self.env.client.post("/api/notes/capture", json={"path": "Today.md", "heading": heading, "line": line, "template": "# Today\n"}).get_json()

    def test_creates_today_md_and_keeps_user_text(self):
        self.assertTrue(self.capture("Fri", "- 09:00 first")["created"])
        self.env.write("Today.md", self.env.read("Today.md") + "\nMy own line.\n")
        self.assertFalse(self.capture("Fri", "- 09:30 second")["created"])
        self.capture("Sat", "- 08:00 weekend")
        text = self.env.read("Today.md")
        self.assertTrue(text.startswith("# Today\n\n## Sat\n- 08:00 weekend\n\n## Fri\n- 09:00 first\n"))
        self.assertIn("My own line.", text)
        self.assertIn("- 09:30 second", text)

    def test_heading_is_required_and_paths_are_checked(self):
        self.assertEqual(self.env.client.post("/api/notes/capture", json={"path": "Today.md", "line": "x"}).status_code, 400)
        self.assertEqual(self.env.client.post("/api/notes/capture", json={"path": "../x.md", "heading": "h", "line": "x"}).status_code, 400)


if __name__ == "__main__":
    unittest.main()
