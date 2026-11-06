# git-workspace

Claude Code mod that adds a **Git 워크스페이스** pane beside the chat. It lists every git
repository directly under a folder you choose, and shows for each one:

- current branch (or detached commit), upstream, ahead/behind counts
- staged / modified / untracked / conflict file counts
- last commit subject and age

Buttons: refresh (`r`), show only changed repos (`f`), copy repo path.
The pane rescans every 60 seconds and shortly after Claude runs a Bash command.

## Usage

- `/git-workspace` opens the pane.
- `/git-workspace <folder>` sets the folder to scan (remembered across sessions).
  You can also type the folder into the input box in the pane.
- Default folder: the parent of the session's working directory.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install git-workspace --marketplace taxi-tabby/claude-mod-git-workspace-viewer
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```bash
claude plugin install git-workspace --marketplace taxi-tabby/claude-mod-git-workspace-viewer
```

In the Claude desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace**
with `taxi-tabby/claude-mod-git-workspace-viewer`, then **Add plugin**.

This repository is private: installing works only for people invited to it on GitHub whose
machine already has a git credential for github.com (an SSH key, or `gh auth login` followed by
`gh auth setup-git`).

## Developing

Point `CLAUDE_CODE_PLUGIN_DIRS` (env block of `~/.claude/settings.json`) at this folder to load it
from disk in every session; saving a file reloads the mod.
