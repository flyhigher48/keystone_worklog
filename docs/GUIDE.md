# Keystone user guide

The complete reference. For a quick overview, installation and first steps, see the [README](../README.md).


A local web app that ties your work together: NWA (Network + Activity) hours per biweekly pay period, project budgets, deliverables, and sick and annual leave, plus your Obsidian vault and an AI assistant that works across all of it.

Keystone writes everything into your vault as Markdown, and you can browse and edit the vault from the app. It also reads the other files you keep there – PDFs, Office files, saved emails, Python scripts, notebooks and solver files such as Abaqus jobs – so you and the assistant can find a file by what's inside it, and it can suggest where new files in your **Inbox** belong. The assistant, **Ask Keystone**, sits beside every page.

It runs on your computer only. Nothing is sent anywhere, unless you connect the optional AI assistant to a cloud model.

The defaults are set up for a US federal employee: a biweekly 80-hour pay period, federal holidays, LA/LS/LH leave codes and a 240 h carry-over limit. All of these are configurable in Settings.

## Install

Requirements: **Python 3.10+** and a modern browser (Firefox, Chrome or Edge). Git and Obsidian are optional.

```bash
pip install "keystone-worklog[all]"       # [all] = [search] (LanceDB, meaning search) + [documents] (PDF, Word, PowerPoint, Excel)
keystone-worklog                         # opens http://127.0.0.1:5000 – stop with Ctrl+C
```

Without `[search]`, everything works, and the assistant uses keyword search only. Without `[documents]`, the assistant can still search emails (`.eml`), text, CSV, HTML and RTF files, but not PDF or Office files.

| Option | |
| --- | --- |
| `keystone-worklog --port 5001` | Use another port (or set `KEYSTONE_PORT`) |
| `keystone-worklog --no-browser` | Don't open a browser window |
| `KEYSTONE_DATA_DIR=/path/to/folder keystone-worklog` | Keep the data somewhere else, e.g. a second profile |
| `python -m keystone_worklog` | The same as `keystone-worklog` |

**Where your data lives:** your tracker data, API keys, chats and backups go in your user data folder:
- Linux: `~/.local/share/keystone-worklog`
- macOS: `~/Library/Application Support/keystone-worklog`
- Windows: `%APPDATA%\keystone-worklog`

The startup message shows the exact path.

### From a source checkout

```bash
git clone https://github.com/<you>/keystone-worklog && cd keystone-worklog
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py                                          # or: pip install -e ".[all]" && keystone-worklog
```

Run from a checkout, the data stays in `./data`, which is git-ignored.

### Try it with demo data

`scripts/make_demo.py` builds a complete, fictional setup in `./demo` (git-ignored): four projects with budgets, seven pay periods of hours, deliverables, follow-ups, leave and travel, and an Obsidian vault with project notes, a specs PDF, Word, Excel and PowerPoint files, saved emails, Abaqus jobs (one that finished, one that failed), a Python script, a notebook – and an `Inbox/` with nine files to file. Dates are relative to today, so it always looks current. It also writes `demo/meetings.ics` to try **Board → Calendar → Import calendar**. For the **Plan** tab it adds two project plans (Girder Bridge rehab and Runway lighting, with a baseline, people, progress, late tasks, issues and risks), a *Bridge rehab template* for **New plan**, and `demo/Culvert C-12 schedule.xml` to try **Plan → Open an MS Project file**. The baselines are worked out with Node.js when it's installed; without it the plans still work, just without baseline bars.

```bash
python scripts/make_demo.py                              # --force rebuilds it, --llm-from data/llm.json copies your AI profiles
KEYSTONE_DATA_DIR=demo/data python app.py --port 5050    # your real data/ is not touched
```

It needs the `[documents]` packages to write the Office files. The screenshots in the README were taken from it.

### Computers without internet (air-gapped)

On a computer **with** internet, bundle everything Keystone needs:

```bash
keystone-worklog-bundle                    # or, in a checkout: python -m keystone_worklog.offline_bundle
```

| Folder | Contents | Size |
| --- | --- | --- |
| `models/` | The embedding model (`all-MiniLM-L6-v2`) and its browser runtime (transformers.js + ONNX WebAssembly) | ~46 MB |
| `wheels/` | Keystone and all ~25 Python packages it needs for this kind of computer: Flask, LanceDB and their dependencies (pyarrow, numpy, pydantic, Jinja2, Werkzeug and so on) | ~150 MB |

If the offline computer has a different OS or Python version, download the packages for **it**:

```bash
keystone-worklog-bundle --platform win_amd64 --python-version 3.12            # 64-bit Windows
keystone-worklog-bundle --platform manylinux_2_28_x86_64 --python-version 3.11 # Linux x86-64
keystone-worklog-bundle --platform macosx_11_0_arm64 --python-version 3.12     # Apple Silicon Mac
keystone-worklog-bundle --skip-wheels --dest some/folder                       # model only, somewhere else
```

Copy `models/` and `wheels/` to the offline computer (USB drive, and so on) and run:

```bash
pip install --no-index --find-links wheels "keystone-worklog[all]"
keystone-worklog --models-dir models --offline
```

**What the offline computer needs installed:**

| Requirement | Why |
| --- | --- |
| **Python 3.10 or newer** with pip | Runs the app. Use the same version you bundled the wheels for. |
| A modern browser (Firefox, Chrome, Edge) | The interface and the in-browser embedding model (WebAssembly) |
| **Git** *(optional)* | Auto-commits the assistant's vault changes |
| A local LLM server *(optional)*, e.g. Ollama, LM Studio, llama.cpp | The AI assistant. Install it and copy its model weights (e.g. Gemma) separately; a cloud profile won't work without internet. |

Nothing else is downloaded at runtime: the Markdown, math (KaTeX) and sanitizer libraries ship inside the package.

## Tabs

| Tab | What it's for |
| --- | --- |
| **Today** | Your home page: hours today and this pay period, leave balances, a start/stop timer, **Log my day**, cards due soon, recent notes, the pay-period check, and **Brief me** / **Weekly status report** buttons for Keystone. A banner reminds you when the pay period ends within 3 days (or last period was never marked submitted). **Heads up** lists projects over 80% of budget, over budget or running out within 4 weeks, annual leave over the carry-over limit, and timer time not yet logged. **Today's meetings** shows imported calendar events. The **timer** keeps stopped time in a log: start another project to switch, then **Review & log** splits the day's time into quarter hours (optionally scaled to fill the hours left in the day). |
| **Timesheet** | One pay period (two Sun–Sat weeks). Each row has a project, Network, Activity, pay code and TS, plus hours per day. The top card shows your total against 80 h, split by type. Includes the pay-period check, **Fill from schedule**, **Same as last week** and **Mark as submitted**. **My usual** saves a pay period as your usual pattern and fills the empty days of another from it, skipping holidays (filled as LH), out-of-office days and days that already have hours. |
| **Projects** | Your list of Network + Activity pairs with a name and a budget of chargeable hours. Shows hours used and remaining, deliverable progress, and a link to the project's note. |
| **Board** | A kanban board of deliverables (To do / In progress / Blocked / Done), each linked to a project. Drag cards between columns, or click one to edit it. **Calendar** shows cards on their due dates; drag a card onto a day to set its due date. It also shows days you're out of office: add annual leave, sick leave, travel or other time away with **Out of office** (or double-click a day), and LA/LS hours you've entered on the Timesheet appear on their own. Annual and sick leave can also put the hours on the timesheet (scheduled hours on each workday, holidays skipped); the dialog shows the balance it leaves and warns about going negative or staying over the carry-over limit. Editing or deleting the entry takes those hours back off. **Import calendar** reads an `.ics` export from Outlook, Google or Apple (read-only, stored only in your data file) and shows meetings on the calendar; click one to charge its time to a project – a project whose name or network is in the title is suggested. |
| **Plan** | Project plans like MS Project: a task grid and a Gantt timeline you can drag, milestones, dependencies and the critical path, who's working on what, progress against a baseline, and issues and risks. Opens and saves MS Project files. Team costs from your ERP with earned value, weekly status reports and an all-plans view. See [Project plans](#project-plans-plan-tab) and [Team costs](#team-costs-status-reports-and-the-portfolio). |
| **Follow-ups** | Emails you owe a reply: from, subject, reply-by date, project, status (To reply / Waiting on them / Done). Import a saved `.eml`, paste an email (From/Subject are filled in), or capture one. **Draft reply ✦** has Keystone write a reply for you to copy. It never sends anything. |
| **Reports** | Budget burn-down (pick a project) plus a burn-rate table for every project, leave forecast with a use-or-lose warning, hours by project by month – the last 6 months or a whole year (CSV or a vault note) – and **pay period history** (what you marked submitted, and when). **Print / PDF** prints the page in light colours; choose *Save as PDF* in the print dialog. **Avg burn** = RG hours in the last 4 completed weeks ÷ the number of those weeks, counting only weeks since the project was first charged (before a full week exists, it uses this week so far). **Weeks left** = budget left ÷ avg burn. |
| **Notes** | Browse and edit the Markdown notes in your Obsidian vault, with live preview, `[[wikilinks]]` and clickable checkboxes. Documents (PDF, Office, emails, code, solver files…) are listed too and open as a PDF viewer or as their text. **File the inbox** appears when there are files in `Inbox/`. |
| **Assistant** | Full-width chat with Keystone, with your chat history in a sidebar. |
| **Leave** | Sick and annual leave balances, and a ledger for each pay period. |
| **Settings** | Pay period start, leave rates and starting balances, the Obsidian vault and its inbox folder, the AI assistant and which files it searches, the **Search index** status, and backups. |

### Work schedule, holidays and the pay-period check

**Settings → Work schedule & holidays:**
- **Schedule:** choose 5 × 8, 9/80 (Friday off in week 1 or week 2), 4 × 10, or a custom hours-per-day grid for the 14 days of a pay period.
- **Holidays:** US federal holidays are built in, with Saturday holidays observed on Friday and Sunday holidays on Monday. Add your own (office closures and so on), one per line.

**On the Timesheet:**
- **Day headers:** each one shows that day's scheduled hours, or *Holiday* or *off*.
- **A new pay period** starts with its holidays already entered as LH.
- **Fill from schedule:** tops every scheduled day up to its hours on the project you pick, with holidays as LH.
- **Same as last week:** copies last week's projects *and* hours. Holidays in the new week are set to LH.
- **Pay period check** flags:
  - totals that don't reach (or go over) 80 h
  - workdays with no hours, and days that don't match your schedule
  - hours on unscheduled days
  - holidays without LH
  - RG rows with no network or activity
  - projects over budget, and negative leave balances
- **Before Copy for portal:** if that week still has issues, you're asked first.
- **Mark as submitted** locks the period, including against the assistant. If you unlock it and change hours, the check reminds you to update the portal.

### Quick capture and Today.md

Press **`Ctrl+Shift+Space`** anywhere, or **+ Capture** in the top bar, type one line and press Enter. Captures go into **one note, `Today.md`**, at the root of your vault, with a heading per day and the newest day on top:

```markdown
# Today

## Saturday, October 24, 2026
- 08:10 Call county about the culvert #bridge [[Bridge rehab]]

## Friday, October 23, 2026
- 09:12 first thought
- [ ] send drainage memo 📅 2026-10-30
```

The first capture of a day adds its heading. Anything you write in the note yourself is left alone. You can change the note's name and the heading format (`dddd, MMMM D, YYYY` by default) in Settings → Obsidian vault.

| Type | Becomes |
| --- | --- |
| `Call the county about the culvert #bridge` | `- 14:05 …` note line, linked to the matching project note |
| `[] send drainage memo due:fri` | `- [ ] send drainage memo 📅 2026-10-30` |
| `@task Review 60% plans due:2026-11-02 #bridge` | a Board card for that project, plus a line in the note |
| `@reply Bob Smith – budget question due:tomorrow` | a follow-up, plus a line in the note |

- **Due dates:** `due:` understands `today`, `tomorrow`, weekday names (the next one), `+3d`, `2w` and `YYYY-MM-DD`.
- **Projects:** `#tag` matches a project by name or network number.
- **Preview:** a line under the box shows where the capture will go before you press Enter.
- **On the Today page,** the **Today's note** card shows today's section of `Today.md` and has its own capture box. **File with Keystone** asks the assistant to sort today's captures into project and meeting notes, Board cards and follow-ups, then mark each line with where it went. You approve each change.

### Timer, command palette, reminders

- **Timer:** start it on the Today page; it shows in the top bar while running. **Stop** keeps the time in the timer log, and picking another project while one runs **switches** to it. When you're done for the day, **Review & log** turns the day's sessions into timesheet hours, rounded to quarter hours with the total kept (or split by tracked time to fill the hours left in the day). Time not logged by the next day shows under *Heads up*.
- **`Ctrl+K` (or Search in the top bar):** jump to any tab, note, project or card, or run commands like *Start timer*, *Log my day*, *Brief me*, *Weekly status report*, *File my inbox*, *Previous/Next pay period*, *New meeting note*.
- **Reminders** (Settings → Reminders & backups): a browser notification once a day, while Keystone is open, for cards and replies that are overdue or due today or tomorrow, and when the pay period is about to end.

### Pay codes

| Code | Meaning | Effect |
| --- | --- | --- |
| `RG` | Regular hours | Counts against the project's budget. Tick **TS** for telework. |
| `LA` | Annual leave | Comes off your annual leave balance. |
| `LS` | Sick leave | Comes off your sick leave balance. |
| `LH` | Holiday | Counts toward the 80 h, but not toward either balance. |

### Copying hours into the portal

Each week has a **Copy for portal** button. It copies tab-separated rows in the portal's column order:

```
Network  Activity  (blank)  Code  TS  (blank)  (blank)  (blank)  (blank)  (blank)  Sun  Mon  Tue  Wed  Thu  Fri  Sat
```

The project name is never copied. Rows with no hours are skipped, and empty days are left blank. Click **Preview** first to see exactly what will be pasted. Then click into the first cell of the portal grid and paste.

Keyboard: `↑ ↓ ← →` and `Enter` move between hour cells.

## Project plans (Plan tab)

<img src="screenshots/plan-gantt.png" alt="The Plan tab: a task grid with IDs, durations, dates, predecessors and people beside a Gantt chart with summary bars, the critical path in red, progress, baseline bars and dependency arrows" width="900">

Plans are separate from the Board: the Board holds the cards you're working on now; a plan holds the whole schedule. Each plan is one file in `data/plans/`.

**Start a plan:** **Plan → New plan** (or `Ctrl+K` → *New project plan*). Pick the project, a name and a start date, and optionally a template. The plan's calendar is your work schedule (including a 9/80 day off) and holidays from Settings. Or **Open an MS Project file** to bring in an existing schedule.

**What you need:** nothing beyond Keystone itself. The scheduler, the Gantt and MS Project XML import/export all run in Keystone, offline. Only reading `.mpp` files directly needs MPXJ and Java ([below](#reading-mpp-files-mpxj-and-java)).

**Try it on the demo** (`python scripts/make_demo.py`, see [Try it with demo data](#try-it-with-demo-data)):

- **Girder Bridge rehab** – 19 tasks in three phases, four people, progress, deadlines and baseline 0. The grey baseline bars show that the FE model and bearing design took longer than first planned. Try *Late or slipping* in the filter, the **Dashboard**, and dragging *Girder FE model* to watch the finish date move.
- **Runway lighting** – a smaller plan that's behind: the circuit survey, photometric calcs and closure window are late, with an open issue and a risk on the **Issues & risks** tab.
- **Bridge rehab template** – pick it under **New plan → Template**.
- **`demo/Culvert C-12 schedule.xml`** – an MS Project XML file to try **Open an MS Project file**.
- **Team costs:** five people with pay rates, two cost models, three weeks of status history on the bridge plan, and two ERP exports. The older export (`ERP labor report <date>.xlsx`) is already imported. Import the newer one from **Plan → Costs → Import from ERP** to see the master layout, a new person to match, overlapping lines being replaced, and the numbers update. See [Team costs, status reports and the portfolio](#team-costs-status-reports-and-the-portfolio).

### The grid and the Gantt

- **Type into the grid** like a spreadsheet. Click a cell and type, or press `F2`/`Enter` to edit. `Enter` moves down, `Tab` moves right. `Insert` adds a task, `Delete` removes the selected ones.
- **Durations:** `3d`, `2w`, `4h`, `1mo`; `0` makes a milestone. A `?` (`5d?`) marks an estimate. `3ed` is 3 *elapsed* days (weekends count).
- **Dates:** `10/19/26`, `Oct 19` or `2026-10-19`. Typing a **Start** sets *Start No Earlier Than* (like MS Project). Typing a **Finish** changes the duration.
- **Predecessors** use row IDs, like MS Project: `4`, `7SS`, `9FF+2d`, `12SF-25%`. A link that would make a loop is refused.
- **People:** `Maria, Sam[50%]`. New names are added to the plan's people.
- **Outline:** indent `Alt+Shift+→` and outdent `Alt+Shift+←`. An indented task's parent becomes a summary task whose dates and % complete come from its tasks. Outdenting a task makes the tasks below it its subtasks (as in MS Project).
- **Link the selected tasks** in order with the link button or `Ctrl+F2` (select with `Ctrl`/`Shift`+click).
- **On the Gantt:** drag a bar to move it (sets *Start No Earlier Than*), drag its right edge to change the duration, drag the handle inside it to set % complete, or drag from one bar onto another to link them (finish-to-start). The whole schedule moves live while you drag. `Esc` cancels. Double-click a bar for **Task details**; right-click for more.
- **Zoom** with Day / Week / Month / Quarter / Year or `Ctrl`+mouse wheel. **Fit** shows the whole plan; **Today** scrolls to today. `Shift`+wheel scrolls sideways.
- **Filters:** critical, late or slipping, milestones, incomplete, my tasks, and tasks with open issues. **Columns** adds WBS, total slack, baseline finish, finish variance, planned and actual hours, cost, baseline and actual cost, budget, budget left, remaining and forecast hours, forecast cost, NWA, deadline and constraint.
- The **milestone strip** above the chart shows every milestone; click one to jump to it.
- **Undo / Redo:** `Ctrl+Z` / `Ctrl+Y`, the arrows at the top. Changes save on their own. If the same plan was changed in another tab, a banner lets you load their version or keep yours.

**Indicators** in the second column: `✓` done, a red dot for late or missing its deadline, `⚑` an open issue or risk, `⌖` a constraint, `✎` notes, `✋` manually scheduled, `!` a conflict (for example a *Must Start On* date its links can't meet).

### Task details

Double-click a row's ID, or select a task and press `Shift+F2`. Here you set the constraint (as soon/late as possible, start/finish no earlier/later than, must start/finish on), a **deadline** (a flag on the chart, and a warning when the task finishes after it), priority, notes, files in the vault, and **Manually scheduled** (the task keeps the dates you give it). You also see its slack, successors, baselines, custom fields from MS Project, and its issues and risks.

**Charges to (timesheet NWA):** link a task to a network/activity and the plan shows the hours you've logged on the timesheet against it (*Actual h*), next to the planned hours. Hours logged on a day go to the linked tasks that were planned for that day.

### Scheduling

Keystone schedules the way MS Project does. It runs a forward pass for the earliest dates, then a backward pass for slack. Tasks with no slack are on the **critical path** (red): if one slips, the finish slips. It handles:

- the four link types (FS, SS, FF, SF) with lead or lag in working time, elapsed time or % of the predecessor;
- the eight constraint types, deadlines, manually scheduled tasks and *as late as possible*;
- progress: a started task's actual start is fixed, and finished work stays where it happened.

A task is **late** when less of it is done than should be by the **status date** (top right). With no status date, "late" is measured against this morning. **Plan → Update progress to the status date** marks work scheduled before the status date as done, like MS Project's *Update Project*.

### Baselines and progress

**Plan → Set baseline** saves every task's start, finish, duration and work as baseline 0–10. The Gantt then draws the baseline as a thin grey bar under each task. *Baseline finish* and *Finish var.* columns show how far each task has moved. The dashboard shows how far the plan's finish has moved against the baseline.

### Team, workload, issues and the dashboard

<img src="screenshots/plan-team.png" alt="Team planner: one lane per person with their tasks as bars, overbooked days in red and days out of office striped" width="900">

- **Team** shows one lane per person, plus *Unassigned*. Drag a bar to another person to reassign it. Overbooked days turn red, and days out of office are striped. Your own time off comes from the Keystone calendar; other people's days off are set in **Plan → People and calendars**, where you also set how much of their time each person can give (*Max %*).
- **Workload** is a heat map of planned hours per person per week against the hours they can work. Holidays and time off are taken out.
- **Issues & risks** is the RAID log: risks (with probability × impact and a 5×5 matrix), issues, actions and decisions. Each can have an owner, a due date and the tasks it affects. From an item's `⋯` menu you can put it on the Board, make it a follow-up, or ask Keystone about it. You can also log an issue from a task's right-click menu.
- **Dashboard** shows the finish date against the baseline, % complete against what's expected, late and critical tasks, hours charged against hours planned, the next milestones and recent changes.

<img src="screenshots/plan-dashboard.png" alt="Plan dashboard: finish date against the baseline, % complete against expected, late tasks, hours charged against planned, next milestones, late tasks and the critical path" width="900">

On **Today**, a *Plans* card lists your late tasks, your tasks this week and milestones in the next two weeks across all plans.

### MS Project files

<img src="screenshots/plan-import.png" alt="Open an MS Project file: a preview of the plan in the file (tasks, links, people, calendars) with a project picker before anything is created" width="900">

- **Open:** **Plan ▾ → Open an MS Project file** reads MS Project XML (**File → Save As → XML** in MS Project). A preview shows what's in the file before anything is created. **Plan → Update from an MS Project file** updates the open plan instead, and lists what was added, removed and changed. Links to timesheet NWAs, Board cards and files are kept.
- **Save:** **Export → MS Project XML** downloads a file MS Project opens with **File → Open**.
- **Nothing is lost on the way through:** everything in the imported file is kept, including fields Keystone doesn't show (extended attributes, cost, outline codes, extra calendars). On export, your changes are written into the original XML.
- **.mpp files** (and `.mpx`/`.mpt`) can be read directly once MPXJ and Java are installed – see the next section. Without them, save the file as XML in MS Project first. Keystone never writes `.mpp`: **Export → MS Project XML** is what you open in MS Project.
- Keystone-only fields (the NWA link, Board card, vault files, issues and risks) aren't written to the XML.

The XML import and export are tested against hand-made MSPDI files that follow Microsoft's schema. Check a real plan before you rely on it: open it, export it, and open the export in MS Project.

### Reading .mpp files (MPXJ and Java)

Optional, and neither step needs admin rights. Keystone itself never needs Java. Without these, everything works except opening `.mpp` files directly.

1. **MPXJ:** `pip install mpxj` into the same Python environment Keystone runs from. Use `pip install --user mpxj` for a user install with the system Python, or `pipx inject keystone-worklog mpxj` if Keystone was installed with pipx. `pip install "keystone-worklog[mpp]"` does the same. Keystone finds it by itself. To use MPXJ jars you downloaded yourself instead, set `KEYSTONE_MPXJ` to their folder.
2. **Java:** download the **Eclipse Temurin JRE 21** (x64) archive from [adoptium.net/temurin/releases](https://adoptium.net/temurin/releases/): the `.zip` on Windows or the `.tar.gz` on Linux. Not the `.msi` or system packages, which need admin rights. Unpack it in your own folder and set `JAVA_HOME`:

   ```powershell
   # Windows (PowerShell)
   Expand-Archive "$HOME\Downloads\OpenJDK21U-jre_x64_windows_hotspot_*.zip" "$env:LOCALAPPDATA\Programs\Java"
   $jre = (Get-ChildItem "$env:LOCALAPPDATA\Programs\Java" -Directory | Select-Object -First 1).FullName
   [Environment]::SetEnvironmentVariable("JAVA_HOME", $jre, "User")
   & "$jre\bin\java.exe" -version
   ```

   ```bash
   # Linux
   mkdir -p ~/.local/java
   tar -xzf ~/Downloads/OpenJDK21U-jre_x64_linux_hotspot_*.tar.gz -C ~/.local/java
   echo 'export JAVA_HOME="$(ls -d ~/.local/java/jdk-* | head -1)"' >> ~/.bashrc
   source ~/.bashrc && "$JAVA_HOME/bin/java" -version
   ```

3. **Restart Keystone from a new terminal** so it sees `JAVA_HOME`, then use **Plan ▾ → Open an MS Project file** and pick the `.mpp`. Keystone looks for `java` on `PATH` first, then in `JAVA_HOME`. If either piece is missing, the message says so.

On an offline computer, download the `mpxj` wheel (`pip download mpxj --no-deps -d wheels`) and the Temurin archive on a connected machine. Copy them over and install with `pip install --no-index --find-links wheels mpxj`. If a company policy blocks running `java` from your own folders, ask IT for Java or use **Save As → XML**. The `.mpp` file is converted on your computer: MPXJ turns it into MS Project XML in a temporary folder, and Keystone reads that.

### Saving, history and templates

- **Saving:** every change saves on its own a moment later. The status next to the plan name shows *Saving…*, then *Saved* with the time. Each plan is one file, `data/plans/p_….json`. The save before it is kept as `p_….bak.json`.
- **Two tabs or two people on one plan:** each save carries a revision number. If the plan changed somewhere else since you opened it, Keystone doesn't overwrite it. A banner offers **Load theirs** or **Keep mine**.
- **Undo** keeps the last 60 changes while the plan is open. Each change is also listed with its time on the Dashboard under *Recent changes*.
- **Deleting a plan** (**Plan ▾ → Delete this plan**) moves the file to `data/plans/.trash/`. Nothing is deleted outright, so a plan can be restored by moving it back.
- **Templates** are plans marked as templates. They're listed under **New plan**, not in the plan picker. **Plan → Save as a template** makes one from the open plan without dates, progress, issues or the project link.
- **Calendar:** a plan uses your work schedule and holidays from Settings. The calendar is copied into the plan when it's made. If you change your schedule or holidays later, use **Plan ▾ → Use my work schedule and holidays as the calendar** to update it. An imported plan keeps MS Project's calendar until you do.

### Limits

- No automatic resource leveling. The Team and Workload views show who is overbooked; you move or reassign the work.
- No links between plans. MS Project's own cost fields are kept and exported unchanged, but not shown; Keystone's costs come from the ERP and your rates (below), and aren't written to the MS Project file.
- People's own days off feed the Team and Workload views, not the scheduling: a task still runs through a person's days off.
- Undo of a change Keystone's assistant made to a plan is lost when the page is reloaded. The plan's undo history (`Ctrl+Z`) works as usual.

### Other exports

**Export** also saves an **Excel/CSV** table, **milestones** or one person's tasks as a calendar file (`.ics`), a **summary note in Obsidian** (milestones table, a Mermaid Gantt and open issues, in `Keystone/Plans/`), and **Print / PDF**. **Plan → Save as a template** keeps the tasks, links and durations (no dates or progress) for the next New plan.

### Asking Keystone about a plan

Profiles with tracker access can read and change plans. Try:

- *What's late on the Girder Bridge plan and what's driving the finish date?*
- *What if the FE model takes 4 more days?* (Keystone uses **simulate**, which saves nothing.)
- *Add a QA check after the load rating, 2 days, Priya.*
- *Log a risk that the pier 3 access permit is late, high impact, for task 9.*

Changes are shown with their effect on the schedule (the finish date, tasks that move, deadlines missed) for you to **Apply** or **Reject**, and can be undone.

## Team costs, status reports and the portfolio

The timesheet tracks **your** hours. A project is run by a team, though, and its budget is in dollars. Keystone brings everyone's hours and dollars in from your ERP, adds the charges the ERP leaves out, and turns that into earned value, a weekly status report and a view across all your plans.

### People & rates (Settings)

<img src="screenshots/people-rates.png" alt="Settings, People & rates, Cost models tab: a County contract model starting from ERP pay plus fringe, with overhead 85% of pay plus fringe, a 6% service charge on the running total and $4.25 per hour for IT and admin, about 2.57 times pay" width="900">

**Settings → People & rates** (or `Ctrl+K` → *People & rates*) has four tabs:

- **People:** one list for every plan and every import. Each person has a name, **ERP aliases** (how the ERP writes them, like `LOPEZ, MARIA`), an employee ID, a labor category, *Max %* and whether it's you. Plans link their people to this list by name, so the same Maria is overbooked across all plans, not one at a time. The import adds aliases for you the first time you match a name.
- **Rates:** base pay per hour, **from a date**, for a person, a labor category, or a default. A raise only changes charges from its date on. Keystone uses the person's own rate first, then their category's, then what the ERP shows they cost (pay ÷ hours on their lines), then the default. A missing rate is flagged, never quietly $0.
- **Cost models:** how a charge becomes its *full* cost. Pick one per project.
  - **Start from ERP pay + fringe:** use the pay and fringe amounts on each ERP line. *Fringe %* is only used for planning and for lines without a fringe amount.
  - **Start from hours × rate:** ignore the ERP's dollars and cost the hours from the rates, plus fringe %.
  - **Then add** charges, in order: *% of pay*, *% of pay + fringe*, *% of the total so far* (compounding, e.g. a fee on everything), or *$ per hour*. Each can start from a date (e.g. a new overhead rate).
  - **Overtime multipliers** (`OT=1.5`) apply to hours × rate; ERP pay already includes the premium. **Non-labor %** is added to lines without a person or hours (travel, materials).
  - The card shows the effective multiplier (*≈ 2.57 × pay*). Hover any charge in a ledger to see its working: *pay $520.00 + fringe $161.20 + Overhead $579.02 + Service charge $75.61 + IT & admin $34.00 = $1,369.83*.
- **ERP layouts:** the column layouts saved by the import, the **master** layout, and the currency symbol.

**Pay data stays private.** `data/people.json` and the ledgers are owner-only files, they're in the daily backup, and the AI assistant never receives pay rates (see [Asking Keystone about costs](#asking-keystone-about-costs-and-status)).

### Importing hours and dollars from the ERP

<img src="screenshots/erp-import.png" alt="Import from the ERP, step 2: the master layout Labor distribution report is applied automatically; each Keystone field (date worked, posting date, person, employee ID, hours, pay, fringe, network) is mapped to a column of the export, with a preview of the first rows" width="900">

Run your ERP's labor report for the projects, then **Plan → Costs → Import from ERP**, **Projects → Import from ERP**, or `Ctrl+K` → *Import costs from the ERP*:

1. **Bring it in:** drop or choose an `.xlsx`/`.csv` file, or paste rows copied from the ERP or Excel (with the header row). Title rows above the header are fine.
2. **Choose the columns** – once. For each thing Keystone needs, pick the column of *your* export:

   | Keystone field | Notes |
   | --- | --- |
   | **Date worked** (required) | The day the work was done: used for progress, rates and putting hours on tasks |
   | **Posting date** | When the ERP posted it: decides which earlier lines an export replaces. Without it, the date worked is used |
   | **Person** | A name column, or *Last name* + *First name* |
   | Employee ID | Matched before the name when it's there |
   | **Hours**, **Pay amount**, **Fringe amount** | At least hours or pay. Numbers like `1,234.50`, `(1,234.50)` and `1,234.50-` all work; tick *Decimal comma* for `1.234,50` |
   | Network / activity | One column, or two. Sends each row to the project with that NWA; without it, everything goes to one project you choose |
   | Task / WBS code, pay type, cost element, document no., description | Optional |

   Keystone guesses from the header names; the preview shows the rows as it reads them. Tick **Save these columns as a layout** and **Master layout**: from then on, any export with those columns opens straight at the preview, even if the ERP reorders them, because layouts remember column *names*.
3. **Match projects and people:** NWAs that aren't in Projects can be ignored, added as new projects, or sent to an existing one. Names that aren't in People & rates can be added as new people, matched to someone (*Same person as…*, which saves the alias) or left unmatched for now.
4. **Check and import:** totals per project (lines, hours, ERP pay + fringe, full cost) and the **posting dates the export covers**.

**Re-importing is safe.** An ERP export is the truth for the period it was run for, so a new import **replaces** the lines of earlier imports whose posting date falls in the range it covers, reversals and corrections included. The check step says how many lines it replaces. Each project's **most recent import can be undone** (**Ledger & budget… → Undo the last import**): its lines go, the lines it replaced come back. Nothing is deleted outright; replaced and undone lines are kept in `data/costs/.trash/`.

**Your own hours** are on the ERP too. **Ledger & budget…** compares your timesheet with the ERP week by week, so you can spot a day the portal never posted or hours charged to the wrong NWA. The ERP always runs behind, so for days after the last posting Keystone adds your own timesheet hours as *not yet posted*. Other people have nothing for those days until the next import.

### A project's ledger and budget

**Projects** has two new columns: **Budget ($)** for the whole team, and **Cost (team)**, the full cost so far and its share of the budget. **Costs** on each row (or **Plan → Costs → Ledger & budget…**) opens the project's ledger: budget, contingency, cost model, totals, cost by person (ERP pay, fringe, full cost), the imports, your timesheet against the ERP, and every charge line (filterable, exportable to CSV).

### The Costs view and earned value

<img src="screenshots/plan-costs.png" alt="Plan, Costs view: cost to date $46,449 (50% of the $156,000 budget used), forecast at completion $124,516, CPI 0.94, SPI 0.77, money runs out not before the finish, and an S-curve of planned value, earned value, actual cost and the forecast against the budget" width="900">

**Plan → Costs** shows the plan's money (switch **$ / Hours** at the top):

- **Planned cost** of every task: each person's planned hours × their full cost per hour on those days (a July raise only changes work after July). **Setting a baseline saves each task's planned cost with it**: that's what earned value measures against.
- **Actual cost** from the ERP, put on tasks: the task column when the export has one; otherwise the tasks **that person** was scheduled on that day, split by their planned hours; otherwise the NWA's tasks that day; otherwise *Not assigned to a task* (still counted in the totals).
- **Earned value:**

  | | What it is |
  | --- | --- |
  | **PV**, planned value | The baseline cost of the work that should be done by the status date |
  | **EV**, earned value | The baseline cost of the work that *is* done (baseline cost × % complete) |
  | **AC**, actual cost | What the work cost: ERP charges (+ your unposted hours) |
  | **CPI** = EV ÷ AC | Below 1: the work costs more than planned |
  | **SPI** = EV ÷ PV | Below 1: behind schedule |
  | **Forecast at completion** | AC + (baseline cost − EV) ÷ CPI. The assistant also gives *if the rest goes to plan* and *bottom-up* (remaining planned cost) |
  | **Money runs out** | When cost so far plus the plan's remaining cost crosses the budget |

- **The S-curve** draws cumulative planned value (baseline), earned value (one point per weekly status, plus today), actual cost, the forecast to the finish, and the budget. Hover for the values on any day.
- **Tables:** by person (hours, cost, share, cost still to come), by month (planned against actual, and non-labor), by task (baseline, planned, actual, cost variance), and charges not assigned to a task.
- **Same dates:** EV uses progress as of the *status date*; AC uses charges up to the last day of work the ERP covers. When those are more than a week apart, a banner says so and offers to set the status date to match.
- **Before the plan:** charges to the NWA from before the plan started count against the **budget** (the tile says how much), but not in earned value or the charts.
- A baseline set before costs were tracked has no costs: a banner offers **Add costs to baseline N** (today's rates, each task's planned hours).
- The **grid** has optional *Cost*, *Baseline cost* and *Actual cost* columns (**Columns ▾**), *Actual h* uses ERP hours when the project has them, and the **Dashboard** shows *Cost to date* and *Forecast cost* with CPI and SPI.

### Estimating a task: hours and a budget

Each task can carry two estimates, and both are compared with what it actually took:

- **Hours.** Show the **Planned h** column (**Columns ▾**) and type the hours the task needs, e.g. `120`. The duration follows from the people on it, like MS Project's *Work* with fixed units: 120 h with Maria full-time and Priya half-time takes 120 ÷ 1.5 = 80 working hours = 10 days. With nobody assigned, the hours are the duration. In **Task details → Estimate**, set the hours **per person** instead (e.g. Priya 20 h instead of 12): that sets their share of the task.
- **Budget ($).** Show the **Budget $** column and type a dollar amount, or use **Task details → Estimate → Budget**. The budget is **your separate check**: it sits next to the cost Keystone works out from people's rates and never replaces it. A summary task's budget is its own when you type one, otherwise the sum of its tasks' budgets (shown in italics) – and then it's compared only with the tasks that have a budget.

How it's compared:

| | Hours | Cost |
| --- | --- | --- |
| **Baseline** | the original estimate, saved with **Set baseline** | the cost at the original estimate |
| **Planned** | the current estimate (what you typed, or duration × people) | planned hours × people's full rates |
| **Actual** | hours charged (ERP, and your timesheet) | full cost of those charges |
| **Forecast** | actual + planned × the part not done yet | the same, in dollars |

A task turns **red** when its forecast hours pass the planned hours, or when the forecast of what a budget covers passes the budget. **Budget left** is the budget minus what's been spent. Because the forecast uses **% complete**, keep it up to date: a task with hours charged but still at 0% forecasts all its planned hours on top.

Everything is in the grid columns, in **Task details → Estimate** (a small table of baseline, planned, actual and forecast with the budget), and in **Costs → By task**, which also lists the tasks heading over their budget. The status report names tasks heading over their budget, and the assistant can set them: *"Give the cost estimate 48 hours and a $5,000 budget."* Budgets are Keystone-only: they aren't written to the MS Project file (typed hours are, as each assignment's work).

### Close the week and the status report

<img src="screenshots/plan-status.png" alt="Plan, Status view: the last status At risk, a milestone trend chart with 60% plans submitted and PS&E submitted drifting a day later each week, and the status history table" width="900">

Once a week, **Plan ▾ → Close the week…** (or **Status → Close the week…**). On Fridays, Today reminds you for each plan.

<img src="screenshots/close-week.png" alt="Close the week dialog: the facts (finish against baseline, % complete against expected, cost, CPI, SPI, forecast), red/amber/green for overall, schedule, cost and scope with the suggested colour and the reason, and drafted Done this week and Next week lists" width="900">

- **Red/amber/green** for overall, schedule, cost and scope, **suggested from the numbers**: SPI or CPI below 0.95 is amber, below 0.85 red; the finish moving 5+ working days since the last status is amber (15+ red); a forecast over budget is amber (10% over: red). Without costs, schedule compares % complete with what's expected. Overall is the worst of the three. You can change any of them, but a colour that differs from the suggestion needs a reason, because "why is it green?" is the first question you'll get.
- **Done this week** and **Next week** are drafted from the plan (tasks finished since the last status; tasks starting or due in the next 7 days), and **Decisions or help needed** from open decisions and high risks. Edit them freely.
- Saving makes a **snapshot**: the numbers, milestone dates and task dates of that day, frozen, so a past report never changes. Saving again on the same status date updates it.
- **The report** is written from the snapshot by a fixed template (no AI needed, exact numbers, never any rates): summary, milestones (baseline, last week, now, change), done, next, budget (budget, cost, EV, PV, CPI, SPI, forecast), risks and issues, decisions. Send it as **a note in Obsidian** (`Keystone/Status/<plan>/<date>.md`), an **email draft** (`.eml`, opens as a draft in Outlook), **Copy for an email** (formatted), or **Print / PDF**.
- **Plan → Status** shows the **milestone trend chart** (each milestone's forecast date at each status: flat is holding, rising is slipping a little every week, the dashed diagonal is "today"), the status history, and **What changed since** a status or a baseline: tasks moved (by how much), progress, tasks added or removed, issues and risks opened or closed.

### All plans (portfolio)

<img src="screenshots/plan-portfolio.png" alt="All plans: a table of each plan with its status, finish against baseline, % done against expected, late tasks, cost against budget and next milestone, and the milestones of every plan on one timeline" width="900">

**Plan ▾ → All plans (portfolio)** (or pick it in the plan picker):

- **One row per plan:** last status, forecast finish against the baseline, % done against expected, late tasks, cost against budget and the next milestone. Click a row to open the plan.
- **Milestones across plans** on one timeline; weeks with three or more milestones due are shaded.
- **People across all plans:** planned hours per person per week from every plan against the hours they can work (holidays, days off and *Max %* taken out). `·2` means they're on two plans that week; hover for the split.
- **Who's free:** pick dates and the hours you need, and see everyone ranked by free time.

### Asking Keystone about costs and status

Profiles with tracker access also get **cost_summary**, **who_is_free**, **portfolio_summary**, **status_draft** and **close_week** (which shows the snapshot for **Apply** and can be undone). Try:

- *How is the bridge project doing on cost? Who is burning the budget?*
- *Who has 40 hours free in the first two weeks of November?*
- *Draft this week's status for the Girder Bridge plan.* → *Save it, but make schedule amber: recovery plan agreed with the county.*
- *Which of my plans are off track?*

Each AI profile has **Allow cost data** (Settings → AI assistant), **off by default**. Off, the tools give hours, ratios like CPI and SPI, and dates, with every dollar amount hidden. On, they include dollar totals. **Pay rates are never sent** either way; keep the switch off for cloud models.

## Obsidian vault

In **Settings → Obsidian vault**, click **Choose vault…** and browse to your vault folder (the one that contains `.obsidian`). From then on, every save writes these notes into a sub-folder of the vault (default `Keystone/`, changeable in Settings):

```
Keystone/
  Keystone.md                  home page (named after the folder): projects, remaining hours, recent timesheets
  Deliverables board.md        every deliverable, grouped by status
  Follow-ups.md                emails to answer, grouped by status
  Leave balances.md            balances and the pay period ledger
  Projects/<project name>.md   budget, used and remaining hours, deliverables as tasks, hours by period
  Timesheets/Timesheet <period start>.md
```

**What you can edit in these notes:**

- Each note has a generated block between `<!-- nwa-tracker:start -->` and `<!-- nwa-tracker:end -->`. The app rewrites it on every save.
- **Anything outside that block is yours.** For example, the `## Notes` section of a project note is never touched. Your text survives when the project is renamed (the file is renamed with it).
- In a project note's **Deliverables** list you can:
  - **tick or untick** a task to mark the deliverable done or not done on the Board;
  - **add a new line** such as `- [ ] Write QA plan 📅 2026-11-02` to create a new deliverable for that project.
- Other edits inside the block (retitling a task, changing hours, and so on) are overwritten. Make those changes in the app.
- Facts like `network:: 4001234` and `remaining-hours:: 160` are [Dataview](https://blacksmithgu.github.io/obsidian-dataview/) inline fields. With that plugin installed you can query them, for example to list projects with fewer than 20 hours left.

**When changes from Obsidian are picked up:** every time the app saves, when you switch back to the app's browser tab, and when you save a tracker note in the Notes tab.

### Notes tab

- **Editor:** Edit / Split / Preview modes. `Ctrl+S` saves, but notes also autosave as you type. Lists and checklists continue when you press `Enter`.
- **Links:** `[[wikilinks]]` work. Clicking a link to a note that doesn't exist offers to create it.
- **Math:** LaTeX renders the way Obsidian writes it: `$inline$` and `$$ display $$` blocks (`\frac`, `\sum`, `\begin{aligned}`, and so on), using [KaTeX](https://katex.org). A `$` inside `code` or written as `\$` stays a plain dollar sign.
- **Images:**
  - `![[photo.png]]`, `![[photo.png|300]]` (sets the width) and `![alt](relative/path.png)` all show in the preview. Click an image to open it full size.
  - Image files appear in the tree. Clicking one opens a viewer with its size and a **Copy embed** button.
- **Pasting or dropping an image** into the editor saves it into the vault and inserts `![[…]]` at the cursor. The image goes to the attachment folder set in Obsidian (*Settings → Files and links → Default location for new attachments*). Pasted images are named `Pasted image 20261023140509.png`, like Obsidian does.
- **Editing in both places:** if a note changed in Obsidian since you opened it here, the app asks which version to keep instead of overwriting it.
- **Delete:** moves the note or image to the vault's `.trash` folder, the same place Obsidian uses.
- **Obsidian button:** opens the current note in the Obsidian app.
- **Documents:** PDFs open in the browser's own viewer (**Pages**) or as extracted text (**Text**); other documents show their text – code and solver output in a fixed-width font, with an *Errors, warnings and status* summary at the top of solver files. **Open in app** opens a file with its usual program on your computer (never scripts or programs), **Show in folder** reveals it, and the ✦ button asks Keystone to summarize it. Links such as `[[Bridge spec.pdf#page=12]]` open a PDF at that page.
- **Inbox:** when `Inbox/` (or the folder set in Settings) has files, a **File the inbox** button appears above the tree – see [Filing the inbox](#filing-the-inbox).

### Right-click menu in the file tree

| Right-click on | Options |
| --- | --- |
| A folder | New note here · New from template ▸ *(each template)* · New folder here · Rename folder · Copy folder path |
| A note | Open · New note in this folder · New from template ▸ · Copy link `[[…]]` · Open in Obsidian · Rename · Delete |
| An image | Preview · Insert into the open note · Copy embed `![[…]]` · Open in Obsidian · Rename · Delete |
| A document | View here · Open in its app · Show in folder · Ask Keystone to summarize it · Copy link · Copy path |
| The Inbox folder | File these files… · Ask Keystone to file them · then the usual folder options |
| The vault name or empty space | New note or new from template in the vault root · New folder |

The menu also opens with the keyboard (the Menu key or `Shift+F10`). Use `↑ ↓` to move, `Enter` to choose and `Esc` to close. Renaming doesn't update links in other notes. Obsidian does that when you rename inside Obsidian.

### Templates

- **Where templates come from:** any note in your templates folder is a template. The app uses the folder from Obsidian's core *Templates* plugin (*Settings → Templates → Template folder location*), or `Templates` if none is set. You can override it in **Settings → Obsidian vault**.
- **Starting a note from a template:** right-click the folder the note should go in, choose the template under **New from template**, type a name and click **Create**. The **+ Note** button opens the same dialog.
- **Filled in when the note is created:** `{{title}}`, `{{date}}` and `{{time}}`. Custom formats like `{{date:dddd, MMMM D, YYYY}}` or `{{time:h:mm A}}` work too, using the same tokens and default formats as Obsidian. Templater plugin syntax (`<% … %>`) is not run.
- **Starter templates:** **Add starter templates** (in Settings, or in the menu when the folder is empty) adds *Meeting notes*, *Project brief*, *Daily log* and *Calculation* (which includes a LaTeX example). Existing files with the same names are never overwritten.

## AI assistant: Ask Keystone

Open it beside **any page** with the **✦ Ask** button in the top bar or `Ctrl+J`. It stays open, with the same conversation, as you switch tabs. The **Assistant** tab shows the same chat full width, with your chat history.

**Page context:** Keystone knows which page you're on, for example the pay period on the Timesheet, the project filter on the Board, or the note open in Notes. Its suggested prompts change to match. Tracker numbers are only shared with profiles that have tracker access. Turn this off with the **Page context** chip.

Examples:

- "What did we decide about the drainage memo?"
- "Add today's call with the county to the Bridge project note."
- "Turn my open note's action items into a checklist."

### Setup

In **Settings → AI assistant**, add one or more **profiles**. Any server with an OpenAI-compatible `/chat/completions` API works:

| Profile field | Notes |
| --- | --- |
| Base URL | e.g. `http://localhost:11434/v1` (Ollama), `http://localhost:1234/v1` (LM Studio), `http://localhost:8080/v1` (llama.cpp / vLLM), `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`. |
| Model | Type it in, or click **Load** to list the models the server has. |
| API key | Optional for local servers. Stored only in `data/llm.json` (owner-only, git-ignored) and never sent back to the browser. |
| Allow tracker access | Lets that model read hours, budgets, leave and deliverables (`tracker_summary`) and add deliverables. Typically on for a local model, off for a cloud one. |
| Stream replies | Shows answers as they're written. Turn it off if a server has trouble streaming tool calls. |

**Test connection** checks that the server answers *and* that the model can call tools, which the assistant needs. Switch profiles from the dropdown at the top of the assistant panel.

### What it can do

| Tool | |
| --- | --- |
| `search_notes` | Keyword search plus meaning search (see below), merged – notes and documents, with the page, slide, sheet or function a match is in |
| `read_note`, `read_document`, `list_folder`, `list_templates`, `get_open_note` | Read notes and documents (by parts: pages, slides, sheets, cells…), folders, the template list, and the note you have open (plus any selected text) |
| `vault_map`, `suggest_folder`, `move_files` | Filing: the folder structure with counts, examples and folder descriptions; where a file probably belongs; and moving any files, shown as one editable table you approve |
| `create_note`, `edit_note`, `append_to_note`, `move_note` | Change the vault. `edit_note` replaces one exact passage, so it can't hit the wrong spot. `move_note` never overwrites and reports notes that link to the old name. |
| `tracker_summary`, `add_deliverable`, `update_deliverable`, `remove_deliverable`, `get_timesheet`, `update_timesheet`, `list_followups`, `add_followup`, `update_followup` | Only offered to profiles with tracker access |
| `recent_notes` | Notes changed in the last N days (used by the weekly status report) |

There is **no delete tool**.

- **Approving edits:** by default every change is shown as a diff with **Apply** / **Reject**. You can switch to *Apply automatically* in Settings.
- **Undo:** each applied change has an **Undo** button. Undoing a newly created note moves it to `.trash`; it is never deleted.
- **Edits that can't conflict:** if the note changed after you saw the diff, nothing is applied and the assistant re-reads it. Tracker-generated blocks can't be edited.

### Git history

With **Git-commit every assistant change** on (the default), each applied change or undo becomes its own commit in the vault, for example `Assistant: Add under "Notes" in Work/Bridge/Load check.md`. Each commit contains only the files that change touched, so your own uncommitted work is left alone.

If the vault isn't a git repository yet, Settings offers **Set up git in the vault**. That runs `git init`, adds a `.gitignore` for `.trash/` and Obsidian's workspace files, and commits the current state as a starting point.

To go back:
- **Recent change:** use **Undo** in the chat.
- **Older change:** use git, for example `git log` then `git revert <hash>`, or the Obsidian Git plugin.

### Meaning search (local embeddings)

Notes and documents are split into chunks (by heading, page, slide, sheet, function or cell) and embedded **in your browser** with `all-MiniLM-L6-v2`, a 23 MB quantized model that runs in a background worker. The vectors are stored on disk with **LanceDB** in `data/index/`.

- **Staying current:** the index updates as you go. Files you save, files the assistant changes and files edited elsewhere are re-embedded within a few seconds while the app is open. Only changed files are processed, each at most once per pass; a file that keeps changing (a solver job that is still running, a log) waits until it has been quiet for 30 seconds.
- **Memory:** the model uses roughly 100 MB while it works and is unloaded after 5 idle minutes.
- **GPU or CPU:** with a GPU, Edge and Chrome (and recent Firefox) run the model through WebGPU, usually 5–20× faster on a big vault; otherwise it runs on the CPU with several threads. WebGPU isn't equally reliable everywhere (some Linux drivers return wrong numbers or never answer), so Keystone only uses the GPU after its results match the CPU's on a test sentence, checks every GPU batch, and gives up on a GPU that doesn't answer. In any of those cases it switches to the CPU by itself, says why under **Settings → Search index**, and starts on the CPU in that browser for a week. Choose *CPU only* there to skip the GPU entirely; choosing *GPU when available* again gives it another try. The GPU uses the full-precision model file (about 90 MB, downloaded or bundled once).
- **Offline:** the model and its runtime are downloaded once, through the app, into `data/models/`, and served locally after that.
- **Turn it off,** or rebuild the index, in Settings.

### Documents: PDF, Word, PowerPoint, Excel, emails

With **Settings → AI assistant → Search documents too** (on by default), the assistant searches inside the documents in your vault, not just your notes, and can find a file by what it says.

| Type | Read with | Results point to |
|---|---|---|
| PDF (`.pdf`, with a text layer – OCR'd scans work) | pypdf | the page |
| Word (`.docx`) | python-docx | the heading; tables included |
| PowerPoint (`.pptx`) | python-pptx | the slide and its title; speaker notes included |
| Excel (`.xlsx`) | openpyxl | the sheet; rows read as “Header: value” |
| Emails (`.eml`, or saved as `.txt` with From/Sent/To/Subject at the top) | built in | the email; readable attachments are searched too |
| Text, CSV, HTML, RTF | built in | – |
| Python (`.py`) | built in | the function or class (`def load_case (line 42)`) |
| Jupyter notebooks (`.ipynb`) | built in | the cell, with its text output and errors |
| Abaqus and other solver files (`.inp`, `.msg`, `.dat`, `.sta`, `.log`, `.out`, Nastran, ANSYS, LS-DYNA…) | built in | **Errors, warnings and status** (every `***ERROR`/`***WARNING`, counted once, plus completion lines), then the text |
| Any other plain-text file (code, configs, data, files without an extension) | built in | – |

- **Everything runs on this computer:** text is extracted by the Keystone server, embedded by the same in-browser model as notes, and stored in `data/index/`. Extracted text is cached in `data/index/docs/` and re-read only when a file changes.
- **Finding files:** ask *“find the spec that covers bearing pads”*. Results show the file, where the match is (page, slide, sheet, email) and a snippet. Links like `[[Bridge spec.pdf#page=12]]` open the PDF at that page.
- **Keyword + meaning:** exact terms (network numbers, drawing numbers, names) are found by keyword search, ideas by meaning search; results from both are merged.
- **Notes tab:** documents appear in the file tree. A PDF opens in the browser's own viewer (**Pages**) or as extracted text (**Text**); other types show their text. **Open in app** opens the file with its usual program on this computer and **Show in folder** reveals it.
- **Plain-text files:** a file counts as text if its first 8 KB are text, so binary files with text-like names (a binary `.dat`, an Outlook `.msg`, `.odb`, `.prt`, `.sim`) are skipped. Big solver output is read as its start and end, and the whole file is scanned for errors, warnings and completion lines; large Abaqus input decks also keep a **Model keywords** section (`*Material`, `*Step`, element types). Turn off **Any other plain-text file** in Settings to keep only the listed types. Scripts are never launched by **Open in app** – use **Show in folder**.
- **Limits:** PDF and Office files over 60 MB are skipped; spreadsheets are read up to 5,000 rows per sheet. A PDF without a text layer, or a broken or password-protected file, is still found by its name; Settings lists the files that couldn't be read.
- **Speed:** the first index of a large folder of documents takes a while (roughly 20–50 chunks a second, while Keystone is open); after that only changed files are processed. Notes are indexed first.
- **Not supported:** old binary Office files (`.doc`, `.xls`, `.ppt`) and Outlook `.msg` files are listed and can be opened in their app, but aren't searched. Save emails as `.eml` or text.

### Filing the inbox

Drop new files into the vault's **Inbox** folder (change its name in **Settings → Obsidian vault**). **Notes → File the inbox** (also on the Inbox folder's right-click menu, in Ctrl K, and in Today's *Heads up*) opens a review table with a suggested folder for every file:

- **How it decides:** files with the **same name or job name** elsewhere (`girder_v4.inp` goes where `girder_v3.inp` is), and files with **similar content** in the search index – only matches clearly above the background count, and each extra match from the same folder counts half, so a big folder can't win by volume. Before a file is embedded, its most telling words are used instead. Files of the same job in the inbox are kept together.
- **Confidence:** *High* and *Medium* rows start ticked; *Low* and *No match* rows start unticked. Click another suggestion or type any folder (new folders are created); untick anything to leave it.
- **Moving:** nothing moves until you click **Move**. Files are never overwritten or deleted, the whole batch can be undone in one click, and with git turned on the move is committed – only for files git already tracked, so moving a large `.odb` or PDF never adds it to the repository.
- **With the assistant:** **Ask Keystone instead** (or *“file my inbox”*) lets the model use `vault_map` (folders, counts, examples and folder descriptions from a folder note or README), `suggest_folder` and `read_document` to decide, and propose everything in one `move_files` table that you can edit before applying. If you change its plan, it offers to record the lesson in a **Filing rules** note, which it reads next time.

### Big vaults and OneDrive

Keystone is built to stay responsive on a vault of thousands of files:

- **Listing never opens files.** The Notes tree and the index status are worked out from names and folder listings only (on Windows the file sizes and dates come with the folder listing). Whether a file of unknown type is really text is checked once, when it is indexed; binary files are then marked *Not text* and left alone.
- **OneDrive / Dropbox "online-only" files are skipped** unless you tick *Include online-only files* – reading them would download them. Use *Always keep on this device* on the vault folder if you want everything indexed.
- **Skip folders** you don't need searched (archives, raw results) and set the **largest file to index** (100 MB by default) in **Settings → Search index → What to index and how**. Skipped files are removed from the index.
- **Documents are read in a separate process,** so a big PDF never freezes the app, and a file that takes more than 3 minutes is given up on. PDFs are read up to 500 pages, and huge solver files are scanned for errors and warnings up to 256 MB.
- **The vault scan is reused for 15 seconds** and refreshed straight away after you save or move files in Keystone.
- **The search index stays out of OneDrive.** It is a cache that changes constantly while indexing, and a syncing folder locks files mid-write (Windows reports *Access is denied*). If the data folder is inside OneDrive, Dropbox or a similar folder, the index is kept in `%LOCALAPPDATA%\keystone-worklog\` (Windows) or `~/.cache/keystone-worklog/` instead; the console shows where at start-up. Set `KEYSTONE_INDEX_DIR` to choose yourself. All of Keystone's saves also retry for a few seconds when a file is briefly locked, and an indexing pass carries on past a file it couldn't save.
- **Slow requests are logged** to the console (`[keystone] slow request: …`), so you can see where time goes; set `KEYSTONE_SLOW_LOG=0.5` to log more.

The first index of a large vault still takes a while – notes go first, then documents, newest first – and runs only while Keystone is open in a browser tab.

### Search index status

**Settings → Search index** shows what the assistant can search: a progress bar, the file being read right now, the speed and whether it runs on the GPU or CPU, about how long is left, and a table of every file – **Indexed** (with its number of chunks and when), **Waiting**, **Changed** (re-indexing), or **Couldn't read** (with the reason). Filter it by status or name, start a pass with **Index now**, or **Rebuild** from scratch. While indexing runs, a **Indexing 43%** chip in the top bar shows progress on every page; click it for the details. Indexing happens in the browser tab, so it only runs while Keystone is open.

### Offline / air-gapped

Start with `keystone-worklog --offline` (or set `KEYSTONE_OFFLINE=1`) and Keystone never connects to the internet: the embedding model must come from the bundle (`--models-dir`), and nothing is downloaded. Document reading, embedding, search and opening files all happen on the computer. The only thing that can leave it is what you send to an AI model profile you set up – use a local model (Ollama, LM Studio, llama.cpp) to keep everything on the machine.

### Privacy

- **Local model** (e.g. Gemma on Ollama or LM Studio): nothing leaves your computer.
- **Cloud model:** the notes the assistant reads, and your messages, are sent to that provider. Tracker data is only sent if that profile has tracker access.
- **Instructions in notes:** text inside notes is treated as data, never as instructions.
- **Chat history:** saved locally in `data/chats/`.

## Your data

Paths are inside your data folder: `./data` in a source checkout, otherwise the user data folder shown at startup (see [Install](#install) above).

| File | What it is |
| --- | --- |
| `data/data.json` | All tracker data: projects, timesheets, deliverables and settings. |
| `data/data.json.bak` | The previous save, as a safety net. |
| `data/vault_manifest.json` | Which vault note belongs to which project, and the last exported tick states. It's rebuilt if deleted. |
| `data/llm.json` | Assistant profiles and API keys (git-ignored, owner-only). Not included in **Download backup**. |
| `data/index/` · `data/models/` | Meaning-search index and the cached embedding model. Safe to delete; both are rebuilt. |
| `data/chats/` · `data/assistant_undo/` | Assistant chat history and undo records. |
| `data/plans/` | One JSON file per project plan (`p_….json`), plus a `.bak.json` with the previous save and `.status.json` with its weekly status snapshots (owner-only). Deleted plans go to `data/plans/.trash/`. |
| `data/people.json` | People & rates: the team directory, pay rates, cost models and ERP layouts (owner-only). |
| `data/costs/` | One ERP cost ledger per project (owner-only). Lines replaced by a newer import, and undone imports, are kept in `data/costs/.trash/`. |
| `data/backups/` | One dated copy of `data.json` per day you use Keystone (the last 60). Restore one from **Settings → Reminders & backups**. `costs-<date>/` folders hold that day's `people.json` and cost ledgers. |

**Optional git history:** turn on *Keep a private git history of data.json* in Settings. Keystone creates a separate repository in `data/.git` that tracks only `data.json`, never API keys, chats or caches, and makes one commit a day. It's separate from the code repository.

**Settings → Backup** downloads or restores the whole tracker as one JSON file. Notes in your vault are separate; back them up like the rest of your vault.

## Security

The app can read and write files in your vault, so:

- It only listens on `127.0.0.1` and refuses requests addressed to any other host name.
- Note reads and writes are locked inside the chosen vault folder. Paths that use `..`, absolute paths, hidden folders like `.obsidian`, and symlinks pointing outside the vault are all refused. Only `.md` files can be edited.
- Documents are only read. PDFs are shown in the browser's own viewer; every other document is offered as a download, never rendered as a page of the app. **Open in app** only opens notes, images and documents – never scripts or programs (`.py`, `.sh`, `.bat`, `.exe`…), which can only be shown in their folder.
- Moving files (filing the inbox) never overwrites or deletes anything and never leaves the vault; a whole batch is undone in one step.
- Uploads must be PNG, JPG, GIF, WebP or BMP images under 25 MB, and never overwrite an existing file.
- The folder picker can list folder names (not file contents) anywhere on your computer. That is how you choose the vault.

Don't change `host` in `app.py` to expose the app on a network.

## Files

```
keystone_worklog/
  app.py               Flask server: data API, folder picker, notes API, assistant routes, the keystone-worklog command
  vault.py             Markdown export and syncing deliverable ticks back from the vault
  assistant.py         assistant back end: profiles and keys, chat proxy, vault tools, undo, git commits
  vector_index.py      note and document chunking and the LanceDB vector index
  msproject.py         MS Project XML (MSPDI) import and export; .mpp through MPXJ when it's installed
  costs.py             reading ERP exports (Excel, CSV, pasted rows) and the per-project cost ledgers
  documents.py         text from PDF, Word, PowerPoint, Excel, emails, code, notebooks, solver files and any text file (+ the text cache)
  offline_bundle.py    keystone-worklog-bundle: model + Python packages for air-gapped computers
  static/index.html    the whole web app (HTML, CSS and JS in one file)
  static/embed-worker.js  in-browser embedding model (runs in a Web Worker)
  static/planner/      the Plan tab (ES modules): engine.js (scheduling), gantt.js (canvas timeline),
                       ui.js (grid, dialogs, import/export), views.js (team, workload, issues, dashboard), ai.js (assistant tools),
                       costs.js (rates, cost models, earned value), costui.js (People & rates, ERP import, Costs view),
                       status.js (Close the week, reports, milestone trend), portfolio.js (all plans)
  static/vendor/       marked (Markdown), DOMPurify (HTML sanitizer) and KaTeX (math)
app.py                 runs the app from a source checkout (python app.py)
scripts/make_demo.py   builds the demo data (./demo) used for the README screenshots
tests/                 Python tests (unittest) and tests/js/ (Node's built-in test runner)
pyproject.toml         package metadata (PyPI name: keystone-worklog)
LICENSE                MIT
THIRD_PARTY_NOTICES.md licenses of the bundled and downloaded components
```

## Development and tests

No extra packages are needed. The Python tests use `unittest`, and the JavaScript tests use Node 18+'s built-in runner.

```bash
python -m unittest discover -s tests -v     # API, vault export and sync, assistant tools, capture, chat proxy, index, documents, filing, MS Project XML, plans, ERP costs
node --test tests/js/*.test.mjs             # holidays, schedules, pay-period check, burn rate, capture, emails, leave, timer, calendar import, plan scheduling, costs and earned value
```

- **Isolation:** each Python test gets its own temporary data folder and vault (through `KEYSTONE_DATA_DIR`), so tests never touch your own `data/`.
- **The chat proxy** is tested against a small OpenAI-compatible mock server (`tests/mock_llm.py`). No API key or network is needed.
- **Skipped when missing:** tests that need Git, LanceDB or the document packages are skipped if those aren't installed.
- **JavaScript tests** load the script from `static/index.html` into a sandbox (`tests/js/load_app.mjs`) and call the real functions.
- **Continuous integration:** `.github/workflows/tests.yml` runs both suites on Linux, Windows and macOS. It also builds the package, checks it with `twine check`, and starts the installed command.

## Releasing (maintainers)

1. Bump `__version__` in `keystone_worklog/__init__.py`.
2. Commit and push, then **publish a GitHub Release** tagged `v<version>` (for example `v1.0.1`).
3. `.github/workflows/publish.yml` runs the tests, checks the tag matches the version, builds, and uploads to PyPI with trusted publishing, so no token is stored.

**One-time PyPI setup:** on pypi.org, go to *Your account → Publishing → Add a pending publisher*. Enter the project name `keystone-worklog`, your GitHub owner and repository, workflow `publish.yml` and environment `pypi`. Also create an environment named `pypi` in the GitHub repository's settings.

To build locally: `pip install build twine && python -m build && twine check dist/*`.

## License

MIT, see [LICENSE](../LICENSE). Bundled third-party components keep their own licenses, see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
