# Release notes

Every GitHub Release opens with notes written for the people using
Athena. They come from the files in this folder, one per change:

- `release-notes/new/` for something you can do now that you couldn't before
- `release-notes/improved/` for something that works better, looks better or costs less
- `release-notes/fixed/` for something that was broken and now works

Add the file in the same commit as the change. A release includes every
note file added since the previous version, under its folder's heading
(New, Improved, Fixed). After that, the commit subjects are listed in a
collapsed block. Only adding a file counts: editing or deleting a note
that has already shipped changes nothing, so notes never need cleaning
up. A change nobody will notice (tests, CI, docs for maintainers) gets
no note. A release with no notes says so in one line.

## How to write one

Write for a student who has never seen the code. Say what changed for
them and what to do differently, if anything. Leave out how it works.

- One or two sentences, as a single bullet. Extra lines continue the same bullet.
- Name the thing as it appears on screen (**Report a bug**, the study picker).
- Mention the issue if one asked for it, e.g. `(#6)`. GitHub links it.
- If the user has to do something to get it, such as re-running the install
  command, say so plainly.
- The file name is only for you: `rename-subjects.md`.

Good:

> Studying for an exam that isn't cumulative? Under **Content** in the study
> picker, choose **Only some files** to be quizzed on just those. (#6)

Not useful to a reader:

> Refs #6: POST /api/sessions takes contentIds
