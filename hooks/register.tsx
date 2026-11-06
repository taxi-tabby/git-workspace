import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiPressArgument } from 'claude-code'

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
  subtreeCounts,
  untrustedFilters,
  visibleRows,
} from './tree'
import type { RawNode } from './tree'

const PANE = 'git-workspace'
const TITLE = 'Git 워크스페이스'
const STORE_RECENT = 'recentRoots'
const REFRESH_MS = 60_000
const GIT_CONCURRENCY = 6
const FS_CONCURRENCY = 8
const MAX_VISITED = 5000
const DEFAULT_DEPTH = 4
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
        ? '저장소 설정을 확인하지 못해 변경 상태 조회를 건너뜀'
        : `저장소 설정의 filter 드라이버(${risky.join(', ')}) 때문에 변경 상태 조회를 건너뜀`
    } else {
      const status = await gitStatus($, path)
      if (status.exitCode !== 0) {
        return sanitize({ ...repo, error: status.stderr.trim().split(/\r?\n/)[0] || 'git status 실패' })
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
      repo.lastCommit = '(커밋 없음)'
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
    if (!(await $.fs.exists(root))) throw new Error(`폴더가 없습니다: ${root}`)
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

export const register: Register = on => {
  let debounce: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'git-workspace',
      description: 'Git 워크스페이스 패널 열기 (인자로 폴더 경로를 주면 스캔 루트 변경)',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void rescan($)
    $.clock.every(REFRESH_MS, () => rescan($))
    return next(e)
  })

  on('command.run', { command: 'git-workspace' }, async ($, e) => {
    if (e.args.trim()) await setRoot($, e.args)
    else void rescan($)
    await $.ui.open({ id: PANE, title: TITLE })
    const { root } = await currentRoot($)
    return { text: `Git 워크스페이스 패널을 열었습니다. 스캔 루트: ${root}` }
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
    // desktop has a pointer: row actions float in on hover. Elsewhere they are
    // drawn inline while the ⋯ menu is open, so the keyboard can reach them.
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
    const syncTotal = allRepos.filter(r => r.ahead > 0 || r.behind > 0).length
    const isSessionRoot = info.root !== '' && samePath(info.root, info.sessionDir)
    const foldable = rows.filter(row => row.hasChildren).map(row => row.path)
    const showRowActions = hasHover || isMenuOpen

    // branch, sync and change chips on one line; every chip carries its own leading space
    const repoSummary = (r: RepoInfo) =>
      r.error ? (
        <Text color="error" wrap="truncate-end"> ✕ {r.error}</Text>
      ) : (
        <Text wrap="truncate-end">
          <Text color={r.isDetached ? 'warning' : 'suggestion'}> ⎇ {r.branch}</Text>
          {r.ahead ? <Text color="success"> ↑{r.ahead}</Text> : null}
          {r.behind ? <Text color="warning"> ↓{r.behind}</Text> : null}
          {!r.upstream && !r.isDetached ? <Text dimColor> 로컬</Text> : null}
          {r.warning ? (
            <Text color="warning"> ⚠</Text>
          ) : isDirty(r) ? (
            <Text>
              {r.conflicts ? <Text color="error"> !{r.conflicts}</Text> : null}
              {r.staged ? <Text color="success"> +{r.staged}</Text> : null}
              {r.unstaged ? <Text color="warning"> ~{r.unstaged}</Text> : null}
              {r.untracked ? <Text dimColor> ?{r.untracked}</Text> : null}
            </Text>
          ) : (
            <Text color="success"> ✓</Text>
          )}
        </Text>
      )

    const repoDetail = (r: RepoInfo, indent: number) =>
      r.lastCommit || r.warning ? (
        <Box flexDirection="column" paddingLeft={indent}>
          {r.lastCommit ? (
            <Text dimColor wrap="truncate-end">
              {r.lastCommitAge ? `${r.lastCommitAge} · ` : ''}
              {r.lastCommit}
            </Text>
          ) : null}
          {r.warning ? <Text color="warning" wrap="truncate-end">{r.warning}</Text> : null}
        </Box>
      ) : null

    const rowActions = (path: string, isRepo: boolean) => (
      <Box
        flexDirection="row"
        gap={1}
        {...(hasHover
          ? { position: 'absolute' as const, top: 0, right: 0, display: 'none' as const, hover: { display: 'flex' as const } }
          : {})}
      >
        <Button key={`root:${path}`} label="⤴ 루트로" variant="secondary" onPress={() => setRoot($, path)} />
        {isRepo ? (
          <Button
            key={`copy:${path}`}
            label="⧉ 복사"
            variant="secondary"
            onPress={press => copyPath($, path, press.surface)}
          />
        ) : null}
      </Box>
    )

    const SLOT = 3 // width of the fold toggle column; detail lines indent past it and the icon
    const row = (node: TreeNode, index: number) => {
      const c = counts.get(node.path) ?? { repos: 0, changed: 0 }
      const isRepo = node.kind === 'repo'
      const isFolded = folded.has(node.path)
      const below = isRepo ? c.repos - 1 : c.repos
      const belowChanged = isRepo && node.repo && needsAttention(node.repo) ? c.changed - 1 : c.changed
      const prev = shown[index - 1]
      const isGroupEdge = node.depth === 0 && index > 0 && (node.hasChildren || prev?.hasChildren === true || (prev?.depth ?? 0) > 0)
      return (
        <Box key={`row:${node.path}`} flexDirection="column" paddingLeft={node.depth * 2} marginTop={isGroupEdge ? 1 : 0}>
          <Box flexDirection="row" alignItems="center">
            <Box width={SLOT} flexShrink={0}>
              {node.hasChildren ? (
                <Button key={`fold:${node.path}`} label={isFolded ? '▸' : '▾'} plain onPress={() => toggleFold($, node.path)} />
              ) : (
                <Text> </Text>
              )}
            </Box>
            <Box flexGrow={1} flexShrink={1} flexDirection="row">
              <Text wrap="truncate-end">
                <Text color={isRepo ? 'claude' : 'subtle'}>{isRepo ? '◆' : '▪'}</Text>{' '}
                <Text bold={isRepo}>{node.label}</Text>
                {isRepo && node.gitKind !== 'repo' ? <Text dimColor> {node.gitKind}</Text> : null}
                {isFolded && below > 0 ? (
                  <Text dimColor>
                    {' '}
                    · 저장소 {below}
                    {belowChanged > 0 ? <Text color="warning"> (변경 {belowChanged})</Text> : null}
                  </Text>
                ) : null}
              </Text>
              {node.repo ? repoSummary(node.repo) : null}
            </Box>
            {showRowActions ? rowActions(node.path, isRepo) : null}
          </Box>
          {node.repo ? repoDetail(node.repo, SLOT + 2) : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {/* header: where we are + three controls */}
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Text bold wrap="truncate-end">
              {clean(baseName(info.root)) || '(계산 중)'}
              {isSessionRoot ? <Text dimColor> · 세션 폴더</Text> : null}
            </Text>
            <Box flexDirection="row" gap={1} flexShrink={0}>
              <Button key="refresh" label="⟳" hotkey="r" variant="secondary" onPress={() => rescan($)} />
              <Button
                key="filter"
                label="변경만"
                hotkey="f"
                variant={dirtyOnly ? 'primary' : 'secondary'}
                onPress={() => update($, onlyDirty, v => !v)}
              />
              <Button
                key="menu"
                label={isMenuOpen ? '✕' : '⋯'}
                hotkey="p"
                variant="secondary"
                onPress={() => update($, isEditingRoot, v => !v)}
              />
            </Box>
          </Box>
          <Text dimColor wrap="truncate-middle">{clean(info.root)}</Text>
          {info.isRootRepo && info.rootRepo ? repoSummary(info.rootRepo) : null}
          <Text dimColor>
            저장소 {repoCount}
            {dirtyTotal ? <Text color="warning"> · 변경 {dirtyTotal}</Text> : null}
            {syncTotal ? <Text color="warning"> · 동기화 {syncTotal}</Text> : null}
            {' · '}
            {info.isScanning ? '스캔 중…' : clockText(info.scannedAt)}
          </Text>
          {info.isTruncated ? (
            <Text color="warning">폴더가 많아 {info.visited}개까지만 살펴봤습니다. 깊이를 줄이거나 하위 폴더를 루트로 지정하세요.</Text>
          ) : null}
          {info.error ? <Text color="error">{info.error}</Text> : null}
        </Box>

        {/* git missing or too old: say so plainly, with where to get it */}
        {info.gitProblem ? (
          <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
            <Text color="warning" bold>
              {info.gitProblem === 'missing'
                ? '⚠ git을 찾을 수 없습니다'
                : `⚠ git ${info.gitVersion}은 너무 오래된 버전입니다 (${MIN_GIT.join('.')} 이상 필요)`}
            </Text>
            <Text>
              {info.gitProblem === 'missing'
                ? '저장소 위치만 표시합니다. Git을 설치하고 PATH에 추가한 뒤 ⟳ 로 다시 확인하세요.'
                : '브랜치만 표시하고 변경 상태는 건너뜁니다. Git을 업데이트한 뒤 ⟳ 로 다시 확인하세요.'}
            </Text>
            <Box flexDirection="row" gap={1} alignItems="center">
              <Link href="https://git-scm.com/downloads" label="git 내려받기 (git-scm.com)" />
              <Button key="git-recheck" label="다시 확인" variant="secondary" onPress={() => rescan($)} />
            </Box>
          </Box>
        ) : null}

        {/* settings, folded away behind ⋯ */}
        {isMenuOpen ? (
          <Box flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
            <Box flexDirection="column">
              <Text dimColor>스캔 루트</Text>
              {Input ? (
                <Input
                  key="root-input"
                  placeholder="폴더 경로 (예: D:\projects)"
                  value={info.root}
                  submitLabel="적용"
                  onSubmit={value => setRoot($, value)}
                />
              ) : (
                <Text dimColor>/git-workspace &lt;폴더 경로&gt;</Text>
              )}
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                <Button key="session-root" label="세션 폴더" variant="secondary" onPress={() => setRoot($, '')} />
                <Button
                  key="parent-root"
                  label="상위 폴더"
                  variant="secondary"
                  onPress={() => setRoot($, parentOf(info.root || info.sessionDir))}
                />
              </Box>
            </Box>

            {recent.length > 0 ? (
              <Box flexDirection="column">
                <Text dimColor>최근</Text>
                {recent.map(path => (
                  <Button key={`recent:${path}`} plain dimColor onPress={() => setRoot($, path)}>
                    {clean(baseName(path))} <Text dimColor>{clean(parentOf(path))}</Text>
                  </Button>
                ))}
              </Box>
            ) : null}

            <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
              <Button
                key="fold-all"
                label={folded.size > 0 ? '모두 펼치기' : '모두 접기'}
                variant="secondary"
                onPress={() => update($, collapsed, list => (list.length > 0 ? [] : foldable))}
              />
              <Text dimColor>깊이</Text>
              <Button
                key="depth-down"
                label="−"
                variant="secondary"
                onPress={() => changeDepth($, -1)}
              />
              <Text>{depth}</Text>
              <Button
                key="depth-up"
                label="+"
                variant="secondary"
                onPress={() => changeDepth($, 1)}
              />
            </Box>

            <Box flexDirection="column">
              <Text dimColor>◆ 저장소 ▪ 폴더 · ↑ 보낼 커밋 ↓ 받을 커밋 · 로컬 = upstream 없음</Text>
              <Text dimColor>+ 스테이지 ~ 수정 ? 새 파일 ! 충돌 · ✓ 깨끗함 · ⚠ 상태 조회 건너뜀</Text>
              {hasHover ? <Text dimColor>행에 마우스를 올리면 ⤴ 루트로 · ⧉ 복사</Text> : null}
              <Text dimColor>{info.gitVersion ? `git ${info.gitVersion}` : 'git 없음'}</Text>
            </Box>
          </Box>
        ) : null}

        {/* the tree */}
        <Box flexDirection="column">
          {shown.length === 0 && !info.isScanning ? (
            <Text dimColor>
              {rows.length === 0
                ? info.isRootRepo
                  ? '하위 저장소가 없습니다.'
                  : `깊이 ${depth} 안에 git 저장소가 없습니다.`
                : '변경된 저장소가 없습니다.'}
            </Text>
          ) : null}
          {shown.map(row)}
        </Box>
      </Box>
    )
  })
}
