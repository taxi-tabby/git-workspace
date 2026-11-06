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

- **Reads** folder listings under the scan root, and the `.git` file of worktrees and submodules.
  It skips `node_modules`, `dist`, `build`, `vendor`, dot-folders and similar, and stops after 5000
  folders.
- **Runs** the local `git` executable, read-only: `config --get-regexp`, `status --porcelain`,
  `log -1` and `symbolic-ref`. Repositories are treated as untrusted. Every call turns off settings
  that could start a program (fsmonitor, hooks, pager, external diff, signature programs). A
  repository that defines its own filter drivers gets its branch shown without `git status`.
  Control characters are stripped from everything shown.
- **Sends** nothing. It makes no network requests and collects no data. The only thing it stores
  is your list of recently used scan roots, in Claude Code's local plugin store.

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
