import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

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
  parentOf,
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
    scannedAt: 0, visited: 0, isTruncated: false, error: '',
  },
  { shape: 'scan-2' },
)
const onlyDirty = atom({ plugin: 'git-workspace', key: 'onlyDirty' } as const, false)
const collapsed = atom({ plugin: 'git-workspace', key: 'collapsed' } as const, [], { shape: 'collapsed-1' })
const rootChoice = atom({ plugin: 'git-workspace', key: 'root' } as const, '')
const maxDepth = atom({ plugin: 'git-workspace', key: 'maxDepth' } as const, DEFAULT_DEPTH)
const isEditingRoot = atom({ plugin: 'git-workspace', key: 'isEditingRoot' } as const, false)

type $ = EngineInterface

// ---------------------------------------------------------------- git

// Scanned repositories are untrusted: switch off every config setting that
// makes `git status` / `git log` start a program (fsmonitor, hooks, pager,
// external diff), skip submodules (their own config is not checked), and never
// prompt for credentials. Filter drivers are checked per repository below.
const SAFE_GIT = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=',
  '-c', 'core.pager=cat',
  '-c', 'diff.external=',
  // `log.showSignature` would run gpg.program / gpg.ssh.program from repo config
  '-c', 'log.showSignature=false',
  '-c', 'gpg.program=false',
  '-c', 'gpg.ssh.program=false',
  '-c', 'gpg.x509.program=false',
  '--no-pager',
  '--no-optional-locks',
]

const git = async ($: $, cwd: string, args: string[]) =>
  $.process.run(['git', ...SAFE_GIT, '-C', cwd, ...args], {
    timeoutMs: 15_000,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  })

const sanitize = (repo: RepoInfo): RepoInfo => ({
  ...repo,
  branch: clean(repo.branch),
  upstream: clean(repo.upstream),
  lastCommit: clean(repo.lastCommit),
  lastCommitAge: clean(repo.lastCommitAge),
  warning: clean(repo.warning),
  error: clean(repo.error),
})

const inspectRepo = async ($: $, path: string): Promise<RepoInfo> => {
  let repo = emptyRepo()
  try {
    // Reading config runs nothing. A filter driver set by the repository itself
    // could run a program during `git status`, so such a repository gets its
    // branch read without status.
    const filters = await git($, path, ['config', '--show-scope', '--name-only', '--get-regexp', '^filter\\.'])
    // exit 1 with no output is git's "no such key"; any other failure fails closed
    const isUnchecked = filters.exitCode !== 0 && !(filters.exitCode === 1 && filters.stdout.trim() === '')
    const risky = filters.exitCode === 0 ? untrustedFilters(filters.stdout) : []

    const log = git($, path, ['log', '-1', '--no-show-signature', '--format=%h %s%x1f%cr'])
    if (isUnchecked || risky.length > 0) {
      const head = await git($, path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      repo.branch = head.exitCode === 0 ? head.stdout.trim() : '(detached)'
      repo.isDetached = head.exitCode !== 0
      repo.warning = isUnchecked
        ? '저장소 설정을 확인하지 못해 변경 상태 조회를 건너뜀'
        : `저장소 설정의 filter 드라이버(${risky.join(', ')}) 때문에 변경 상태 조회를 건너뜀`
    } else {
      const status = await git($, path, [
        'status', '--porcelain=v2', '--branch', '--untracked-files=normal', '--ignore-submodules=all',
      ])
      if (status.exitCode !== 0) {
        return sanitize({ ...repo, error: status.stderr.trim().split(/\r?\n/)[0] || 'git status 실패' })
      }
      repo = parseStatus(status.stdout, repo)
    }

    const last = await log
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

// ---------------------------------------------------------------- scan

const limiter = (limit: number) => {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve))
    active++
    try {
      return await fn()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

const mapLimited = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const run = limiter(limit)
  return Promise.all(items.map(item => run(() => fn(item))))
}

/**
 * Walks the folder tree from `root` down to `depth` levels, through
 * repositories too (a repository can hold more repositories), and keeps only
 * the folders that lead to a repository.
 */
const walkTree = async ($: $, root: string, depth: number) => {
  const run = limiter(FS_CONCURRENCY)
  let visited = 0
  let isTruncated = false

  const visit = async (path: string, level: number): Promise<RawNode | null> => {
    if (visited >= MAX_VISITED) {
      isTruncated = true
      return null
    }
    visited++
    const entries = await run(() => $.fs.list(path)).catch(() => [])
    const dotGit = entries.find(entry => entry.name === '.git')
    let gitKind: RawNode['gitKind'] = 'repo'
    if (dotGit?.kind === 'file') {
      const content = await $.fs.read(joinPath(path, '.git')).catch(() => '')
      gitKind = gitKindOfFile(typeof content === 'string' ? content : '')
    }
    const children: RawNode[] = []
    if (level < depth) {
      const dirs = entries
        .filter(e => e.kind === 'dir' && !e.isLink && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
        .map(e => e.name)
        .sort((a, b) => a.localeCompare(b))
      const found = await Promise.all(dirs.map(name => visit(joinPath(path, name), level + 1)))
      for (const child of found) if (child) children.push(child)
    }
    const isRepo = dotGit !== undefined
    if (!isRepo && children.length === 0 && level > 0) return null
    return { path, name: clean(baseName(path) || path), isRepo, gitKind, children }
  }

  const tree = (await visit(root, 0)) ?? { path: root, name: root, isRepo: false, gitKind: 'repo', children: [] }
  return { tree, visited, isTruncated }
}

const repoPaths = (node: RawNode, into: string[] = []): string[] => {
  if (node.isRepo) into.push(node.path)
  for (const child of node.children) repoPaths(child, into)
  return into
}

const sessionDir = async ($: $): Promise<string> => {
  const cwd = await $.fs.stat('.', { resolve: true }).catch(() => undefined)
  return cwd?.realPath ?? '.'
}

const currentRoot = async ($: $): Promise<{ root: string; session: string }> => {
  const session = await sessionDir($)
  const chosen = (await read($, rootChoice)).trim()
  return { root: chosen || session, session }
}

let running: Promise<void> | undefined
let again = false

const rescan = ($: $): Promise<void> => {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      const { root, session } = await currentRoot($)
      const depth = await read($, maxDepth)
      await update($, scan, s => ({ ...s, root, sessionDir: session, isScanning: true, error: '' }))
      try {
        if (!(await $.fs.exists(root))) throw new Error(`폴더가 없습니다: ${root}`)
        const { tree, visited, isTruncated } = await walkTree($, root, depth)
        const paths = repoPaths(tree)
        const infos = await mapLimited(paths, GIT_CONCURRENCY, path => inspectRepo($, path))
        const byPath = new Map(paths.map((path, i) => [path, infos[i]!]))
        const rows = flatten(tree, byPath)
        await update($, nodes, () => rows)
        await update($, scan, s => ({
          ...s,
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
    } while (again)
  })().finally(() => {
    running = undefined
  })
  return running
}

const rememberRoot = async ($: $, root: string) => {
  const stored = await $.store.get(STORE_RECENT)
  const list = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []
  await $.store.set(STORE_RECENT, [root, ...list.filter(x => x !== root)].slice(0, 6))
}

const recentRoots = async ($: $): Promise<string[]> => {
  const stored = await $.store.get(STORE_RECENT)
  return Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []
}

/** '' goes back to the session's folder. */
const setRoot = async ($: $, value: string) => {
  const root = value.trim().replace(/^"(.*)"$/, '$1')
  await update($, rootChoice, () => root)
  await update($, collapsed, () => [])
  await update($, isEditingRoot, () => false)
  if (root) await rememberRoot($, root)
  await rescan($)
}

// ---------------------------------------------------------------- drawing

const pad2 = (n: number) => String(n).padStart(2, '0')
const clockText = (ms: number) => {
  if (!ms) return '-'
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const samePath = (a: string, b: string) =>
  a.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase() === b.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()


export const register: Register = on => {
  let debounce: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'git-workspace',
      description: 'Git 워크스페이스 패널 열기 (인자로 폴더 경로를 주면 스캔 루트 변경)',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void rescan($)
    $.clock.every(REFRESH_MS, () => void rescan($))
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
    debounce = $.clock.after(1500, () => void rescan($))
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
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
    const dirtyTotal = allRepos.filter(isDirty).length
    const syncTotal = allRepos.filter(r => r.ahead > 0 || r.behind > 0).length
    const isSessionRoot = info.root !== '' && samePath(info.root, info.sessionDir)
    const foldable = rows.filter(row => row.hasChildren).map(row => row.path)
    const showRowActions = hasHover || isMenuOpen

    const toggle = (path: string) =>
      void update($, collapsed, list => (list.includes(path) ? list.filter(p => p !== path) : [...list, path]))

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
        <Button key={`root:${path}`} label="⤴ 루트로" variant="secondary" onPress={() => void setRoot($, path)} />
        {isRepo ? (
          <Button
            key={`copy:${path}`}
            label="⧉ 복사"
            variant="secondary"
            onPress={press => void $.ui.copy({ text: path, surface: press.surface })}
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
                <Button key={`fold:${node.path}`} label={isFolded ? '▸' : '▾'} plain onPress={() => toggle(node.path)} />
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
              <Button key="refresh" label="⟳" hotkey="r" variant="secondary" onPress={() => void rescan($)} />
              <Button
                key="filter"
                label="변경만"
                hotkey="f"
                variant={dirtyOnly ? 'primary' : 'secondary'}
                onPress={() => void update($, onlyDirty, v => !v)}
              />
              <Button
                key="menu"
                label={isMenuOpen ? '✕' : '⋯'}
                hotkey="p"
                variant="secondary"
                onPress={() => void update($, isEditingRoot, v => !v)}
              />
            </Box>
          </Box>
          <Text dimColor wrap="truncate-middle">{clean(info.root)}</Text>
          {info.isRootRepo && info.rootRepo ? repoSummary(info.rootRepo) : null}
          <Text dimColor>
            저장소 {allRepos.length}
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
                  onSubmit={value => void setRoot($, value)}
                />
              ) : (
                <Text dimColor>/git-workspace &lt;폴더 경로&gt;</Text>
              )}
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                <Button key="session-root" label="세션 폴더" variant="secondary" onPress={() => void setRoot($, '')} />
                <Button
                  key="parent-root"
                  label="상위 폴더"
                  variant="secondary"
                  onPress={() => void setRoot($, parentOf(info.root || info.sessionDir))}
                />
              </Box>
            </Box>

            {recent.length > 0 ? (
              <Box flexDirection="column">
                <Text dimColor>최근</Text>
                {recent.map(path => (
                  <Button key={`recent:${path}`} plain dimColor onPress={() => void setRoot($, path)}>
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
                onPress={() => void update($, collapsed, list => (list.length > 0 ? [] : foldable))}
              />
              <Text dimColor>깊이</Text>
              <Button
                key="depth-down"
                label="−"
                variant="secondary"
                onPress={() => void update($, maxDepth, d => Math.max(1, d - 1)).then(() => rescan($))}
              />
              <Text>{depth}</Text>
              <Button
                key="depth-up"
                label="+"
                variant="secondary"
                onPress={() => void update($, maxDepth, d => Math.min(10, d + 1)).then(() => rescan($))}
              />
            </Box>

            <Box flexDirection="column">
              <Text dimColor>◆ 저장소 ▪ 폴더 · ↑ 보낼 커밋 ↓ 받을 커밋 · 로컬 = upstream 없음</Text>
              <Text dimColor>+ 스테이지 ~ 수정 ? 새 파일 ! 충돌 · ✓ 깨끗함 · ⚠ 상태 조회 건너뜀</Text>
              {hasHover ? <Text dimColor>행에 마우스를 올리면 ⤴ 루트로 · ⧉ 복사</Text> : null}
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
