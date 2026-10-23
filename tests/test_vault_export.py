"""Obsidian export: generated notes, the user's own text, ticks flowing back, project renames."""
import unittest

from helpers import Env, sample_data


class VaultExportTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.data = sample_data(self.env.vault)
        self.env.put_data(self.data)

    def tearDown(self):
        self.env.close()

    def test_writes_the_tracker_notes(self):
        v = self.env.vault / "Keystone"
        for rel in ["Keystone.md", "Leave balances.md", "Deliverables board.md", "Follow-ups.md", "Projects/Bridge rehab.md", "Projects/Runway lighting.md"]:
            self.assertTrue((v / rel).exists(), rel)
        self.assertTrue(list((v / "Timesheets").glob("Timesheet *.md")))
        note = self.env.read("Keystone/Projects/Bridge rehab.md")
        self.assertIn("network:: 4001234", note)
        self.assertIn("- [x] 30% submittal 📅 2026-03-01 ^dl-d1", note)
        self.assertIn("- [ ] 60% submittal · In progress 📅 2026-04-01 ^dl-d2", note)
        self.assertIn("Site visit — Maria · [[Bridge rehab]]", self.env.read("Keystone/Follow-ups.md"))

    def test_text_outside_the_generated_block_is_kept(self):
        rel = "Keystone/Projects/Bridge rehab.md"
        self.env.write(rel, self.env.read(rel) + "My own meeting notes.\n")
        self.data["projects"][0]["budget"] = "250"
        self.env.put_data(self.data)
        note = self.env.read(rel)
        self.assertIn("budget-hours:: 250", note)
        self.assertIn("My own meeting notes.", note)

    def test_ticks_and_new_tasks_flow_back_from_obsidian(self):
        rel = "Keystone/Projects/Bridge rehab.md"
        note = self.env.read(rel).replace("- [ ] 60% submittal", "- [x] 60% submittal")
        note = note.replace("^dl-d2\n", "^dl-d2\n- [ ] Write QA plan 📅 2026-05-01\n")
        self.env.write(rel, note)
        data = self.env.get_data()  # every load syncs from the vault first
        by_title = {d["title"]: d for d in data["deliverables"]}
        self.assertEqual(by_title["60% submittal"]["status"], "done")
        self.assertEqual(by_title["Write QA plan"]["due"], "2026-05-01")
        self.assertEqual(by_title["Write QA plan"]["projectId"], "a")

    def test_renaming_a_project_moves_its_note_with_the_users_text(self):
        rel = "Keystone/Projects/Bridge rehab.md"
        self.env.write(rel, self.env.read(rel) + "Keep this.\n")
        self.data["projects"][0]["name"] = "Bridge rehab – final"
        self.env.put_data(self.data)
        self.assertFalse((self.env.vault / rel).exists())
        self.assertIn("Keep this.", self.env.read("Keystone/Projects/Bridge rehab – final.md"))


if __name__ == "__main__":
    unittest.main()
