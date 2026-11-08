# Security policy

git-workspace runs `git` in folders you choose to scan, and those folders may contain
repositories other people prepared. Its job is to make sure such a repository cannot make
the pane start a program or reach another machine. The README, under "What it reads, runs
and sends", lists every command and every check.

## Reporting a vulnerability

Please report it privately. Do not open a public issue.

- On GitHub: **Security → Report a vulnerability**
  (<https://github.com/taxi-tabby/git-workspace/security/advisories/new>)

Include how the repository or folder is prepared, what the pane does with it, and the
versions of git-workspace, Claude Code, git and your OS. You'll get a reply within a week.
Fixes ship as a new version. Advisories are published once a fix is out.

## Supported versions

Only the latest released version receives fixes. Update with
`claude plugin update git-workspace@git-workspace`.
