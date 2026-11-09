// Checks a pull request's description against .github/PULL_REQUEST_TEMPLATE.md.
//
//   node .github/scripts/check-pr-body.mjs            reads the body from $PR_BODY
//   node .github/scripts/check-pr-body.mjs file.md    reads it from a file
//
// Exits 1, listing every problem, when the body does not follow the template:
//   - the three sections, as `## ` headings, in the template's order
//   - "What and why" says something (HTML comments don't count)
//   - every checklist item of the template is there, and each one is ticked `[x]`
//     or marked N/A on its line
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const SECTIONS = ['What and why', 'How it was checked', 'Before merging']

// the checklist items, by a phrase each one must still contain
export const ITEMS = [
  ['How it was checked', 'claude plugin validate'],
  ['How it was checked', 'claude plugin test'],
  ['How it was checked', 'Looked at the pane'],
  ['Before merging', 'version'],
  ['Before merging', 'README'],
  ['Before merging', 'SAFE_GIT_ARGS'],
]

const stripComments = text => text.replace(/<!--[\s\S]*?(-->|$)/g, '')

/** The body's `## ` sections, by heading, in order. */
export function sections(body) {
  const out = []
  let current = null
  for (const line of stripComments(body.replace(/\r\n?/g, '\n')).split('\n')) {
    const m = /^##\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) {
      current = { title: m[1], lines: [] }
      out.push(current)
    } else if (current) current.lines.push(line)
  }
  return out
}

/** Every problem with the body; empty when it follows the template. */
export function problems(body) {
  if (!body || !body.trim()) return ['The description is empty. Fill in the pull request template.']
  const found = sections(body)
  const errors = []
  const byTitle = new Map(found.map(s => [s.title.toLowerCase(), s]))

  let last = -1
  for (const title of SECTIONS) {
    const index = found.findIndex(s => s.title.toLowerCase() === title.toLowerCase())
    if (index < 0) errors.push(`Missing the "## ${title}" section.`)
    else if (index < last) errors.push(`"## ${title}" is out of order; keep the template's order.`)
    else last = index
  }

  const what = byTitle.get(SECTIONS[0].toLowerCase())
  if (what && what.lines.join('').trim().length < 10) {
    errors.push(`"## ${SECTIONS[0]}" is empty: say what this changes and why.`)
  }

  for (const [title, phrase] of ITEMS) {
    const section = byTitle.get(title.toLowerCase())
    if (!section) continue
    const line = section.lines.find(l => /^\s*[-*]\s+\[[ xX]\]/.test(l) && l.toLowerCase().includes(phrase.toLowerCase()))
    if (!line) errors.push(`"## ${title}" is missing the checklist item about "${phrase}".`)
    else if (!/^\s*[-*]\s+\[[xX]\]/.test(line) && !/\bN\/A\b/i.test(line)) {
      errors.push(`Not ticked: "${line.trim().replace(/^[-*]\s+\[ \]\s*/, '')}" (tick it, or write N/A on its line).`)
    }
  }
  return errors
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const body = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : (process.env.PR_BODY ?? '')
  const errors = problems(body)
  if (errors.length) {
    for (const e of errors) console.log(`::error title=PR description::${e}`)
    console.log(`\nThe description does not follow .github/PULL_REQUEST_TEMPLATE.md (${errors.length} problem(s)).`)
    console.log('Edit the description; this check runs again on every edit.')
    process.exit(1)
  }
  console.log('The description follows the template.')
}
