# Learning Filter — the learnings.md Lifecycle

The full lifecycle for `docs/ideation/learnings.md`: how implementation notes
become durable learnings, and the rules that keep the file worth reading.

This reference is **invocation-agnostic** — the same rules are invoked from two
moments, each passing different inputs through them:

1. **Interactive completion** (a watched `execute-spec` or autopilot run) —
   input is the just-finished project's `implementation-notes-phase-*.html` and
   that run's noted gap-decisions, **bounded to that one project**.
2. **Intake** (interview engine) — input is unmined implementation notes left
   behind by unattended runs, surfaced by the engine's bounded scan.

Capture always passes through a human accept/edit/dismiss review — nothing is
ever auto-appended, and unattended runs never write this file.

## Classify

For each note entry, read its Context / Decision / Alternative and classify it
by the note categories used in `execute-spec`:

- **spec gap** — the spec didn't address something; a judgment call was required
- **spec deviation** — an intentional divergence from the spec
- **tradeoff** — multiple valid approaches existed; one was chosen
- **codebase surprise** — existing code was in an unexpected state
- **dependency decision** — a dependency version/API/behavior differed from the spec's assumption

## Generalize

This is the core filter. Keep **only** patterns that would change how a _future_
spec or interview is written. Discard project trivia.

- **Disqualifying (trivia — discard):** "we picked 3 retries", "the fixture used
  the scope/risk/effort keys", "we left two dead CSS rules in place." These are
  decisions local to one project; they teach nothing transferable.
- **Qualifying (pattern — keep):** "specs that touch test fixtures never declared
  the fixture in their File Changes table, which broke the engine's file-overlap
  serialization", or "every phase assumed the scout agent was registered, but the
  Agent tool was unavailable — specs should not assume optional infrastructure."
  These change how the next spec/interview should be written.

A useful test: would this pattern make you **ask a different interview question**
or **add a row to a future spec's File Changes table**? If not, it's trivia.

Two hard rules bound every capture moment:

- **At most 3 candidates survive.** More than 3 qualifying patterns means the
  filter is running loose — keep the 3 with the clearest transferable
  implication and discard the rest.
- **Zero candidates → silence.** No prompt, no output, no "nothing to learn"
  message. A clean project that followed its specs produces zero learnings, and
  that is correct; a mandatory capture question on clean runs is prompt fatigue.

## Dedupe and Persist

Accepted candidates append to `docs/ideation/learnings.md` (repo-level — the
sibling of the project directories, **not** per-project and **not** inside the
plugin directory; learnings are codebase-specific and the plugin dir shouldn't
accumulate user state).

The store is meant to be **committed and shared with the repo** — but that only
happens if git can see it. If the repo ignores `docs/ideation/`, un-ignore this
one file (`docs/ideation/*` plus `!docs/ideation/learnings.md` — git cannot
re-include a file under an ignored *directory*), otherwise the sharing intent
silently fails and the store stays machine-local. This plugin's own repo made
exactly that mistake for its first several releases.

1. **Read the existing `learnings.md` first** (if it exists). If it does not
   exist, create it with this header:

   ```markdown
   # Ideation Learnings

   Generalizable spec-gap and interview patterns captured from completed
   ideation projects. Intake reads this file so recurring gaps inform future
   questioning and spec generation. Each entry is dated and cites its
   evidence; treat entries as hints, never as a substitute for gate evidence.
   ```

2. **Dedupe**: for each accepted pattern, scan existing entries. If the pattern
   matches one already recorded, do **not** add a duplicate — instead add an
   `_Also seen in {project} ({date})._` line under the existing entry. Only
   genuinely new patterns become new entries.

3. **Retire stale entries**: while the file is open, re-verify each standing
   entry against the current codebase. Retire (delete) an entry when its
   evidence no longer holds — it cites a file, script, or piece of
   infrastructure that no longer exists (confirm with an actual Glob/Grep, not
   a guess) — or when a newer entry supersedes it. Delete outright: the file is
   read by intake every session, so a kept-but-dead entry costs attention;
   git history is the archive. Report every retirement with its reason. An
   entry you cannot cheaply verify stays — when unsure, keep it.
   If a retired pattern later re-emerges, it returns as a new dated entry,
   which is correct: re-emergence is fresh evidence.

4. **Entry format** for a new pattern:

   ```markdown
   ## {YYYY-MM-DD} — {project-name}

   - **Pattern**: {one sentence}
     **Evidence**: {which phase / note title, brief}
     **Spec/interview implication**: {what to do differently next time}
   ```

   Use today's date (run `date +%Y-%m-%d` if unsure).

## Key Principles

1. **Write nothing rather than noise** — trivia pollution makes `learnings.md`
   something future sessions skim past. The generalization filter is the whole
   point; when in doubt, discard.
2. **Dedupe before append** — capturing the same project twice must amend, not
   duplicate. Always read the existing file first.
3. **Retire, don't archive** — delete entries the current codebase has
   invalidated (verified, not guessed); git history is the archive. A dead
   entry kept "for reference" costs intake attention every session. When
   unsure whether an entry still holds, keep it.
4. **Zero notes is normal** — clean phases never create note files. A project
   with no notes and no gap-decisions produces zero candidates, which produces
   silence, never invented patterns.
5. **Learnings are hints, not gates** — entries inform future questions; they never
   replace the evidence a gate requires. Codebases drift, so entries are dated.
6. **Human in the loop** — every candidate passes accept/edit/dismiss before it
   is written; unattended runs never write this file.
7. **Markdown, not HTML** — `learnings.md` is a reference document read by future
   sessions, per the SKILL.md Markdown/HTML split.
