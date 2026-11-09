## What and why

<!-- One or two sentences: what this changes and the reason. Link an issue if there is one. -->

## How it was checked

<!-- Tick every box, or write N/A on a line that does not apply. A check blocks the merge until the description follows this template. -->

- [ ] `claude plugin validate --strict .` passes
- [ ] `claude plugin test .` passes, with a test for the change where it fits
- [ ] Looked at the pane in the desktop app (and the terminal, if the layout changed)

## Before merging

- [ ] `version` in `.claude-plugin/plugin.json` is bumped if users should get this as an update
- [ ] README updated if a command git runs, what is read or sent, or how to use the pane changed
- [ ] Any new git command uses `SAFE_GIT_ARGS` / `GIT_OPTIONS`, and repository-derived text goes through `clean()`
