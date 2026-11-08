import { expect, test } from 'claude-code/testing'

import { emptyRepo, flatten, gitKindOfFile, parentOf, parseGitVersion, parseStatus, supportsRichText, actionHref, actionOf, parseCommitLines, parseChangedFiles, elapsed, parseAheadBehind, isNetworkPath, clean, subtreeCounts, untrustedFilters, visibleRows } from '../hooks/tree'
import type { RawNode } from '../hooks/tree'

const repo = (path: string, children: RawNode[] = []): RawNode => ({
  path, name: path.split('/').pop()!, isRepo: true, gitKind: 'repo', children,
})
const folder = (path: string, children: RawNode[]): RawNode => ({
  path, name: path.split('/').pop()!, isRepo: false, gitKind: 'repo', children,
})

// root (plain folder)
//   a (repo) -> nested (repo)                      repo → repo
//   group (folder) -> x (repo), y (repo)           folder → many repos
//   deep (folder) -> one (folder) -> two (repo)    folder chain → repo, merged into one row
//   b (repo) -> sub (folder) -> c (repo)           repo → folder → repo
const tree = folder('/r', [
  repo('/r/a', [repo('/r/a/nested')]),
  folder('/r/group', [repo('/r/group/x'), repo('/r/group/y')]),
  folder('/r/deep', [folder('/r/deep/one', [repo('/r/deep/one/two')])]),
  repo('/r/b', [folder('/r/b/sub', [repo('/r/b/sub/c')])]),
])

const dirty = { ...emptyRepo(), unstaged: 2 }
const infos = new Map<string, ReturnType<typeof emptyRepo>>([
  ['/r/a', emptyRepo()], ['/r/a/nested', emptyRepo()], ['/r/group/x', dirty], ['/r/group/y', emptyRepo()],
  ['/r/deep/one/two', emptyRepo()], ['/r/b', emptyRepo()], ['/r/b/sub/c', dirty],
])

test('flatten keeps hierarchy and merges plain folder chains', async () => {
  const rows = flatten(tree, infos)
  expect(rows.map(r => `${r.depth}:${r.label}`)).toEqual([
    '0:a', '1:nested', '0:group', '1:x', '1:y', '0:deep/one', '1:two', '0:b', '1:sub', '2:c',
  ])
  expect(rows.find(r => r.label === 'deep/one')!.path).toBe('/r/deep/one')
  expect(rows.find(r => r.label === 'two')!.parent).toBe('/r/deep/one')
})

test('collapsing hides descendants; changed-only keeps ancestors', async () => {
  const rows = flatten(tree, infos)
  expect(visibleRows(rows, new Set(['/r/b']), false).map(r => r.label)).toEqual([
    'a', 'nested', 'group', 'x', 'y', 'deep/one', 'two', 'b',
  ])
  expect(visibleRows(rows, new Set(), true).map(r => r.label)).toEqual(['group', 'x', 'b', 'sub', 'c'])
  const counts = subtreeCounts(rows)
  expect(counts.get('/r/group')).toEqual({ repos: 2, changed: 1 })
  expect(counts.get('/r/b')).toEqual({ repos: 2, changed: 1 })
})

test('parsers', async () => {
  const s = parseStatus(
    ['# branch.oid 0123456789abcdef', '# branch.head (detached)', '1 M. N... 1 1 1 a b f', '? new.txt', 'u UU x'].join('\n'),
    emptyRepo(),
  )
  expect(s.branch).toBe('(detached 0123456)')
  expect([s.staged, s.unstaged, s.untracked, s.conflicts]).toEqual([1, 0, 1, 1])
  expect(gitKindOfFile('gitdir: D:/x/.git/worktrees/wt')).toBe('worktree')
  expect(gitKindOfFile('gitdir: ../.git/modules/lib')).toBe('submodule')
  expect(untrustedFilters('global\tfilter.lfs.clean\nlocal\tfilter.evil.smudge\nlocal\tfilter.evil.required')).toEqual(['evil'])
  expect(parentOf('D:\\projects\\x')).toBe('D:\\projects')
  expect(parentOf('D:\\projects')).toBe('D:/')
  expect(parentOf('D:/')).toBe('D:/')
  expect(parseGitVersion('git version 2.52.0.windows.1\n')).toEqual({ version: '2.52.0', isTooOld: false })
  expect(parseGitVersion('git version 2.26.0')).toEqual({ version: '2.26.0', isTooOld: false })
  expect(parseGitVersion('git version 2.25.4')).toEqual({ version: '2.25.4', isTooOld: true })
  expect(parseGitVersion('bash: git: command not found')).toBeNull()
  expect(supportsRichText('2.1.317')).toBe(true)
  expect(supportsRichText('2.2.0')).toBe(true)
  expect(supportsRichText('2.1.320-dev')).toBe(true)
  expect(supportsRichText('2.1.296')).toBe(false)
  expect(supportsRichText('1.9.999')).toBe(false)
  expect(supportsRichText('')).toBe(false)
  expect(actionHref('D:\\a b\\c(1)', 'scan')).toBe('file:///D:/a%20b/c%281%29#scan')
  expect(actionHref('/home/me/x', 'copy')).toBe('file:///home/me/x#copy')
  expect(actionOf(actionHref('D:\\x', 'copy'))).toBe('copy')
  expect(actionOf('https://example.com')).toBeNull()
  expect(parseCommitLines('a1\x1fa1full\x1fsubj\x1f2 h ago\x1fme\x1e\nb2\x1fb2full\x1fother\x1f3 d ago\x1fyou\x1e')).toEqual([
    { hash: 'a1', full: 'a1full', subject: 'subj', age: '2 h ago', author: 'me' },
    { hash: 'b2', full: 'b2full', subject: 'other', age: '3 d ago', author: 'you' },
  ])
  expect(parseChangedFiles(' M a.ts\0R  new.ts\0old.ts\0?? c.md\0')).toEqual([
    { code: ' M', path: 'a.ts' },
    { code: 'R ', path: 'new.ts' },
    { code: '??', path: 'c.md' },
  ])
  // a worktree-side rename is followed by its original path too
  expect(parseChangedFiles(' R new.ts\0old.ts\0 M a.ts\0').map(f => f.path)).toEqual(['new.ts', 'a.ts'])
  expect(parseAheadBehind('3\t5\n')).toEqual({ ahead: 3, behind: 5 })
  expect(parseAheadBehind('fatal: no upstream')).toBeNull()
  expect(isNetworkPath('\\\\host\\share\\.git')).toBe(true)
  expect(isNetworkPath('//host/share/.git')).toBe(true)
  expect(isNetworkPath('D:/project/.git')).toBe(false)
  expect(isNetworkPath('.git')).toBe(false)
  // bidi and zero-width marks are stripped, so a name cannot reorder what is shown
  expect(clean('evil\u202etxt.exe\u200b')).toBe('eviltxt.exe')
  expect(elapsed(0, 59 * 60_000)).toEqual({ value: 59, unit: 'm' })
  expect(elapsed(0, 3 * 3_600_000)).toEqual({ value: 3, unit: 'h' })
  expect(elapsed(0, 72 * 3_600_000)).toEqual({ value: 3, unit: 'd' })
})
