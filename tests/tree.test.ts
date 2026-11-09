import { expect, test } from 'claude-code/testing'

import { emptyRepo, flatten, gitKindOfFile, parentOf, parseGitVersion, parseStatus, supportsRichText, actionHref, actionOf, parseCommitLines, parseChangedFiles, elapsed, parseAheadBehind, isNetworkPath, ancestorsOf, isHomeOrDriveRoot, clean, configValues, allFilterNames, filterOffArgs, shorten, subtreeCounts, untrustedFilters, visibleRows } from '../hooks/tree'
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
  expect(untrustedFilters('global\tfilter.lfs.clean\nlocal\tfilter.evil.smudge\nlocal\tfilter.evil.required')).toHaveLength(2)
  // a crafted local key is untrusted whatever its last part
  expect(untrustedFilters('local\tfilter.lfs.process=calc .required')).toEqual(['filter.lfs.process=calc .required'])
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
  expect(parseCommitLines('a1a1\x00a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1\x00subj\x002 h ago\x00me\x00\nb2b2\x00b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2\x00other\x003 d ago\x00you\x00')).toEqual([
    { hash: 'a1a1', full: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', subject: 'subj', age: '2 h ago', author: 'me' },
    { hash: 'b2b2', full: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', subject: 'other', age: '3 d ago', author: 'you' },
  ])
  expect(parseChangedFiles(' M a.ts\x00R  new.ts\x00old.ts\x00?? c.md\x00')).toEqual([
    { code: ' M', path: 'a.ts', raw: 'a.ts' },
    { code: 'R ', path: 'new.ts', raw: 'new.ts' },
    { code: '??', path: 'c.md', raw: 'c.md' },
  ])
  // a subject holding the old separators cannot forge a second commit any more
  expect(parseCommitLines('aaaa\x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x00real\x1e\ndeadbee\x1fdddddddddddddddddddddddddddddddddddddddd\x1ffake\x00now\x00me\x00').length).toBe(1)
  // a record whose hashes are not hex is dropped
  expect(parseCommitLines('zz\x00zz\x00s\x00a\x00b\x00')).toEqual([])
  // trusted global drivers are listed too, so they can be switched off for status
  // only the person's own drivers are switched off; local ones make status skip instead
  expect(allFilterNames('system\tfilter.lfs.clean\nglobal\tfilter.lfs.process\nlocal\tfilter.x.y.smudge')).toEqual(['lfs'])
  // a name that could split into another key and value inside -c fails closed
  expect(allFilterNames('global\tfilter.lfs.process=calc .required')).toBeNull()
  expect(filterOffArgs(['ok', 'bad=x', 'sp ace'])).toEqual(['-c', 'filter.ok.process=', '-c', 'filter.ok.clean=', '-c', 'filter.ok.smudge=', '-c', 'filter.ok.required=false'])
  // config lines this reader cannot parse fail closed
  expect(configValues('[include "a\\\\b"]\n\tpath = x\n').some(v => v.isOdd)).toBe(true)
  expect(configValues('[core]\n\tbare\n').some(v => v.isOdd)).toBe(false)
  expect(configValues('[core]\n\t"weird line\n').some(v => v.isOdd)).toBe(true)
  expect(filterOffArgs(['lfs'])).toEqual(['-c', 'filter.lfs.process=', '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false'])
  expect(clean('a\u00adb\u3164c\u2028d\u{e0041}e\ufe0f')).toBe('abcde')
  expect(shorten('😀'.repeat(10), 4)).toBe('😀😀😀…')
  expect(() => actionHref('D:\\x\ud800y', 'scan')).not.toThrow()
  // a worktree-side rename is followed by its original path too
  expect(parseChangedFiles(' R new.ts\x00old.ts\x00 M a.ts\x00').map(f => f.path)).toEqual(['new.ts', 'a.ts'])
  expect(parseAheadBehind('3\t5\n')).toEqual({ ahead: 3, behind: 5 })
  expect(parseAheadBehind('fatal: no upstream')).toBeNull()
  expect(isNetworkPath('\\\\host\\share\\.git')).toBe(true)
  expect(isNetworkPath('//host/share/.git')).toBe(true)
  expect(isNetworkPath('D:/project/.git')).toBe(false)
  expect(isNetworkPath('.git')).toBe(false)
  // bidi and zero-width marks are stripped, so a name cannot reorder what is shown
  expect(clean('evil\u202etxt.exe\u200b')).toBe('eviltxt.exe')
  expect(configValues('[include]\n\tpath = a.cfg\n[includeIf "gitdir:x/"]\n  path = "b.cfg" ; note\n[core]\n\tworktree = //h/s\n'))
    .toEqual([
      { value: 'a.cfg', loose: 'a.cfg', isIncludePath: true, isOdd: false },
      { value: 'b.cfg', loose: 'b.cfg ; note', isIncludePath: true, isOdd: false },
      { value: '//h/s', loose: '//h/s', isIncludePath: false, isOdd: false },
    ])
  // forms git may decode differently are flagged: escapes, partial quotes, glued comments, continuations
  for (const odd of ['p\\\\ath', 'a"b"', 'x#y', 'line\\']) {
    expect(configValues(`[include]\n\tpath = ${odd}\n`)[0]?.isOdd).toBe(true)
  }
  // a quoted, escaped share is still seen as a share by the loose reading
  expect(isNetworkPath(configValues('[core]\n\tworktree = "\\\\\\\\h\\\\s"\n')[0]!.loose)).toBe(true)
  expect(isNetworkPath('\\??\\UNC\\h\\s')).toBe(true)
  expect(elapsed(0, 59 * 60_000)).toEqual({ value: 59, unit: 'm' })
  expect(elapsed(0, 3 * 3_600_000)).toEqual({ value: 3, unit: 'h' })
  expect(elapsed(0, 72 * 3_600_000)).toEqual({ value: 3, unit: 'd' })
})

test('the session folder is anchored to the repository it sits in, never a home or drive top', () => {
  expect(ancestorsOf('D:/ws/app/src')).toEqual(['D:/ws/app/src', 'D:/ws/app', 'D:/ws', 'D:/'])
  expect(ancestorsOf('/ws/app')).toEqual(['/ws/app', '/ws', '/'])
  expect(ancestorsOf('C:\\')).toEqual(['C:\\'])
  for (const top of ['C:\\', 'D:/', '/', 'C:\\Users\\me', '/home/me', '/Users/me', '/root']) {
    expect(isHomeOrDriveRoot(top)).toBe(true)
  }
  for (const not of ['D:/ws', 'C:\\Users\\me\\code', '/home/me/src', 'C:\\Users']) {
    expect(isHomeOrDriveRoot(not)).toBe(false)
  }
})
