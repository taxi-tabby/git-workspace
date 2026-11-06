// Pure helpers: no `$`, so the tests can call them directly.
import type { GitKind, RepoInfo, TreeNode } from '../types'

/** A directory found by the scan: a repository, or a folder holding one somewhere below. */
export type RawNode = {
  path: string
  name: string
  isRepo: boolean
  gitKind: GitKind
  children: RawNode[]
}

export const joinPath = (dir: string, name: string): string =>
  dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}/${name}`

export const parentOf = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}/`
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut < 0) return path
  if (cut === 0) return trimmed.slice(0, 1)
  const parent = trimmed.slice(0, cut)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent
}

export const baseName = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

/** Strip C0/C1 control characters (terminal escape sequences) from repo-derived text. */
export const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

/** What a `.git` *file* points at: a linked worktree, a submodule, or a plain gitdir. */
export const gitKindOfFile = (content: string): GitKind => {
  const dir = content.replace(/\\/g, '/')
  if (dir.includes('/worktrees/')) return 'worktree'
  if (dir.includes('/modules/')) return 'submodule'
  return 'repo'
}

export const emptyRepo = (): RepoInfo => ({
  branch: '',
  isDetached: false,
  upstream: '',
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicts: 0,
  lastCommit: '',
  lastCommitAge: '',
  warning: '',
  error: '',
})

/** Reads `git status --porcelain=v2 --branch`. */
export const parseStatus = (stdout: string, repo: RepoInfo): RepoInfo => {
  const next = { ...repo }
  let oid = ''
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('# branch.oid ')) {
      oid = line.slice('# branch.oid '.length)
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length)
      next.isDetached = head === '(detached)'
      next.branch = head
    } else if (line.startsWith('# branch.upstream ')) {
      next.upstream = line.slice('# branch.upstream '.length)
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) {
        next.ahead = Number(m[1])
        next.behind = Number(m[2])
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4)
      if (xy[0] !== '.') next.staged++
      if (xy[1] !== '.') next.unstaged++
    } else if (line.startsWith('u ')) {
      next.conflicts++
    } else if (line.startsWith('? ')) {
      next.untracked++
    }
  }
  if (next.isDetached) next.branch = oid && oid !== '(initial)' ? `(detached ${oid.slice(0, 7)})` : '(detached)'
  return next
}

/**
 * Names of filter drivers set in a repository's own config
 * (`git config --show-scope --name-only --get-regexp ^filter\.` output).
 * Global and system ones are the person's own and trusted.
 */
export const untrustedFilters = (stdout: string): string[] => {
  const names = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const [scope, key] = line.split('\t')
    if (!key || scope === 'global' || scope === 'system') continue
    const m = /^filter\.(.+)\.(clean|smudge|process)$/i.exec(key)
    if (m?.[1]) names.add(m[1])
  }
  return [...names]
}

export const isDirty = (r: RepoInfo): boolean => r.staged + r.unstaged + r.untracked + r.conflicts > 0
export const needsAttention = (r: RepoInfo): boolean =>
  isDirty(r) || r.ahead > 0 || r.behind > 0 || r.error !== '' || r.warning !== ''

/**
 * Turns the scanned tree (its root excluded) into pre-order rows. A folder
 * that is not a repository and holds exactly one folder that is not one either
 * is merged with it ("apps/web"), so deep plain-folder chains take one row.
 */
export const flatten = (root: RawNode, repos: ReadonlyMap<string, RepoInfo>): TreeNode[] => {
  const rows: TreeNode[] = []
  const visit = (node: RawNode, parent: string, depth: number) => {
    let current = node
    let label = node.name
    while (!current.isRepo && current.children.length === 1 && !current.children[0]!.isRepo) {
      current = current.children[0]!
      label = `${label}/${current.name}`
    }
    rows.push({
      path: current.path,
      parent,
      depth,
      kind: current.isRepo ? 'repo' : 'folder',
      gitKind: current.gitKind,
      label,
      hasChildren: current.children.length > 0,
      repo: current.isRepo ? (repos.get(current.path) ?? null) : null,
    })
    for (const child of current.children) visit(child, current.path, depth + 1)
  }
  for (const child of root.children) visit(child, '', 0)
  return rows
}

/** Rows to draw: hides rows under a collapsed one and, with `onlyChanged`, quiet repositories. */
export const visibleRows = (
  rows: readonly TreeNode[],
  collapsed: ReadonlySet<string>,
  onlyChanged: boolean,
): TreeNode[] => {
  let keep: Set<string> | undefined
  if (onlyChanged) {
    const byPath = new Map(rows.map(row => [row.path, row]))
    keep = new Set()
    for (const row of rows) {
      if (!row.repo || !needsAttention(row.repo)) continue
      let at: TreeNode | undefined = row
      while (at && !keep.has(at.path)) {
        keep.add(at.path)
        at = byPath.get(at.parent)
      }
    }
  }
  const out: TreeNode[] = []
  let hiddenBelow = -1
  for (const row of rows) {
    if (hiddenBelow >= 0 && row.depth > hiddenBelow) continue
    hiddenBelow = -1
    if (keep && !keep.has(row.path)) continue
    out.push(row)
    if (collapsed.has(row.path) && row.hasChildren) hiddenBelow = row.depth
  }
  return out
}

/** Repositories and changed repositories at or below each row. */
export const subtreeCounts = (rows: readonly TreeNode[]): Map<string, { repos: number; changed: number }> => {
  const counts = new Map<string, { repos: number; changed: number }>()
  const byPath = new Map(rows.map(row => [row.path, row]))
  for (const row of rows) counts.set(row.path, { repos: 0, changed: 0 })
  for (const row of rows) {
    if (!row.repo) continue
    const isChanged = needsAttention(row.repo)
    let at: TreeNode | undefined = row
    while (at) {
      const c = counts.get(at.path)!
      c.repos++
      if (isChanged) c.changed++
      at = byPath.get(at.parent)
    }
  }
  return counts
}
