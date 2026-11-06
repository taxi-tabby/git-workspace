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
const fakeHost = (on: On, gitVersion: string | null) => {
  on('command.register', () => ({ value: { command: 'git-workspace' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/ws' } }))
  on('fs.exists', () => ({ value: true }))
  on('store.get', () => ({ value: ['D:/old/place'] }))
  on('fs.list', (_, e) => ({
    value: (DIRS[norm(e.path)] ?? []).map(d => ({ ...d, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', (_, e) => {
    const args = e.argv.join(' ')
    if (args === 'git --version') {
      if (gitVersion === null) throw new Error('spawn git ENOENT')
      return { value: { exitCode: 0, stdout: `git version ${gitVersion}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (gitVersion === null) throw new Error('spawn git ENOENT')
    const stdout = args.includes(' status ') ? STATUS : args.includes(' log ') ? 'abc1234 init\x1f2 days ago' : ''
    return {
      value: { exitCode: args.includes(' config ') ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
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
    // row actions: hover overlay on desktop, inline (menu open) on the terminal — reachable either way
    expect(await ui.find({ type: 'Button', key: 'root:/ws/group' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'copy:/ws/app/lib' })).toBeTruthy()
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
