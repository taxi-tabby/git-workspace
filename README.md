# git-workspace

A Claude Code mod that keeps a **Git workspace** pane beside the chat. It finds every git
repository under a folder, however they are nested, and shows them as a collapsible tree:

- a plain folder holding many repositories
- a repository holding more repositories
- a repository, then plain folders, then more repositories
- linked worktrees and submodules, marked as such

For each repository you see the current branch (or detached commit), commits to push (↑) and to
pull (↓), counts of staged (+), modified (~), untracked (?) and conflicted (!) files, and the last
commit with its age.

## Examples

- Open Claude Code in a folder of several projects and see at a glance which ones have
  uncommitted work or unpushed commits.
- In a monorepo or a workspace folder with nested repositories, fold everything except the group
  you are working on.
- Press **Changed** before you leave for the day to list every repository that still
  needs a commit or a push.

## Usage

- `/git-workspace` opens the pane. `/git-workspace <folder>` scans another folder.
- The pane scans the session's folder by default, down to 4 levels (adjustable from 1 to 10).
- Header buttons: **Refresh** (`r`), **Changed** shows only repositories that need attention
  (`f`), and **Settings** (`p`).
- **Settings** holds the scan-root field, **Session folder**, **Parent folder**, recent roots,
  collapse or expand all, depth − / +, and a legend.
- Press **▸** beside a repository to open its details:
  - whether it is up to date, has commits **to pull** or **to push**, has diverged, or has no
    upstream, and when it was last fetched
  - the commits to pull and to push
  - its changed files, its stash count, and the last 8 commits on the checked-out branch
- "To pull" compares against the remote-tracking branch as your last `git fetch` left it. The pane
  never fetches, so run `git fetch` (or let your editor do it) for fresh numbers.
- Hover a row for **⤴** (scan from that folder) and **⧉** (copy its path). In the terminal these
  appear as buttons while Settings is open.
- The pane rescans every 60 seconds and shortly after Claude runs a Bash command. An opened row's
  details refresh with it.

## Language

The pane is in English by default. To use Korean (한국어), set the plugin's **Language** option
to `ko`. The install screen asks for it, and it also appears as a row in `/config`. The pane
reloads in the new language.

## Requirements

- `git` 2.26 or newer on `PATH`.
- If git is missing, the pane says so in a banner. It still shows where the repositories are,
  links to [git-scm.com/downloads](https://git-scm.com/downloads), and has a **Check again**
  button.
- If git is older than 2.26, the banner names the installed version. Branches are still shown,
  but changed files are not.

## What it reads, runs and sends

### Reads

- Folder listings under the scan root.
- The `.git` file of worktrees and submodules, to tell which kind they are.
- It skips `node_modules`, `dist`, `build`, `vendor`, dot-folders and similar, and stops after 5000
  folders.

### Runs: `git` only

The mod runs one program: the local `git` executable, started directly by name with a fixed
argument list. No shell or inline script is involved. It needs `git` to read each repository's
branch, upstream, ahead/behind counts, changed files and last commit. Although git can reach the
network, this mod never uses it that way. It never runs `fetch`, `pull`, `push`, `clone`,
`ls-remote` or any other command that contacts a remote. The ahead/behind counts come from the
remote-tracking branches already on disk. It never writes to a repository. These are the four commands, written as
fixed text in `hooks/register.tsx`. `<repo>` is the repository's folder, and every call has the
safety options shown under it.

| Purpose | Command |
| --- | --- |
| Check that git is installed, and its version (once per scan) | `git --version` |
| Find filter drivers the repository sets for itself | `git -C <repo> config --show-scope --name-only --get-regexp ^filter\.` |
| Branch, upstream, ahead/behind, changed files | `git -C <repo> status --porcelain=v2 --branch --untracked-files=normal --ignore-submodules=all` |
| Branch only, when status is skipped | `git -C <repo> symbolic-ref --quiet --short HEAD` |
| Last commit | `git -C <repo> log -1 --no-show-signature --format=%h %s%x1f%cr` |
| Details: last 8 commits | `git -C <repo> log -8 --no-show-signature --format=… --` |
| Details: commits to pull | `git -C <repo> log -20 --no-show-signature --format=… HEAD..@{upstream} --` |
| Details: commits to push | `git -C <repo> log -20 --no-show-signature --format=… @{upstream}..HEAD --` |
| Details: upstream name | `git -C <repo> rev-parse --abbrev-ref --symbolic-full-name @{upstream}` |
| Details: how many to push / pull | `git -C <repo> rev-list --left-right --count HEAD...@{upstream} --` |
| Details: changed files | `git -C <repo> status --porcelain=v1 -z --untracked-files=normal --ignore-submodules=all` |
| Details: stash count | `git -C <repo> rev-list --walk-reflogs --count refs/stash --` |
| Details: where FETCH_HEAD is, for the last fetch time | `git -C <repo> rev-parse --git-dir --git-common-dir` |

The details commands run only for the row you open. The changed-files command is skipped for a
repository that sets its own filter drivers, the same rule as `git status` above.

Scanned repositories are treated as untrusted. Every call passes
`-c core.fsmonitor=false -c core.hooksPath= -c core.pager=cat -c diff.external=
-c log.showSignature=false -c gpg.program=false -c gpg.ssh.program=false
-c gpg.x509.program=false -c protocol.allow=never -c core.sshCommand= -c credential.helper=
-c core.askPass= --no-pager --no-optional-locks`. With these, repository config cannot make git
start another program, and git can use no transport at all. It also sets `GIT_NO_LAZY_FETCH=1`,
so even a partial clone can't fetch a missing object, and `GIT_TERMINAL_PROMPT=0`, so git never
prompts. Before git runs in a repository, the pane reads its `.git` file, the git folder's real
path, `commondir` and `objects/info/alternates`. If any of them points at a network path
(`\\host\share`, `//host/share`), the repository is listed but git never runs there, details
included. The same applies when a symbolic link sits inside the git folder (the folder
itself, refs, logs, info, worktrees, objects/info, objects/pack), when a config file git would
read is oversized or unreadable, when an include path is written in a form git might decode
differently (quotes, escapes, comment marks, line continuations), or when a check runs out of
its budget. Known limits: a drive letter mapped to a network share (`net use Z:`) looks like a
local path to these checks, and untracked nested repositories deeper than the scan depth are
not inspected. A repository
that defines its own filter drivers, or whose config cannot be read, gets its branch shown
without `git status`. Control characters are stripped from everything shown.

### Sends: nothing over the network

- It makes no network requests and sends no data anywhere.
- Pressing **⧉ Copy path** puts that repository's folder path on your clipboard through Claude
  Code's clipboard call (`$.ui.copy`). That happens only when you press it.
- It stores only your list of recently used scan roots, in Claude Code's local plugin store
  (`$.store`). The scan results stay in the session's own state.

## Hooks and command

- `session.start`: registers `/git-workspace`, opens the pane, starts a scan and a 60-second
  refresh timer. It then passes the event on unchanged.
- `command.run` for `/git-workspace` only: opens the pane. With a folder argument it sets the
  scan root. It answers with one line naming the scan root, and handles no other command.
- `tool.call` for `Bash` only: lets the call run unchanged, returns its result unchanged, and
  schedules a rescan 1.5 seconds later. A Bash command may have switched branches, committed or
  pulled. It never blocks, rewrites or delays a call. It does not read the command, its output
  or anything else from the conversation. It uses the event only as a signal to refresh.
- Nothing from the conversation reaches `git` or the pane. The only inputs are folder paths: the
  session's folder, a folder you type or pick, and what the scan finds on disk.
- `ui.render` for its own pane: draws the tree.

It changes no settings or permissions, and adds no tools, agents or subagents.

## Install

In a Claude Code session:

```
/plugin install git-workspace --marketplace taxi-tabby/git-workspace
```

From a shell:

```bash
claude plugin install git-workspace --marketplace taxi-tabby/git-workspace
```

In the Claude desktop app, click **+** next to the prompt box, choose **Plugins**, add the
marketplace `taxi-tabby/git-workspace`, then add the plugin.

To receive updates automatically, run `/plugin`, open the **Marketplaces** tab, select
`git-workspace` and choose **Enable auto-update**. Otherwise run
`claude plugin update git-workspace@git-workspace`.

## Developing

Point `CLAUDE_CODE_PLUGIN_DIRS` (the `env` block of `~/.claude/settings.json`) at a clone of this
repository to load it from disk in every session. Saving a file reloads the mod.
`claude plugin test .` runs the tests. Bump `version` in `.claude-plugin/plugin.json` for every
release, because installed copies update only when it changes.

## Contributing

Changes go through pull requests into `main`; CI runs `claude plugin validate --strict` and
`claude plugin test`, and must pass before a PR can be squash-merged. The PR template lists
what to check. Security problems: see [SECURITY.md](SECURITY.md).

## Support

Report problems and ideas in
[GitHub issues](https://github.com/taxi-tabby/git-workspace/issues).

## License

MIT. See [LICENSE](LICENSE).
