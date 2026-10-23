"""Note chunking and the LanceDB index (vectors are faked; the real ones come from the browser)."""
import hashlib
import math
import unittest

from keystone_worklog import vector_index as vi
from helpers import Env, sample_data


def fake_vector(text):
    """Bag-of-words hashed into 384 dims, normalised: similar words → similar vectors."""
    v = [0.0] * vi.DIM
    for w in text.lower().split():
        v[int(hashlib.md5(w.strip(".,#*").encode()).hexdigest(), 16) % vi.DIM] += 1
    n = math.sqrt(sum(x * x for x in v)) or 1
    return [x / n for x in v]


class ChunkingTest(unittest.TestCase):
    def test_headings_comments_and_long_paragraphs(self):
        text = "%% hidden %%\n<!-- c -->\n# Title\nIntro\n\n## Part A\n" + ("word " * 400) + "\n\n```\n## not a heading\n```\n"
        chunks = vi.chunk_markdown(text, "Note")
        self.assertTrue(all(len(c["text"]) <= vi.MAX_CHARS for c in chunks))
        self.assertEqual(chunks[0]["heading"], "Title")
        self.assertTrue(any(c["heading"] == "Part A" for c in chunks))
        self.assertFalse(any("hidden" in c["text"] or "<!--" in c["text"] for c in chunks))
        self.assertTrue(chunks[1]["embed"].startswith("Note › Part A\n"))

    def test_empty_note_is_still_indexed_by_title(self):
        self.assertEqual(vi.chunk_markdown("", "Empty"), [{"heading": "", "text": "", "embed": "Empty"}])


@unittest.skipUnless(vi.available, "LanceDB is not installed")
class IndexTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.env.put_data(sample_data(self.env.vault))
        self.env.write("Work/County meeting.md", "# County meeting\nThey want the drainage memo early because of the storm season.\n")
        self.env.write("Ideas/Recipes.md", "# Recipes\nPasta with garlic and olive oil.\n")
        self.c = self.env.client

    def tearDown(self):
        self.env.close()

    def index_all(self, model="m1"):
        n = 0
        while True:
            j = self.c.post("/api/index/next", json={"model": model, "limit": 3}).get_json()
            if not j["files"]:
                return n
            for f in j["files"]:
                self.assertIsInstance(f["mtime"], str)  # ns timestamps don't fit in JS numbers
                chunks = [{**c, "vector": fake_vector(c["embed"])} for c in f["chunks"]]
                self.assertEqual(self.c.post("/api/index/upsert", json={"model": model, "path": f["path"], "mtime": f["mtime"], "chunks": chunks}).status_code, 200)
                n += 1

    def test_index_search_and_staleness(self):
        total = self.c.get("/api/index/status?model=m1").get_json()["total"]
        self.assertEqual(self.index_all(), total)
        self.assertEqual(self.c.get("/api/index/status?model=m1").get_json()["stale"], 0)
        r = self.env.tool("search_notes", {"query": "zzz", "limit": 2}, vector=fake_vector("drainage memo storm season"))["result"]
        self.assertIn("[[County meeting]]", r.splitlines()[0])
        self.assertIn("(meaning)", r.splitlines()[0])
        self.env.write("Ideas/Recipes.md", "# Recipes\nchanged\n")
        self.assertEqual(self.c.get("/api/index/status?model=m1").get_json()["stale"], 1)
        self.assertEqual(self.c.get("/api/index/status?model=m2").get_json()["indexed"], 0)  # a new model starts over

    def test_wrong_vector_size_is_refused(self):
        r = self.c.post("/api/index/upsert", json={"model": "m1", "path": "Ideas/Recipes.md", "mtime": "1", "chunks": [{"text": "x", "vector": [0.1, 0.2]}]})
        self.assertEqual(r.status_code, 400)


if __name__ == "__main__":
    unittest.main()
