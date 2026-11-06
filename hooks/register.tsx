import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RepoInfo, ScanInfo } from '../types'

const PANE = 'git-workspace'
const TITLE = 'Git 워크스페이스'
const STORE_ROOT = 'root'
const REFRESH_MS = 60_000
const CONCURRENCY = 6
const SKIP_DIRS = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information'])

const repos = atom({ plugin: 'git-workspace', key: 'repos' } as const, [], { shape: 'repos-1' })
const scan = atom(
  { plugin: 'git-workspace', key: 'scan' } as const,
  { root: '', isScanning: false, scannedAt: 0, error: '' },
  { shape: 'scan-1' },
)
const onlyDirty = atom({ plugin: 'git-workspace', key: 'onlyDirty' } as const, false)

type $ = EngineInterface

const joinPath = (dir: string, name: string): string =>
  dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}/${name}`

const parentOf = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut <= 0) return trimmed
  const parent = trimmed.slice(0, cut)
  // keep a drive root a root: "D:" -> "D:/"
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent
}

const baseName = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

// Scanned repositories are untrusted: switch off every config setting that
// makes `git status` / `git log` start a program (fsmonitor, hooks, pager,
// external diff), and never prompt for credentials.
const SAFE_GIT = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=',
  '-c', 'core.pager=cat',
  '-c', 'diff.external=',
  '--no-pager',
  '--no-optional-locks',
]

const git = async ($: $, cwd: string, args: string[]) =>
  $.process.run(['git', ...SAFE_GIT, '-C', cwd, ...args], {
    timeoutMs: 15_000,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  })

// Strip C0/C1 control characters (terminal escape sequences) from repo-derived text.
const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

const sanitize = (repo: RepoInfo): RepoInfo => ({
  ...repo,
  name: clean(repo.name),
  branch: clean(repo.branch),
  upstream: clean(repo.upstream),
  lastCommit: clean(repo.lastCommit),
  lastCommitAge: clean(repo.lastCommitAge),
  error: clean(repo.error),
})

const emptyRepo = (path: string): RepoInfo => ({
  name: baseName(path),
  path,
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
  error: '',
})

const parseStatus = (stdout: string, repo: RepoInfo): RepoInfo => {
  const next = { ...repo }
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) {
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
  // branch.oid comes before branch.head, so fix a detached name here too
  if (next.isDetached && next.branch === '(detached)') {
    const oid = /# branch\.oid (\S+)/.exec(stdout)
    if (oid) next.branch = `(detached ${(oid[1] ?? "").slice(0, 7)})`
  }
  return next
}

const inspectRepo = async ($: $, path: string): Promise<RepoInfo> => {
  let repo = emptyRepo(path)
  try {
    const [status, log] = await Promise.all([
      git($, path, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']),
      git($, path, ['log', '-1', '--format=%h %s%x1f%cr']),
    ])
    if (status.exitCode !== 0) {
      return sanitize({ ...repo, error: status.stderr.trim().split(/\r?\n/)[0] || 'git status 실패' })
    }
    repo = parseStatus(status.stdout, repo)
    if (log.exitCode === 0) {
      const [subject, age] = log.stdout.trim().split('\x1f')
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

const findRepos = async ($: $, root: string): Promise<string[]> => {
  const found: string[] = []
  if (await $.fs.exists(joinPath(root, '.git'))) found.push(root)
  const entries = await $.fs.list(root)
  const dirs = entries
    .filter(entry => entry.kind === 'dir' && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
    .map(entry => joinPath(root, entry.name))
  const checks = await Promise.all(
    dirs.map(async dir => ((await $.fs.exists(joinPath(dir, '.git')).catch(() => false)) ? dir : '')),
  )
  for (const dir of checks) if (dir) found.push(dir)
  return found
}

const mapLimited = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length)
  let index = 0
  const worker = async () => {
    while (index < items.length) {
      const mine = index++
      out[mine] = await fn(items[mine] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const resolveRoot = async ($: $): Promise<string> => {
  const stored = await $.store.get(STORE_ROOT)
  if (typeof stored === 'string' && stored.trim()) return stored.trim()
  const cwd = await $.fs.stat('.', { resolve: true }).catch(() => undefined)
  return cwd?.realPath ? parentOf(cwd.realPath) : '.'
}

let running: Promise<void> | undefined

const rescan = ($: $): Promise<void> => {
  if (running) return running
  running = (async () => {
    const root = await resolveRoot($)
    await update($, scan, s => ({ ...s, root, isScanning: true, error: '' }))
    try {
      const paths = await findRepos($, root)
      const list = await mapLimited(paths, CONCURRENCY, path => inspectRepo($, path))
      list.sort((a, b) => a.name.localeCompare(b.name))
      await update($, repos, () => list)
      await update($, scan, s => ({ ...s, isScanning: false, scannedAt: Date.now() }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await update($, repos, () => [])
      await update($, scan, s => ({ ...s, isScanning: false, scannedAt: Date.now(), error: message }))
    }
  })().finally(() => {
    running = undefined
  })
  return running
}

const setRoot = async ($: $, value: string) => {
  const root = value.trim().replace(/^"(.*)"$/, '$1')
  await $.store.set(STORE_ROOT, root)
  await rescan($)
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const clockText = (ms: number) => {
  if (!ms) return '-'
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

const isDirty = (r: RepoInfo) => r.staged + r.unstaged + r.untracked + r.conflicts > 0

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
    const { root } = await read($, scan)
    return { text: `Git 워크스페이스 패널을 열었습니다. 스캔 루트: ${root || '(계산 중)'}` }
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
    const info: ScanInfo = await read($, scan)
    const all: RepoInfo[] = await read($, repos)
    const dirtyOnly = await read($, onlyDirty)
    const list = dirtyOnly ? all.filter(r => isDirty(r) || r.ahead || r.behind || r.error) : all
    const dirtyCount = all.filter(isDirty).length

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text dimColor>스캔 루트</Text>
          <Text bold>{info.root || '(계산 중)'}</Text>
          <Text dimColor>
            저장소 {all.length}개 · 변경 있음 {dirtyCount}개 · 갱신 {info.isScanning ? '스캔 중…' : clockText(info.scannedAt)}
          </Text>
          {info.error ? <Text color="error">{info.error}</Text> : null}
        </Box>

        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="refresh" label="새로고침" hotkey="r" onPress={() => void rescan($)} />
          <Button
            key="filter"
            label={dirtyOnly ? '전체 보기' : '변경된 것만'}
            hotkey="f"
            variant="secondary"
            onPress={() => void update($, onlyDirty, v => !v)}
          />
        </Box>

        {Input ? (
          <Input
            key="root"
            placeholder="스캔할 폴더 경로 (예: D:\projects)"
            value={info.root}
            submitLabel="적용"
            onSubmit={value => void setRoot($, value)}
          />
        ) : (
          <Text dimColor>루트 변경: /git-workspace &lt;폴더 경로&gt;</Text>
        )}

        {list.length === 0 && !info.isScanning ? (
          <Text dimColor>{all.length === 0 ? '이 폴더 바로 아래에 git 저장소가 없습니다.' : '변경된 저장소가 없습니다.'}</Text>
        ) : null}

        {list.map(r => (
          <Box key={`repo:${r.path}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text bold>{r.name}</Text>
              <Button
                key={`copy:${r.path}`}
                label="경로 복사"
                variant="secondary"
                onPress={press => void $.ui.copy({ text: r.path, surface: press.surface })}
              />
            </Box>
            {r.error ? (
              <Text color="error">{r.error}</Text>
            ) : (
              <Box flexDirection="column">
                <Text>
                  <Text color={r.isDetached ? 'warning' : 'suggestion'} mono>
                    ⎇ {r.branch}
                  </Text>
                  {r.upstream ? <Text dimColor> → {r.upstream}</Text> : <Text dimColor> (upstream 없음)</Text>}
                  {r.ahead ? <Text color="success"> ↑{r.ahead}</Text> : null}
                  {r.behind ? <Text color="warning"> ↓{r.behind}</Text> : null}
                </Text>
                <Text>
                  {isDirty(r) ? (
                    <Text>
                      {r.conflicts ? <Text color="error">충돌 {r.conflicts} </Text> : null}
                      {r.staged ? <Text color="success">staged {r.staged} </Text> : null}
                      {r.unstaged ? <Text color="warning">수정 {r.unstaged} </Text> : null}
                      {r.untracked ? <Text dimColor>untracked {r.untracked}</Text> : null}
                    </Text>
                  ) : (
                    <Text color="success">깨끗함</Text>
                  )}
                </Text>
                {r.lastCommit ? (
                  <Text dimColor>
                    {r.lastCommit}
                    {r.lastCommitAge ? ` · ${r.lastCommitAge}` : ''}
                  </Text>
                ) : null}
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
