import { expect, test } from 'claude-code/testing'

import { emptyRepo, flatten, gitKindOfFile, parentOf, parseGitVersion, parseStatus, supportsRichText, subtreeCounts, untrustedFilters, visibleRows } from '../hooks/tree'
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
})
