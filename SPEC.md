# Athena-Studying — Tech Spec (v1)

Status: draft, written in Eden sessions 2026-10-06, to be handed to Ada once
the new repo exists. Decisions marked **(Ada)** are deliberately left to
the implementer; everything else is decided.

## 1. What this is

A standalone, installable version of Zeona's Hermione study workspace,
renamed **Athena**, for the user's friends (and eventually anyone). Each
person runs their own copy locally; the model work runs through **their
own** Claude Code login. It shares Zeona Hub's look and patterns but none
of its data, and none of Zeona's other agents.

Not to be confused with `~/Desktop/Coding/Athena` (2026-08-23), a separate
public template repo for building your own Zeona-style multi-agent Hub.
This product's repo is **`git@github.com:Elca10/Athena.git`** (public;
product name Athena-Studying). That takes the GitHub name the template repo
was going to use, so the template needs a different name if it's ever
pushed.

### Goals

- Fully implement *Make It Stick* (section 6).
- Minimal waiting between questions and minimal model usage, so heavy daily
  studying fits comfortably inside a Claude Pro plan.
- Zero technical knowledge needed to install, use, or get bugs fixed.
- Works on macOS and Windows.

### Non-goals for v1

- Full calendar mode / Google Calendar sync (deferred — section 9).
- Hosted/multi-tenant version, metered API keys, billing.
- Importing the user's existing Hermione data — every install starts empty.
- Any Zeona agent besides Athena and the bug fixer.

## 2. Platform and install

- **Local web app**: a local backend server + browser UI, same shape as
  Zeona Hub. Binds to localhost only.
- **Model access**: shells out to the user's own `claude` CLI
  (`claude -p ... --output-format stream-json`, `--resume` for multi-turn
  sessions), exactly as Hub's `claudeRunner.js` does. Never reads or
  requires an Anthropic API key. Each friend has their own Claude account
  (Pro or higher, since Claude Code needs it).
- **OS**: macOS and Windows are both first-class. No bash-only scripts in
  the runtime path, no POSIX-only path handling, no shell-string
  `exec` (use argument vectors — also a security requirement).
- **One-command installer** per OS (e.g. a `curl … | sh` for macOS and a
  PowerShell one-liner for Windows) that installs/checks prerequisites,
  clones the repo, installs dependencies, and launches the app.
  - Prerequisites to minimise: Node, git, Claude Code, GitHub CLI. Hub's
    content parser is Python (`Hermione/canvas_parse/`); requiring Python
    on Windows is real friction — **(Ada)** port the parser to Node or
    bundle Python, whichever is more robust.
- **First-run setup screen** (in the browser, not a terminal):
  1. Confirm Claude Code is installed and logged in (button runs a cheap
     check; clear instructions if not).
  2. Connect GitHub (`gh auth login` flow) — needed for bug reports.
     Friends use their **own** GitHub accounts, added as collaborators on
     the Athena repo.
  3. Create the first subject and add content.
- **Auto-update**: on every launch the app pulls the latest `main`,
  reinstalls/rebuilds if needed, and restarts. If the updated version fails
  a startup health check, it **automatically rolls back** to the last
  version that started successfully and tells the user. This is what lets
  friends' copies "self-heal" without them touching git.

## 3. Privacy and the public repo — be VIGILANT

The repo is **public**. No user-specific data may ever be committed,
pushed, or put in a GitHub issue. This is the single most important
constraint in the spec; treat any leak as a severity-1 bug.

- **All user data lives outside the repo checkout** (a per-OS app-data
  directory, e.g. `~/Library/Application Support/Athena-Studying` /
  `%APPDATA%\Athena-Studying`): subjects, topics, attempts, question
  banks, uploaded/parsed course content, Tune Athena preferences, session
  transcripts, logs, config. Nothing user-specific should be able to sit in
  the working tree even by accident.
- **Belt and braces**, because the bug fixer commits and pushes
  autonomously:
  - `.gitignore` covers every known data/log/upload pattern anyway.
  - A pre-commit hook **and** a CI check reject commits containing data
    files, files outside an allowlist of source paths, or content matching
    known personal-data patterns (emails, file paths with usernames, etc.).
  - The fixer persona's instructions forbid committing anything outside
    source/test files, and it must review its own staged diff before every
    commit.
- **GitHub issues are redacted**: the bug-report flow builds the issue body
  from the user's description plus technical context (error messages,
  stack traces, app version, OS) with paths/usernames scrubbed — never
  course content, question text, answers, or study history. The user sees
  the exact issue text before it's filed.
- Course material and study data are only ever sent to Claude via the
  user's own Claude Code session, and only the parts a task needs.

## 4. UI

Visually modelled on Zeona Hub's dashboard (same general look, panels,
card style). Reference components in Zeona: `Hub/web/src/components/`
(`Dashboard.tsx`, `StatsBox.tsx`, `BugReportBox.tsx`, `BugTracker.tsx`,
`AgentUpdateInput.tsx`, `SessionRow.tsx`) and the `hunter/` view for the
"open from a top-bar button" pattern.

### Top bar

- Stats: **subscription usage** (Claude Code rate-limit/usage windows, as
  Hub's `usageLimitStatus.js` / `usageLog.js` do) and **session stats**
  (sessions/questions this week, streak, accuracy, calibration).
- **Report a bug** box + bug tracker (status of filed bugs, linked to their
  GitHub issues).
- **Tune Athena** — renamed "agent update" (section 8).
- **Calendar** button — opens the schedule view (like Hub's Hunter dash
  button).
- **Archive** button — same as Hub's: opens archived sessions and archived
  subjects.

### Main area

- **Left: subject cards.** One per active subject: name, mastery summary
  (new/learning/mastered counts), due-today count, next deadline, Ready
  question bank size, buttons **Add content**, **Study** (Live/Ready),
  **Archive**. Clicking opens a subject detail view (topics, content
  files, deadlines, big-ideas summary).
- **Right: study sessions**, in three sections **stacked vertically** —
  **Active**, **Waiting**, **Completed** — and the whole right panel
  scrolls vertically.
  - **Active**: Athena is currently working (generating a Live question,
    grading, generating a bank).
  - **Waiting**: waiting on the user (a question is up, a reflection
    prompt, etc.).
  - **Completed**: finished sessions, until archived.
- Sessions and subjects can both be archived and restored from the
  Archive view. Archiving a subject keeps its data; it just leaves the
  dashboard and the schedule.

## 5. Study session modes: Live and Ready

Every session is started as one of:

- **Ready** — uses pre-generated questions, model answers and rubrics from
  the subject's question bank. Questions appear instantly. Grading is done
  without a model call wherever possible (below). Goal: near-zero model
  usage per session.
- **Live** — Athena generates custom questions and responses in real time
  in a Claude Code session (today's Hermione experience): follow-ups,
  elaboration dialogue, tailored explanations. Uses more model time; the
  user chooses it when they want that.

### Question banks

- Generated by a user-triggered background job whenever the user **adds
  content**, **creates a subject**, or new topics appear. Also topped up
  after a Ready session that drained a topic's unused questions (triggered
  by that session ending).
- Model: **Sonnet** (one-time cost per content item; output drives tracked
  progress, so quality matters).
- Per topic, several questions of **varied types and angles** (see
  "variation" in section 6): free recall, explain-why, apply-to-a-new-case,
  compare/contrast, short answer, cloze, multiple choice, worked problem.
  Each question stores: prompt, type, topic, difficulty, a model answer, a
  grading rubric / key points, and common misconceptions.
- Questions are not reused verbatim too soon; the bank tracks which
  questions a user has seen.

### Grading without a model call

- Multiple choice, cloze and numeric: auto-graded locally.
- Free recall / explain / short answer: the user answers first, then sees
  the model answer and rubric points and **self-grades** (each key point:
  got it / partly / missed). This comparison is itself calibration
  practice.
- Model escalation, only on user action: "Explain what I'm missing" or
  "Check my answer" sends that one answer + rubric to Claude. Cheap model
  is acceptable here **(Ada)** — though grading feeds progress, so lean
  Sonnet if quality suffers.

### Empty or thin banks

If a Ready session is started for a subject whose bank is empty or not yet
generated, say so and offer Live or "generate now".

## 6. Make It Stick — full implementation

Every principle below must be present in v1. The scheduler and session
builder must be **deterministic code**, not model calls.

| Principle | How Athena does it |
|---|---|
| Retrieval practice | Every session is questions answered from memory; never re-reading or summaries as "study". |
| Spaced repetition | A real scheduling algorithm — recommend **FSRS** (open source, well validated) replacing Hermione's SM-2-lite (`Hub/server/src/hermione/scheduler.js`) **(Ada: library vs port)**. Review intervals grow with demonstrated retention and shrink on misses. |
| Interleaving | Sessions mix topics (and subjects, when the user picks multiple) instead of blocking one topic. |
| Variation | Same topic tested from different angles/question types across reviews. |
| Generation | New topics start with an attempt *before* explanation ("what do you think X means / how would you solve this?"), then feedback. |
| Elaboration | Explain-why and connect-to-something-you-know questions; Live mode pushes follow-up "why". |
| Reflection | Short end-of-session prompt: what did you learn, what surprised you, what connects to what, what will you do differently. Stored per subject. |
| Calibration | Confidence rating (1–5) before seeing the answer on every question; dashboard shows predicted vs actual accuracy over time (Hermione's `hermione_calibration.json` model). |
| Desirable difficulty | Difficulty adapts so success is high but not automatic; mastered topics get harder variants, not just longer gaps. |
| Structure building / mental models | Per subject, a living "big ideas" summary the user builds and revises (prompted after sessions), shown on the subject view. |
| Mastery is earned | New topics start unfamiliar; nothing is pre-credited. Blunt, accurate feedback; no ego-boosting. |
| Exam-aware pacing | Upcoming deadlines pull their topics forward in the schedule. |

Tone and personality come from Hermione's `PERSONA.md`, renamed to Athena:
positive but never ego-boosting, blunt about wrong answers, accurate
calibration over comfort.

## 7. Content ingestion

- **Add content** button on each subject opens a native file picker
  (PDF, PPTX, and plain text/markdown at minimum **(Ada: DOCX too?)**).
  Also a "paste class notes" text box (Hermione's "summary of what I
  learned" path).
- Flow, same as Hub's today: copy into the subject's raw folder in the
  app-data dir → local text extraction (no network, no model) with the
  garbled-text detection already built in `canvas_parse` → one background
  turn extracts topics from the newly parsed files only → seed them as
  planned topics → generate the question bank (section 5).
- Each step shows progress as an Active session; failures surface in the
  UI, not just logs.
- Limits on file size and count per batch **(Ada)**.

## 8. Tune Athena

The renamed "agent update" panel. The user writes plain-language
preferences ("harder questions on proofs", "always give me a worked
example after a miss"). These are stored as **per-user preferences in the
app-data dir** and included in Athena's prompts. They never edit the
shared persona, code, or repo. Viewable and deletable in the UI.

## 9. Deadlines and schedule (v1 minimal; calendar deferred)

- v1: add class/exam deadlines by hand in the UI (subject, title, date,
  which topics it covers — optional).
- The Calendar button opens a **suggested schedule**: which topics to
  study on which days, derived deterministically from the scheduler, due
  dates, and deadlines. Read-only in v1.
- Deferred, to be designed later (reminder in the user's Hub inbox):
  missed-day handling, Google Calendar connection vs. ICS feed (including
  Canvas's calendar feed), editing the schedule.

## 10. Bug fixer

A background coding persona **derived from Ada** but written mostly fresh
for this repo — copy only the relevant parts of Ada's instructions and
lessons (test before shipping, verify the real app, clean commits, never
trust a green test count alone). Named **Bug Fixer**. End users never see
its persona; they just use **Report a bug**.

Flow, started by the user submitting a bug report:

1. Gather context (user's description, recent error logs, app version,
   OS), redact it (section 3), show the user the issue text, and file a
   **clear GitHub issue** on the Athena repo from the user's own
   GitHub account.
2. Start a Claude Code session on the user's own account, in an isolated
   worktree of their local checkout, to fix it.
3. Write a regression test for the bug, fix it, run the full test suite.
4. If green: fetch, rebase onto the current `origin/main`, re-run tests,
   push to `main`, and comment on and close the issue with a summary of
   the fix. If it can't fix it or tests fail: comment on the issue with
   what it found and leave it open.
5. The user's copy picks up the fix via auto-update (section 2); everyone
   else's copy gets it on their next launch.

Rules:

- **No start-strict gate**: it pushes to `main` without human review
  (explicit owner decision). Safety comes from tests + CI + the data-leak
  checks (section 3) + auto-rollback on startup failure.
- Handles concurrent fixers (two friends pushing at once): fetch/rebase/
  retest loop; never force-push.
- Bug report text is untrusted input. The fixer only edits the repo's
  source and tests, never touches the user's data dir or anything outside
  the checkout, and never runs commands the report asks it to run.
- Bug status shows in the dashboard's bug tracker, linked to the issue.
- Notifications to the owner: GitHub's own issue emails for now; a
  dedicated notification feature is future work.

## 11. Decisions for Ada

- Storage engine (Zeona Hub's JSON-file stores had torn-write/data-loss
  incidents — see `shared/memory/ada/hub-data-loss-and-stores.md` before
  choosing).
- Stack (Hub's Node + React is the obvious default given how much UI
  carries over).
- FSRS library vs. own port; parser in Node vs. bundled Python.
- Installer mechanics per OS; how auto-update restarts the server on
  Windows.
- Exact file types and size limits for content.

## 12. Still open (owner)

- Calendar design (deferred, see section 9).
- Scaling past friends: model access beyond each person's own Claude
  account, if the product takes off.

## 13. Suggested build order

1. Repo skeleton, data dir outside the repo, privacy guards (hooks + CI),
   installer + setup screen, auto-update + rollback.
2. Subjects, content ingestion, topic extraction.
3. Scheduler (FSRS) + Live sessions (port of Hermione).
4. Question banks + Ready sessions + local grading.
5. Dashboard: session sections, stats, archive, Tune Athena.
6. Bug report → issue → fixer → push loop.
7. Deadlines + suggested-schedule view.
8. End-to-end test on a clean Mac **and** a clean Windows machine.
