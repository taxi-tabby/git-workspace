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
const DIRS: Record<string, { name: string; kind: 'dir' | 'file' }[]> = {
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
  disk: { dirs?: typeof DIRS; files?: Record<string, string>; ran?: string[] } = {},
) => {
  const dirs = disk.dirs ?? DIRS

  on('command.register', () => ({ value: { command: 'git-workspace' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/ws' } }))
  on('fs.exists', () => ({ value: true }))
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
    if (args.includes(' config ')) return answer('', 1)
    if (args.includes(' status --porcelain=v1 ')) return answer(' M src/app.ts\0?? notes.md\0R  new.ts\0old.ts\0')
    if (args.includes(' status ')) return answer(STATUS)
    if (args.includes(' @{upstream}..HEAD ')) return answer('def5678\x1fdef5678000000000000000000000000000000000\x1fadd the feature\x1f1 hour ago\x1fme\x1e')
    if (args.includes(' HEAD..@{upstream} ')) return answer('')
    if (args.includes(' --abbrev-ref --symbolic-full-name @{upstream}')) return answer('origin/main\n')
    if (args.includes(' rev-list --left-right --count ')) return answer('1\t0\n')
    if (args.includes(' rev-parse --git-dir --git-common-dir')) return answer('.git\n.git\n')
    if (args.includes(' log -8 ')) return answer('def5678\x1fdef5678000000000000000000000000000000000\x1fadd the feature\x1f1 hour ago\x1fme\x1eabc1234\x1fabc1234000000000000000000000000000000000\x1finit\x1f2 days ago\x1fme\x1e')
    if (args.includes(' log ')) return answer('abc1234 init\x1f2 days ago')
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
  expect(await ui.find({ type: 'Markdown', key: 'copy-file:src/app.ts' })).toBeTruthy()
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
