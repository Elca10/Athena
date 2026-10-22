# Athena-Studying — Tech Spec (v2)

Status: draft, started in an Eden session 2026-10-11. Holds everything cut
from v1 to ship a first friend-ready build that week. The v1 spec
(`SPEC.md`; a copy of this file lives at `specs/athena-studying-v2.md` in the owner's private repo) still defines
how each item below should work — this file records *what* moved here and
*what's already built toward it*, not a redesign. Section numbers refer to
the v1 spec.

## Why these were cut

v1.0's ship bar is "a friend can install it, add material, and actually
study with it on their own machine." Everything below either isn't needed
for that loop or has a workable stand-in for a first user (e.g. bugs get
reported to the owner directly instead of through Bug Fixer).

## 1. Bug Fixer (v1 section 10, build step 6)

Entire section moves here unchanged: Report a bug box, redacted GitHub
issue from the user's account, isolated-worktree fix session, regression
test, fetch/rebase/retest/push loop, issue close/comment, bug tracker in
the dashboard.

- v1.0 ships the first half only (decided 2026-10-12): "Report a bug"
  files a redacted, user-previewed GitHub issue from the user's own
  account via `gh`. Everything after filing (the fixer session, regression
  test, push, issue close, bug tracker) stays here. Open design questions
  for the fixer: the user's account needs push access (collaborator
  invite) or the fixer opens a PR from a fork instead; and with the
  `release` channel, a fix pushed to `main` only reaches the user once the
  owner promotes it.
- Nothing built yet.
- **Shelved (owner decision 2026-10-19).** Fixes keep happening on the
  owner's own account from filed issues; no fixer runs on friends'
  machines. Reasons: it would spend the friend's own usage limits, need
  push access (or a fork) per friend, and feed untrusted report text into
  a session that can push. Revisit only if the user base outgrows the
  owner fixing issues by hand.

## 2. Deadlines + suggested schedule (v1 section 9, build step 7)

Hand-entered deadlines (subject, title, date, optional topics) and the
read-only, deterministic suggested-schedule view behind the Calendar
button. The calendar design itself (missed days, Google Calendar vs. ICS /
Canvas feed, editing the schedule) was already deferred past v1 and stays
an open owner decision (v1 section 12).

- Stand-in for v1.0: the Calendar button is hidden; subject cards omit
  "next deadline".
- Calendar decisions (owner, 2026-10-19):
  - Missed days fix themselves: the schedule is recomputed from the
    scheduler's current state, nothing to catch up on.
  - Each planned study block can be marked done (and is marked done
    automatically when a real session covers it) or deleted when the
    user decides they don't need it.
  - The user can move individual blocks and set availability (which days,
    how long). Moved and deleted blocks are stored as overrides on top of
    the computed schedule, so it stays deterministic.
  - **The user's scheduling decisions win.** A moved, deleted or completed
    block, and the availability settings, are never overridden by the
    scheduler, deadline pacing or anything else; the computed schedule
    fills in around them.
  - The user chooses which assignments/exams to study for; deadlines
    can come from a Canvas calendar feed as well as by hand.
  - Canvas import is plain code, no model calls: the user pastes their
    private Canvas calendar-feed URL once, the server fetches and parses
    the ICS directly, and the user ticks which events to study for and
    picks the subject. The URL is a secret: stored in the data dir only,
    redacted from bug reports and logs. It's the only network call Athena
    makes outside the user's Claude account and GitHub.
  - Deferred past v0.8.0: an ICS feed of planned study blocks for
    calendar apps (localhost-only, so Apple Calendar on the same Mac can
    subscribe but Google Calendar can't). No Google Calendar API (OAuth
    credentials can't live in a public repo).
- **Built (v0.8.0), hand-entered deadlines + the Calendar.** Deadlines
  (`deadlines.js`, `deadlines.json`): subject, title, local `YYYY-MM-DD`
  date, optional topics (none = the whole subject), and a "study for
  this" flag; edited in the subject detail view, next one on each card.
  The Calendar (`schedule.js`, `CalendarView.tsx`) recomputes a 14-day
  plan on every request, no model calls. The user's decisions (move,
  delete, done, availability) live in `schedule.json` as overrides keyed
  by block id (`<originDate>:<topicId>`); any override still on today or
  later claims its topic so nothing computed replaces it, and overrides
  are applied last. Real sessions mark today's blocks done. Study adds
  today's pulled-forward and user-placed topics. Still to do: the ICS
  feed of study blocks (deferred).
- **Built (v0.8.0), Canvas calendar-feed import.** `canvasFeed.js`: the
  user pastes the feed link once (Calendar → Import deadlines from
  Canvas); it must be an https `/feeds/calendars/*.ics` link (webcal://
  accepted), is test-fetched before it's saved to `canvas-feed.json`, and
  never leaves the server again (status reports the host only; error
  messages never contain it; `redact.js` strips feed links from bug
  reports). The ICS is fetched (20s timeout, 5 MB cap) and parsed in plain
  code; upcoming events are listed with a subject suggested from the
  course in brackets when exactly one subject matches. Ticked events
  become ordinary deadlines (`source: "canvas"`, the event UID as
  `externalId`, never imported twice), with title and date taken from a
  fresh fetch, not the browser. An added event whose title or date later
  changes in Canvas is only flagged, with an Update button; nothing is
  rewritten on its own.

## 3. Make It Stick — remaining rows (v1 section 6)

v1.0 ships with retrieval practice, spaced repetition (FSRS), interleaving,
calibration, mastery-is-earned, end-of-session reflection, and
generation-before-explanation in both Live and Ready modes. Still to do,
per the 2026-10-11 audit (full table in the build progress log):

| Principle | Gap |
|---|---|
| Variation | **Built (v0.4.0).** Ready mode's `pickBankQuestion` now avoids a topic's recently-asked types (read from existing attempt history, falling back gracefully rather than ever refuse a question); Live mode's prompt steers away from them too (`liveSession.js`'s `recentlyAskedTypes`), from the `type` every answered attempt already carries — no new data, no migration. |
| Elaboration | Live mode never asks a follow-up "why" after a correct-but-shallow answer — it moves straight to the next topic. |
| Desirable difficulty | **Built (v0.4.0).** `scheduler.js`'s `targetDifficultyForCard` derives a target (intro/medium/hard) deterministically from a topic's FSRS state (Review + stability vs. New/Learning/Relearning); Ready mode's `pickBankQuestion` narrows to it when possible, Live mode's prompt names it as a short steer. |
| Structure building | **Built (v0.7.0), optional.** `bigIdeas.js`: a per-subject text the user writes and revises themselves (no model call), with a capped revision history so a bad edit can be undone. Shown and editable in `SubjectDetailPanel.tsx`'s own section, with a small "+ Add big ideas" affordance when empty. `settings.js`'s one toggle (off by default, in Tune Athena) adds a short, one-click-skippable "revise your big ideas?" prompt after the end-of-session reflection. |
| Exam-aware pacing | **Built (v0.8.0).** `schedule.js`: a topic covered by an upcoming deadline the user is studying for goes on min(its FSRS due day, the day before the deadline), else the nearest earlier free study day, else a later one still before the date; never on a day off or past the minutes per day (what can't fit is shown as a warning). |

## 4. Subject detail view (v1 section 4)

Clicking a subject card opens a detail view: topics (with mastery), content
files, deadlines, big-ideas summary, and past reflections
(`GET /api/subjects/:id/reflections` already exists, read-only). Cut
together with section 3's big-ideas row, which needs somewhere to live.

- **Built (v0.5.0), topics/content/reflections only.** Clicking a subject
  card's name opens `SubjectDetailPanel.tsx`, a focus-trapped modal (same
  pattern as Add content/Tune Athena/Report a bug): topics with their
  mastery badge, content files (reusing Add content's own Remove action),
  and past reflections, each with its own loading/empty/error state.
  Deadlines and the big-ideas summary are still not built — no placeholder
  slot for either yet (section 3's structure-building row and section 2
  still need to land first).

## 5. Athena persona doc (v1 section 6, closing paragraph)

A single `PERSONA.md` for Athena (from Hermione's, renamed: positive but
never ego-boosting, blunt about wrong answers, calibration over comfort)
that every prompt draws from. v1.0's prompts already carry this tone ad
hoc in their own wording; the doc makes it consistent as more prompts are
added.

- **Built (v0.6.0).** `server/src/persona/PERSONA.md` (~350 words, loaded
  once and cached by `persona/persona.js`'s `getPersonaBlock`), included in
  `liveSession.js`'s first-question and grading prompts and
  `questionBankGeneration.js`'s bank prompt; `topicExtraction.js` gets none
  (pure topic labels, no voice). Old ad-hoc tone wording in those prompts
  was removed in favor of the shared doc. Confidence fix: `submitLiveAnswer`
  now passes the user's 1-5 confidence into the grading prompt so the model
  can name a clear confidence/correctness mismatch in one sentence; Ready
  mode (no model call) gets the same callout deterministically via
  `readySession.js`'s `confidenceMismatchNote`. Milestone applause: a topic
  reaching mastered as a direct result of an answer is detected
  deterministically (`subjectSummary.js`'s `justReachedMastered`, from the
  FSRS state change) and surfaced as a plain UI line in both modes — a
  calibration-improvement milestone was considered and skipped (no clean,
  non-noisy deterministic hook).

## 6. Full clean-machine testing on both OSes (v1 build step 8)

v1.0 requires a clean-machine end-to-end test on Windows, the first
friend's OS. The macOS clean-machine test (a new macOS user account works
as a stand-in) moves here, before the app goes to a friend on a Mac. CI
still covers both OSes in the meantime.

## 7. macOS relaunch shortcut

v1.0 adds a Windows Start Menu/Desktop shortcut to reopen Athena after the
first install. The macOS equivalent (an app bundle or Dock/Launchpad
entry) moves here alongside the macOS clean-machine test.

- Built for v0.3.0: `installers/macos.sh` writes
  `~/Applications/Athena-Studying.app`, which re-runs the checkout's
  installer with the install-time PATH baked in (Finder's PATH has no
  node/claude/gh), logs to `~/Library/Logs/Athena-Studying/launcher.log`,
  and shows a dialog if Athena can't start. Still needs the clean-machine
  test on a real Mac (section 6).

## Roadmap (owner, 2026-10-19)

Each step is a `--minor` release (strict semver, see README).

| Version | Title | Scope |
|---|---|---|
| v0.3.0 | Athena on Mac | Section 7 + the macOS clean-machine test (section 6). |
| v0.4.0 | Never the same question twice | Section 3: variation + desirable difficulty (deterministic, no model calls). |
| v0.5.0 | Inside a subject | Section 4: subject detail view. |
| v0.6.0 | Athena's voice | Section 5: persona doc, carefully revised; prompts brought in line. Owner reviews the draft first. |
| v0.7.0 | Big ideas | Section 3's structure-building row, **optional**: off unless the user turns it on. |
| v0.8.0 | Deadlines | Section 2 with the calendar decisions above. May split if Canvas import or the ICS feed grows. |
| v0.9.0 | Pick your version | Updater follows release tags (beta channel / pinning). |
| v1.0.0 | Public launch | Clean-machine pass on both OSes, public-ready docs, privacy audit. |

Dropped: Elaboration (section 3's Live follow-up "why"), owner decision
2026-10-19. Shelved: Bug Fixer (section 1).

## Already out of scope for v1, still out for v2 unless decided otherwise

- Hosted/multi-tenant version, metered API keys, billing.
- Importing existing Hermione data.
- Scaling model access past each person's own Claude account (v1 section 12).
