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

- Stand-in for v1.0: the top bar's "Report a bug" button is hidden; the
  first users report bugs to the owner directly. The setup wizard's
  GitHub (`gh`) step stays in v1.0 so Bug Fixer can drop in without a
  re-setup — and the owner may still pull Bug Fixer back into v1.
- Nothing built yet.

## 2. Deadlines + suggested schedule (v1 section 9, build step 7)

Hand-entered deadlines (subject, title, date, optional topics) and the
read-only, deterministic suggested-schedule view behind the Calendar
button. The calendar design itself (missed days, Google Calendar vs. ICS /
Canvas feed, editing the schedule) was already deferred past v1 and stays
an open owner decision (v1 section 12).

- Stand-in for v1.0: the Calendar button is hidden; subject cards omit
  "next deadline".
- Nothing built yet. `subjectSummary.js` deliberately leaves out the
  "next deadline" field until this exists.

## 3. Make It Stick — remaining rows (v1 section 6)

v1.0 ships with retrieval practice, spaced repetition (FSRS), interleaving,
calibration, mastery-is-earned, end-of-session reflection, and
generation-before-explanation in both Live and Ready modes. Still to do,
per the 2026-10-11 audit (full table in the build progress log):

| Principle | Gap |
|---|---|
| Variation | Ready mode's `pickBankQuestion` ignores question `type`, so one type can repeat across reviews; Live mode doesn't track which types a topic has already been asked. |
| Elaboration | Live mode never asks a follow-up "why" after a correct-but-shallow answer — it moves straight to the next topic. |
| Desirable difficulty | Question difficulty isn't tied to mastery: mastered topics (FSRS state Review) get the same difficulty mix as ones reviewed once; Ready mode ignores `difficulty` when picking. |
| Structure building | No per-subject "big ideas" summary: no data model, no post-session prompt to build/revise it, nowhere to show it. |
| Exam-aware pacing | Depends on section 2 (deadlines) above. |

## 4. Subject detail view (v1 section 4)

Clicking a subject card opens a detail view: topics (with mastery), content
files, deadlines, big-ideas summary, and past reflections
(`GET /api/subjects/:id/reflections` already exists, read-only). Cut
together with section 3's big-ideas row, which needs somewhere to live.

## 5. Athena persona doc (v1 section 6, closing paragraph)

A single `PERSONA.md` for Athena (from Hermione's, renamed: positive but
never ego-boosting, blunt about wrong answers, calibration over comfort)
that every prompt draws from. v1.0's prompts already carry this tone ad
hoc in their own wording; the doc makes it consistent as more prompts are
added.

## 6. Full clean-machine testing on both OSes (v1 build step 8)

v1.0 requires a clean-machine end-to-end test on Windows, the first
friend's OS. The macOS clean-machine test (a new macOS user account works
as a stand-in) moves here, before the app goes to a friend on a Mac. CI
still covers both OSes in the meantime.

## 7. macOS relaunch shortcut

v1.0 adds a Windows Start Menu/Desktop shortcut to reopen Athena after the
first install. The macOS equivalent (an app bundle or Dock/Launchpad
entry) moves here alongside the macOS clean-machine test.

## Already out of scope for v1, still out for v2 unless decided otherwise

- Hosted/multi-tenant version, metered API keys, billing.
- Importing existing Hermione data.
- Scaling model access past each person's own Claude account (v1 section 12).
