import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'git-workspace',
  component: 'Pane',
  requestId: 'git-workspace',
  props: {
    title: 'Git Workspace',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// A fake disk: /ws (folder) holds app (repo, which holds lib, a repo) and group/x (repo).
const DIRS: Record<string, { name: string; kind: 'dir' | 'file' | 'other' }[]> = {
  '/ws': [{ name: 'app', kind: 'dir' }, { name: 'group', kind: 'dir' }],
  '/ws/app': [{ name: '.git', kind: 'dir' }, { name: 'lib', kind: 'dir' }],
  '/ws/app/lib': [{ name: '.git', kind: 'dir' }],
  '/ws/group': [{ name: 'x', kind: 'dir' }],
  '/ws/group/x': [{ name: '.git', kind: 'dir' }],
}

// the engine hands hooks absolute, platform-spelled paths (D:\ws\app on Windows)
const norm = (p: string) => p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

const STATUS = ['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +1 -0', '1 .M N... 1 1 1 a b f'].join('\n')

type On = Parameters<TestBody>[1]

/**
 * Stands for the engine: a fake disk and a fake `git`. `gitVersion` is what
 * `git --version` prints, or null when git cannot start at all.
 */
const fakeHost = (
  on: On,
  gitVersion: string | null,
  disk: { dirs?: typeof DIRS; files?: Record<string, string>; ran?: string[]; filters?: string } = {},
) => {
  const dirs = disk.dirs ?? DIRS

  on('command.register', () => ({ value: { command: 'git-workspace' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.stat', (_, e) => {
    const file = disk.files?.[norm(e.path)]
    return {
      value: {
        kind: file === undefined ? 'dir' : 'file',
        size: file?.length ?? 0,
        mtimeMs: 0,
        isLink: false,
        realPath: norm(e.path).startsWith('/ws') ? norm(e.path) : '/ws',
      },
    }
  })
  on('fs.exists', (_, e) => {
    const n = norm(e.path)
    const cut = n.lastIndexOf('/')
    const inParent = (dirs[n.slice(0, cut)] ?? []).some(d => d.name === n.slice(cut + 1))
    return { value: n === '/ws' || !n.startsWith('/ws') || n in dirs || disk.files?.[n] !== undefined || inParent }
  })
  on('store.get', () => ({ value: ['D:/old/place'] }))
  on('fs.list', (_, e) => ({
    value: (dirs[norm(e.path)] ?? []).map(d => ({ ...d, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_, e) => {
    const text = disk.files?.[norm(e.path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('process.run', (_, e) => {
    const args = e.argv.join(' ')
    disk.ran?.push(args)
    if (args === 'git --version') {
      if (gitVersion === null) throw new Error('spawn git ENOENT')
      return { value: { exitCode: 0, stdout: `git version ${gitVersion}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (gitVersion === null) throw new Error('spawn git ENOENT')
    const answer = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (args.includes(' config ')) return disk.filters ? answer(disk.filters) : answer('', 1)
    if (args.includes(' status --porcelain=v1 ')) return answer(' M src/app.ts\x00?? notes.md\x00R  new.ts\x00old.ts\x00')
    if (args.includes(' status ')) return answer(STATUS)
    if (args.includes(' @{upstream}..HEAD ')) return answer('def5678\x00def5678000000000000000000000000000000000\x00add the feature\x001 hour ago\x00me\x00')
    if (args.includes(' HEAD..@{upstream} ')) return answer('')
    if (args.includes(' --abbrev-ref --symbolic-full-name @{upstream}')) return answer('origin/main\n')
    if (args.includes(' rev-list --left-right --count ')) return answer('1\t0\n')
    if (args.includes(' rev-parse --git-dir --git-common-dir')) return answer('.git\n.git\n')
    if (args.includes(' log -8 ')) return answer('def5678\x00def5678000000000000000000000000000000000\x00add the feature\x001 hour ago\x00me\x00\nabc1234\x00abc1234000000000000000000000000000000000\x00init\x002 days ago\x00me\x00')
    if (args.includes(' log ')) return answer('abc1234 init\x002 days ago')
    if (args.includes(' rev-list ')) return answer('', 128)
    if (args.includes(' rev-parse --git-common-dir')) return answer('.git\n')
    return answer('')
  })
}

test('without git the pane says so, links the download, and still shows where repositories are', async ($, on) => {
  fakeHost(on, null)
  await $.session.start({ cwd: '/ws', surface: 'desktop', isInteractive: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /git wasn't found/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'git-recheck' })).toBeTruthy()
    expect(await ui.find({ type: 'Link' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /3 repos/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /group/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /⎇/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('an old git is named with the version it needs', async ($, on) => {
  fakeHost(on, '2.20.1')
  await $.session.start({ cwd: '/ws', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /git 2\.20\.1 is too old \(2\.26 or newer needed\)/ })).toBeTruthy()
  await ui.unmount()
})

test('the tree and the menu draw on desktop and terminal', async ($, on) => {
  fakeHost(on, '2.52.0.windows.1')

  await $.session.start({ cwd: '/ws', surface: 'desktop', isInteractive: true })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // a press settles the work it starts: the scan it joins has finished after it
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /app/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /group/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /↑1/ })).toBeTruthy()
    // open the ⋯ menu: settings and the legend appear
    await ui.press({ key: 'menu' })
    expect(await ui.find({ type: 'Text', text: /Depth/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'recent:D:/old/place' })).toBeTruthy()
    // row actions: text-sized hover links on desktop, buttons while the menu is open elsewhere
    if (surface === 'desktop') {
      expect(await ui.find({ type: 'Markdown', key: 'act:/ws/group' })).toBeTruthy()
      expect(await ui.find({ type: 'Markdown', key: 'act:/ws/app/lib' })).toBeTruthy()
      expect(await ui.find({ type: 'Button', key: 'root:/ws/group' })).toBeUndefined()
    } else {
      expect(await ui.find({ type: 'Button', key: 'root:/ws/group' })).toBeTruthy()
      expect(await ui.find({ type: 'Button', key: 'copy:/ws/app/lib' })).toBeTruthy()
    }
    await ui.press({ key: 'menu' })
    await ui.unmount()
  }
})

test('the language option switches the pane to Korean', { options: { language: 'ko' } }, async ($, on) => {
  fakeHost(on, '2.52.0')
  await $.session.start({ cwd: '/ws', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Button', key: 'filter' }))?.text).toBe('변경만')
  expect(await ui.find({ type: 'Text', text: /저장소 3/ })).toBeTruthy()
  await ui.press({ key: 'menu' })
  expect(await ui.find({ type: 'Text', text: /깊이/ })).toBeTruthy()
  await ui.unmount()
})

test('English is the default', async ($, on) => {
  fakeHost(on, '2.52.0')
  await $.session.start({ cwd: '/ws', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Button', key: 'filter' }))?.text).toBe('Changed')
  expect(await ui.find({ type: 'Text', text: /[가-힣]/ })).toBeUndefined()
  await ui.press({ key: 'menu' })
  expect(await ui.find({ type: 'Text', text: /[가-힣]/ })).toBeUndefined()
  await ui.unmount()
})

test('at any width the name and the status are separate Texts, so neither squeezes the other', async ($, on) => {
  fakeHost(on, '2.52.0')
  await $.session.start({ cwd: '/ws', surface: 'desktop', isInteractive: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    for (const bodyColumns of [28, 90]) {
      const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns } })
      await ui.press({ key: 'refresh' })
      // the name line holds only the name; the branch and chips are a Text of their own
      const name = await ui.find({ type: 'Text', text: /^lib$/ })
      expect(name?.text).toBe('lib')
      expect((await ui.find({ type: 'Text', text: /main ↑1/ }))?.text).not.toMatch(/lib/)
      for (const key of ['refresh', 'filter', 'menu']) expect(await ui.find({ type: 'Button', key })).toBeTruthy()
      await ui.unmount()
    }
  }
})

test('the terminal draws glyphs where the desktop draws SVG icons', async ($, on) => {
  fakeHost(on, '2.52.0')
  await $.session.start({ cwd: '/ws', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: '◆' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '▪' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '⎇' })).toBeTruthy()
  // one branch glyph per status, never two
  expect(await ui.find({ type: 'Text', text: /⎇ ⎇/ })).toBeUndefined()
  await ui.unmount()
})

test('opening a repository row shows what to push, its changes and recent commits', async ($, on) => {
  fakeHost(on, '2.52.0')
  await $.session.start({ cwd: '/ws', surface: 'desktop', isInteractive: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /to push/ })).toBeUndefined()
    await ui.press({ key: 'open:/ws/app/lib' })
    expect(await ui.find({ type: 'Text', text: /↑ 1 to push/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /TO PUSH/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /CHANGES/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /src\/app\.ts/ })).toBeTruthy()
    // a rename's original path is not listed as a file of its own
    expect(await ui.find({ type: 'Text', text: /old\.ts/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /RECENT COMMITS/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /add the feature/ })).toBeTruthy()
    // pressing it again closes it
    await ui.press({ key: 'open:/ws/app/lib' })
    expect(await ui.find({ type: 'Text', text: /RECENT COMMITS/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the copy link on a commit copies its full hash', async ($, on) => {
  fakeHost(on, '2.52.0')
  const copied: string[] = []
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/ws', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'open:/ws/app/lib' })
  expect(await ui.find({ type: 'Markdown', key: 'copy-hash:recent:def5678' })).toBeTruthy()
  expect(await ui.find({ type: 'Markdown', key: 'copy-file:0' })).toBeTruthy()
  await ui.press({ key: 'copy-hash:recent:def5678', link: { href: 'file:///ws#copy' } })
  expect(copied).toEqual(['def5678000000000000000000000000000000000'])
  await ui.unmount()
})

test('a repository whose git folder is on a network share is listed but never run', async ($, on) => {
  const ran: string[] = []
  fakeHost(on, '2.52.0', {
    dirs: {
      '/ws': [{ name: 'app', kind: 'dir' }, { name: 'shared', kind: 'dir' }],
      '/ws/app': [{ name: '.git', kind: 'dir' }],
      '/ws/shared': [{ name: '.git', kind: 'file' }],
    },
    files: { '/ws/shared/.git': 'gitdir: //fileserver/repos/shared.git\n' },
    ran,
  })
  await $.session.start({ cwd: '/ws', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /network path/ })).toBeTruthy()
  // no details toggle for it, and git never ran in it
  expect(await ui.find({ type: 'Button', key: 'open:/ws/shared' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'open:/ws/app' })).toBeTruthy()
  expect(ran.some(args => args.includes('/ws/shared'))).toBe(false)
  await ui.unmount()
})

test('a repository whose config or alternates reach a network share is never run', async ($, on) => {
  const ran: string[] = []
  fakeHost(on, '2.52.0', {
    dirs: {
      '/ws': [{ name: 'app', kind: 'dir' }, { name: 'incl', kind: 'dir' }, { name: 'alt', kind: 'dir' }],
      '/ws/app': [{ name: '.git', kind: 'dir' }],
      '/ws/incl': [{ name: '.git', kind: 'dir' }],
      '/ws/alt': [{ name: '.git', kind: 'dir' }],
    },
    files: {
      // an include two files deep whose value is a share
      '/ws/incl/.git/config': '[core]\n\tbare = false\n[include]\n\tpath = extra.cfg\n',
      '/ws/incl/.git/extra.cfg': '[core]\n\texcludesFile = "\\\\\\\\evil\\\\share\\\\x"\n',
      // a relative alternate whose own alternates point at a share
      '/ws/alt/.git/objects/info/alternates': '../../../app/.git/objects\n',
      '/ws/app/.git/objects/info/alternates': '//evil/share/objects\n',
    },
    ran,
  })
  await $.session.start({ cwd: '/ws', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(ran.some(args => args.includes('/ws/incl'))).toBe(false)
  expect(ran.some(args => args.includes('/ws/alt'))).toBe(false)
  // app's own alternates reach the share too, so it is skipped as well
  expect(ran.some(args => args.includes('/ws/app'))).toBe(false)
  expect(await ui.find({ type: 'Button', key: 'open:/ws/incl' })).toBeUndefined()
  await ui.unmount()
})

test('status runs with every filter driver switched off, trusted global ones included', async ($, on) => {
  const ran: string[] = []
  fakeHost(on, '2.52.0', { ran, filters: 'global\tfilter.lfs.process\nsystem\tfilter.lfs.clean\n' })
  await $.session.start({ cwd: '/ws', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  const statuses = ran.filter(args => args.includes(' status --porcelain=v2 '))
  expect(statuses.length).toBeGreaterThan(0)
  for (const args of statuses) expect(args).toContain('-c filter.lfs.process= -c filter.lfs.clean= -c filter.lfs.smudge= -c filter.lfs.required=false')
  await ui.unmount()
})

test('an oversized config, a link inside .git, or an odd include path fails closed', async ($, on) => {
  const ran: string[] = []
  fakeHost(on, '2.52.0', {
    dirs: {
      '/ws': [{ name: 'big', kind: 'dir' }, { name: 'linked', kind: 'dir' }, { name: 'odd', kind: 'dir' }, { name: 'ok', kind: 'dir' }],
      '/ws/big': [{ name: '.git', kind: 'dir' }],
      '/ws/big/.git': [{ name: 'config', kind: 'file' }],
      '/ws/linked': [{ name: '.git', kind: 'dir' }],
      '/ws/linked/.git': [{ name: 'HEAD', kind: 'other' }],
      '/ws/odd': [{ name: '.git', kind: 'dir' }],
      '/ws/odd/.git': [{ name: 'config', kind: 'file' }],
      '/ws/ok': [{ name: '.git', kind: 'dir' }],
    },
    files: {
      // git reads the whole file; the pane refuses past 1 MB, so the repository is skipped
      '/ws/big/.git/config': '#'.repeat(1_100_000) + '\n[include]\n\tpath = //evil/x\n',
      '/ws/odd/.git/config': '[include]\n\tpath = "a"\\\\evil\n',
    },
    ran,
  })
  await $.session.start({ cwd: '/ws', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  for (const name of ['big', 'linked', 'odd']) {
    expect(ran.some(args => args.includes(`/ws/${name}`))).toBe(false)
  }
  expect(ran.some(args => args.includes('/ws/ok'))).toBe(true)
  await ui.unmount()
})

test('a crafted local filter key makes status skip; it never reaches a -c option', async ($, on) => {
  const ran: string[] = []
  fakeHost(on, '2.52.0', {
    ran,
    filters: 'global\tfilter.lfs.process\nlocal\tfilter.lfs.process=calc .required\n',
  })
  await $.session.start({ cwd: '/ws', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(ran.some(args => args.includes(' status '))).toBe(false)
  expect(ran.some(args => args.includes('calc'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /filter driver/ })).toBeTruthy()
  await ui.unmount()
})

test('a session started below a repository scans that repository, not the subfolder', async ($, on) => {
  const ran: string[] = []
  fakeHost(on, '2.52.0', { ran, dirs: { ...DIRS, '/ws/app/src': [], '/ws/app/src/deep': [] } })
  on('session.root', () => ({ value: '/ws/app/src/deep' }))
  await $.session.start({ cwd: '/ws/app/src/deep', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /^app$/ })).toBeTruthy()
  expect(ran.some(a => a.includes('/ws/app/src/deep'))).toBe(false)
  await ui.unmount()
})
