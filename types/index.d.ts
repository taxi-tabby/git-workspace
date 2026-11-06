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
    }
  }
}
