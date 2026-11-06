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
- Press **변경만** (changed only) before you leave for the day to list every repository that still
  needs a commit or a push.

## Usage

- `/git-workspace` opens the pane. `/git-workspace <folder>` scans another folder.
- The pane scans the session's folder by default, down to 4 levels (adjustable from 1 to 10).
- Header buttons: **⟳** refresh (`r`), **변경만** show only repositories that need attention (`f`),
  **⋯** menu (`p`).
- The menu holds the scan-root field, **세션 폴더** (session folder), **상위 폴더** (parent folder),
  recent roots, fold or unfold all, depth − / +, and a legend.
- Hover a row to show **⤴ 루트로** (scan from here) and **⧉ 복사** (copy path). In the terminal
  these appear inline while the menu is open.
- The pane rescans every 60 seconds and shortly after Claude runs a Bash command.

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
| Find filter drivers the repository sets for itself | `git -C <repo> config --show-scope --name-only --get-regexp ^filter\.` |
| Branch, upstream, ahead/behind, changed files | `git -C <repo> status --porcelain=v2 --branch --untracked-files=normal --ignore-submodules=all` |
| Branch only, when status is skipped | `git -C <repo> symbolic-ref --quiet --short HEAD` |
| Last commit | `git -C <repo> log -1 --no-show-signature --format=%h %s%x1f%cr` |

Scanned repositories are treated as untrusted. Every call passes
`-c core.fsmonitor=false -c core.hooksPath= -c core.pager=cat -c diff.external=
-c log.showSignature=false -c gpg.program=false -c gpg.ssh.program=false
-c gpg.x509.program=false --no-pager --no-optional-locks`, so repository config cannot make git
start another program. It also sets `GIT_TERMINAL_PROMPT=0`, so git never prompts. A repository
that defines its own filter drivers, or whose config cannot be read, gets its branch shown
without `git status`. Control characters are stripped from everything shown.

### Sends: nothing over the network

- It makes no network requests and sends no data anywhere.
- Pressing **⧉ 복사** (copy) puts that repository's folder path on your clipboard through Claude
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

## Support

Report problems and ideas in
[GitHub issues](https://github.com/taxi-tabby/git-workspace/issues).

## License

MIT. See [LICENSE](LICENSE).
