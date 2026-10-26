"""MS Project XML (MSPDI): import, export, round trip without losing anything, and the plans API."""
import base64
import json
import os
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest import mock

from helpers import Env  # first: puts this checkout on sys.path
from keystone_worklog import msproject as msp

SAMPLE = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <SaveVersion>14</SaveVersion>
  <Name>Girder.xml</Name>
  <Title>Girder Bridge rehab</Title>
  <Author>Hiren</Author>
  <ScheduleFromStart>1</ScheduleFromStart>
  <StartDate>2026-10-19T08:00:00</StartDate>
  <FinishDate>2026-11-06T17:00:00</FinishDate>
  <CalendarUID>1</CalendarUID>
  <MinutesPerDay>480</MinutesPerDay>
  <MinutesPerWeek>2400</MinutesPerWeek>
  <DaysPerMonth>20</DaysPerMonth>
  <StatusDate>2026-10-23T17:00:00</StatusDate>
  <CurrencySymbol>$</CurrencySymbol>
  <ExtendedAttributes>
    <ExtendedAttribute><FieldID>188743731</FieldID><FieldName>Text1</FieldName><Alias>Discipline</Alias></ExtendedAttribute>
  </ExtendedAttributes>
  <Calendars>
    <Calendar>
      <UID>1</UID><Name>Standard</Name><IsBaseCalendar>1</IsBaseCalendar><BaseCalendarUID>-1</BaseCalendarUID>
      <WeekDays>
        <WeekDay><DayType>1</DayType><DayWorking>0</DayWorking></WeekDay>
        <WeekDay><DayType>2</DayType><DayWorking>1</DayWorking><WorkingTimes>
          <WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime>
          <WorkingTime><FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>
        <WeekDay><DayType>3</DayType><DayWorking>1</DayWorking><WorkingTimes>
          <WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime>
          <WorkingTime><FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>
        <WeekDay><DayType>4</DayType><DayWorking>1</DayWorking><WorkingTimes>
          <WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime>
          <WorkingTime><FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>
        <WeekDay><DayType>5</DayType><DayWorking>1</DayWorking><WorkingTimes>
          <WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime>
          <WorkingTime><FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>
        <WeekDay><DayType>6</DayType><DayWorking>1</DayWorking><WorkingTimes>
          <WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime>
          <WorkingTime><FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>
        <WeekDay><DayType>7</DayType><DayWorking>0</DayWorking></WeekDay>
        <WeekDay><DayType>0</DayType><DayWorking>0</DayWorking>
          <TimePeriod><FromDate>2026-11-11T00:00:00</FromDate><ToDate>2026-11-11T23:59:00</ToDate></TimePeriod></WeekDay>
      </WeekDays>
      <Exceptions><Exception><EnteredByOccurrences>0</EnteredByOccurrences>
        <TimePeriod><FromDate>2026-11-26T00:00:00</FromDate><ToDate>2026-11-27T23:59:00</ToDate></TimePeriod>
        <Name>Thanksgiving</Name><Type>1</Type><DayWorking>0</DayWorking></Exception></Exceptions>
    </Calendar>
  </Calendars>
  <Tasks>
    <Task><UID>0</UID><ID>0</ID><Name>Girder Bridge rehab</Name><OutlineLevel>0</OutlineLevel><Summary>1</Summary></Task>
    <Task><UID>1</UID><ID>1</ID><Name>Design</Name><OutlineNumber>1</OutlineNumber><OutlineLevel>1</OutlineLevel>
      <Start>2026-10-19T08:00:00</Start><Finish>2026-10-23T17:00:00</Finish><Duration>PT40H0M0S</Duration><DurationFormat>7</DurationFormat>
      <Summary>1</Summary><Critical>1</Critical><FixedCostAccrual>3</FixedCostAccrual></Task>
    <Task><UID>2</UID><ID>2</ID><Name>Bearing calcs</Name><OutlineNumber>1.1</OutlineNumber><OutlineLevel>2</OutlineLevel><Priority>700</Priority>
      <Start>2026-10-19T08:00:00</Start><Finish>2026-10-21T17:00:00</Finish><Duration>PT24H0M0S</Duration><DurationFormat>7</DurationFormat>
      <Milestone>0</Milestone><Summary>0</Summary><PercentComplete>50</PercentComplete><ActualStart>2026-10-19T08:00:00</ActualStart>
      <ConstraintType>0</ConstraintType><Hyperlink>Spec</Hyperlink><HyperlinkAddress>specs/girder.pdf</HyperlinkAddress>
      <Notes>Pier 3 first</Notes>
      <ExtendedAttribute><FieldID>188743731</FieldID><Value>Structures</Value></ExtendedAttribute>
      <Baseline><Number>0</Number><Start>2026-10-19T08:00:00</Start><Finish>2026-10-21T17:00:00</Finish><Duration>PT24H0M0S</Duration><Work>PT24H0M0S</Work></Baseline>
    </Task>
    <Task><UID>3</UID><ID>3</ID><Name>Bearing drawings</Name><OutlineNumber>1.2</OutlineNumber><OutlineLevel>2</OutlineLevel>
      <Start>2026-10-23T08:00:00</Start><Finish>2026-10-23T17:00:00</Finish><Duration>PT8H0M0S</Duration><DurationFormat>39</DurationFormat>
      <ConstraintType>4</ConstraintType><ConstraintDate>2026-10-22T08:00:00</ConstraintDate><Deadline>2026-10-30T17:00:00</Deadline>
      <PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type><CrossProject>0</CrossProject><LinkLag>4800</LinkLag><LagFormat>7</LagFormat></PredecessorLink>
    </Task>
    <Task><UID>4</UID><ID>4</ID><Name>Submit 60%</Name><OutlineNumber>2</OutlineNumber><OutlineLevel>1</OutlineLevel>
      <Start>2026-10-23T17:00:00</Start><Finish>2026-10-23T17:00:00</Finish><Duration>PT0H0M0S</Duration><DurationFormat>7</DurationFormat><Milestone>1</Milestone>
      <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type><CrossProject>0</CrossProject><LinkLag>0</LinkLag><LagFormat>7</LagFormat></PredecessorLink>
      <PredecessorLink><PredecessorUID>3</PredecessorUID><Type>3</Type><CrossProject>0</CrossProject><LinkLag>250</LinkLag><LagFormat>19</LagFormat></PredecessorLink>
      <PredecessorLink><PredecessorUID>9</PredecessorUID><Type>1</Type><CrossProject>1</CrossProject><CrossProjectName>Other.mpp\\9</CrossProjectName><LinkLag>0</LinkLag><LagFormat>7</LagFormat></PredecessorLink>
    </Task>
  </Tasks>
  <Resources>
    <Resource><UID>0</UID><ID>0</ID><IsNull>0</IsNull><MaxUnits>1.00</MaxUnits></Resource>
    <Resource><UID>1</UID><ID>1</ID><Name>Hiren</Name><Type>1</Type><Initials>HP</Initials><Group>Structures</Group><MaxUnits>1.00</MaxUnits><StandardRate>0</StandardRate></Resource>
    <Resource><UID>2</UID><ID>2</ID><Name>Maria Lopez</Name><Type>1</Type><Initials>ML</Initials><MaxUnits>0.50</MaxUnits></Resource>
  </Resources>
  <Assignments>
    <Assignment><UID>1</UID><TaskUID>2</TaskUID><ResourceUID>1</ResourceUID><Units>1</Units><Work>PT24H0M0S</Work><WorkContour>0</WorkContour></Assignment>
    <Assignment><UID>2</UID><TaskUID>3</TaskUID><ResourceUID>2</ResourceUID><Units>0.5</Units><Work>PT4H0M0S</Work></Assignment>
    <Assignment><UID>3</UID><TaskUID>4</TaskUID><ResourceUID>-65535</ResourceUID><Units>1</Units><Work>PT0H0M0S</Work></Assignment>
  </Assignments>
</Project>
"""


def tasks_by_uid(plan):
    return {t["uid"]: t for t in plan["tasks"]}


class MSPDITest(unittest.TestCase):
    def test_import(self):
        plan, warnings, stats = msp.parse_mspdi(SAMPLE)
        self.assertEqual(plan["name"], "Girder Bridge rehab")
        self.assertEqual((plan["start"], plan["statusDate"]), ("2026-10-19T08:00", "2026-10-23T17:00"))
        self.assertEqual(stats, {"tasks": 4, "summaries": 1, "milestones": 1, "links": 3, "resources": 2, "assignments": 2,
                                 "calendars": 1, "baselines": 1, "customFields": 1})
        cal = plan["calendar"]
        self.assertEqual(cal["week"][1], [[480, 720], [780, 1020]])
        self.assertEqual(cal["week"][0], [])
        self.assertEqual((cal["exceptions"]["2026-11-11"], cal["exceptions"]["2026-11-27"]), ([], []))
        t = tasks_by_uid(plan)
        self.assertEqual(t[2]["parentUid"], 1)
        self.assertEqual(t[4]["parentUid"], None)
        self.assertEqual(t[2]["duration"], {"minutes": 1440, "format": "d", "estimated": False})
        self.assertEqual(t[3]["duration"], {"minutes": 480, "format": "d", "estimated": True})  # 39 = estimated days
        self.assertEqual(t[3]["constraint"], {"type": "SNET", "date": "2026-10-22T08:00"})
        self.assertEqual(t[3]["links"], [{"pred": 2, "type": "FS", "lag": {"minutes": 480, "format": "d"}}])  # 4800 tenths of a minute
        self.assertEqual(t[4]["links"][1], {"pred": 3, "type": "SS", "lag": {"minutes": 25.0, "format": "%"}})
        self.assertEqual(len(t[4]["links"]), 2)  # the cross-project link isn't scheduled…
        self.assertTrue(any("another project" in w for w in warnings))  # …and is reported
        self.assertEqual((t[2]["percent"], t[2]["priority"], t[2]["notes"]), (50, 700, "Pier 3 first"))
        self.assertEqual(t[2]["custom"], {"Discipline": "Structures"})
        self.assertEqual(t[2]["baselines"]["0"]["finish"], "2026-10-21T17:00")
        self.assertTrue(t[4]["milestone"])
        self.assertEqual([r["name"] for r in plan["resources"]], ["Hiren", "Maria Lopez"])
        self.assertEqual(plan["resources"][1]["maxUnits"], 0.5)
        self.assertEqual([(a["taskUid"], a["resourceUid"], a["units"]) for a in plan["assignments"]], [(2, 1, 1.0), (3, 2, 0.5)])

    def test_round_trip_keeps_everything(self):
        plan, _, _ = msp.parse_mspdi(SAMPLE)
        xml = msp.to_mspdi(plan)
        again, _, stats = msp.parse_mspdi(xml)
        a, b = tasks_by_uid(plan), tasks_by_uid(again)
        for uid in a:
            for key in ("name", "parentUid", "duration", "start", "finish", "constraint", "deadline", "links", "percent", "baselines", "custom", "milestone", "notes"):
                self.assertEqual(a[uid][key], b[uid][key], f"task {uid} {key}")
        self.assertEqual(plan["calendar"], again["calendar"])
        root = msp._strip_ns(ET.fromstring(xml))
        task2 = [t for t in root.findall("Tasks/Task") if msp._t(t, "UID") == "2"][0]
        self.assertEqual(msp._t(task2, "HyperlinkAddress"), "specs/girder.pdf")  # elements Keystone doesn't use survive
        self.assertEqual(msp._t(root, "Author"), "Hiren")
        self.assertEqual(msp._t(root, "CurrencySymbol"), "$")
        task4 = [t for t in root.findall("Tasks/Task") if msp._t(t, "UID") == "4"][0]
        self.assertEqual(len(task4.findall("PredecessorLink")), 3)  # the cross-project link is written back too
        self.assertTrue(xml.startswith('<?xml'))
        self.assertIn('xmlns="http://schemas.microsoft.com/project"', xml)

    def test_edits_are_written_in_schema_order(self):
        plan, _, _ = msp.parse_mspdi(SAMPLE)
        t = tasks_by_uid(plan)
        t[2]["deadline"] = "2026-10-28T17:00"
        t[2]["name"] = "Bearing calcs (rev)"
        t[2]["duration"] = {"minutes": 1920, "format": "d", "estimated": False}
        root = msp._strip_ns(ET.fromstring(msp.to_mspdi(plan)))
        task2 = [x for x in root.findall("Tasks/Task") if msp._t(x, "UID") == "2"][0]
        tags = [c.tag for c in task2]
        order = [msp.TASK_ORDER.index(x) for x in tags]
        self.assertEqual(order, sorted(order), tags)  # every element in the order the MSPDI schema requires
        self.assertEqual((msp._t(task2, "Deadline"), msp._t(task2, "Duration")), ("2026-10-28T17:00:00", "PT32H0M0S"))

    def test_a_plan_made_in_keystone_exports_cleanly(self):
        plan = {"name": "New plan", "start": "2026-11-02T08:00", "units": {"minutesPerDay": 480, "minutesPerWeek": 2400, "daysPerMonth": 20},
                "calendar": {"name": "Keystone schedule", "week": [[], [[480, 720], [780, 1080]]] + [[[480, 720], [780, 1080]]] * 3 + [[[480, 720], [780, 1020]], []],
                             "exceptions": {"2026-11-11": []}},
                "tasks": [{"uid": 1, "name": "Phase", "parentUid": None, "duration": {"minutes": 0, "format": "d"}},
                          {"uid": 2, "name": "Survey", "parentUid": 1, "duration": {"minutes": 960, "format": "d"}, "start": "2026-11-02T08:00", "finish": "2026-11-03T17:00"},
                          {"uid": 3, "name": "Report", "parentUid": 1, "duration": {"minutes": 480, "format": "d"}, "links": [{"pred": 2, "type": "FS", "lag": {"minutes": -480, "format": "d"}}]}],
                "resources": [{"uid": 1, "name": "Hiren", "maxUnits": 1.0}], "assignments": [{"taskUid": 2, "resourceUid": 1, "units": 1.0}]}
        xml = msp.to_mspdi(plan)
        back, _, stats = msp.parse_mspdi(xml)
        self.assertEqual(stats["tasks"], 3)
        t = tasks_by_uid(back)
        self.assertEqual(t[3]["links"][0]["lag"], {"minutes": -480, "format": "d"})
        self.assertEqual(t[2]["parentUid"], 1)
        self.assertEqual(back["calendar"]["week"][1], [[480, 720], [780, 1080]])  # 9-hour days
        self.assertEqual(back["calendar"]["exceptions"]["2026-11-11"], [])
        self.assertEqual(back["assignments"][0]["workMinutes"], 960)
        root = msp._strip_ns(ET.fromstring(xml))
        order = [msp.PROJECT_ORDER.index(c.tag) for c in root]
        self.assertEqual(order, sorted(order), [c.tag for c in root])

    def test_durations_and_bad_files(self):
        self.assertEqual(msp.parse_duration("PT40H0M0S"), 2400)
        self.assertEqual(msp.parse_duration("P1DT2H30M0S"), 1590)
        self.assertEqual(msp.parse_duration("-PT8H0M0S"), -480)
        self.assertEqual(msp.format_duration(1590), "PT26H30M0S")
        with self.assertRaises(msp.MSProjectError):
            msp.parse_mspdi("<html></html>")
        with self.assertRaises(msp.MSProjectError):
            msp.parse_mspdi("not xml at all")
        with mock.patch.object(msp, "mpxj_available", return_value=None), self.assertRaisesRegex(msp.MSProjectError, "Save As → XML"):
            msp.read_upload("plan.mpp", base64.b64encode(b"\xd0\xcf\x11\xe0binary").decode())

    @unittest.skipIf(os.name == "nt", "the stand-in java is a shell script")
    def test_mpp_through_mpxj(self):
        """.mpp goes through MPXJ's converter: the new class name (org.mpxj) first, then the old one (net.sf.mpxj)."""
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "lib").mkdir()
            (d / "lib" / "mpxj.jar").write_bytes(b"")
            java, calls = d / "java", d / "calls.txt"
            # an old MPXJ: only net.sf.mpxj exists; it "converts" by writing the sample XML
            java.write_text(f"#!/bin/sh\necho \"$3\" >> '{calls}'\n"
                            f"case \"$3\" in net.sf.*) cp '{d / 'sample.xml'}' \"$5\";; *) echo 'Error: Could not find or load main class' >&2; exit 1;; esac\n")
            java.chmod(0o755)
            (d / "sample.xml").write_text(SAMPLE, encoding="utf-8")
            with mock.patch.dict(os.environ, {"KEYSTONE_MPXJ": str(d / "lib"), "JAVA_HOME": ""}), mock.patch.object(msp.shutil, "which", return_value=str(java)):
                plan, _, stats = msp.read_upload("plan.mpp", base64.b64encode(b"\xd0\xcf\x11\xe0binary").decode())
            self.assertEqual(plan["name"], "Girder Bridge rehab")
            self.assertEqual(calls.read_text().split(), list(msp.CONVERT_CLASSES))


class PlansAPITest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.c = self.env.client

    def tearDown(self):
        self.env.close()

    def test_import_create_save_export_delete(self):
        r = self.c.post("/api/plans/import", json={"filename": "girder.xml", "data": base64.b64encode(SAMPLE.encode()).decode()}).get_json()
        self.assertEqual(r["stats"]["tasks"], 4)
        plan = self.c.post("/api/plans", json={"plan": {**r["plan"], "projectId": "bridge"}}).get_json()
        pid = plan["id"]
        self.assertRegex(pid, r"^p_[a-f0-9]{8}$")
        self.assertEqual(plan["rev"], 1)
        self.assertEqual(self.c.get("/api/plans").get_json()["plans"][0]["tasks"], 4)
        plan["tasks"][0]["name"] = "Design phase"
        s = self.c.put(f"/api/plans/{pid}", json={"plan": plan, "baseRev": 1}).get_json()
        self.assertEqual(s["rev"], 2)
        stale = self.c.put(f"/api/plans/{pid}", json={"plan": plan, "baseRev": 1})  # another tab still on rev 1
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.get_json()["plan"]["tasks"][0]["name"], "Design phase")
        self.c.post("/api/plans", json={"plan": {"name": "Bridge template", "template": True, "tasks": []}})
        listed = self.c.get("/api/plans").get_json()["plans"]  # the .bak.json kept by the save isn't a second plan
        self.assertEqual(sorted((p["name"], p["template"]) for p in listed), [("Bridge template", True), ("Girder Bridge rehab", False)])
        x = self.c.get(f"/api/plans/{pid}/export.xml")
        self.assertIn('attachment; filename="Girder Bridge rehab.xml"', x.headers["Content-Disposition"])
        self.assertIn(b"<Name>Design phase</Name>", x.data)
        self.assertEqual(self.c.post(f"/api/plans/{pid}/delete", json={}).status_code, 200)
        self.assertEqual(self.c.get(f"/api/plans/{pid}").status_code, 404)
        self.assertEqual(len(list((self.env.data / "plans" / ".trash").glob("*.json"))), 1)  # moved, never deleted

    def test_bad_plans_and_ids_are_refused(self):
        self.assertEqual(self.c.post("/api/plans", json={"plan": {"tasks": [{"uid": 1}, {"uid": 1}]}}).status_code, 400)
        self.assertEqual(self.c.get("/api/plans/../../etc").status_code, 404)
        self.assertEqual(self.c.get("/api/plans/p_nothere1").status_code, 400)
        r = self.c.post("/api/plans/import", json={"filename": "plan.mpp", "data": base64.b64encode(b"\xd0\xcf").decode()})
        self.assertEqual(r.status_code, 400)
        self.assertIn("Save As", r.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
