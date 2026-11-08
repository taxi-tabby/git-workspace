export type GitKind = 'repo' | 'worktree' | 'submodule'

export type RepoInfo = {
  branch: string
  isDetached: boolean
  upstream: string
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicts: number
  lastCommit: string
  lastCommitAge: string
  /** why `git status` was not run (untrusted filter drivers), or '' */
  warning: string
  error: string
}

/** One row of the tree, in pre-order. `parent` is '' for a top-level row. */
export type TreeNode = {
  path: string
  parent: string
  depth: number
  kind: 'folder' | 'repo'
  gitKind: GitKind
  label: string
  hasChildren: boolean
  repo: RepoInfo | null
}

export type ScanInfo = {
  root: string
  isRootRepo: boolean
  rootRepo: RepoInfo | null
  sessionDir: string
  isScanning: boolean
  scannedAt: number
  visited: number
  isTruncated: boolean
  error: string
  /** `git --version`'s number ("2.52.0"), or '' when git did not run */
  gitVersion: string
  /** '' when git is usable; 'missing' when it cannot start; 'old' when older than the mod needs */
  gitProblem: '' | 'missing' | 'old'
}

/** One commit as a detail list shows it. */
export type CommitLine = {
  hash: string
  /** the full 40-character hash, what the copy link puts on the clipboard */
  full: string
  subject: string
  age: string
  author: string
}

/** A changed file: its two-letter porcelain code ("M ", " M", "??", "UU") and path. */
export type ChangedFile = {
  code: string
  path: string
}

/** What an opened repository row shows below itself. Read on demand, never fetched. */
export type RepoDetail = {
  path: string
  isLoading: boolean
  /** true once this row's details were read at least once (no flicker on refreshes) */
  hasLoaded: boolean
  /** when `git fetch` last updated this repository ('' when it never has) */
  lastFetchAge: string
  /** the upstream as git names it ("origin/main"); '' when the branch has none */
  upstream: string
  ahead: number
  behind: number
  incoming: CommitLine[]
  outgoing: CommitLine[]
  recent: CommitLine[]
  files: ChangedFile[]
  filesTotal: number
  stashes: number
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'git-workspace': {
      nodes: Shaped<TreeNode[]>
      scan: Shaped<ScanInfo>
      onlyDirty: boolean
      collapsed: Shaped<string[]>
      /** scan root chosen in this session; '' = the session's own folder */
      root: string
      maxDepth: number
      isEditingRoot: boolean
      /** the repository row opened to show its details; '' = none */
      openRepo: string
      detail: Shaped<RepoDetail | null>
    }
  }
}
