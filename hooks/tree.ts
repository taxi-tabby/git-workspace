// Pure helpers: no `$`, so the tests can call them directly.
import type { ChangedFile, CommitLine, GitKind, RepoInfo, TreeNode } from '../types'

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
export const clean = (text: string): string =>
  // control and format characters (bidi marks, zero-width, soft hyphen, tags), line and
  // paragraph separators, invisible letters (Hangul fillers, CGJ, Mongolian selectors) and
  // variation selectors: anything that could reorder, hide or fake what is shown
  wellFormed(text).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu,
    '',
  )

/** Replaces lone surrogates (possible in NTFS names) so later string work cannot throw. */
export const wellFormed = (text: string): string => text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd')

/** Cuts to `max` code points (never inside a surrogate pair), with an ellipsis. */
export const shorten = (text: string, max: number): string => {
  const points = Array.from(text)
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : text
}

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
  // any filter.* key the repository sets for itself, whatever its last part: a crafted key
  // such as "filter.lfs.process=cmd .required" must never pass as harmless
  const keys: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const [scope, key] = line.split('\t')
    if (!key || scope === 'global' || scope === 'system') continue
    if (/^filter\./i.test(key)) keys.push(key)
  }
  return keys
}

/** `config --show-scope` (git 2.26) is the newest option the mod uses. */
export const MIN_GIT: readonly [number, number] = [2, 26]

/** Reads `git --version` ("git version 2.52.0.windows.1") into "2.52.0" and whether it is too old. */
export const parseGitVersion = (stdout: string): { version: string; isTooOld: boolean } | null => {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(stdout)
  if (!m) return null
  const major = Number(m[1])
  const minor = Number(m[2])
  const version = clean(`${m[1]}.${m[2]}${m[3] ? `.${m[3]}` : ''}`)
  const isTooOld = major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])
  return { version, isTooOld }
}

/**
 * A `file:` URL for a folder, with the row action in its fragment
 * ("D:\a b\c", "scan" -> "file:///D:/a%20b/c#scan"). Markdown links need a file:
 * URL to be drawn as links; every character that could end a markdown link is encoded.
 */
export const actionHref = (path: string, action: 'scan' | 'copy'): string => {
  const parts = path.replace(/\\/g, '/').split('/')
  const encoded = parts
    .map((part, i) => (i === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(wellFormed(part))))
    .join('/')
    .replace(/[()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  const rooted = encoded.startsWith('/') ? encoded : `/${encoded}`
  return `file://${rooted}#${action}`
}

/** Which row action a pressed link names: the fragment actionHref put there. */
export const actionOf = (href: string): 'scan' | 'copy' | null =>
  href.endsWith('#copy') ? 'copy' : href.endsWith('#scan') ? 'scan' : null

/** The first engine known to draw Text `size`, `weight` and `tabular` (older ones refuse them). */
export const RICH_TEXT_SINCE: readonly [number, number, number] = [2, 1, 317]

/** Whether an engine version string ("2.1.317", "2.1.320-dev") is at least RICH_TEXT_SINCE. */
export const supportsRichText = (version: string): boolean => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!m) return false
  const v = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (let i = 0; i < 3; i++) {
    if (v[i]! !== RICH_TEXT_SINCE[i]) return v[i]! > RICH_TEXT_SINCE[i]!
  }
  return true
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

/** Separators for `git log --format`: %x1f between fields, %x1e after each commit. */
export const LOG_FORMAT = '%h%x00%H%x00%s%x00%cr%x00%an%x00'

/**
 * Reads `git log --format=LOG_FORMAT` into commits. Fields and commits are framed by NUL,
 * which no subject or name can contain, so a crafted message cannot forge a row; a record
 * whose hashes are not hex is dropped.
 */
export const parseCommitLines = (stdout: string): CommitLine[] => {
  const fields = stdout.split('\0')
  const out: CommitLine[] = []
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const hash = fields[i]!.trim()
    const full = fields[i + 1]!
    if (!/^[0-9a-f]{4,64}$/.test(hash) || !/^[0-9a-f]{40,64}$/.test(full)) break
    out.push({
      hash,
      full,
      subject: clean(fields[i + 2]!),
      age: clean(fields[i + 3]!),
      author: clean(fields[i + 4]!),
    })
  }
  return out
}

/**
 * Reads `git status --porcelain=v1 -z` into files. Each entry is "XY path"; a
 * rename or copy is followed by its original path, which is skipped.
 */
export const parseChangedFiles = (stdout: string): ChangedFile[] => {
  const files: ChangedFile[] = []
  const parts = stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    files.push({ code: clean(code), path: clean(entry.slice(3)), raw: wellFormed(entry.slice(3)) })
    // a rename or copy, in the index or the worktree, is followed by its original path
    if ('RC'.includes(code[0]!) || 'RC'.includes(code[1]!)) i++
  }
  return files
}

/** Whole minutes, hours or days between two times, for "fetched 3 h ago". */
export const elapsed = (fromMs: number, nowMs: number): { value: number; unit: 'm' | 'h' | 'd' } => {
  const minutes = Math.max(0, Math.floor((nowMs - fromMs) / 60_000))
  if (minutes < 60) return { value: minutes, unit: 'm' }
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return { value: hours, unit: 'h' }
  return { value: Math.floor(hours / 24), unit: 'd' }
}

/** A UNC, device or other double-slash path, which Windows would reach over the network. */
export const isNetworkPath = (path: string): boolean => {
  const p = path.trim().replace(/^"/, '')
  // \\host\share, //host, \\?\UNC\, \\.\, and the NT form \??\UNC\
  return /^[\\/]{2}/.test(p) || /^[\\/]\?\?[\\/]/.test(p)
}

/** The folder itself, then each folder above it, up to the top of its drive (at most 64). */
export const ancestorsOf = (path: string): string[] => {
  const out: string[] = []
  let p = path
  while (p && out.length < 64) {
    out.push(p)
    const up = parentOf(p)
    if (up === p || up.replace(/[\\/]+$/, '') === p.replace(/[\\/]+$/, '')) break
    p = up
  }
  return out
}

/**
 * A drive's top (`C:\`, `/`) or a user's home folder (`C:\Users\me`, `/home/me`,
 * `/Users/me`, `/root`): a `.git` there is a dotfiles repository, not the workspace,
 * so the search for the session's repository stops before it.
 */
export const isHomeOrDriveRoot = (path: string): boolean => {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '')
  if (p === '' || /^[A-Za-z]:$/.test(p)) return true
  return /^(?:[A-Za-z]:)?\/(?:users|home)\/[^/]+$/i.test(p) || /^(?:[A-Za-z]:)?\/root$/i.test(p)
}

/** Reads `rev-list --left-right --count HEAD...@{upstream}` ("<ahead>\t<behind>"). */
export const parseAheadBehind = (stdout: string): { ahead: number; behind: number } | null => {
  const m = /^(\d+)\s+(\d+)/.exec(stdout.trim())
  return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : null
}

/**
 * Every value in a git config file's text: as this simple reader takes it (`value`), a
 * looser reading with quotes dropped and doubled backslashes folded (`loose`, for the
 * network-path test), whether it is an include path (`[include] path` or
 * `[includeIf "…"] path`), and whether it is written in a form git might decode
 * differently from this reader (`isOdd`: quotes or backslashes inside it, a comment mark
 * without a space before it, or a line continuation).
 */
export const configValues = (text: string): { value: string; loose: string; isIncludePath: boolean; isOdd: boolean }[] => {
  const out: { value: string; loose: string; isIncludePath: boolean; isOdd: boolean }[] = []
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[([^\]]*)\]\s*(.*)$/.exec(line)
    const body = header ? header[2]! : line
    if (header) section = header[1]!.trim().split(/\s+/)[0]!.toLowerCase()
    // a section header git might read differently (quoted subsection with escapes or
    // brackets, text after the closing bracket that is not a setting) fails closed
    if (header && (/\\/.test(header[1]!) || /"[^"]*\][^"]*"/.test(line))) {
      out.push({ value: '', loose: '', isIncludePath: true, isOdd: true })
      continue
    }
    if (!body) continue
    const kv = /^([A-Za-z][\w-]*)\s*=\s*(.*)$/.exec(body)
    if (!kv) {
      // a bare boolean key is fine; any other line this reader cannot parse fails closed
      if (!/^[A-Za-z][\w-]*\s*([#;].*)?$/.test(body)) out.push({ value: '', loose: '', isIncludePath: true, isOdd: true })
      continue
    }
    const key = kv[1]!.toLowerCase()
    const written = kv[2]!
    const value = written.replace(/\s[#;].*$/, '').trim().replace(/^"(.*)"$/, '$1')
    const inner = written.replace(/\s[#;].*$/, '').trim()
    const isWhollyQuoted = /^"[^"\\]*"$/.test(inner)
    const isOdd =
      written.endsWith('\\') ||
      (!isWhollyQuoted && /["\\]/.test(inner)) ||
      /[^\s][#;]/.test(inner.replace(/^"[^"]*"$/, ''))
    const loose = written.replace(/"/g, '').replace(/\\\\/g, '\\').trim()
    out.push({ value, loose, isIncludePath: (section === 'include' || section === 'includeif') && key === 'path', isOdd })
  }
  return out
}

/**
 * The filter drivers the person's own (global or system) config defines, to switch off for a
 * status call; null when any of them has a name that is not plain (letters, digits, `.`, `_`,
 * `-`), since such a name could split into a different key and value inside `-c`.
 */
export const allFilterNames = (stdout: string): string[] | null => {
  const names = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const [scope, key] = line.split('\t')
    if (!key || (scope !== 'global' && scope !== 'system')) continue
    const m = /^filter\.(.+)\.(clean|smudge|process|required)$/i.exec(key)
    if (!m?.[1] || !SAFE_FILTER_NAME.test(m[1])) return null
    names.add(m[1])
  }
  return [...names]
}

const SAFE_FILTER_NAME = /^[A-Za-z0-9_.-]{1,64}$/

/** `-c` options that switch each named filter driver off for one git call. */
export const filterOffArgs = (names: readonly string[]): string[] =>
  names.filter(name => SAFE_FILTER_NAME.test(name)).flatMap(name => [
    '-c', `filter.${name}.process=`,
    '-c', `filter.${name}.clean=`,
    '-c', `filter.${name}.smudge=`,
    '-c', `filter.${name}.required=false`,
  ])
