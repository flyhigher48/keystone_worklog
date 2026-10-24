<p align="center">
  <img src="docs/logo.svg" width="72" alt="Keystone logo">
</p>

<h1 align="center">Keystone</h1>

<p align="center">
  <b>Your hours, projects, deliverables, leave and notes in one app that runs on your own computer,<br>
  with an AI assistant that does the paperwork for you, one click to approve at a time.</b>
</p>

<p align="center">
  <a href="https://pypi.org/project/keystone-worklog/"><img alt="PyPI" src="https://img.shields.io/pypi/v/keystone-worklog"></a>
  <a href="https://pypi.org/project/keystone-worklog/"><img alt="Python" src="https://img.shields.io/pypi/pyversions/keystone-worklog"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Local-first" src="https://img.shields.io/badge/your%20data-stays%20on%20your%20computer-2ea44f">
  <img alt="Works offline" src="https://img.shields.io/badge/works-offline-6f42c1">
</p>

<p align="center">
  <img src="docs/screenshots/today.png" alt="The Today page: a pay-period reminder, hours and leave balances, the timer with unlogged time, a Heads up list of budget and leave warnings, today's meetings, captured notes and what's due soon" width="900">
</p>

**Keystone** is a timesheet that checks itself, a project board, a leave planner and an Obsidian-powered notebook that can search inside every file you keep: PDFs, Office files, emails, Python and Abaqus jobs. An assistant ties them together and can log your hours, update your cards, write your notes and file your documents, but only after you click **Apply**.

It was built for people who charge time to **network/activity (NWA) numbers** on a biweekly pay period, with leave codes, budgets per project and a portal to paste hours into. It works just as well for anyone who wants a single place for hours, deadlines and notes.

```bash
pip install "keystone-worklog[all]"
keystone-worklog
```

---

## Why Keystone?

- ⏱️ **A timesheet that catches mistakes before you submit.** Missing days, short totals, holidays without holiday hours, projects over budget. It fills days from your schedule and copies hours straight into your time-entry portal.
- 📈 **Know when a budget runs out.** Burn-down per project, average hours per week, and a run-out date you can check by hand.
- 🗂️ **Your notes stay plain Markdown in Obsidian.** Projects, timesheets, deliverables and follow-ups are written into your vault. Tick a checkbox in Obsidian and the Board updates.
- 🔎 **Find any file by what's inside it.** PDFs, Word, PowerPoint, Excel, saved emails, Python scripts, notebooks and solver files (Abaqus `.inp`/`.msg`/`.dat`/`.sta`) are searched by keywords and by meaning, and results point to the page, slide, sheet or function.
- 📥 **An inbox that files itself.** Drop files into `Inbox/` and Keystone suggests where each one belongs, from similar files and job names already in your vault. Review the table, click **Move**, undo if needed.
- 🤖 **An assistant that works with you.** "Log 8 hours to each project for today." "Push every card without a date to next Friday." "Summarize this note." Every change shows up as a diff to **Apply** or **Reject**, and can be undone.
- 🔒 **Local-first and private.** Keystone runs on `127.0.0.1`. Use a local model (Ollama, LM Studio, llama.cpp) and nothing leaves your machine. API keys never reach the browser.
- ✈️ **Works without internet.** One command bundles Keystone, its Python packages and the embedding model for an air-gapped computer.

---

## A quick tour

### 🗓️ A timesheet that checks itself
Two Sun–Sat weeks per pay period, with pay codes (RG, LA, LS, LH) and telework. The **pay-period check** lists everything to fix before you submit. **Fill from schedule** tops every day up to your 5×8, 9/80 or 4×10 schedule, and federal holidays are filled in for you. **Copy for portal** puts the week on your clipboard in your portal's column order. **Mark as submitted** locks the period.

<img src="docs/screenshots/timesheet.png" alt="Timesheet with the pay-period check, scheduled hours in each day header and a budget left per project" width="900">

### 🤖 Ask Keystone, beside every page
Open the assistant with **✦ Ask** or `Ctrl+J`. It searches and reads your vault (by keywords *and* by meaning, using a small model that runs in your browser), including what's **inside your PDFs, Word, PowerPoint and Excel files and saved emails**, so it can find a file for you and tell you the page. It knows which page you're on and proposes changes for you to approve. Bring any OpenAI-compatible model: a **local Gemma or Llama**, or a cloud provider.

<img src="docs/screenshots/assistant.png" alt="Notes tab with a note containing LaTeX math, and the assistant proposing an edit as a diff with Apply and Reject buttons" width="900">

### 🔎 Search inside every file, and file the inbox
Keystone reads the documents in your vault on your own computer and embeds them with a small model that runs in your browser, so the assistant finds files by what they say. Solver output gets an **Errors, warnings and status** summary, so *"why did girder_v3 fail?"* finds the right `.msg`. New files dropped into `Inbox/` get a suggested folder each; you review them in one table.

| A solver message file in the Notes tab | File the inbox |
| --- | --- |
| <img src="docs/screenshots/document.png" alt="An Abaqus .msg file open in the Notes tab, with its errors and warnings summarised at the top" width="440"> | <img src="docs/screenshots/inbox.png" alt="The File the inbox table: each file with a suggested folder, confidence and the reason, such as a matching job name or a similar file" width="440"> |

**Settings → Search index** shows which files have been read and embedded, what's waiting and anything that couldn't be read, and an *Indexing 43%* chip in the top bar shows progress while it runs.

<img src="docs/screenshots/search-index.png" alt="Search index card: progress bar, filters for Indexed, Waiting and Couldn't read, and a table of files with type, size, status, chunks and when they were indexed" width="900">

### 📋 Deliverables, leave and meetings on one calendar

| Kanban board | Calendar |
| --- | --- |
| <img src="docs/screenshots/board.png" alt="Kanban board with To do, In progress, Blocked and Done columns" width="440"> | <img src="docs/screenshots/calendar.png" alt="Month calendar with cards on their due dates, travel and annual leave, federal holidays and meetings imported from an .ics file" width="440"> |

Mark annual leave, sick leave or travel as **Out of office**; leave can put its hours on the timesheet for you and shows the balance it leaves. Import an `.ics` file from Outlook, Google or Apple to see meetings and charge their time to a project.

<img src="docs/screenshots/leave.png" alt="Out of office dialog adding three days of annual leave, showing the hours it adds, the balance afterwards and the carry-over limit" width="900">

### 📈 Budgets, leave and hours at a glance
Burn-down per project with a run-out date, a burn-rate table for every project, a leave forecast with a **use-or-lose** warning, hours by project for the last 6 months or a whole year (CSV or a vault note), and a history of submitted pay periods. **Print / PDF** gives a clean report.

<img src="docs/screenshots/reports.png" alt="Reports: burn-down chart with the projected run-out date and a burn-rate table" width="900">

### ✉️ Never lose an email you owe a reply to

| Follow-ups | Quick capture (`Ctrl+Shift+Space`), dark mode |
| --- | --- |
| <img src="docs/screenshots/followups.png" alt="Follow-ups grouped by Overdue, Due today, Coming up and Waiting on them, each with a Draft reply button" width="440"> | <img src="docs/screenshots/capture-dark.png" alt="Quick capture dialog in dark mode showing where an @reply line will go" width="440"> |

Drop in a saved email or paste one from Outlook, set a reply-by date, and let Keystone **draft the reply** (it never sends anything). Quick capture turns one line into a note, a to-do, a Board card or a follow-up, all logged in a single `Today.md` with a heading per day.

---

## Quick start

**Requirements:** Python 3.10+ and a modern browser (Firefox, Chrome or Edge). Obsidian, Git and an AI model are all optional.

```bash
pip install "keystone-worklog[all]"      # or plain keystone-worklog: no meaning search or document reading
keystone-worklog                          # opens http://127.0.0.1:5000 — stop with Ctrl+C
```

**Try it with demo data first** (from a source checkout – a fictional vault with projects, specs, emails and Abaqus jobs, and an inbox to file; your own data is not touched):

```bash
python scripts/make_demo.py                     # creates ./demo
KEYSTONE_DATA_DIR=demo/data python app.py --port 5050
```

**Your first five minutes:**

1. **Settings → Pay period:** set a real pay-period start date (a Sunday) and your hours per period.
2. **Settings → Work schedule & holidays:** pick 5×8, 9/80 or 4×10 (or make your own), and enter your leave balances and accrual rates.
3. **Projects:** add each network + activity you charge to, with a name and an hour budget.
4. **Timesheet:** pick a project on each row and type hours, or use **Fill from schedule**. At the end of the week: **Copy for portal**, paste, done.
5. *(Optional)* **Settings → Obsidian vault:** choose your vault to get Markdown notes, the Notes tab and quick capture.
6. *(Optional)* **Settings → AI assistant:** add a profile for your local or cloud model, then press **Test connection**.

---

## Using Keystone day to day

| When | What to do |
| --- | --- |
| **Morning** | Open **Today**: hours to log, what's due, replies owed. Click **Brief me** for a summary from the assistant. |
| **During the day** | `Ctrl+Shift+Space` to capture anything. Start the **timer** when you switch tasks. |
| **End of day** | Stop the timer, or type what you did into **Log my day**, and the assistant turns it into timesheet hours. |
| **New files** | Drop them into `Inbox/` in your vault, then **Notes → File the inbox**. |
| **Friday** | **Weekly status report** drafts your report from hours, the Board and this week's notes, and saves it to your vault. |
| **End of pay period** | Clear the **pay-period check**, **Copy for portal**, then **Mark as submitted**. |

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl+K` | Search everything and run commands: notes, projects, cards, "Start timer", "File my inbox", "Next pay period"… |
| `Ctrl+Shift+Space` | Quick capture from anywhere |
| `Ctrl+J` | Open or close the assistant |
| `↑ ↓ ← →`, `Enter` | Move between hour cells on the timesheet |
| `Ctrl+S` | Save the note you're editing (notes also autosave) |

### Quick-capture syntax

| You type | You get |
| --- | --- |
| `Call the county about the culvert #bridge` | A timestamped line in `Today.md`, linked to the *Bridge* project note |
| `[] send drainage memo due:fri` | A checkbox with a due date |
| `@task Review 60% plans due:2026-11-02 #bridge` | A card on the Board, plus a line in `Today.md` |
| `@reply Bob Smith – budget question due:tomorrow` | A follow-up, plus a line in `Today.md` |

`due:` understands `today`, `tomorrow`, weekday names, `+3d`, `2w` and `YYYY-MM-DD`.

### Things to ask the assistant

> *"Log 8 hours to each project for today."* · *"How many hours do I still need this pay period?"* · *"What's overdue on the Board?"* · *"Set a due date of next Friday on every card that has none."* · *"Summarize the note I have open and pull out the action items."* · *"Draft a reply to my oldest follow-up."* · *"How much annual leave will I have on December 31?"* · *"Find the spec that covers elastomeric bearing pads."* · *"Which email from the county mentioned the culvert deadline?"* · *"Why did girder_v3 fail?"* · *"File my inbox."*

---

## Configuration

| Option | What it does |
| --- | --- |
| `keystone-worklog --port 5001` | Use another port (or set `KEYSTONE_PORT`) |
| `keystone-worklog --no-browser` | Don't open a browser window |
| `keystone-worklog --models-dir PATH` | Use an offline embedding-model bundle (see below) |
| `keystone-worklog --offline` | Never connect to the internet (or set `KEYSTONE_OFFLINE=1`) |
| `KEYSTONE_DATA_DIR=PATH` | Keep the data in another folder, e.g. a second profile |

**Where your data lives:**

| OS | Data folder |
| --- | --- |
| Linux | `~/.local/share/keystone-worklog` |
| macOS | `~/Library/Application Support/keystone-worklog` |
| Windows | `%APPDATA%\keystone-worklog` |

The data folder holds your tracker data, a dated backup for every day you use Keystone, assistant chats and API keys (owner-only). Restore a backup from **Settings → Reminders & backups**.

**AI models:** any server with an OpenAI-compatible `/chat/completions` API works.

| Provider | Base URL |
| --- | --- |
| Ollama (local) | `http://localhost:11434/v1` |
| LM Studio (local) | `http://localhost:1234/v1` |
| llama.cpp / vLLM (local) | `http://localhost:8080/v1` |
| OpenAI | `https://api.openai.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |

Each profile has an **Allow tracker access** switch. Turn it on for your local model and off for a cloud one, and your hours, budgets and leave never reach the cloud.

### Computers without internet

On a machine **with** internet:

```bash
keystone-worklog-bundle --platform win_amd64 --python-version 3.12   # match the offline computer
```

Copy the resulting `models/` and `wheels/` folders over, then on the offline machine:

```bash
pip install --no-index --find-links wheels "keystone-worklog[all]"
keystone-worklog --models-dir models --offline     # --offline: never connects to the internet
```

---

## Privacy and security

- **Your computer only:** Keystone listens on `127.0.0.1` and refuses requests addressed to any other host.
- **Documents are read, never changed:** PDFs, Office files, emails and text files are read on this computer to search them; their text is cached in `data/index/docs/`. **Open in app** only opens documents, notes and images – never programs or scripts.
- **Notes stay in the vault:** the Notes tab and the assistant can only read and write `.md` files inside the vault you chose. Paths that escape it, hidden folders and symlinks pointing outside are refused.
- **Nothing is ever deleted or overwritten.** The assistant can create, edit, append to and move notes, and move files when filing; it can't delete. Moving a batch of files is one undo, and only files git already tracks are committed. Every change is a diff you approve, can be undone, and (optionally) becomes its own Git commit in your vault.
- **API keys stay on the server**, in an owner-only file, and are never sent back to the browser.

---

## Documentation

The **[user guide](docs/GUIDE.md)** covers every feature in detail:
- pay codes and the portal format;
- the Obsidian export and two-way sync;
- the Notes editor, templates, math and images;
- every assistant tool and the meaning-search index;
- searching documents, solver files and code, and the search index status;
- filing the inbox, out-of-office days, calendar import and the timer log;
- backups and Git history.

---

## Development

```bash
git clone https://github.com/<you>/keystone-worklog && cd keystone-worklog
python -m venv .venv && source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e ".[all]"
python app.py                                            # runs from the checkout, with data in ./data

python -m unittest discover -s tests -v                 # Python tests (no extra packages needed)
node --test tests/js/*.test.mjs                          # JavaScript tests (Node 18+, built-in runner)
```

| Path | What's there |
| --- | --- |
| `keystone_worklog/app.py` | Flask server and the `keystone-worklog` command |
| `keystone_worklog/static/index.html` | The whole web app in one file: HTML, CSS and JavaScript, no build step |
| `keystone_worklog/assistant.py` | Model profiles, chat proxy, vault tools, undo, Git commits |
| `keystone_worklog/vault.py` | Markdown export to Obsidian and syncing ticks back |
| `keystone_worklog/vector_index.py` | Note and document chunking and the LanceDB index |
| `keystone_worklog/documents.py` | Text from PDF, Word, PowerPoint, Excel, emails, code, notebooks and solver files |
| `scripts/make_demo.py` | Builds the demo data used for the screenshots |
| `tests/` | Python tests, a mock OpenAI-compatible server, and `tests/js/` |

Contributions are welcome. Please open an issue to discuss bigger changes, and make sure both test suites pass. Continuous integration runs them on Linux, Windows and macOS. Releases go to PyPI automatically when a GitHub Release is published (see the [user guide](docs/GUIDE.md#releasing-maintainers)).

---

## License

[MIT](LICENSE). Bundled components (marked, DOMPurify, KaTeX), the optional document readers (pypdf, python-docx, python-pptx, openpyxl) and the downloaded embedding model keep their own licenses, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
