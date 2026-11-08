import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, TextProps, UiPressArgument } from 'claude-code'

import type { RepoDetail, RepoInfo, ScanInfo, TreeNode } from '../types'
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
  actionHref,
  actionOf,
  elapsed,
  isNetworkPath,
  configValues,
  allFilterNames,
  filterOffArgs,
  shorten,
  parseAheadBehind,
  parseChangedFiles,
  parseCommitLines,
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
// repositories the last scan skipped because their git folder reaches a network path;
// nothing runs git in them, details included (a reload empties it until the next scan,
// and session.start scans first)
let skippedRepos: Set<string> = new Set()
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
const openRepo = atom({ plugin: 'git-workspace', key: 'openRepo' } as const, '')
const detail = atom({ plugin: 'git-workspace', key: 'detail' } as const, null, { shape: 'detail-1' })

type Engine = EngineInterface

// ---------------------------------------------------------------- git
//
// The only program this mod runs is the local `git`, read-only, with these four
// fixed commands. Scanned repositories are untrusted, so every call switches off
// each config setting that could make git start another program (fsmonitor,
// hooks, pager, external diff, signature programs) and never prompts.

/**
 * Put before every git subcommand. Scanned repositories are untrusted, so these switch off
 * each setting their config could use to start a program (fsmonitor, hooks, pager, external
 * diff, signature programs, ssh command, credential helper, askpass) and allow no transport
 * at all, so not even a partial clone's lazy fetch can reach a remote.
 */
const SAFE_GIT_ARGS = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=',
  '-c', 'core.pager=cat',
  '-c', 'diff.external=',
  '-c', 'log.showSignature=false',
  '-c', 'gpg.program=false',
  '-c', 'gpg.ssh.program=false',
  '-c', 'gpg.x509.program=false',
  '-c', 'protocol.allow=never',
  '-c', 'core.sshCommand=',
  '-c', 'credential.helper=',
  '-c', 'core.askPass=',
  '--no-pager',
  '--no-optional-locks',
] as const

const GIT_OPTIONS = {
  timeoutMs: 15_000,
  env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_ASKPASS: '', SSH_ASKPASS: '' },
}

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
    ['git', ...SAFE_GIT_ARGS, '-C', cwd, 'config', '--show-scope', '--name-only', '--get-regexp', '^filter\\.'],
    GIT_OPTIONS,
  )
}

/** Branch, upstream, ahead/behind and changed files. */
async function gitStatus($: Engine, cwd: string, filterOff: readonly string[]) {
  return $.process.run(
    ['git', ...SAFE_GIT_ARGS, ...filterOff, '-C', cwd, 'status', '--porcelain=v2', '--branch', '--untracked-files=normal', '--ignore-submodules=all'],
    GIT_OPTIONS,
  )
}

/** The current branch name, for a repository whose status is not read. */
async function gitHead($: Engine, cwd: string) {
  return $.process.run(
    ['git', ...SAFE_GIT_ARGS, '-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
    GIT_OPTIONS,
  )
}

/** Short hash, subject and age of the last commit. */
async function gitLastCommit($: Engine, cwd: string) {
  return $.process.run(
    ['git', ...SAFE_GIT_ARGS, '-C', cwd, 'log', '-1', '--no-show-signature', '--format=%h %s%x00%cr'],
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
    // `git status`, so such a repository gets its branch read without status. Drivers
    // from the person's own config (git-lfs, say) are trusted but still switched off for
    // the status call: a repository's .gitattributes alone could otherwise start them.
    const filters = await gitFilterConfig($, path)
    // exit 1 with no output is git's "no such key"; any other failure fails closed
    const isUnchecked =
      (filters.exitCode !== 0 && !(filters.exitCode === 1 && filters.stdout.trim() === '')) ||
      (filters.exitCode === 0 && allFilterNames(filters.stdout) === null)
    const risky = filters.exitCode === 0 ? untrustedFilters(filters.stdout) : []
    const trustedNames = filters.exitCode === 0 ? allFilterNames(filters.stdout) : []
    const filterOff = filterOffArgs(trustedNames ?? [])

    if (isUnchecked || risky.length > 0) {
      const head = await gitHead($, path)
      repo.branch = head.exitCode === 0 ? head.stdout.trim() : '(detached)'
      repo.isDetached = head.exitCode !== 0
      repo.warning = isUnchecked
        ? T.skippedUnchecked
        : T.skippedFilters(risky.length)
    } else {
      const status = await gitStatus($, path, filterOff)
      if (status.exitCode !== 0) {
        return sanitize({ ...repo, error: status.stderr.trim().split(/\r?\n/)[0] || T.statusFailed })
      }
      repo = parseStatus(status.stdout, repo)
    }

    const last = await gitLastCommit($, path)
    if (last.exitCode === 0) {
      const [subject, age] = last.stdout.trim().split('\0')
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

// ---------------------------------------------------------------- repository details
//
// Read only when a row is opened, with the same safety options; nothing here contacts a
// remote: "to pull" is measured against the remote-tracking branch as the last `git fetch`
// left it, and the pane says when that was.

/** The last 8 commits of the checked-out branch. */
async function gitRecent($: Engine, cwd: string) {
  return $.process.run(
    ['git', ...SAFE_GIT_ARGS, '-C', cwd, 'log', '-8', '--no-show-signature', '--format=%h%x00%H%x00%s%x00%cr%x00%an%x00', '--'],
    GIT_OPTIONS,
  )
}

/** Up to 20 commits on the upstream that this branch doesn't have yet (what a pull brings). */
async function gitIncoming($: Engine, cwd: string) {
  return $.process.run(
    ['git', ...SAFE_GIT_ARGS, '-C', cwd, 'log', '-20', '--no-show-signature', '--format=%h%x00%H%x00%s%x00%cr%x00%an%x00', 'HEAD..@{upstream}', '--'],
    GIT_OPTIONS,
  )
}

/** Up to 20 commits on this branch that the upstream doesn't have yet (what a push sends). */
async function gitOutgoing($: Engine, cwd: string) {
  return $.process.run(
    ['git', ...SAFE_GIT_ARGS, '-C', cwd, 'log', '-20', '--no-show-signature', '--format=%h%x00%H%x00%s%x00%cr%x00%an%x00', '@{upstream}..HEAD', '--'],
    GIT_OPTIONS,
  )
}

/** The upstream's name ("origin/main"); fails when the branch has none. */
async function gitUpstreamName($: Engine, cwd: string) {
  return $.process.run(
    ['git', ...SAFE_GIT_ARGS, '-C', cwd, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    GIT_OPTIONS,
  )
}

/** "<ahead>\t<behind>": commits only on HEAD, and only on the upstream. */
async function gitAheadBehind($: Engine, cwd: string) {
  return $.process.run(
    ['git', ...SAFE_GIT_ARGS, '-C', cwd, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}', '--'],
    GIT_OPTIONS,
  )
}

/** The changed files, NUL-separated so any file name reads back whole. */
async function gitChangedFiles($: Engine, cwd: string, filterOff: readonly string[]) {
  return $.process.run(
    ['git', ...SAFE_GIT_ARGS, ...filterOff, '-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all'],
    GIT_OPTIONS,
  )
}

/** How many stashes there are (exits non-zero when there are none). */
async function gitStashCount($: Engine, cwd: string) {
  return $.process.run(
    ['git', ...SAFE_GIT_ARGS, '-C', cwd, 'rev-list', '--walk-reflogs', '--count', 'refs/stash', '--'],
    GIT_OPTIONS,
  )
}

/** The repository's own git folder and its shared one, one per line (equal outside worktrees). */
async function gitDirs($: Engine, cwd: string) {
  return $.process.run(
    ['git', ...SAFE_GIT_ARGS, '-C', cwd, 'rev-parse', '--git-dir', '--git-common-dir'],
    GIT_OPTIONS,
  )
}

/**
 * When `git fetch` last wrote FETCH_HEAD, as "3 h ago"; '' when it never has. FETCH_HEAD
 * lives in a worktree's own folder when fetched there, else in the shared one, so the newer
 * of the two counts. A folder on a network path is never looked at.
 */
async function lastFetchAge($: Engine, cwd: string): Promise<string> {
  try {
    const out = await gitDirs($, cwd)
    if (out.exitCode !== 0) return ''
    let newest = 0
    for (const line of out.stdout.split(/\r?\n/)) {
      const dir = line.trim()
      if (!dir || isNetworkPath(dir)) continue
      const isAbsolute = /^([A-Za-z]:[\\/]|[\\/])/.test(dir)
      const stat = await $.fs.stat(joinPath(isAbsolute ? dir : joinPath(cwd, dir), 'FETCH_HEAD')).catch(() => undefined)
      if (stat && stat.mtimeMs > newest) newest = stat.mtimeMs
    }
    return newest ? T.ago(elapsed(newest, Date.now())) : ''
  } catch {
    return ''
  }
}

const emptyDetail = (path: string): RepoDetail => ({
  path, isLoading: true, hasLoaded: false, lastFetchAge: '', upstream: '', ahead: 0, behind: 0,
  incoming: [], outgoing: [], recent: [], files: [], filesTotal: 0, stashes: 0, error: '',
})

/**
 * Reads the opened repository's details. Every write checks that this row is still the
 * open one, so a slower read for another row never lands on it.
 */
async function loadDetail($: Engine, path: string) {
  if ((await read($, openRepo)) !== path || skippedRepos.has(path)) return
  await update($, detail, d => (d && d.path === path ? { ...d, isLoading: true } : emptyDetail(path)))
  const next = emptyDetail(path)
  try {
    const filters = await gitFilterConfig($, path)
    const canReadStatus = filters.exitCode === 0
      ? untrustedFilters(filters.stdout).length === 0 && allFilterNames(filters.stdout) !== null
      : filters.exitCode === 1 && filters.stdout.trim() === ''
    const [recent, incoming, outgoing, upstream, counts, changed, stash, fetched] = await Promise.all([
      gitRecent($, path),
      gitIncoming($, path),
      gitOutgoing($, path),
      gitUpstreamName($, path),
      gitAheadBehind($, path),
      canReadStatus ? gitChangedFiles($, path, filterOffArgs(allFilterNames(filters.stdout) ?? [])) : Promise.resolve(null),
      gitStashCount($, path),
      lastFetchAge($, path),
    ])
    next.recent = recent.exitCode === 0 ? parseCommitLines(recent.stdout) : []
    next.incoming = incoming.exitCode === 0 ? parseCommitLines(incoming.stdout) : []
    next.outgoing = outgoing.exitCode === 0 ? parseCommitLines(outgoing.stdout) : []
    next.upstream = upstream.exitCode === 0 ? clean(upstream.stdout.trim()) : ''
    const ab = counts.exitCode === 0 ? parseAheadBehind(counts.stdout) : null
    next.ahead = ab?.ahead ?? 0
    next.behind = ab?.behind ?? 0
    const files = changed && changed.exitCode === 0 ? parseChangedFiles(changed.stdout) : []
    next.filesTotal = files.length
    next.files = files.slice(0, 12)
    next.stashes = stash.exitCode === 0 ? Number(stash.stdout.trim()) || 0 : 0
    next.lastFetchAge = fetched
  } catch (err) {
    next.error = clean(err instanceof Error ? err.message : String(err))
  }
  next.isLoading = false
  next.hasLoaded = true
  if ((await read($, openRepo)) === path) await update($, detail, () => next)
}

/** Opens a repository row's details, or closes them when that row is already open. */
async function toggleDetail($: Engine, path: string) {
  if (skippedRepos.has(path)) return
  const current = await read($, openRepo)
  if (current === path) {
    await update($, openRepo, () => '')
    await update($, detail, () => null)
    return
  }
  await update($, openRepo, () => path)
  await update($, detail, () => emptyDetail(path))
  await loadDetail($, path)
}

// ---------------------------------------------------------------- scan

type Walk = { visited: number; isTruncated: boolean; active: number; waiting: (() => void)[]; unsafe: Set<string> }

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

/** A text file's content, or '' when it is missing or unreadable. */
/**
 * A text file for the pre-git checks: 'missing' when it isn't there, 'refused' when it is
 * there but is no plain regular file of sane size or can't be read (the checks treat that
 * as unsafe: git would still read it), else its text.
 */
async function readCheckFile($: Engine, path: string): Promise<{ state: 'missing' } | { state: 'refused' } | { state: 'ok'; text: string }> {
  if (!(await $.fs.exists(path).catch(() => true))) return { state: 'missing' }
  if (await isLinkEntry($, path)) return { state: 'refused' }
  try {
    const stat = await $.fs.stat(path)
    if (stat.kind !== 'file' || stat.size > MAX_READ_BYTES) return { state: 'refused' }
    const content = await $.fs.read(path)
    return typeof content === 'string' ? { state: 'ok', text: content } : { state: 'refused' }
  } catch {
    return { state: 'refused' }
  }
}

/** A text file's content, or '' when it is missing, refused or unreadable (display uses only). */
async function readText($: Engine, path: string): Promise<string> {
  const file = await readCheckFile($, path)
  return file.state === 'ok' ? file.text : ''
}

/** Whether `path` itself is a symbolic link, read from its folder's listing (which never follows it). */
async function isLinkEntry($: Engine, path: string): Promise<boolean> {
  const name = baseName(path)
  const entries = await $.fs.list(parentOf(path)).catch(() => null)
  if (!entries) return false
  const entry = entries.find(e => e.name.toLowerCase() === name.toLowerCase())
  return entry ? entry.isLink || entry.kind === 'other' : false
}

/** Resolves `target` against `base` unless it is absolute already. */
function resolveFrom(base: string, target: string): string {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(target) ? target : joinPath(base, target)
}

/** How deep git itself follows includes and alternates; a chain past this is refused. */
const MAX_CHAIN = 5
/** Per repository: config/alternates files read before git runs, and their size cap. */
const MAX_CHECK_FILES = 64
const MAX_READ_BYTES = 1_048_576
/** Per repository: folder listings spent looking for links inside the git folders. */
const MAX_LINK_LISTINGS = 400

/** One repository's pre-git check: files already seen, and how many were read. */
type Check = { seen: Set<string>; reads: number; listings: number }

/** Counts a file against the budget; false (fail closed) once the budget is spent. */
function withinBudget(check: Check, file: string): boolean | 'seen' {
  const key = file.replace(/\\/g, '/').toLowerCase()
  if (check.seen.has(key)) return 'seen'
  check.seen.add(key)
  check.reads++
  return check.reads <= MAX_CHECK_FILES
}

/**
 * Whether a git config file, or any file it includes, holds a value that is a network
 * path (include.path, includeIf, core.worktree, core.excludesFile, core.attributesFile, or
 * any other). Read as text, never through git. A value written in a form this simple
 * reader might decode differently from git (quotes, backslashes, comment marks, line
 * continuations) fails closed when it is an include path.
 */
async function configReachesNetwork($: Engine, check: Check, file: string, depth: number): Promise<boolean> {
  if (depth > MAX_CHAIN) return true
  const budget = withinBudget(check, file)
  if (budget === 'seen') return false
  if (!budget) return true
  const read = await readCheckFile($, file)
  if (read.state === 'missing') return false
  if (read.state === 'refused') return true
  const values = configValues(read.text)
  if (values.some(v => isNetworkPath(v.value) || isNetworkPath(v.loose))) return true
  for (const v of values) {
    if (!v.isIncludePath) continue
    if (v.isOdd) return true
    if (!v.value || v.value.startsWith('~')) continue
    const included = resolveFrom(parentOf(file), v.value)
    if (await isLinkEntry($, included)) return true
    if (await configReachesNetwork($, check, included, depth + 1)) return true
  }
  return false
}

/**
 * Whether an objects folder's alternates, followed as git follows them (relative to that
 * objects folder, up to MAX_CHAIN deep), reach a network path. A quoted line (git C-unquotes
 * it) or a linked entry fails closed.
 */
async function alternatesReachNetwork($: Engine, check: Check, objectsDir: string, depth: number): Promise<boolean> {
  if (depth > MAX_CHAIN) return true
  const budget = withinBudget(check, objectsDir)
  if (budget === 'seen') return false
  if (!budget) return true
  const read = await readCheckFile($, joinPath(objectsDir, 'info/alternates'))
  if (read.state === 'missing') return false
  if (read.state === 'refused') return true
  for (const line of read.text.split(/\r?\n/)) {
    const entry = line.trim()
    if (!entry || entry.startsWith('#')) continue
    if (entry.startsWith('"') || isNetworkPath(entry)) return true
    const target = resolveFrom(objectsDir, entry)
    if (await isLinkEntry($, target)) return true
    if (await alternatesReachNetwork($, check, target, depth + 1)) return true
  }
  return false
}

/**
 * Whether any entry git reads for this pane's commands is a symbolic link (a link can point
 * at a share, and following it would reach that host): the git folder itself and its info,
 * refs, logs, worktrees, objects/info and objects/pack folders, walked without following
 * links. A walk past its budget fails closed.
 */
async function linksInside($: Engine, check: Check, gitDir: string): Promise<boolean> {
  const queue: [string, number][] = [[gitDir, 0]]
  const deepInto = new Set(['refs', 'logs', 'worktrees', 'info'])
  while (queue.length > 0) {
    const [dir, level] = queue.shift()!
    check.listings++
    if (check.listings > MAX_LINK_LISTINGS) return true
    const entries = await $.fs.list(dir).catch(() => null)
    if (!entries) continue
    for (const entry of entries) {
      if (entry.isLink || entry.kind === 'other') return true
      if (entry.kind !== 'dir') continue
      const child = joinPath(dir, entry.name)
      if (level === 0 && entry.name === 'objects') {
        queue.push([joinPath(child, 'info'), 2], [joinPath(child, 'pack'), 2])
        // the objects folder's own entries (loose object folders) are listed once, not walked
        const objects = await $.fs.list(child).catch(() => null)
        check.listings++
        if (objects?.some(o => o.isLink || o.kind === 'other')) return true
      } else if (level === 0 ? deepInto.has(entry.name) : level < 8) {
        queue.push([child, level + 1])
      }
    }
  }
  return false
}

/**
 * Whether running git in this repository could reach another machine, read from the files
 * alone before git ever runs there: the `.git` file's gitdir, the git folder's real path,
 * its `commondir`, links inside the git folders, the config files of both folders with
 * everything they include, and the object alternates of both. Any network path means yes;
 * so does a chain deeper than git would follow, an unreadable or oversized file git would
 * still read, or a check that runs out of budget.
 */
async function reachesNetwork($: Engine, repoPath: string, isGitFile: boolean, gitFile: string): Promise<boolean> {
  const declared = isGitFile ? gitFile.replace(/^gitdir:\s*/i, '').trim() : '.git'
  if (!declared || isNetworkPath(declared) || declared.startsWith('"')) return true
  const gitDir = resolveFrom(repoPath, declared)
  if (await isLinkEntry($, gitDir)) return true
  const real = await $.fs.stat(gitDir, { resolve: true }).catch(() => undefined)
  if (real?.realPath && isNetworkPath(real.realPath)) return true
  const local = real?.realPath ?? gitDir
  const commondir = await readCheckFile($, joinPath(local, 'commondir'))
  if (commondir.state === 'refused') return true
  const commonRaw = commondir.state === 'ok' ? commondir.text.trim() : ''
  if (commonRaw && (isNetworkPath(commonRaw) || commonRaw.startsWith('"'))) return true
  const common = commonRaw ? resolveFrom(local, commonRaw) : local
  if (commonRaw && (await isLinkEntry($, common))) return true
  const commonReal = await $.fs.stat(common, { resolve: true }).catch(() => undefined)
  if (commonReal?.realPath && isNetworkPath(commonReal.realPath)) return true
  const shared = commonReal?.realPath ?? common
  const check: Check = { seen: new Set(), reads: 0, listings: 0 }
  for (const dir of new Set([local, shared])) {
    if (await linksInside($, check, dir)) return true
    if (await configReachesNetwork($, check, joinPath(dir, 'config'), 0)) return true
    if (await configReachesNetwork($, check, joinPath(dir, 'config.worktree'), 0)) return true
    if (await alternatesReachNetwork($, check, joinPath(dir, 'objects'), 0)) return true
  }
  return false
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
  const gitFile = dotGit?.kind === 'file' ? await readGitFile($, path) : ''
  const gitKind: RawNode['gitKind'] = dotGit?.kind === 'file' ? gitKindOfFile(gitFile) : 'repo'
  // a git folder on a network share: running git there would reach out to that host
  if (dotGit && (await reachesNetwork($, path, dotGit.kind === 'file', gitFile))) walk.unsafe.add(path)
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
  const walk: Walk = { visited: 0, isTruncated: false, active: 0, waiting: [], unsafe: new Set() }
  const tree = (await visitDir($, walk, root, 0, depth)) ?? { path: root, name: root, isRepo: false, gitKind: 'repo', children: [] }
  return { tree, visited: walk.visited, isTruncated: walk.isTruncated, unsafe: walk.unsafe }
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
    const { tree, visited, isTruncated, unsafe } = await walkTree($, root, depth)
    const paths = repoPaths(tree)
    // without git the tree still shows where the repositories are, with no status
    const safePaths = paths.filter(p => !unsafe.has(p))
    const safeInfos = git.problem === 'missing' ? [] : await inspectAll($, safePaths)
    const bySafe = new Map(safePaths.map((p, i) => [p, safeInfos[i]!]))
    skippedRepos = unsafe
    const infos = git.problem === 'missing' ? [] : paths.map(p => bySafe.get(p) ?? { ...emptyRepo(), error: T.networkGitdir, isNetworkGitdir: true })
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
    // keep an opened row's details current, or close them if the row is gone
    const opened = await read($, openRepo)
    if (opened && safePaths.includes(opened)) await loadDetail($, opened)
    else if (opened) {
      await update($, openRepo, () => '')
      await update($, detail, () => null)
    }
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
  await update($, openRepo, () => '')
  await update($, detail, () => null)
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

/** Puts text on the clipboard of the surface that asked, and says so. */
async function copyText($: Engine, text: string, surface: UiPressArgument['surface']) {
  const safe = clean(text)
  if (!safe) return
  const result = await $.ui.copy({ text: safe, surface })
  if (result.isCopied) $.ui.toast(T.copied(shorten(safe, 48)))
}

/** A pressed row link: scan from that folder, or copy its path. */
async function rowLinkAction($: Engine, path: string, href: string, surface: UiPressArgument['surface']) {
  const action = actionOf(href)
  if (action === 'copy') await copyText($, path, surface)
  else if (action === 'scan') await setRoot($, path)
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
    const opened = await read($, openRepo)
    const readDetail: RepoDetail | null = opened ? await read($, detail) : null
    const openDetail = readDetail && readDetail.path === opened ? readDetail : null
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
    const rt = (props: Pick<TextProps, 'size' | 'weight' | 'tabular' | 'mono'>) => (richText ? props : {})
    // spacing steps likewise: a step name where the engine knows them, whole cells elsewhere
    const sp = (step: 'xs' | 'sm' | 'md', cells: number) => (richText ? step : cells)

    const ICON_W = Svg ? 3 : 2 // the icon's column, with a little air before the label
    // the fold chevron's column; a flat list has nothing to fold, so it keeps one cell of air
    // every repository row has a details toggle, so the column is there whenever rows are
    const SLOT = rows.length > 0 ? 3 : 1
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

    const commitLine = (r: RepoInfo, indent: number, trailing?: RenderChildren) => (
      <Box flexDirection="column" paddingLeft={indent}>
        <Box flexDirection="row" alignItems="center">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text {...rt({ size: 'caption' })} dimColor wrap="truncate-end">
              {r.lastCommitAge ? `${r.lastCommitAge} · ` : ''}
              {r.lastCommit || ' '}
            </Text>
          </Box>
          {trailing ?? null}
        </Box>
        {r.warning ? (
          <Text {...rt({ size: 'caption' })} color="warning" wrap="truncate-end">
            {r.warning}
          </Text>
        ) : null}
      </Box>
    )

    // Desktop row actions: two text-sized links in a slot that always keeps its width
    // and shows on hover, so nothing overlaps, reflows or changes height.
    const Markdown = 'Markdown' in els ? els.Markdown : undefined
    const ACTION_W = 6
    const actionLinks = (path: string, isRepo: boolean) =>
      hasHover && Markdown ? (
        <Box flexShrink={0} width={ACTION_W} flexDirection="row" justifyContent="flex-end">
          <Box display="none" hover={{ display: 'flex' }}>
            <Markdown
              key={`act:${path}`}
              text={isRepo ? `[⤴](${actionHref(path, 'scan')})  [⧉](${actionHref(path, 'copy')})` : `[⤴](${actionHref(path, 'scan')})`}
              onLinkPress={(link, press) => rowLinkAction($, path, link.href, press.surface)}
            />
          </Box>
        </Box>
      ) : null

    const actionButtons = (path: string, isRepo: boolean) => [
      <Button key={`root:${path}`} label={T.setRoot} variant="secondary" onPress={() => setRoot($, path)} />,
      isRepo ? (
        <Button key={`copy:${path}`} label={T.copy} variant="secondary" onPress={press => copyPath($, path, press.surface)} />
      ) : null,
    ]

    // ---- the details of an opened repository row
    // a hover-only ⧉ in a slot that always keeps its width: copies `text`, moves nothing
    const copySlot = (key: string, text: string) =>
      hasHover && Markdown ? (
        <Box flexShrink={0} width={3} flexDirection="row" justifyContent="flex-end">
          <Box display="none" hover={{ display: 'flex' }}>
            <Markdown key={key} text={`[⧉](${actionHref(info.root || '/', 'copy')})`} onLinkPress={(_, press) => copyText($, text, press.surface)} />
          </Box>
        </Box>
      ) : null

    const commitRow = (c: { hash: string; full: string; subject: string; age: string }, keyPrefix: string) => (
      <Box key={`${keyPrefix}:${c.hash}`} flexDirection="row" {...hoverRow}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text {...rt({ size: 'caption' })} wrap="truncate-end">
            <Text color="subtle" {...rt({ mono: true })}>
              {c.hash}
            </Text>{' '}
            {c.subject}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text {...rt({ size: 'caption' })} dimColor>
            {c.age}
          </Text>
        </Box>
        {copySlot(`copy-hash:${keyPrefix}:${c.hash}`, c.full || c.hash)}
      </Box>
    )

    const fileColor = (code: string): 'success' | 'warning' | 'error' | 'subtle' =>
      code === '??' ? 'subtle' : code.includes('U') || code === 'AA' || code === 'DD' ? 'error' : code[0] !== ' ' ? 'success' : 'warning'

    const syncLine = (r: RepoInfo, d: RepoDetail) => {
      const parts = r.isDetached ? (
        <Text color="warning">{T.detachedHead}</Text>
      ) : d.recent.length === 0 ? (
        <Text color="subtle">{T.noCommitsYet}</Text>
      ) : !d.upstream ? (
        <Text color="subtle">{T.noUpstream}</Text>
      ) : d.ahead && d.behind ? (
        <Text>
          <Text color="warning">{T.diverged}</Text>
          <Text color="warning"> · {T.toPull(d.behind)}</Text>
          <Text color="success"> · {T.toPush(d.ahead)}</Text>
        </Text>
      ) : d.behind ? (
        <Text color="warning">{T.toPull(d.behind)}</Text>
      ) : d.ahead ? (
        <Text color="success">{T.toPush(d.ahead)}</Text>
      ) : (
        <Text color="success">✓ {T.upToDate(d.upstream)}</Text>
      )
      return (
        <Box flexDirection="column">
          <Text {...rt({ size: 'footnote', weight: 'medium' })} wrap="truncate-end">
            {parts}
          </Text>
          {d.upstream ? (
            <Text {...rt({ size: 'caption' })} dimColor wrap="truncate-end">
              {d.lastFetchAge ? T.fetchedAgo(d.lastFetchAge) : T.neverFetched}
              {d.stashes > 0 ? ` · ${T.stashes(d.stashes)}` : ''}
            </Text>
          ) : d.stashes > 0 ? (
            <Text {...rt({ size: 'caption' })} dimColor>
              {T.stashes(d.stashes)}
            </Text>
          ) : null}
        </Box>
      )
    }

    const countLabel = (total: number) => String(total)

    const detailPanel = (r: RepoInfo, d: RepoDetail | null, indent: number) => (
      <Box flexDirection="column" marginLeft={indent} marginTop={sp('xs', 0)} gap={sp('sm', 1)} {...groupProps}>
        {!d || !d.hasLoaded ? (
          <Text {...rt({ size: 'caption' })} dimColor>
            {T.loading}
          </Text>
        ) : (
          [
            <Box key="sync" flexDirection="column">
              {syncLine(r, d)}
            </Box>,
            d.incoming.length > 0 ? (
              <Box key="in" flexDirection="column">
                {heading(T.sectionIncoming, countLabel(d.behind))}
                {d.incoming.slice(0, 6).map(c => commitRow(c, 'in'))}
              </Box>
            ) : null,
            d.outgoing.length > 0 ? (
              <Box key="out" flexDirection="column">
                {heading(T.sectionOutgoing, countLabel(d.ahead))}
                {d.outgoing.slice(0, 6).map(c => commitRow(c, 'out'))}
              </Box>
            ) : null,
            d.filesTotal > 0 ? (
              <Box key="files" flexDirection="column">
                {heading(T.sectionChanges, String(d.filesTotal))}
                {d.files.map((f, i) => (
                  <Box key={`file:${i}`} flexDirection="row" {...hoverRow}>
                    <Box flexGrow={1} flexShrink={1} minWidth={0}>
                      <Text {...rt({ size: 'caption' })} wrap="truncate-middle">
                        <Text color={fileColor(f.code)} {...rt({ mono: true })}>
                          {f.code.replace(/ /g, '·')}
                        </Text>{' '}
                        {f.path}
                      </Text>
                    </Box>
                    {copySlot(`copy-file:${i}`, f.raw)}
                  </Box>
                ))}
                {d.filesTotal > d.files.length ? (
                  <Text {...rt({ size: 'caption' })} dimColor>
                    {T.moreFiles(d.filesTotal - d.files.length)}
                  </Text>
                ) : null}
              </Box>
            ) : null,
            d.recent.length > 0 ? (
              <Box key="recent" flexDirection="column">
                {heading(T.sectionRecentCommits)}
                {d.recent.map(c => commitRow(c, 'recent'))}
              </Box>
            ) : null,
            d.error ? (
              <Text key="err" {...rt({ size: 'caption' })} color="error">
                {d.error}
              </Text>
            ) : null,
          ]
        )}
      </Box>
    )

    const INLINE_BRANCH_MAX = 16
    const row = (node: TreeNode, index: number) => {
      const c = counts.get(node.path) ?? { repos: 0, changed: 0 }
      const isRepo = node.kind === 'repo'
      const isFolded = folded.has(node.path)
      const isOpen = isRepo && opened === node.path
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
              {isRepo && !node.repo?.isNetworkGitdir ? (
                <Button
                  key={`open:${node.path}`}
                  label={isOpen ? '▾' : '▸'}
                  plain
                  dimColor={!isOpen}
                  onPress={() => toggleDetail($, node.path)}
                />
              ) : node.hasChildren ? (
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
            {node.repo ? null : actionLinks(node.path, false)}
          </Box>
          {!isInlineSummary && node.repo ? summaryLine(node.repo, NAME_INDENT) : null}
          {node.repo ? commitLine(node.repo, NAME_INDENT, actionLinks(node.path, true)) : null}
          {isOpen && node.repo ? detailPanel(node.repo, openDetail, NAME_INDENT) : null}
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
          {info.isRootRepo && info.rootRepo && (info.rootRepo.lastCommit || info.rootRepo.warning) ? commitLine(info.rootRepo, ICON_W) : null}
          {info.isRootRepo && info.rootRepo ? (
            <Box paddingLeft={ICON_W} flexDirection="row">
              <Button
                key="open:(root)"
                label={opened === info.root ? `▾ ${T.hideDetails}` : `▸ ${T.showDetails}`}
                plain
                dimColor
                onPress={() => toggleDetail($, info.root)}
              />
            </Box>
          ) : null}
          {info.isRootRepo && info.rootRepo && opened === info.root ? detailPanel(info.rootRepo, openDetail, ICON_W) : null}
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
