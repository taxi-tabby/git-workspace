import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TextProps, UiPressArgument } from 'claude-code'

import type { RepoInfo, ScanInfo, TreeNode } from '../types'
import {
  baseName,
  clean,
  emptyRepo,
  flatten,
  gitKindOfFile,
  isDirty,
  needsAttention,
  joinPath,
  MIN_GIT,
  parentOf,
  parseGitVersion,
  parseStatus,
  supportsRichText,
  subtreeCounts,
  untrustedFilters,
  visibleRows,
} from './tree'
import type { RawNode } from './tree'
import { STRINGS, toLang } from './i18n'
import { ICONS, statusBar } from './icons'
import type { IconName } from './icons'
import type { Strings } from './i18n'

const PANE = 'git-workspace'
// the strings of the language chosen in the plugin's settings (English by default)
let T: Strings = STRINGS.en
// Text `size` / `weight` / `tabular` arrived after 2.1.296; set from the engine's version at session start
let richText = false
const STORE_RECENT = 'recentRoots'
const REFRESH_MS = 60_000
const GIT_CONCURRENCY = 6
const FS_CONCURRENCY = 8
const MAX_VISITED = 5000
const DEFAULT_DEPTH = 4
/** Below this many columns the header and each row stack instead of sharing a line. */
const NARROW_COLUMNS = 48
const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'venv', '__pycache__', 'target', 'dist', 'build', 'out', 'obj', 'Pods',
  '$RECYCLE.BIN', 'System Volume Information',
])

const nodes = atom({ plugin: 'git-workspace', key: 'nodes' } as const, [], { shape: 'nodes-1' })
const scan = atom(
  { plugin: 'git-workspace', key: 'scan' } as const,
  {
    root: '', isRootRepo: false, rootRepo: null, sessionDir: '', isScanning: false,
    scannedAt: 0, visited: 0, isTruncated: false, error: '', gitVersion: '', gitProblem: '',
  },
  { shape: 'scan-3' },
)
const onlyDirty = atom({ plugin: 'git-workspace', key: 'onlyDirty' } as const, false)
const collapsed = atom({ plugin: 'git-workspace', key: 'collapsed' } as const, [], { shape: 'collapsed-1' })
const rootChoice = atom({ plugin: 'git-workspace', key: 'root' } as const, '')
const maxDepth = atom({ plugin: 'git-workspace', key: 'maxDepth' } as const, DEFAULT_DEPTH)
const isEditingRoot = atom({ plugin: 'git-workspace', key: 'isEditingRoot' } as const, false)

type Engine = EngineInterface

// ---------------------------------------------------------------- git
//
// The only program this mod runs is the local `git`, read-only, with these four
// fixed commands. Scanned repositories are untrusted, so every call switches off
// each config setting that could make git start another program (fsmonitor,
// hooks, pager, external diff, signature programs) and never prompts.

const GIT_OPTIONS = { timeoutMs: 15_000, env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }

/** Whether git can start at all, and its version. */
async function gitVersionCommand($: Engine) {
  return $.process.run(['git', '--version'], { timeoutMs: 10_000, env: { GIT_TERMINAL_PROMPT: '0' } })
}

async function checkGit($: Engine): Promise<{ version: string; problem: ScanInfo['gitProblem'] }> {
  try {
    const result = await gitVersionCommand($)
    const parsed = result.exitCode === 0 ? parseGitVersion(result.stdout) : null
    if (!parsed) return { version: '', problem: 'missing' }
    return { version: parsed.version, problem: parsed.isTooOld ? 'old' : '' }
  } catch {
    // the process could not start: git is not installed or not on PATH
    return { version: '', problem: 'missing' }
  }
}

/** Lists filter drivers from every config scope (reading config runs nothing). */
async function gitFilterConfig($: Engine, cwd: string) {
  return $.process.run(
    ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'log.showSignature=false', '-c', 'gpg.program=false', '-c', 'gpg.ssh.program=false', '-c', 'gpg.x509.program=false', '--no-pager', '--no-optional-locks', '-C', cwd, 'config', '--show-scope', '--name-only', '--get-regexp', '^filter\\.'],
    GIT_OPTIONS,
  )
}

/** Branch, upstream, ahead/behind and changed files. */
async function gitStatus($: Engine, cwd: string) {
  return $.process.run(
    ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'log.showSignature=false', '-c', 'gpg.program=false', '-c', 'gpg.ssh.program=false', '-c', 'gpg.x509.program=false', '--no-pager', '--no-optional-locks', '-C', cwd, 'status', '--porcelain=v2', '--branch', '--untracked-files=normal', '--ignore-submodules=all'],
    GIT_OPTIONS,
  )
}

/** The current branch name, for a repository whose status is not read. */
async function gitHead($: Engine, cwd: string) {
  return $.process.run(
    ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'log.showSignature=false', '-c', 'gpg.program=false', '-c', 'gpg.ssh.program=false', '-c', 'gpg.x509.program=false', '--no-pager', '--no-optional-locks', '-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
    GIT_OPTIONS,
  )
}

/** Short hash, subject and age of the last commit. */
async function gitLastCommit($: Engine, cwd: string) {
  return $.process.run(
    ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'log.showSignature=false', '-c', 'gpg.program=false', '-c', 'gpg.ssh.program=false', '-c', 'gpg.x509.program=false', '--no-pager', '--no-optional-locks', '-C', cwd, 'log', '-1', '--no-show-signature', '--format=%h %s%x1f%cr'],
    GIT_OPTIONS,
  )
}

function sanitize(repo: RepoInfo): RepoInfo {
  return {
    ...repo,
    branch: clean(repo.branch),
    upstream: clean(repo.upstream),
    lastCommit: clean(repo.lastCommit),
    lastCommitAge: clean(repo.lastCommitAge),
    warning: clean(repo.warning),
    error: clean(repo.error),
  }
}

async function inspectRepo($: Engine, path: string): Promise<RepoInfo> {
  let repo = emptyRepo()
  try {
    // A filter driver set by the repository itself could run a program during
    // `git status`, so such a repository gets its branch read without status.
    const filters = await gitFilterConfig($, path)
    // exit 1 with no output is git's "no such key"; any other failure fails closed
    const isUnchecked = filters.exitCode !== 0 && !(filters.exitCode === 1 && filters.stdout.trim() === '')
    const risky = filters.exitCode === 0 ? untrustedFilters(filters.stdout) : []

    if (isUnchecked || risky.length > 0) {
      const head = await gitHead($, path)
      repo.branch = head.exitCode === 0 ? head.stdout.trim() : '(detached)'
      repo.isDetached = head.exitCode !== 0
      repo.warning = isUnchecked
        ? T.skippedUnchecked
        : T.skippedFilters(risky.join(', '))
    } else {
      const status = await gitStatus($, path)
      if (status.exitCode !== 0) {
        return sanitize({ ...repo, error: status.stderr.trim().split(/\r?\n/)[0] || T.statusFailed })
      }
      repo = parseStatus(status.stdout, repo)
    }

    const last = await gitLastCommit($, path)
    if (last.exitCode === 0) {
      const [subject, age] = last.stdout.trim().split('\x1f')
      const s = clean(subject ?? '')
      repo.lastCommit = s.length > 90 ? `${s.slice(0, 89)}…` : s
      repo.lastCommitAge = age ?? ''
    } else {
      repo.lastCommit = T.noCommits
    }
  } catch (err) {
    repo.error = err instanceof Error ? err.message : String(err)
  }
  return sanitize(repo)
}

/** Inspects `paths` from a shared cursor; several of these run side by side. */
async function inspectWorker($: Engine, paths: string[], out: RepoInfo[], cursor: { next: number }) {
  while (cursor.next < paths.length) {
    const index = cursor.next++
    out[index] = await inspectRepo($, paths[index]!)
  }
}

async function inspectAll($: Engine, paths: string[]): Promise<RepoInfo[]> {
  const out: RepoInfo[] = new Array(paths.length)
  const cursor = { next: 0 }
  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(GIT_CONCURRENCY, paths.length); i++) workers.push(inspectWorker($, paths, out, cursor))
  await Promise.all(workers)
  return out
}

// ---------------------------------------------------------------- scan

type Walk = { visited: number; isTruncated: boolean; active: number; waiting: (() => void)[] }

async function acquireSlot(walk: Walk) {
  if (walk.active >= FS_CONCURRENCY) await new Promise<void>(resolve => walk.waiting.push(resolve))
  walk.active++
}

function releaseSlot(walk: Walk) {
  walk.active--
  walk.waiting.shift()?.()
}

async function listDir($: Engine, walk: Walk, path: string) {
  await acquireSlot(walk)
  try {
    return await $.fs.list(path)
  } catch {
    return []
  } finally {
    releaseSlot(walk)
  }
}

async function readGitFile($: Engine, path: string): Promise<string> {
  try {
    const content = await $.fs.read(joinPath(path, '.git'))
    return typeof content === 'string' ? content : ''
  } catch {
    return ''
  }
}

/**
 * One folder of the walk: a repository, or a folder that leads to one. It goes
 * on through repositories too (a repository can hold more repositories).
 */
async function visitDir($: Engine, walk: Walk, path: string, level: number, depth: number): Promise<RawNode | null> {
  if (walk.visited >= MAX_VISITED) {
    walk.isTruncated = true
    return null
  }
  walk.visited++
  const entries = await listDir($, walk, path)
  const dotGit = entries.find(entry => entry.name === '.git')
  const gitKind: RawNode['gitKind'] = dotGit?.kind === 'file' ? gitKindOfFile(await readGitFile($, path)) : 'repo'
  const children: RawNode[] = []
  if (level < depth) {
    const dirs = entries
      .filter(entry => entry.kind === 'dir' && !entry.isLink && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b))
    const pending: Promise<RawNode | null>[] = []
    for (const name of dirs) pending.push(visitDir($, walk, joinPath(path, name), level + 1, depth))
    for (const child of await Promise.all(pending)) if (child) children.push(child)
  }
  const isRepo = dotGit !== undefined
  if (!isRepo && children.length === 0 && level > 0) return null
  return { path, name: clean(baseName(path) || path), isRepo, gitKind, children }
}

async function walkTree($: Engine, root: string, depth: number) {
  const walk: Walk = { visited: 0, isTruncated: false, active: 0, waiting: [] }
  const tree = (await visitDir($, walk, root, 0, depth)) ?? { path: root, name: root, isRepo: false, gitKind: 'repo', children: [] }
  return { tree, visited: walk.visited, isTruncated: walk.isTruncated }
}

function repoPaths(node: RawNode, into: string[] = []): string[] {
  if (node.isRepo) into.push(node.path)
  for (const child of node.children) repoPaths(child, into)
  return into
}

async function sessionDir($: Engine): Promise<string> {
  try {
    const cwd = await $.fs.stat('.', { resolve: true })
    return cwd.realPath ?? '.'
  } catch {
    return '.'
  }
}

async function currentRoot($: Engine): Promise<{ root: string; session: string }> {
  const session = await sessionDir($)
  const chosen = (await read($, rootChoice)).trim()
  return { root: chosen || session, session }
}

async function scanOnce($: Engine) {
  const { root, session } = await currentRoot($)
  const depth = await read($, maxDepth)
  await update($, scan, s => ({ ...s, root, sessionDir: session, isScanning: true, error: '' }))
  try {
    if (!(await $.fs.exists(root))) throw new Error(T.folderMissing(root))
    const git = await checkGit($)
    const { tree, visited, isTruncated } = await walkTree($, root, depth)
    const paths = repoPaths(tree)
    // without git the tree still shows where the repositories are, with no status
    const infos = git.problem === 'missing' ? [] : await inspectAll($, paths)
    const byPath = new Map(infos.map((info, i) => [paths[i]!, info]))
    const rows = flatten(tree, byPath)
    await update($, nodes, () => rows)
    await update($, scan, s => ({
      ...s,
      gitVersion: git.version,
      gitProblem: git.problem,
      isRootRepo: tree.isRepo,
      rootRepo: tree.isRepo ? (byPath.get(tree.path) ?? null) : null,
      isScanning: false,
      scannedAt: Date.now(),
      visited,
      isTruncated,
    }))
  } catch (err) {
    const message = clean(err instanceof Error ? err.message : String(err))
    await update($, nodes, () => [])
    await update($, scan, s => ({
      ...s, isRootRepo: false, rootRepo: null, isScanning: false, scannedAt: Date.now(), error: message,
    }))
  }
}

// one scan at a time; a request during a scan runs one more after it
const scanner: { running: Promise<void> | undefined; again: boolean } = { running: undefined, again: false }

async function scanLoop($: Engine) {
  try {
    do {
      scanner.again = false
      await scanOnce($)
    } while (scanner.again)
  } finally {
    scanner.running = undefined
  }
}

function rescan($: Engine): Promise<void> {
  if (scanner.running) {
    scanner.again = true
    return scanner.running
  }
  scanner.running = scanLoop($)
  return scanner.running
}

async function rememberRoot($: Engine, root: string) {
  const stored = await $.store.get(STORE_RECENT)
  const list = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []
  await $.store.set(STORE_RECENT, [root, ...list.filter(x => x !== root)].slice(0, 6))
}

async function recentRoots($: Engine): Promise<string[]> {
  const stored = await $.store.get(STORE_RECENT)
  return Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []
}

/** '' goes back to the session's folder. */
async function setRoot($: Engine, value: string) {
  const root = value.trim().replace(/^"(.*)"$/, '$1')
  await update($, rootChoice, () => root)
  await update($, collapsed, () => [])
  await update($, isEditingRoot, () => false)
  if (root) await rememberRoot($, root)
  await rescan($)
}

async function toggleFold($: Engine, path: string) {
  await update($, collapsed, list => (list.includes(path) ? list.filter(p => p !== path) : [...list, path]))
}

async function changeDepth($: Engine, delta: number) {
  await update($, maxDepth, d => Math.min(10, Math.max(1, d + delta)))
  await rescan($)
}

async function copyPath($: Engine, path: string, surface: UiPressArgument['surface']) {
  await $.ui.copy({ text: path, surface })
}

// ---------------------------------------------------------------- drawing

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

function clockText(ms: number) {
  if (!ms) return '-'
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function samePath(a: string, b: string) {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  return norm(a) === norm(b)
}

export const register: Register = (on, options) => {
  T = STRINGS[toLang(options.language)]

  let debounce: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    richText = supportsRichText((await $.session.version()).version)
    await $.command.register({
      name: 'git-workspace',
      description: T.commandDescription,
    })
    void $.ui.open({ id: PANE, title: T.title })
    void rescan($)
    $.clock.every(REFRESH_MS, () => rescan($))
    return next(e)
  })

  on('command.run', { command: 'git-workspace' }, async ($, e) => {
    if (e.args.trim()) await setRoot($, e.args)
    else void rescan($)
    await $.ui.open({ id: PANE, title: T.title })
    const { root } = await currentRoot($)
    return { text: T.commandOpened(root) }
  })

  // a Bash call may have switched branches, committed or pulled: refresh shortly after
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    debounce?.cancel()
    debounce = $.clock.after(1500, () => rescan($))
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Link } = els
    const Input = 'Input' in els ? els.Input : undefined
    // Decide by surface, not by `'Svg' in els`: the table is completed to every element
    // name, so a surface without Svg may still hand out one that draws nothing.
    const hasSvg = e.surface === 'desktop' || e.surface === 'vscode'
    const Svg = hasSvg && 'Svg' in els ? els.Svg : undefined
    // desktop has a pointer: row actions float in on hover. Elsewhere they are
    // drawn on a line of their own while the menu is open, so the keyboard reaches them.
    const hasHover = e.surface === 'desktop'

    const info: ScanInfo = await read($, scan)
    const rows: TreeNode[] = await read($, nodes)
    const dirtyOnly = await read($, onlyDirty)
    const folded = new Set(await read($, collapsed))
    const depth = await read($, maxDepth)
    const isMenuOpen = await read($, isEditingRoot)
    const recent = isMenuOpen ? (await recentRoots($)).filter(p => !samePath(p, info.root)) : []

    const counts = subtreeCounts(rows)
    const shown = visibleRows(rows, folded, dirtyOnly)
    const allRepos = [...rows.map(row => row.repo), info.rootRepo].filter((r): r is RepoInfo => r !== null)
    const repoCount = rows.filter(row => row.kind === 'repo').length + (info.isRootRepo ? 1 : 0)
    const dirtyTotal = allRepos.filter(isDirty).length
    const syncOnly = allRepos.filter(r => !isDirty(r) && (r.ahead > 0 || r.behind > 0)).length
    const syncTotal = allRepos.filter(r => r.ahead > 0 || r.behind > 0).length
    const cleanTotal = Math.max(0, allRepos.length - dirtyTotal - syncOnly)
    const isSessionRoot = info.root !== '' && samePath(info.root, info.sessionDir)
    const foldable = rows.filter(row => row.hasChildren).map(row => row.path)

    // Layout rule: one line of text is ONE Text (nested Texts inside it for color). The
    // only neighbours on a line are fixed-size icons and buttons, so nothing shrinks into a
    // one-character column; a Text that owns its line truncates instead.
    const width = e.props.bodyColumns > 0 ? e.props.bodyColumns : (e.viewport?.columns ?? 80)
    const isNarrow = width < NARROW_COLUMNS
    const indentOf = (depth: number) => Math.min(depth * 2, Math.floor(width / 4))
    const HOVER_BG = 'rgba(127, 127, 127, 0.14)'
    const INSET_BG = 'rgba(127, 127, 127, 0.08)'
    // a hover background only where there is a pointer
    const hoverRow = hasHover ? { hover: { backgroundColor: HOVER_BG } } : {}
    // text sizes and weights only where the engine knows them; older engines refuse the
    // whole drawing over one unknown prop, so they get the plain text instead
    const rt = (props: Pick<TextProps, 'size' | 'weight' | 'tabular'>) => (richText ? props : {})
    // spacing steps likewise: a step name where the engine knows them, whole cells elsewhere
    const sp = (step: 'xs' | 'sm' | 'md', cells: number) => (richText ? step : cells)

    const ICON_W = Svg ? 3 : 2 // the icon's column, with a little air before the label
    // the fold chevron's column; a flat list has nothing to fold, so it keeps one cell of air
    const SLOT = rows.some(row => row.hasChildren) ? 3 : 1
    const NAME_INDENT = SLOT + ICON_W // secondary lines line up with the name

    const icon = (name: IconName, color: 'subtle' | 'claude' | 'suggestion' | 'warning' = 'subtle') => (
      <Box flexShrink={0} width={ICON_W}>
        {Svg ? <Svg source={ICONS[name].source} alt={name} width={14} height={14} /> : <Text color={color}>{ICONS[name].glyph}</Text>}
      </Box>
    )

    const heading = (label: string, right?: string) => (
      <Box flexDirection="row" justifyContent="space-between" marginBottom={sp('xs', 0)}>
        <Text {...rt({ size: 'caption', weight: 'semibold' })} dimColor wrap="truncate-end">
          {label}
        </Text>
        {right ? (
          <Box flexShrink={0}>
            <Text {...rt({ size: 'caption', tabular: true })} dimColor>
              {right}
            </Text>
          </Box>
        ) : null}
      </Box>
    )

    const shortBranch = (branch: string, max: number) => (branch.length > max ? `${branch.slice(0, max - 1)}…` : branch)

    // branch, sync and change chips, as Texts to nest inside one line's Text (no glyph:
    // the caller draws the branch icon beside it)
    const summaryParts = (r: RepoInfo, branchMax: number) =>
      r.error ? (
        <Text color="error">✕ {r.error}</Text>
      ) : (
        <Text>
          <Text color={r.isDetached ? 'warning' : 'suggestion'}>{shortBranch(r.branch, branchMax)}</Text>
          {r.ahead ? <Text color="success"> ↑{r.ahead}</Text> : null}
          {r.behind ? <Text color="warning"> ↓{r.behind}</Text> : null}
          {!r.upstream && !r.isDetached ? <Text color="subtle"> {T.local}</Text> : null}
          {r.warning ? (
            <Text color="warning"> ⚠</Text>
          ) : isDirty(r) ? (
            <Text>
              {r.conflicts ? <Text color="error"> !{r.conflicts}</Text> : null}
              {r.staged ? <Text color="success"> +{r.staged}</Text> : null}
              {r.unstaged ? <Text color="warning"> ~{r.unstaged}</Text> : null}
              {r.untracked ? <Text color="subtle"> ?{r.untracked}</Text> : null}
            </Text>
          ) : (
            <Text color="success"> ✓</Text>
          )}
        </Text>
      )

    // roughly how many cells the inline status takes, to decide whether it fits
    const summaryLength = (r: RepoInfo, branchMax: number) =>
      Math.min(r.branch.length, branchMax) +
      (r.ahead ? String(r.ahead).length + 2 : 0) +
      (r.behind ? String(r.behind).length + 2 : 0) +
      (!r.upstream && !r.isDetached ? T.local.length + 1 : 0) +
      (isDirty(r)
        ? [r.conflicts, r.staged, r.unstaged, r.untracked].filter(Boolean).reduce((n, v) => n + String(v).length + 2, 0)
        : 2) +
      ICON_W

    // the status on a line of its own: branch icon, then the chips
    const summaryLine = (r: RepoInfo, indent: number) => (
      <Box flexDirection="row" paddingLeft={indent}>
        {r.error ? null : icon('branch', 'suggestion')}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text {...rt({ size: 'footnote' })} wrap="truncate-end">
            {summaryParts(r, 40)}
          </Text>
        </Box>
      </Box>
    )

    const hideOnHover = hasHover ? { hover: { color: 'transparent' } } : {}
    const commitLine = (r: RepoInfo, indent: number, inRow = false) =>
      r.lastCommit || r.warning ? (
        <Box flexDirection="column" paddingLeft={indent}>
          {r.lastCommit ? (
            <Text {...rt({ size: 'caption' })} dimColor wrap="truncate-end" {...(inRow ? hideOnHover : {})}>
              {r.lastCommitAge ? `${r.lastCommitAge} · ` : ''}
              {r.lastCommit}
            </Text>
          ) : null}
          {r.warning ? (
            <Text {...rt({ size: 'caption' })} color="warning" wrap="truncate-end" {...(inRow ? hideOnHover : {})}>
              {r.warning}
            </Text>
          ) : null}
        </Box>
      ) : null

    const actionButtons = (path: string, isRepo: boolean) => [
      <Button key={`root:${path}`} label={T.setRoot} variant="secondary" onPress={() => setRoot($, path)} />,
      isRepo ? (
        <Button key={`copy:${path}`} label={T.copy} variant="secondary" onPress={press => copyPath($, path, press.surface)} />
      ) : null,
    ]

    const INLINE_BRANCH_MAX = 16
    const row = (node: TreeNode, index: number) => {
      const c = counts.get(node.path) ?? { repos: 0, changed: 0 }
      const isRepo = node.kind === 'repo'
      const isFolded = folded.has(node.path)
      const below = isRepo ? c.repos - 1 : c.repos
      const belowChanged = isRepo && node.repo && needsAttention(node.repo) ? c.changed - 1 : c.changed
      const prev = shown[index - 1]
      const isGroupEdge = node.depth === 0 && index > 0 && (node.hasChildren || prev?.hasChildren === true || (prev?.depth ?? 0) > 0)
      // the status sits at the right end of the name line only when it leaves the name
      // at least 12 cells; otherwise (and for errors) it gets a line of its own
      const nameRoom = width - indentOf(node.depth) - NAME_INDENT
      const isInlineSummary =
        !isNarrow && node.repo !== null && !node.repo.error && nameRoom - summaryLength(node.repo, INLINE_BRANCH_MAX) - 1 >= 12
      const kindIcon: IconName = !isRepo ? 'folder' : node.gitKind === 'repo' ? 'repo' : node.gitKind
      return (
        <Box
          key={`row:${node.path}`}
          flexDirection="column"
          paddingLeft={indentOf(node.depth)}
          paddingY={sp('xs', 0)}
          marginTop={isGroupEdge ? 1 : 0}
          {...hoverRow}
        >
          <Box flexDirection="row" alignItems="center">
            <Box width={SLOT} flexShrink={0} alignItems="center">
              {node.hasChildren ? (
                <Button key={`fold:${node.path}`} label={isFolded ? '▸' : '▾'} plain dimColor onPress={() => toggleFold($, node.path)} />
              ) : (
                <Text> </Text>
              )}
            </Box>
            {icon(kindIcon, isRepo ? 'claude' : 'subtle')}
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text wrap="truncate-end">
                <Text {...rt({ weight: isRepo ? 'medium' : 'regular' })}>{node.label}</Text>
                {isRepo && node.gitKind !== 'repo' ? (
                  <Text {...rt({ size: 'caption' })} dimColor>
                    {' '}
                    {node.gitKind}
                  </Text>
                ) : null}
                {isFolded && below > 0 ? (
                  <Text {...rt({ size: 'caption' })} dimColor>
                    {'  '}
                    {T.reposBelow(below)}
                    {belowChanged > 0 ? <Text color="warning"> · {T.changedBelow(belowChanged)}</Text> : null}
                  </Text>
                ) : null}
              </Text>
            </Box>
            {isInlineSummary && node.repo ? (
              // fixed-size neighbour, sized to fit above: it keeps its width, the name truncates
              <Box flexShrink={0} marginLeft={1} flexDirection="row" alignItems="center">
                {icon('branch', 'suggestion')}
                <Text {...rt({ size: 'footnote' })}>{summaryParts(node.repo, INLINE_BRANCH_MAX)}</Text>
              </Box>
            ) : null}
          </Box>
          {!isInlineSummary && node.repo ? summaryLine(node.repo, NAME_INDENT) : null}
          {node.repo ? commitLine(node.repo, NAME_INDENT, true) : null}
          {hasHover ? (
            // floats in on hover: takes no room and moves nothing. On a repo row it covers
            // the commit line, which turns transparent meanwhile, so nothing shows through.
            <Box
              flexDirection="row"
              gap={sp('sm', 1)}
              position="absolute"
              {...(node.repo ? { bottom: 0, left: indentOf(node.depth) + NAME_INDENT } : { top: 0, right: 0 })}
              display="none"
              hover={{ display: 'flex' }}
            >
              {actionButtons(node.path, isRepo)}
            </Box>
          ) : null}
          {!hasHover && isMenuOpen ? (
            <Box flexDirection="row" flexWrap="wrap" gap={1} paddingLeft={NAME_INDENT}>
              {actionButtons(node.path, isRepo)}
            </Box>
          ) : null}
        </Box>
      )
    }

    const headerButtons = (
      <Box flexDirection="row" gap={1} flexShrink={0}>
        <Button key="refresh" label={T.refresh} hotkey="r" variant="secondary" onPress={() => rescan($)}>
          ⟳
        </Button>
        <Button
          key="filter"
          label={dirtyOnly ? `✓ ${T.changedOnly}` : T.changedOnly}
          hotkey="f"
          variant="secondary"
          onPress={() => update($, onlyDirty, v => !v)}
        />
        <Button
          key="menu"
          label={T.menu}
          hotkey="p"
          variant="secondary"
          onPress={() => update($, isEditingRoot, v => !v)}
        >
          {isMenuOpen ? '✕' : '⋯'}
        </Button>
      </Box>
    )

    const rootLine = (
      <Box flexDirection="row" alignItems="center">
        {icon(info.isRootRepo ? 'repo' : 'folder', info.isRootRepo ? 'claude' : 'subtle')}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text {...rt({ weight: 'semibold' })} wrap="truncate-end">
            {clean(baseName(info.root)) || T.computing}
          </Text>
        </Box>
      </Box>
    )

    const statsText = (
      <Text {...rt({ size: 'footnote' })} dimColor wrap="truncate-end">
        {T.repos(repoCount)}
        {dirtyTotal ? <Text color="warning"> · {T.changed(dirtyTotal)}</Text> : null}
        {syncTotal ? <Text color="suggestion"> · {T.unsynced(syncTotal)}</Text> : null}
        {' · '}
        {info.isScanning ? T.scanning : clockText(info.scannedAt)}
      </Text>
    )

    // the settings group: an inset block on desktop, a framed one where there is no fill
    const groupProps = hasHover
      ? { borderStyle: 'round', borderDimColor: true, backgroundColor: INSET_BG, paddingX: sp('md', 1), paddingY: sp('sm', 0) }
      : { borderStyle: 'round', borderDimColor: true, paddingX: 1 }

    const legendKinds = Svg ? (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {(['repo', 'folder', 'worktree', 'submodule', 'branch'] as const).map(name => (
          <Box key={`legend:${name}`} flexDirection="row" flexShrink={0} alignItems="center">
            {icon(name)}
            <Text {...rt({ size: 'caption' })} dimColor>
              {T.legendIcon[name]}
            </Text>
          </Box>
        ))}
      </Box>
    ) : (
      <Text {...rt({ size: 'caption' })} dimColor>
        {T.legendKinds}
      </Text>
    )

    return (
      <Box flexDirection="column" gap={sp('md', 1)}>
        {/* toolbar: the section name at left, the three controls at right */}
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            {heading(isSessionRoot ? `${T.sectionWorkspace} · ${T.sessionFolder.toUpperCase()}` : T.sectionWorkspace)}
          </Box>
          {headerButtons}
        </Box>

        {/* WORKSPACE card: where we are and a status bar */}
        <Box flexDirection="column" {...groupProps}>
          {rootLine}
          <Box paddingLeft={ICON_W}>
            <Text {...rt({ size: 'caption' })} dimColor wrap="truncate-middle">
              {clean(info.root)}
            </Text>
          </Box>
          {info.isRootRepo && info.rootRepo ? summaryLine(info.rootRepo, ICON_W) : null}
          {info.isRootRepo && info.rootRepo ? commitLine(info.rootRepo, ICON_W) : null}
          <Box marginTop={1} flexDirection="column">
            {Svg && allRepos.length > 0 ? (
              <Svg
                source={statusBar(cleanTotal, dirtyTotal, syncOnly)}
                alt={T.statusBarAlt(cleanTotal, dirtyTotal, syncOnly)}
                height={4}
              />
            ) : null}
            {statsText}
          </Box>
          {info.isTruncated ? (
            <Text {...rt({ size: 'footnote' })} color="warning">
              {T.truncated(info.visited)}
            </Text>
          ) : null}
          {info.error ? (
            <Text {...rt({ size: 'footnote' })} color="error">
              {info.error}
            </Text>
          ) : null}
        </Box>

        {/* git missing or too old: say so plainly, with where to get it */}
        {info.gitProblem ? (
          <Box flexDirection="column" {...groupProps}>
            <Box flexDirection="row" alignItems="center">
              {icon('warning', 'warning')}
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text color="warning" {...rt({ weight: 'semibold' })}>
                  {info.gitProblem === 'missing'
                    ? T.gitMissingTitle.replace(/^⚠ /, '')
                    : T.gitOldTitle(info.gitVersion, MIN_GIT.join('.')).replace(/^⚠ /, '')}
                </Text>
              </Box>
            </Box>
            <Text {...rt({ size: 'footnote' })}>{info.gitProblem === 'missing' ? T.gitMissingBody : T.gitOldBody}</Text>
            <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
              <Link href="https://git-scm.com/downloads" label={T.gitDownload} />
              <Button key="git-recheck" label={T.checkAgain} variant="secondary" onPress={() => rescan($)} />
            </Box>
          </Box>
        ) : null}

        {/* settings, folded away behind ⋯ */}
        {isMenuOpen ? (
          <Box flexDirection="column" gap={sp('md', 1)} {...groupProps}>
            <Box flexDirection="column" gap={sp('xs', 0)}>
              {heading(T.sectionScanFolder)}
              {Input ? (
                <Box width="100%" flexDirection="column">
                <Input
                  key="root-input"
                  placeholder={T.rootPlaceholder}
                  value={info.root}
                  submitLabel={T.apply}
                  onSubmit={value => setRoot($, value)}
                />
                </Box>
              ) : (
                <Text {...rt({ size: 'footnote' })} dimColor>
                  {T.rootCommandHint}
                </Text>
              )}
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                <Button key="session-root" label={T.sessionFolderButton} variant="secondary" onPress={() => setRoot($, '')} />
                <Button
                  key="parent-root"
                  label={T.parentFolderButton}
                  variant="secondary"
                  onPress={() => setRoot($, parentOf(info.root || info.sessionDir))}
                />
              </Box>
            </Box>

            {recent.length > 0 ? (
              <Box flexDirection="column">
                {heading(T.sectionRecent)}
                {recent.map(path => (
                  <Box key={`recent-row:${path}`} flexDirection="column" {...hoverRow}>
                    <Box flexDirection="row" alignItems="center">
                      {icon('folder')}
                      {/* a short fixed label: the folder's own name */}
                      <Button key={`recent:${path}`} label={clean(baseName(path)) || clean(path)} plain onPress={() => setRoot($, path)} />
                    </Box>
                    <Box paddingLeft={ICON_W}>
                      <Text {...rt({ size: 'caption' })} dimColor wrap="truncate-middle">
                        {clean(parentOf(path))}
                      </Text>
                    </Box>
                  </Box>
                ))}
              </Box>
            ) : null}

            <Box flexDirection="column">
              {heading(T.sectionView)}
              <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                <Button
                  key="fold-all"
                  label={folded.size > 0 ? T.expandAll : T.collapseAll}
                  variant="secondary"
                  onPress={() => update($, collapsed, list => (list.length > 0 ? [] : foldable))}
                />
                <Box flexShrink={0}>
                  <Text {...rt({ size: 'footnote' })} dimColor>
                    {T.depth}
                  </Text>
                </Box>
                <Button key="depth-down" label="−" variant="secondary" onPress={() => changeDepth($, -1)} />
                <Box flexShrink={0}>
                  <Text {...rt({ size: 'footnote', tabular: true })}>{depth}</Text>
                </Box>
                <Button key="depth-up" label="+" variant="secondary" onPress={() => changeDepth($, 1)} />
              </Box>
            </Box>

            <Box flexDirection="column">
              {heading(T.sectionLegend, T.gitVersion(info.gitVersion))}
              {legendKinds}
              <Text {...rt({ size: 'caption' })} dimColor>
                {T.legendChanges}
              </Text>
              {hasHover ? (
                <Text {...rt({ size: 'caption' })} dimColor>
                  {T.legendHover}
                </Text>
              ) : null}
            </Box>
          </Box>
        ) : null}

        {/* REPOSITORIES card: the tree */}
        {heading(T.sectionRepos, rows.length ? String(repoCount) : undefined)}
        <Box flexDirection="column" {...groupProps}>
          {shown.length === 0 && !info.isScanning ? (
            <Text {...rt({ size: 'footnote' })} dimColor>
              {rows.length === 0 ? (info.isRootRepo ? T.noChildRepos : T.noRepos(depth)) : T.noChangedRepos}
            </Text>
          ) : null}
          {shown.map(row)}
        </Box>
      </Box>
    )
  })
}
