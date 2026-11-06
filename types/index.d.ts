export type RepoInfo = {
  name: string
  path: string
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
  error: string
}

export type ScanInfo = {
  root: string
  isScanning: boolean
  scannedAt: number
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'git-workspace': {
      repos: Shaped<RepoInfo[]>
      scan: Shaped<ScanInfo>
      onlyDirty: boolean
    }
  }
}
