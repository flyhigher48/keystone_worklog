"""Microsoft Project files: read and write MS Project XML (MSPDI), the format MS Project opens and saves directly
(File → Open / Save As → XML). `.mpp` can be read through MPXJ (Java), when it's installed.

Round trip: every element Keystone doesn't model is kept – each task, resource, assignment and calendar keeps
its original XML, and export writes it back with only the values Keystone manages updated. New elements are
inserted in the order the MSPDI schema requires, so MS Project reads the file without complaint.
"""
import base64
import importlib.util
import os
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from pathlib import Path

NS = "http://schemas.microsoft.com/project"
Q = lambda tag: f"{{{NS}}}{tag}"  # noqa: E731

DURATION_FORMATS = {3: ("m", False), 4: ("em", False), 5: ("h", False), 6: ("eh", False), 7: ("d", False), 8: ("ed", False),
                    9: ("w", False), 10: ("ew", False), 11: ("mo", False), 12: ("emo", False), 19: ("%", False), 20: ("e%", False),
                    35: ("m", True), 36: ("em", True), 37: ("h", True), 38: ("eh", True), 39: ("d", True), 40: ("ed", True),
                    41: ("w", True), 42: ("ew", True), 43: ("mo", True), 44: ("emo", True), 51: ("%", True), 52: ("e%", True)}
FORMAT_CODES = {(f, est): code for code, (f, est) in DURATION_FORMATS.items()}
CONSTRAINTS = ["ASAP", "ALAP", "MSO", "MFO", "SNET", "SNLT", "FNET", "FNLT"]
LINK_TYPES = ["FF", "FS", "SF", "SS"]

# element order within each MSPDI element (xsd:sequence) – used to insert elements Keystone adds
PROJECT_ORDER = """SaveVersion BuildNumber Name GUID Title Subject Category Company Manager Author CreationDate Revision LastSaved
ScheduleFromStart StartDate FinishDate FYStartDate CriticalSlackLimit CurrencyDigits CurrencySymbol CurrencyCode CurrencySymbolPosition
CalendarUID DefaultStartTime DefaultFinishTime MinutesPerDay MinutesPerWeek DaysPerMonth DefaultTaskType DefaultFixedCostAccrual
DefaultStandardRate DefaultOvertimeRate DurationFormat WorkFormat EditableActualCosts HonorConstraints EarnedValueMethod
InsertedProjectsLikeSummary MultipleCriticalPaths NewTasksEffortDriven NewTasksEstimated SplitsInProgressTasks SpreadActualCost
SpreadPercentComplete TaskUpdatesResource FiscalYearStart WeekStartDay MoveCompletedEndsBack MoveRemainingStartsBack
MoveRemainingStartsForward MoveCompletedEndsForward BaselineForEarnedValue AutoAddNewResourcesAndTasks StatusDate CurrentDate
MicrosoftProjectServerURL Autolink NewTaskStartDate NewTasksAreManual DefaultTaskEVMethod ProjectExternallyEdited
ExtendedCreationDate ActualsInSync RemoveFileProperties AdminProject UpdateManuallyScheduledTasksWhenEditingLinks
KeepTaskOnNearestWorkingTimeWhenMadeAutoScheduled OutlineCodes WBSMasks ExtendedAttributes Calendars Tasks Resources Assignments""".split()
TASK_ORDER = """UID GUID ID Name Active Manual Type IsNull CreateDate Contact WBS WBSLevel OutlineNumber OutlineLevel Priority Start Finish
Duration ManualStart ManualFinish ManualDuration DurationFormat Work Stop Resume ResumeValid EffortDriven Recurring OverAllocated
Estimated Milestone Summary DisplayAsSummary Critical IsSubproject IsSubprojectReadOnly SubprojectName ExternalTask
ExternalTaskProject EarlyStart EarlyFinish LateStart LateFinish StartVariance FinishVariance WorkVariance FreeSlack TotalSlack
StartSlack FinishSlack FixedCost FixedCostAccrual PercentComplete PercentWorkComplete Cost OvertimeCost OvertimeWork ActualStart
ActualFinish ActualDuration ActualCost ActualOvertimeCost ActualWork ActualOvertimeWork RegularWork RemainingDuration RemainingCost
RemainingWork RemainingOvertimeCost RemainingOvertimeWork ACWP CV ConstraintType CalendarUID ConstraintDate Deadline
LevelAssignments LevelingCanSplit LevelingDelay LevelingDelayFormat PreLeveledStart PreLeveledFinish Hyperlink HyperlinkAddress
HyperlinkSubAddress IgnoreResourceCalendar Notes HideBar Rollup BCWS BCWP PhysicalPercentComplete EarnedValueMethod
PredecessorLink ActualWorkProtected ActualOvertimeWorkProtected ExtendedAttribute Baseline OutlineCode IsPublished StatusManager
CommitmentStart CommitmentFinish CommitmentType TimephasedData""".split()
RESOURCE_ORDER = """UID GUID ID Name Type IsNull Initials Phonetics NTAccount MaterialLabel Code Group WorkGroup EmailAddress Hyperlink
HyperlinkAddress HyperlinkSubAddress MaxUnits PeakUnits OverAllocated AvailableFrom AvailableTo Start Finish CanLevel AccrueAt Work
RegularWork OvertimeWork ActualWork RemainingWork ActualOvertimeWork RemainingOvertimeWork PercentWorkComplete StandardRate
StandardRateFormat Cost OvertimeRate OvertimeRateFormat OvertimeCost CostPerUse ActualCost ActualOvertimeCost RemainingCost
RemainingOvertimeCost WorkVariance CostVariance SV CV ACWP CalendarUID Notes BCWS BCWP IsGeneric IsInactive IsEnterprise
BookingType ActualWorkProtected ActualOvertimeWorkProtected ActiveDirectoryGUID CreationDate ExtendedAttribute Baseline
OutlineCode IsCostResource AssnOwner AssnOwnerGuid IsBudget AvailabilityPeriods Rates TimephasedData""".split()
ASSIGNMENT_ORDER = """UID GUID TaskUID ResourceUID PercentWorkComplete ActualCost ActualFinish ActualOvertimeCost ActualOvertimeWork
ActualStart ActualWork ACWP Confirmed Cost CostRateTable RateScale CostVariance CV Delay Finish FinishVariance Hyperlink
HyperlinkAddress HyperlinkSubAddress WorkVariance HasFixedRateUnits FixedMaterial LevelingDelay LevelingDelayFormat LinkedFields
Milestone Notes Overallocated OvertimeCost OvertimeWork PeakUnits RegularWork RemainingCost RemainingOvertimeCost
RemainingOvertimeWork RemainingWork ResponsePending Start Stop Resume StartVariance Summary SV Units UpdateNeeded VAC Work
WorkContour BCWS BCWP BookingType ActualWorkProtected ActualOvertimeWorkProtected CreationDate AssnOwner AssnOwnerGuid
BudgetCost BudgetWork ExtendedAttribute Baseline TimephasedData""".split()
BASELINE_ORDER = "TimephasedData Number Interim Start Finish Duration DurationFormat EstimatedDuration Work Cost BCWS BCWP".split()


class MSProjectError(Exception):
    pass


# ---------- small helpers ----------
def _strip_ns(root):
    """Work with plain tag names whether or not the file uses the MSPDI namespace."""
    for el in root.iter():
        if isinstance(el.tag, str) and "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    return root


def _t(el, tag, default=None):
    c = el.find(tag)
    return c.text.strip() if c is not None and c.text is not None else default


def _int(v, default=0):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def _float(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def parse_duration(s):
    """MSPDI duration (PT40H0M0S, P1DT2H, -PT8H…) → minutes."""
    if not s:
        return 0
    m = re.fullmatch(r"(-)?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?", s.strip())
    if not m:
        return 0
    sign, y, mo, d, h, mi, sec = m.groups()
    total = (_float(y) * 365 + _float(mo) * 30 + _float(d)) * 1440 + _float(h) * 60 + _float(mi) + _float(sec) / 60
    return round(-total if sign else total)


def format_duration(minutes):
    minutes = int(round(minutes or 0))
    sign = "-" if minutes < 0 else ""
    minutes = abs(minutes)
    return f"{sign}PT{minutes // 60}H{minutes % 60}M0S"


def _time(s):
    """MSPDI datetime → Keystone "YYYY-MM-DDTHH:MM" (or None)."""
    if not s:
        return None
    m = re.match(r"(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?", s)
    return f"{m.group(1)}T{m.group(2) or '00'}:{m.group(3) or '00'}" if m else None


def _xtime(s):
    if not s:
        return None
    return (s if "T" in s else s + "T00:00")[:16] + ":00"


def _clock(s):
    """'17:00:00' → minutes in the day ('00:00:00' as an end time means midnight = 1440)."""
    h, m = (s or "0:0").split(":")[:2]
    return int(h) * 60 + int(m)


def _set(el, tag, value, order):
    """Set (or insert in schema order) a child element's text; value None removes it."""
    cur = el.find(tag)
    if value is None:
        if cur is not None:
            el.remove(cur)
        return
    if cur is None:
        cur = ET.Element(tag)
        idx = order.index(tag) if tag in order else len(order)
        pos = len(el)
        for i, child in enumerate(list(el)):
            if child.tag in order and order.index(child.tag) > idx:
                pos = i
                break
        el.insert(pos, cur)
    cur.text = str(value)


def _insert_many(el, tag, new_children, order):
    """Replace every <tag> child by new_children, placed where the schema order says."""
    for c in el.findall(tag):
        el.remove(c)
    if not new_children:
        return
    idx = order.index(tag)
    pos = len(el)
    for i, child in enumerate(list(el)):
        if child.tag in order and order.index(child.tag) > idx:
            pos = i
            break
    for k, c in enumerate(new_children):
        el.insert(pos + k, c)


def _raw(el):
    return ET.tostring(el, encoding="unicode")


# ---------- calendars ----------
def _periods(el):
    out = []
    for wt in el.findall("WorkingTimes/WorkingTime"):
        a, b = _clock(_t(wt, "FromTime")), _clock(_t(wt, "ToTime"))
        if b <= a:
            b = 1440
        out.append([a, b])
    return sorted(out)


def _dates(a, b, cap=366 * 6):
    d0, d1 = date.fromisoformat(a[:10]), date.fromisoformat(b[:10])
    n = 0
    while d0 <= d1 and n < cap:
        yield d0.isoformat()
        d0 += timedelta(days=1)
        n += 1


def _calendar(cal_el, by_uid, depth=0):
    """An MSPDI calendar (following BaseCalendarUID) → engine calendar {week, exceptions}."""
    base_uid = _t(cal_el, "BaseCalendarUID")
    if base_uid and base_uid in by_uid and by_uid[base_uid] is not cal_el and depth < 5:
        base = _calendar(by_uid[base_uid], by_uid, depth + 1)
        week, exceptions = [list(p) for p in base["week"]], dict(base["exceptions"])
    else:
        std = [[480, 720], [780, 1020]]
        week, exceptions = [[], std, std, std, std, std, []], {}
    for wd in cal_el.findall("WeekDays/WeekDay"):
        dt, working = _int(_t(wd, "DayType")), _t(wd, "DayWorking") == "1"
        if 1 <= dt <= 7:
            week[dt - 1] = _periods(wd) if working else []
        elif dt == 0:  # an exception written the old way
            tp = wd.find("TimePeriod")
            if tp is not None:
                for d in _dates(_t(tp, "FromDate", ""), _t(tp, "ToDate", "")):
                    exceptions[d] = _periods(wd) if working else []
    for ex in cal_el.findall("Exceptions/Exception"):
        tp = ex.find("TimePeriod")
        if tp is None:
            continue
        working = _t(ex, "DayWorking") == "1"
        for d in _dates(_t(tp, "FromDate", ""), _t(tp, "ToDate", "")):
            exceptions[d] = _periods(ex) if working else []
    return {"name": _t(cal_el, "Name", "Standard"), "week": week, "exceptions": exceptions}


def _calendar_xml(cal, uid=1):
    """Engine calendar → an MSPDI base calendar (weekdays + exceptions the classic way, which every version reads)."""
    c = ET.Element("Calendar")
    for tag, val in (("UID", uid), ("Name", cal.get("name") or "Standard"), ("IsBaseCalendar", 1), ("BaseCalendarUID", -1)):
        ET.SubElement(c, tag).text = str(val)
    wds = ET.SubElement(c, "WeekDays")

    def day(dt, periods, frm=None, to=None):
        wd = ET.SubElement(wds, "WeekDay")
        ET.SubElement(wd, "DayType").text = str(dt)
        ET.SubElement(wd, "DayWorking").text = "1" if periods else "0"
        if frm:
            tp = ET.SubElement(wd, "TimePeriod")
            ET.SubElement(tp, "FromDate").text = f"{frm}T00:00:00"
            ET.SubElement(tp, "ToDate").text = f"{to}T23:59:00"
        if periods:
            wts = ET.SubElement(wd, "WorkingTimes")
            for a, b in periods:
                wt = ET.SubElement(wts, "WorkingTime")
                ET.SubElement(wt, "FromTime").text = f"{a // 60:02d}:{a % 60:02d}:00"
                ET.SubElement(wt, "ToTime").text = "00:00:00" if b >= 1440 else f"{b // 60:02d}:{b % 60:02d}:00"
    for i, p in enumerate(cal.get("week") or []):
        day(i + 1, p)
    for d, p in sorted((cal.get("exceptions") or {}).items()):
        day(0, p, d, d)
    return c


# ---------- reading ----------
def parse_mspdi(text):
    """MS Project XML → (plan dict, warnings)."""
    try:
        root = _strip_ns(ET.fromstring(text.encode("utf-8") if isinstance(text, str) else text))
    except ET.ParseError as e:
        raise MSProjectError(f"not a valid XML file ({e})") from None
    if root.tag != "Project":
        raise MSProjectError("this XML file isn't an MS Project file (no <Project> element)")
    warnings = []
    units = {"minutesPerDay": _int(_t(root, "MinutesPerDay"), 480) or 480, "minutesPerWeek": _int(_t(root, "MinutesPerWeek"), 2400) or 2400,
             "daysPerMonth": _int(_t(root, "DaysPerMonth"), 20) or 20}
    # calendars
    cal_els = {(_t(c, "UID") or ""): c for c in root.findall("Calendars/Calendar")}
    cal_uid = _t(root, "CalendarUID")
    proj_cal = _calendar(cal_els[cal_uid], cal_els) if cal_uid in cal_els else _calendar(next(iter(cal_els.values())), cal_els) if cal_els else None
    # custom field names
    fields = {}
    for ea in root.findall("ExtendedAttributes/ExtendedAttribute"):
        fields[_t(ea, "FieldID")] = _t(ea, "Alias") or _t(ea, "FieldName") or _t(ea, "FieldID")
    # tasks
    tasks, stack, summary_raw, skipped = [], [], None, 0
    for el in root.findall("Tasks/Task"):
        uid = _int(_t(el, "UID"), -1)
        if uid == 0:
            summary_raw = _raw(el)
            continue
        if _t(el, "IsNull") == "1":
            skipped += 1
            continue
        level = max(1, _int(_t(el, "OutlineLevel"), 1))
        while stack and stack[-1][0] >= level:
            stack.pop()
        parent = stack[-1][1] if stack else None
        stack.append((level, uid))
        fmt, est = DURATION_FORMATS.get(_int(_t(el, "DurationFormat"), 7), ("d", False))
        if fmt.endswith("%"):
            fmt = "d"
        if _t(el, "Estimated") == "1":
            est = True
        links = []
        for pl in el.findall("PredecessorLink"):
            lag_fmt_code = _int(_t(pl, "LagFormat"), 7)
            lag_fmt, _ = DURATION_FORMATS.get(lag_fmt_code, ("d", False))
            raw_lag = _int(_t(pl, "LinkLag"), 0)
            lag = {"minutes": raw_lag / 10, "format": "%"} if lag_fmt.endswith("%") else {"minutes": round(raw_lag / 10), "format": lag_fmt}
            if _t(pl, "CrossProject") == "1":
                warnings.append(f"Task {uid} links to another project ({_t(pl, 'CrossProjectName', '')}); that link is kept for export but not scheduled.")
                continue
            links.append({"pred": _int(_t(pl, "PredecessorUID")), "type": LINK_TYPES[_int(_t(pl, "Type"), 1) % 4], "lag": lag})
        baselines = {}
        for b in el.findall("Baseline"):
            baselines[str(_int(_t(b, "Number"), 0))] = {"start": _time(_t(b, "Start")), "finish": _time(_t(b, "Finish")),
                                                       "minutes": parse_duration(_t(b, "Duration")), "work": parse_duration(_t(b, "Work"))}
        custom = {}
        for xa in el.findall("ExtendedAttribute"):
            custom[fields.get(_t(xa, "FieldID"), _t(xa, "FieldID"))] = _t(xa, "Value", "")
        ctype = CONSTRAINTS[_int(_t(el, "ConstraintType"), 0) % 8]
        manual = _t(el, "Manual") == "1"
        summary = _t(el, "Summary") == "1"
        dur_min = parse_duration(_t(el, "Duration"))
        tasks.append({
            "uid": uid, "id": _int(_t(el, "ID"), uid), "name": _t(el, "Name", "") or "", "parentUid": parent,
            "kind": "summary" if summary else "milestone" if _t(el, "Milestone") == "1" else "task",
            "milestone": _t(el, "Milestone") == "1" and not summary, "manual": manual,
            "duration": {"minutes": dur_min, "format": fmt, "estimated": est},
            "start": _time(_t(el, "Start")), "finish": _time(_t(el, "Finish")),
            "constraint": {"type": ctype, "date": _time(_t(el, "ConstraintDate")) if ctype not in ("ASAP", "ALAP") else None},
            "deadline": _time(_t(el, "Deadline")), "priority": _int(_t(el, "Priority"), 500),
            "percent": _int(_t(el, "PercentComplete"), 0), "actualStart": _time(_t(el, "ActualStart")), "actualFinish": _time(_t(el, "ActualFinish")),
            "notes": _t(el, "Notes", "") or "", "wbs": _t(el, "WBS"), "links": links, "baselines": baselines, "custom": custom,
            "active": _t(el, "Active", "1") != "0",
            "msp": _raw(el),
        })
    if skipped:
        warnings.append(f"{skipped} blank row(s) were left out.")
    # resources & assignments
    resources = []
    for el in root.findall("Resources/Resource"):
        uid = _int(_t(el, "UID"), -1)
        if uid <= 0 or _t(el, "IsNull") == "1" or not _t(el, "Name"):
            continue
        resources.append({"uid": uid, "name": _t(el, "Name"), "initials": _t(el, "Initials", ""), "group": _t(el, "Group", ""),
                          "email": _t(el, "EmailAddress", ""), "maxUnits": _float(_t(el, "MaxUnits"), 1.0),
                          "type": {"0": "material", "1": "work", "2": "cost"}.get(_t(el, "Type", "1"), "work"), "msp": _raw(el)})
    res_ids = {r["uid"] for r in resources}
    task_ids = {t["uid"] for t in tasks}
    assignments = []
    for el in root.findall("Assignments/Assignment"):
        tu, ru = _int(_t(el, "TaskUID"), -1), _int(_t(el, "ResourceUID"), -1)
        if tu not in task_ids or ru not in res_ids:
            continue
        assignments.append({"uid": _int(_t(el, "UID"), 0), "taskUid": tu, "resourceUid": ru, "units": _float(_t(el, "Units"), 1.0),
                            "workMinutes": parse_duration(_t(el, "Work")), "actualWorkMinutes": parse_duration(_t(el, "ActualWork")), "msp": _raw(el)})
    # project-level elements to keep (everything except the four collections)
    keep = ET.Element("Project")
    for child in root:
        if child.tag not in ("Tasks", "Resources", "Assignments"):
            keep.append(child)
    plan = {
        "name": _t(root, "Title") or _t(root, "Name") or "Imported plan",
        "start": _time(_t(root, "StartDate")), "statusDate": _time(_t(root, "StatusDate")),
        "units": units, "calendar": proj_cal or None, "calendarSource": "msp" if proj_cal else "keystone",
        "tasks": tasks, "resources": resources, "assignments": assignments, "raid": [],
        "customFields": sorted(set(fields.values())),
        "msp": {"project": _raw(keep), "summaryTask": summary_raw, "calendarUID": cal_uid},
    }
    stats = {"tasks": len(tasks), "summaries": sum(1 for t in tasks if t["kind"] == "summary"), "milestones": sum(1 for t in tasks if t["milestone"]),
             "links": sum(len(t["links"]) for t in tasks), "resources": len(resources), "assignments": len(assignments),
             "calendars": len(cal_els), "baselines": len({n for t in tasks for n in t["baselines"]}), "customFields": len(fields)}
    return plan, warnings, stats


# ---------- writing ----------
def to_mspdi(plan):
    """A Keystone plan → MS Project XML text."""
    keep = (plan.get("msp") or {}).get("project")
    root = _strip_ns(ET.fromstring(keep)) if keep else ET.Element("Project")
    units = {"minutesPerDay": 480, "minutesPerWeek": 2400, "daysPerMonth": 20, **(plan.get("units") or {})}
    tasks = plan.get("tasks") or []
    finishes = [t.get("finish") for t in tasks if t.get("finish")]
    _set(root, "SaveVersion", _t(root, "SaveVersion") or 14, PROJECT_ORDER)
    if not keep:
        _set(root, "Name", (plan.get("name") or "Plan") + ".xml", PROJECT_ORDER)
    _set(root, "Title", plan.get("name") or "Plan", PROJECT_ORDER)
    _set(root, "ScheduleFromStart", _t(root, "ScheduleFromStart") or 1, PROJECT_ORDER)
    if plan.get("start"):
        _set(root, "StartDate", _xtime(plan["start"]), PROJECT_ORDER)
    if finishes:
        _set(root, "FinishDate", _xtime(max(finishes)), PROJECT_ORDER)
    _set(root, "MinutesPerDay", units["minutesPerDay"], PROJECT_ORDER)
    _set(root, "MinutesPerWeek", units["minutesPerWeek"], PROJECT_ORDER)
    _set(root, "DaysPerMonth", units["daysPerMonth"], PROJECT_ORDER)
    _set(root, "StatusDate", _xtime(plan.get("statusDate")) if plan.get("statusDate") else None, PROJECT_ORDER)
    # calendars: the originals when they came from MS Project and weren't replaced, else Keystone's calendar
    if plan.get("calendarSource") != "msp" or root.find("Calendars") is None:
        cals = root.find("Calendars")
        if cals is None:
            cals = ET.Element("Calendars")
            _insert_many(root, "Calendars", [cals], PROJECT_ORDER)
        for c in list(cals):
            cals.remove(c)
        std = [[480, 720], [780, 1020]]
        cals.append(_calendar_xml(plan.get("calendar") or {"name": "Standard", "week": [[], std, std, std, std, std, []]}, 1))
        _set(root, "CalendarUID", 1, PROJECT_ORDER)
    # tasks
    rows = []
    summary_raw = (plan.get("msp") or {}).get("summaryTask")
    st = _strip_ns(ET.fromstring(summary_raw)) if summary_raw else ET.Element("Task")
    for tag, val in (("UID", 0), ("ID", 0), ("Name", plan.get("name") or "Plan"), ("OutlineLevel", 0), ("Summary", 1)):
        _set(st, tag, val, TASK_ORDER)
    rows.append(st)
    depth, number = {}, {}
    counters = {}
    for i, t in enumerate(tasks, 1):
        parent = t.get("parentUid")
        d = depth.get(parent, 0) + 1 if parent is not None else 1
        depth[t["uid"]] = d
        counters[parent] = counters.get(parent, 0) + 1
        number[t["uid"]] = (number[parent] + "." if parent is not None and parent in number else "") + str(counters[parent])
        el = _strip_ns(ET.fromstring(t["msp"])) if t.get("msp") else ET.Element("Task")
        is_sum = any(x.get("parentUid") == t["uid"] for x in tasks)
        dur = t.get("duration") or {"minutes": 0, "format": "d"}
        fmt_code = FORMAT_CODES.get((dur.get("format", "d"), bool(dur.get("estimated"))), 7)
        c = t.get("constraint") or {"type": "ASAP"}
        values = [("UID", t["uid"]), ("ID", i), ("Name", t.get("name", "")), ("Manual", 1 if t.get("manual") else 0),
                  ("WBS", t.get("wbs") or number[t["uid"]]), ("OutlineNumber", number[t["uid"]]), ("OutlineLevel", d),
                  ("Priority", t.get("priority", 500)), ("Start", _xtime(t.get("start"))), ("Finish", _xtime(t.get("finish"))),
                  ("Duration", format_duration(dur.get("minutes", 0))), ("DurationFormat", fmt_code),
                  ("Estimated", 1 if dur.get("estimated") else 0), ("Milestone", 1 if (t.get("milestone") or (not is_sum and not dur.get("minutes"))) else 0),
                  ("Summary", 1 if is_sum else 0), ("PercentComplete", int(t.get("percent") or 0)),
                  ("ActualStart", _xtime(t.get("actualStart"))), ("ActualFinish", _xtime(t.get("actualFinish"))),
                  ("ConstraintType", CONSTRAINTS.index(c.get("type", "ASAP")) if c.get("type", "ASAP") in CONSTRAINTS else 0),
                  ("ConstraintDate", _xtime(c.get("date")) if c.get("date") and c.get("type") not in ("ASAP", "ALAP") else None),
                  ("Deadline", _xtime(t.get("deadline"))), ("Notes", t.get("notes") or None)]
        for tag, val in values:
            _set(el, tag, val, TASK_ORDER)
        links = []
        for l in t.get("links") or []:
            pl = ET.Element("PredecessorLink")
            lag = l.get("lag") or {"minutes": 0, "format": "d"}
            pct = lag.get("format") == "%"
            for tag, val in (("PredecessorUID", l["pred"]), ("Type", LINK_TYPES.index(l.get("type", "FS"))), ("CrossProject", 0),
                             ("LinkLag", round(lag.get("minutes", 0) * 10)), ("LagFormat", 19 if pct else FORMAT_CODES.get((lag.get("format", "d"), False), 7))):
                ET.SubElement(pl, tag).text = str(val)
            links.append(pl)
        cross = [pl for pl in el.findall("PredecessorLink") if _t(pl, "CrossProject") == "1"]  # kept as they were
        _insert_many(el, "PredecessorLink", links + cross, TASK_ORDER)
        bls = []
        for n, b in sorted((t.get("baselines") or {}).items(), key=lambda x: int(x[0])):
            be = ET.Element("Baseline")
            for tag, val in (("Number", int(n)), ("Start", _xtime(b.get("start"))), ("Finish", _xtime(b.get("finish"))),
                             ("Duration", format_duration(b.get("minutes", 0))), ("DurationFormat", 7), ("Work", format_duration(b.get("work", 0)))):
                if val is not None:
                    ET.SubElement(be, tag).text = str(val)
            bls.append(be)
        _insert_many(el, "Baseline", bls, TASK_ORDER)
        rows.append(el)
    _insert_many(root, "Tasks", [_wrap("Tasks", rows)], PROJECT_ORDER)
    # resources
    res_rows = []
    for i, r in enumerate(plan.get("resources") or [], 1):
        el = _strip_ns(ET.fromstring(r["msp"])) if r.get("msp") else ET.Element("Resource")
        for tag, val in (("UID", r["uid"]), ("ID", i), ("Name", r.get("name", "")), ("Type", {"material": 0, "cost": 2}.get(r.get("type"), 1)),
                         ("Initials", r.get("initials") or (r.get("name") or "?")[:1]), ("Group", r.get("group") or None),
                         ("EmailAddress", r.get("email") or None), ("MaxUnits", r.get("maxUnits", 1.0))):
            _set(el, tag, val, RESOURCE_ORDER)
        res_rows.append(el)
    _insert_many(root, "Resources", [_wrap("Resources", res_rows)] if res_rows else [], PROJECT_ORDER)
    # assignments
    asg_rows, next_uid = [], max([a.get("uid") or 0 for a in plan.get("assignments") or []] + [0]) + 1
    task_by_uid = {t["uid"]: t for t in tasks}
    for a in plan.get("assignments") or []:
        if a.get("taskUid") not in task_by_uid:
            continue
        el = _strip_ns(ET.fromstring(a["msp"])) if a.get("msp") else ET.Element("Assignment")
        uid = a.get("uid") or next_uid
        if not a.get("uid"):
            next_uid += 1
        t = task_by_uid[a["taskUid"]]
        work = a.get("workMinutes")
        if work is None:
            work = (t.get("duration") or {}).get("minutes", 0) * (a.get("units") or 1)
        for tag, val in (("UID", uid), ("TaskUID", a["taskUid"]), ("ResourceUID", a["resourceUid"]), ("Units", a.get("units", 1.0)),
                         ("Work", format_duration(work))):
            _set(el, tag, val, ASSIGNMENT_ORDER)
        asg_rows.append(el)
    _insert_many(root, "Assignments", [_wrap("Assignments", asg_rows)] if asg_rows else [], PROJECT_ORDER)
    root.set("xmlns", NS)
    ET.indent(root, space="  ")
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + ET.tostring(root, encoding="unicode") + "\n"


def _wrap(tag, children):
    w = ET.Element(tag)
    w.extend(children)
    return w


# ---------- .mpp through MPXJ (optional) ----------
def mpxj_folder():
    """The folder with MPXJ's jars: $KEYSTONE_MPXJ, or the lib folder of `pip install mpxj` (found without importing it)."""
    folder = os.environ.get("KEYSTONE_MPXJ")
    if not folder:
        spec = importlib.util.find_spec("mpxj")
        folder = spec and spec.submodule_search_locations and os.path.join(list(spec.submodule_search_locations)[0], "lib")
    return folder if folder and Path(folder).is_dir() else None


def mpxj_available():
    """(java, classpath) if MPXJ can be used: its jars are found (see mpxj_folder) and Java is installed."""
    folder = mpxj_folder()
    java = shutil.which("java") or (os.path.join(os.environ["JAVA_HOME"], "bin", "java") if os.environ.get("JAVA_HOME") else None)
    if not folder or not java:
        return None
    jars = [str(p) for p in Path(folder).rglob("*.jar")]
    return (java, os.pathsep.join(jars)) if jars else None


# MPXJ 14 moved its classes from net.sf.mpxj to org.mpxj; try the new name first
CONVERT_CLASSES = ("org.mpxj.sample.MpxjConvert", "net.sf.mpxj.sample.MpxjConvert")


def convert_with_mpxj(data, suffix):
    found = mpxj_available()
    if not found:
        raise MSProjectError("Reading .mpp files needs MPXJ and Java on this computer (pip install mpxj, or set KEYSTONE_MPXJ to the MPXJ folder). "
                             "Or open the file in MS Project and use File → Save As → XML, then import that.")
    java, cp = found
    with tempfile.TemporaryDirectory() as d:
        src, dst = Path(d) / f"in{suffix}", Path(d) / "out.xml"
        src.write_bytes(data)
        for cls in CONVERT_CLASSES:
            r = subprocess.run([java, "-cp", cp, cls, str(src), str(dst)], capture_output=True, text=True, timeout=180)
            if r.returncode == 0 and dst.exists():
                return dst.read_text(encoding="utf-8")
            if "ClassNotFoundException" not in (r.stderr or "") and "Could not find or load main class" not in (r.stderr or ""):
                break
        raise MSProjectError(f"MPXJ couldn't convert the file: {(r.stderr or r.stdout).strip()[:300]}")


def read_upload(filename, data_b64):
    """An uploaded file (base64) → (plan, warnings, stats)."""
    data = base64.b64decode(data_b64 or "")
    suffix = Path(filename or "plan.xml").suffix.lower()
    if suffix in (".mpp", ".mpx", ".mpt"):
        return parse_mspdi(convert_with_mpxj(data, suffix))
    if suffix == ".xml" or data.lstrip()[:5] == b"<?xml" or b"<Project" in data[:2000]:
        return parse_mspdi(data.decode("utf-8-sig", errors="replace"))
    raise MSProjectError(f"{suffix or 'This'} files can't be imported – use MS Project XML (.xml), or .mpp with MPXJ installed.")
