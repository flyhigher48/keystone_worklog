# Keystone user guide

The complete reference. For a quick overview, installation and first steps, see the [README](../README.md).


A local web app that ties your work together: NWA (Network + Activity) hours per biweekly pay period, project budgets, deliverables, and sick and annual leave, plus your Obsidian vault and an AI assistant that works across all of it.

Keystone writes everything into your vault as Markdown, and you can browse and edit the vault from the app. The assistant, **Ask Keystone**, sits beside every page.

It runs on your computer only. Nothing is sent anywhere, unless you connect the optional AI assistant to a cloud model.

The defaults are set up for a US federal employee: a biweekly 80-hour pay period, federal holidays, LA/LS/LH leave codes and a 240 h carry-over limit. All of these are configurable in Settings.

## Install

Requirements: **Python 3.10+** and a modern browser (Firefox, Chrome or Edge). Git and Obsidian are optional.

```bash
pip install "keystone-worklog[search]"    # [search] adds LanceDB for the assistant's meaning search (optional)
keystone-worklog                         # opens http://127.0.0.1:5000 – stop with Ctrl+C
```

Without `[search]`, everything works, and the assistant uses keyword search only.

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
python app.py                                          # or: pip install -e ".[search]" && keystone-worklog
```

Run from a checkout, the data stays in `./data`, which is git-ignored.

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
pip install --no-index --find-links wheels "keystone-worklog[search]"
keystone-worklog --models-dir models
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
| **Today** | Your home page: hours today and this pay period, leave balances, a start/stop timer, **Log my day**, cards due soon, recent notes, the pay-period check, and **Brief me** / **Weekly status report** buttons for Keystone. |
| **Timesheet** | One pay period (two Sun–Sat weeks). Each row has a project, Network, Activity, pay code and TS, plus hours per day. The top card shows your total against 80 h, split by type. Includes the pay-period check, **Fill from schedule**, **Same as last week** and **Mark as submitted**. |
| **Projects** | Your list of Network + Activity pairs with a name and a budget of chargeable hours. Shows hours used and remaining, deliverable progress, and a link to the project's note. |
| **Board** | A kanban board of deliverables (To do / In progress / Blocked / Done), each linked to a project. Drag cards between columns, or click one to edit it. **Calendar** shows cards on their due dates; drag a card onto a day to set its due date. |
| **Follow-ups** | Emails you owe a reply: from, subject, reply-by date, project, status (To reply / Waiting on them / Done). Import a saved `.eml`, paste an email (From/Subject are filled in), or capture one. **Draft reply ✦** has Keystone write a reply for you to copy. It never sends anything. |
| **Reports** | Budget burn-down (pick a project) plus a burn-rate table for every project, leave forecast with a use-or-lose warning, and hours by project by month (CSV or a vault note). **Avg burn** = RG hours in the last 4 completed weeks ÷ the number of those weeks, counting only weeks since the project was first charged (before a full week exists, it uses this week so far). **Weeks left** = budget left ÷ avg burn. |
| **Notes** | Browse and edit the Markdown notes in your Obsidian vault, with live preview, `[[wikilinks]]` and clickable checkboxes. |
| **Assistant** | Full-width chat with Keystone, with your chat history in a sidebar. |
| **Leave** | Sick and annual leave balances, and a ledger for each pay period. |
| **Settings** | Pay period start, leave rates and starting balances, the Obsidian vault, and backups. |

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

- **Timer:** start it on the Today page. It shows in the top bar while running, and **Stop & log** adds the time (rounded to the nearest quarter hour) to that day's row for the project.
- **`Ctrl+K` (or Search in the top bar):** jump to any tab, note, project or card, or run commands like *Start timer*, *Log my day*, *Brief me*, *Weekly status report*, *Previous/Next pay period*, *New meeting note*.
- **Reminders** (Settings → Reminders & backups): a browser notification once a day, while Keystone is open, for cards and replies that are overdue or due today or tomorrow.

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

### Right-click menu in the file tree

| Right-click on | Options |
| --- | --- |
| A folder | New note here · New from template ▸ *(each template)* · New folder here · Rename folder · Copy folder path |
| A note | Open · New note in this folder · New from template ▸ · Copy link `[[…]]` · Open in Obsidian · Rename · Delete |
| An image | Preview · Insert into the open note · Copy embed `![[…]]` · Open in Obsidian · Rename · Delete |
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
| `search_notes` | Keyword search plus meaning search (see below), merged |
| `read_note`, `list_folder`, `list_templates`, `get_open_note` | Read the vault, the template list, and the note you have open (plus any selected text) |
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

Notes are split into heading-aware chunks and embedded **in your browser** with `all-MiniLM-L6-v2`, a 23 MB quantized model that runs in a background worker. The vectors are stored on disk with **LanceDB** in `data/index/`.

- **Staying current:** the index updates as you go. Notes you save, notes the assistant changes and notes edited in Obsidian are re-embedded within a few seconds while the app is open. Only changed notes are processed.
- **Memory:** the model uses roughly 100 MB while it works and is unloaded after 5 idle minutes.
- **Offline:** the model and its runtime are downloaded once, through the app, into `data/models/`, and served locally after that.
- **Turn it off,** or rebuild the index, in Settings.

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
| `data/backups/` | One dated copy of `data.json` per day you use Keystone (the last 60). Restore one from **Settings → Reminders & backups**. |

**Optional git history:** turn on *Keep a private git history of data.json* in Settings. Keystone creates a separate repository in `data/.git` that tracks only `data.json`, never API keys, chats or caches, and makes one commit a day. It's separate from the code repository.

**Settings → Backup** downloads or restores the whole tracker as one JSON file. Notes in your vault are separate; back them up like the rest of your vault.

## Security

The app can read and write files in your vault, so:

- It only listens on `127.0.0.1` and refuses requests addressed to any other host name.
- Note reads and writes are locked inside the chosen vault folder. Paths that use `..`, absolute paths, hidden folders like `.obsidian`, and symlinks pointing outside the vault are all refused. Only `.md` files can be edited, and only images can be served for embeds.
- Uploads must be PNG, JPG, GIF, WebP or BMP images under 25 MB, and never overwrite an existing file.
- The folder picker can list folder names (not file contents) anywhere on your computer. That is how you choose the vault.

Don't change `host` in `app.py` to expose the app on a network.

## Files

```
keystone_worklog/
  app.py               Flask server: data API, folder picker, notes API, assistant routes, the keystone-worklog command
  vault.py             Markdown export and syncing deliverable ticks back from the vault
  assistant.py         assistant back end: profiles and keys, chat proxy, vault tools, undo, git commits
  vector_index.py      note chunking and the LanceDB vector index
  offline_bundle.py    keystone-worklog-bundle: model + Python packages for air-gapped computers
  static/index.html    the whole web app (HTML, CSS and JS in one file)
  static/embed-worker.js  in-browser embedding model (runs in a Web Worker)
  static/vendor/       marked (Markdown), DOMPurify (HTML sanitizer) and KaTeX (math)
app.py                 runs the app from a source checkout (python app.py)
tests/                 Python tests (unittest) and tests/js/ (Node's built-in test runner)
pyproject.toml         package metadata (PyPI name: keystone-worklog)
LICENSE                MIT
THIRD_PARTY_NOTICES.md licenses of the bundled and downloaded components
```

## Development and tests

No extra packages are needed. The Python tests use `unittest`, and the JavaScript tests use Node 18+'s built-in runner.

```bash
python -m unittest discover -s tests -v     # API, vault export and sync, assistant tools, capture, chat proxy, index
node --test tests/js/*.test.mjs             # holidays, schedules, pay-period check, burn rate, capture and email parsing
```

- **Isolation:** each Python test gets its own temporary data folder and vault (through `KEYSTONE_DATA_DIR`), so tests never touch your own `data/`.
- **The chat proxy** is tested against a small OpenAI-compatible mock server (`tests/mock_llm.py`). No API key or network is needed.
- **Skipped when missing:** tests that need Git or LanceDB are skipped if those aren't installed.
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
