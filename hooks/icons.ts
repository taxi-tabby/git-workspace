// Small 16x16 SVG icons for the desktop surface (drawn as images, so the colors are
// fixed: mid tones that read on both light and dark themes). The terminal has no
// Svg element and falls back to the glyph beside each icon.

const svg = (body: string, size = 16) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16">${body}</svg>`

const GRAY = '#8b949e'
const ORANGE = '#f0883e'
const BLUE = '#58a6ff'
const PURPLE = '#a371f7'
const YELLOW = '#d29922'

export type IconName = 'folder' | 'repo' | 'worktree' | 'submodule' | 'branch' | 'warning'

export const ICONS: Record<IconName, { source: string; glyph: string }> = {
  folder: {
    glyph: '▪',
    source: svg(
      `<path fill="${GRAY}" d="M1.75 2.5h4.1c.4 0 .78.16 1.06.44l.95.95c.1.1.22.15.36.15h6.03c.97 0 1.75.78 1.75 1.75v6.46c0 .97-.78 1.75-1.75 1.75H1.75C.78 14 0 13.22 0 12.25v-8C0 3.28.78 2.5 1.75 2.5Z"/>`,
    ),
  },
  repo: {
    glyph: '◆',
    source: svg(
      `<path fill="${ORANGE}" d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.71 1.71.75.75 0 1 1-1.07 1.05A2.5 2.5 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.71A2.5 2.5 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.09a.25.25 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/>`,
    ),
  },
  worktree: {
    glyph: '◇',
    source: svg(
      `<path fill="${PURPLE}" d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.12a2.25 2.25 0 1 0-1.5 0v5.26a2.25 2.25 0 1 0 1.5 0V9.5A2.5 2.5 0 0 1 7.5 7h1A3.99 3.99 0 0 0 12.25 4.9a2.25 2.25 0 1 0-1.5-.04A2.49 2.49 0 0 1 8.5 5.5h-1c-.95 0-1.82.33-2.5.88Zm7.25-1.37a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM4.25 12a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Z"/>`,
    ),
  },
  submodule: {
    glyph: '◈',
    source: svg(
      `<path fill="${BLUE}" d="M0 1.75C0 .78.78 0 1.75 0h12.5C15.22 0 16 .78 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .14.11.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25ZM5 5h6v6H5Z"/>`,
    ),
  },
  branch: {
    glyph: '⎇',
    source: svg(
      `<path fill="${BLUE}" d="M9.5 3.25a2.25 2.25 0 1 1 3 2.12V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.13a2.25 2.25 0 1 1-1.5 0V5.37a2.25 2.25 0 1 1 1.5 0v1.84A2.49 2.49 0 0 1 6 7h4a1 1 0 0 0 1-1v-.63A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>`,
    ),
  },
  warning: {
    glyph: '⚠',
    source: svg(
      `<path fill="${YELLOW}" d="M6.46 1.4a1.75 1.75 0 0 1 3.08 0l6.27 11.15A1.75 1.75 0 0 1 14.27 15H1.73a1.75 1.75 0 0 1-1.54-2.45ZM8 5a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0v-3.5A.75.75 0 0 0 8 5Zm0 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/>`,
    ),
  },
}

/**
 * A thin stacked bar: clean, changed and to-sync repositories as a share of all.
 * Drawn as an image that stretches to the pane's width.
 */
export const statusBar = (clean: number, changed: number, unsynced: number): string => {
  const total = clean + changed + unsynced
  const open = '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="4" viewBox="0 0 100 4" preserveAspectRatio="none">'
  if (total === 0) return `${open}<rect width="100" height="4" fill="${GRAY}" opacity=".35"/></svg>`
  const parts: [number, string][] = [
    [clean, '#3fb950'],
    [changed, YELLOW],
    [unsynced, BLUE],
  ]
  let x = 0
  const rects = parts
    .filter(([n]) => n > 0)
    .map(([n, color]) => {
      const w = (n / total) * 100
      const r = `<rect x="${x.toFixed(2)}" width="${w.toFixed(2)}" height="4" fill="${color}"/>`
      x += w
      return r
    })
    .join('')
  // a large intrinsic width: the image box takes it capped at the slot, so the bar spans the pane
  return `${open}${rects}</svg>`
}
