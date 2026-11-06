import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'git-workspace',
  component: 'Pane',
  requestId: 'git-workspace',
  props: {
    title: 'Git 워크스페이스',
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

test('the tree and the menu draw on desktop and terminal', async ($, on) => {
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
    const stdout = args.includes(' status ') ? STATUS : args.includes(' log ') ? 'abc1234 init\x1f2 days ago' : ''
    return {
      value: { exitCode: args.includes(' config ') ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })

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
    expect(await ui.find({ type: 'Text', text: /깊이/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'recent:D:/old/place' })).toBeTruthy()
    // row actions: hover overlay on desktop, inline (menu open) on the terminal — reachable either way
    expect(await ui.find({ type: 'Button', key: 'root:/ws/group' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'copy:/ws/app/lib' })).toBeTruthy()
    await ui.press({ key: 'menu' })
    await ui.unmount()
  }
})
