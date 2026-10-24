"""Plain-text files in the vault: Abaqus job files, big solver output, Python, notebooks, any other text; and the per-file index status."""
import json
import unittest
from unittest import mock

from helpers import Env, sample_data  # first: puts this checkout on sys.path
from keystone_worklog import documents as docs
from keystone_worklog import vector_index as vi
from test_vector_index import fake_vector

ABAQUS_MSG = """ Abaqus 2023
 STEP 1 INCREMENT 1
 ***WARNING: 12 NODES ARE MISSING DEGREE OF FREEDOM CONSTRAINTS
 ***WARNING: 12 NODES ARE MISSING DEGREE OF FREEDOM CONSTRAINTS
 ***WARNING: 12 NODES ARE MISSING DEGREE OF FREEDOM CONSTRAINTS
       CONVERGENCE CHECKS FOR EQUILIBRIUM ITERATION   1
 ***ERROR: TOO MANY ATTEMPTS MADE FOR THIS INCREMENT
 THE ANALYSIS HAS NOT BEEN COMPLETED
"""
ABAQUS_STA = """ SUMMARY OF JOB INFORMATION:
 STEP  INC ATT SEVERE EQUIL TOTAL  TOTAL      STEP       INC OF
   1     1   1     0     3     3  0.100      0.100      0.1000
   1     2   1     0     2     2  0.250      0.250      0.1500
 THE ANALYSIS HAS COMPLETED SUCCESSFULLY
"""
PY = (
    '"""Load cases for the girder model."""\n'
    "import math\n"
    "\n"
    "\n"
    "def dead_load(span, w):\n"
    "    return w * span ** 2 / 8\n"
    "\n"
    "\n"
    "class LoadCase:\n"
    "    def __init__(self, name):\n"
    "        self.name = name\n"
)


class PlainTextTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.v = self.env.vault

    def tearDown(self):
        docs.ALL_TEXT = True
        self.env.close()

    def put(self, rel, data):
        p = self.v / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(data, bytes):
            p.write_bytes(data)
        else:
            p.write_text(data, encoding="utf-8")
        return p

    def test_abaqus_message_and_status_files(self):
        s = docs.extract(self.put("Jobs/girder.msg", ABAQUS_MSG))
        self.assertEqual(s[0]["heading"], "Errors, warnings and status")
        self.assertIn("***WARNING: 12 NODES ARE MISSING DEGREE OF FREEDOM CONSTRAINTS  (×3)", s[0]["text"])
        self.assertIn("THE ANALYSIS HAS NOT BEEN COMPLETED", s[0]["text"])
        sta = docs.extract(self.put("Jobs/girder.sta", ABAQUS_STA))
        self.assertIn("COMPLETED SUCCESSFULLY", sta[0]["text"])
        self.assertIn("   1     2   1     0     2     2  0.250", sta[1]["text"])  # columns kept
        self.assertEqual(docs.kind("girder.sta"), "Status file")
        self.assertEqual(docs.doc_kind(self.v / "Jobs/girder.msg"), "Message file")

    def test_binary_files_with_text_extensions_are_skipped(self):
        self.put("Jobs/girder.dat", b"\x00\x01\x02binary results" * 50)
        self.put("Mail/outlook.msg", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 600)
        self.put("Jobs/girder.odb", b"text-looking but an odb")
        found = docs.vault_documents(self.v)
        self.assertNotIn("Jobs/girder.dat", found)
        self.assertNotIn("Jobs/girder.odb", found)
        self.assertNotIn("Mail/outlook.msg", found)
        self.assertTrue(docs.listable(self.v / "Mail/outlook.msg"))  # still shown in the tree, opened in Outlook
        with self.assertRaisesRegex(docs.DocError, "Outlook .msg"):
            docs.extract(self.v / "Mail/outlook.msg")

    def test_big_output_file_keeps_start_end_and_every_warning(self):
        block = (" ***WARNING: SOLVER PROBLEM. NUMERICAL SINGULARITY\n" + "  1.0  2.0  3.0\n" * 400
                 + " ***ERROR: TIME INCREMENT REQUIRED IS LESS THAN THE MINIMUM SPECIFIED\n")
        p = self.put("Jobs/big.dat", " HEADER LINE\n" + block * 3 + " FINAL LINE\n")
        with mock.patch.multiple(docs, SMALL_LOG=1000, LOG_HEAD=500, LOG_TAIL=300):
            s = docs.extract(p)
        self.assertEqual([x["heading"].split(" (")[0] for x in s], ["Errors, warnings and status", "Start of file", "End of file"])
        self.assertIn("NUMERICAL SINGULARITY  (×3)", s[0]["text"])
        self.assertIn("LESS THAN THE MINIMUM SPECIFIED  (×3)", s[0]["text"])
        self.assertIn("HEADER LINE", s[1]["text"])
        self.assertIn("FINAL LINE", s[2]["text"])
        self.assertIn("was only scanned for errors and warnings", s[2]["heading"])
        self.assertLess(sum(len(x["text"]) for x in s), 2000)

    def test_big_input_deck_keeps_its_keywords(self):
        nodes = "".join(f"{i}, {i}.0, 0., 0.\n" for i in range(1, 3000))
        p = self.put("Jobs/girder.inp", "*Heading\n** Girder FE model\n*Node\n" + nodes + "*Material, name=Steel\n*Element, type=C3D8R\n*Step, nlgeom=YES\n")
        with mock.patch.multiple(docs, SMALL_TEXT=1000, HEAD=300, TAIL=200):
            s = docs.extract(p)
        kw = next(x for x in s if x["heading"] == "Model keywords")["text"]
        self.assertIn("*Material, name=Steel", kw)
        self.assertIn("*Element, type=C3D8R", kw)
        self.assertNotIn("1500,", kw)

    def test_python_files_split_by_function(self):
        s = docs.extract(self.put("Scripts/loads.py", PY))
        self.assertEqual([x["heading"] for x in s], ["Module code", "def dead_load (line 5)", "class LoadCase (line 9)"])
        self.assertIn("    return w * span ** 2 / 8", s[1]["text"])  # indentation kept

    def test_jupyter_notebook_cells_and_outputs(self):
        nb = {"nbformat": 4, "cells": [
            {"cell_type": "markdown", "source": ["# Scour check\n", "Pier 3"]},
            {"cell_type": "code", "source": "depth = 4.2\nprint(depth)", "outputs": [{"output_type": "stream", "text": ["4.2\n"]}]},
            {"cell_type": "code", "source": "1/0", "outputs": [{"output_type": "error", "ename": "ZeroDivisionError", "evalue": "division by zero"}]}]}
        s = docs.extract(self.put("Scripts/scour.ipynb", json.dumps(nb)))
        self.assertEqual([x["heading"] for x in s], ["Cell 1 · markdown", "Cell 2 · code", "Cell 3 · code"])
        self.assertIn("Output:\n4.2", s[1]["text"])
        self.assertIn("ZeroDivisionError: division by zero", s[2]["text"])

    def test_any_other_text_file_unless_turned_off(self):
        self.put("Notes/README", "Project readme without an extension\n")
        self.put("Jobs/run.023", "never sniffed\n")
        self.put("data/coords.xyz", "1.0 2.0 3.0\n")
        self.put("Scripts/loads.py", PY)
        self.assertEqual(set(docs.vault_documents(self.v)), {"Notes/README", "data/coords.xyz", "Scripts/loads.py"})
        docs.ALL_TEXT = False  # known text types (.py, .inp, .msg…) stay; unknown extensions are no longer sniffed
        self.assertEqual(set(docs.vault_documents(self.v)), {"Scripts/loads.py"})

    @unittest.skipUnless(vi.available, "LanceDB is not installed")
    def test_index_file_list(self):
        self.env.put_data(sample_data(self.v))
        self.env.write("Work/a.md", "# A\nnote\n")
        self.put("Jobs/girder.msg", ABAQUS_MSG)
        self.put("Jobs/girder.dat", b"\x00binary")
        c = self.env.client
        j = c.get("/api/index/files?model=m1").get_json()
        rows = {f["path"]: f["state"] for f in j["files"]}
        self.assertEqual((rows["Work/a.md"], rows["Jobs/girder.msg"]), ("waiting", "waiting"))
        self.assertNotIn("Jobs/girder.dat", rows)
        while True:
            files = c.post("/api/index/next", json={"model": "m1", "limit": 8}).get_json()["files"]
            if not files:
                break
            for f in files:
                c.post("/api/index/upsert", json={"model": "m1", "path": f["path"], "mtime": f["mtime"],
                                                  "chunks": [{**x, "vector": fake_vector(x["embed"])} for x in f["chunks"]]})
        j = c.get("/api/index/files?model=m1").get_json()
        rows = {f["path"]: f for f in j["files"]}
        self.assertEqual(j["counts"]["indexed"], j["total"])
        self.assertGreater(rows["Jobs/girder.msg"]["chunks"], 0)
        self.assertIsInstance(rows["Work/a.md"]["at"], int)
        self.assertEqual(rows["Jobs/girder.msg"]["kind"], "Message file")
        self.env.write("Work/a.md", "# A\nchanged\n")
        self.assertEqual(c.get("/api/index/files?model=m1").get_json()["counts"]["changed"], 1)
        r = self.env.tool("search_notes", {"query": "too many attempts increment"})["result"]
        self.assertIn("[[girder.msg]] — Jobs/girder.msg", r.splitlines()[0])
        self.assertIn("(Message file;", r.splitlines()[0])

    def test_plain_text_setting(self):
        c = self.env.client
        self.assertTrue(c.get("/api/assistant/settings").get_json()["plainText"])
        c.put("/api/assistant/settings", json={"plainText": False})
        self.assertFalse(c.get("/api/assistant/settings").get_json()["plainText"])


if __name__ == "__main__":
    unittest.main()
