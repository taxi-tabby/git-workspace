// Every string the pane shows, in English (the default) and Korean.
// The `language` option in the plugin's settings picks one.

export type Lang = 'en' | 'ko'

export const toLang = (value: unknown): Lang => (value === 'ko' ? 'ko' : 'en')

const en = {
  title: 'Git Workspace',
  commandDescription: 'Open the Git Workspace pane (give a folder path to scan that folder)',
  commandOpened: (root: string) => `Opened the Git Workspace pane. Scanning: ${root}`,

  // repository status
  skippedUnchecked: "Skipped change status: couldn't read the repository's config",
  skippedFilters: (names: string) => `Skipped change status: the repository sets its own filter drivers (${names})`,
  statusFailed: 'git status failed',
  noCommits: '(no commits)',
  folderMissing: (root: string) => `Folder not found: ${root}`,
  local: 'local',

  // header
  computing: '(working…)',
  sessionFolder: 'session folder',
  changedOnly: 'Changed',
  repos: (n: number) => `${n} ${n === 1 ? 'repo' : 'repos'}`,
  changed: (n: number) => `${n} changed`,
  unsynced: (n: number) => `${n} to sync`,
  scanning: 'scanning…',
  truncated: (n: number) => `Stopped after ${n} folders. Lower the depth or scan a subfolder.`,

  // folded rows
  reposBelow: (n: number) => `${n} ${n === 1 ? 'repo' : 'repos'}`,
  changedBelow: (n: number) => `${n} changed`,

  // row actions
  setRoot: '⤴ Scan here',
  copy: '⧉ Copy path',

  // git banner
  gitMissingTitle: "⚠ git wasn't found",
  gitMissingBody: 'Showing where repositories are, without their status. Install git, add it to PATH, then check again.',
  gitOldTitle: (version: string, min: string) => `⚠ git ${version} is too old (${min} or newer needed)`,
  gitOldBody: 'Showing branches without changed files. Update git, then check again.',
  gitDownload: 'Download git (git-scm.com)',
  checkAgain: 'Check again',

  // menu
  scanRoot: 'Scan folder',
  rootPlaceholder: 'Folder path (e.g. D:\\projects or ~/code)',
  apply: 'Apply',
  rootCommandHint: '/git-workspace <folder path>',
  sessionFolderButton: 'Session folder',
  parentFolderButton: 'Parent folder',
  recent: 'Recent',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  depth: 'Depth',
  legendKinds: '◆ repo ▪ folder · ↑ to push ↓ to pull · local = no upstream',
  legendChanges: '+ staged ~ modified ? untracked ! conflict · ✓ clean · ⚠ status skipped',
  legendHover: 'Hover a row: ⤴ scan from there · ⧉ copy its path',
  gitVersion: (version: string) => (version ? `git ${version}` : 'git not found'),

  // empty states
  noChildRepos: 'No repositories below this one.',
  noRepos: (depth: number) => `No git repositories within ${depth} ${depth === 1 ? 'level' : 'levels'}.`,
  noChangedRepos: 'No repositories with changes.',

  // section headings and redesign bits
  sectionWorkspace: 'WORKSPACE',
  sectionRepos: 'REPOSITORIES',
  sectionScanFolder: 'SCAN FOLDER',
  sectionRecent: 'RECENT',
  sectionView: 'VIEW',
  sectionLegend: 'LEGEND',
  statusBarAlt: (clean: number, changed: number, unsynced: number) =>
    `${clean} clean, ${changed} changed, ${unsynced} to sync`,
  refresh: 'Refresh',
  menu: 'Settings',
  closeMenu: 'Close settings',
  copied: (text: string) => `Copied ${text}`,
  // repository details
  ago: ({ value, unit }: { value: number; unit: 'm' | 'h' | 'd' }) =>
    value === 0 && unit === 'm' ? 'just now' : `${value} ${{ m: 'min', h: 'h', d: 'd' }[unit]} ago`,
  showDetails: 'Show details',
  hideDetails: 'Hide details',
  loading: 'Reading…',
  toPull: (n: number) => `↓ ${n} to pull`,
  toPush: (n: number) => `↑ ${n} to push`,
  upToDate: (upstream: string) => `Up to date with ${upstream}`,
  noUpstream: 'No upstream — the branch is not published',
  diverged: 'Diverged: pull before you push',
  fetchedAgo: (age: string) => `as of the last fetch, ${age}`,
  neverFetched: 'never fetched — run git fetch to see what is new upstream',
  detachedHead: 'Detached HEAD — not on a branch',
  noCommitsYet: 'No commits yet',
  networkGitdir: 'Skipped: its git folder is on a network path',
  sectionIncoming: 'TO PULL',
  sectionOutgoing: 'TO PUSH',
  sectionChanges: 'CHANGES',
  sectionRecentCommits: 'RECENT COMMITS',
  moreFiles: (n: number) => `+${n} more`,
  stashes: (n: number) => `${n} ${n === 1 ? 'stash' : 'stashes'}`,
  moreCommits: (n: number) => `${n}+ commits`,
  legendIcon: { repo: 'repo', folder: 'folder', worktree: 'worktree', submodule: 'submodule', branch: 'branch' } as Record<'repo' | 'folder' | 'worktree' | 'submodule' | 'branch', string>,
}

export type Strings = typeof en

const ko: Strings = {
  title: 'Git 워크스페이스',
  commandDescription: 'Git 워크스페이스 패널 열기 (인자로 폴더 경로를 주면 그 폴더를 스캔)',
  commandOpened: root => `Git 워크스페이스 패널을 열었습니다. 스캔 루트: ${root}`,

  skippedUnchecked: '저장소 설정을 확인하지 못해 변경 상태 조회를 건너뜀',
  skippedFilters: names => `저장소 설정의 filter 드라이버(${names}) 때문에 변경 상태 조회를 건너뜀`,
  statusFailed: 'git status 실패',
  noCommits: '(커밋 없음)',
  folderMissing: root => `폴더가 없습니다: ${root}`,
  local: '로컬',

  computing: '(계산 중)',
  sessionFolder: '세션 폴더',
  changedOnly: '변경만',
  repos: n => `저장소 ${n}`,
  changed: n => `변경 ${n}`,
  unsynced: n => `동기화 ${n}`,
  scanning: '스캔 중…',
  truncated: n => `폴더가 많아 ${n}개까지만 살펴봤습니다. 깊이를 줄이거나 하위 폴더를 루트로 지정하세요.`,

  reposBelow: n => `저장소 ${n}`,
  changedBelow: n => `변경 ${n}`,

  setRoot: '⤴ 루트로',
  copy: '⧉ 복사',

  gitMissingTitle: '⚠ git을 찾을 수 없습니다',
  gitMissingBody: '저장소 위치만 표시합니다. Git을 설치하고 PATH에 추가한 뒤 다시 확인하세요.',
  gitOldTitle: (version, min) => `⚠ git ${version}은 너무 오래된 버전입니다 (${min} 이상 필요)`,
  gitOldBody: '브랜치만 표시하고 변경 상태는 건너뜁니다. Git을 업데이트한 뒤 다시 확인하세요.',
  gitDownload: 'git 내려받기 (git-scm.com)',
  checkAgain: '다시 확인',

  scanRoot: '스캔 루트',
  rootPlaceholder: '폴더 경로 (예: D:\\projects)',
  apply: '적용',
  rootCommandHint: '/git-workspace <폴더 경로>',
  sessionFolderButton: '세션 폴더',
  parentFolderButton: '상위 폴더',
  recent: '최근',
  expandAll: '모두 펼치기',
  collapseAll: '모두 접기',
  depth: '깊이',
  legendKinds: '◆ 저장소 ▪ 폴더 · ↑ 보낼 커밋 ↓ 받을 커밋 · 로컬 = upstream 없음',
  legendChanges: '+ 스테이지 ~ 수정 ? 새 파일 ! 충돌 · ✓ 깨끗함 · ⚠ 상태 조회 건너뜀',
  legendHover: '행에 마우스를 올리면: ⤴ 거기서 스캔 · ⧉ 경로 복사',
  gitVersion: version => (version ? `git ${version}` : 'git 없음'),

  noChildRepos: '하위 저장소가 없습니다.',
  noRepos: depth => `깊이 ${depth} 안에 git 저장소가 없습니다.`,
  noChangedRepos: '변경된 저장소가 없습니다.',

  sectionWorkspace: '워크스페이스',
  sectionRepos: '저장소',
  sectionScanFolder: '스캔 폴더',
  sectionRecent: '최근',
  sectionView: '보기',
  sectionLegend: '범례',
  statusBarAlt: (clean, changed, unsynced) => `깨끗함 ${clean}, 변경 ${changed}, 동기화 ${unsynced}`,
  refresh: '새로고침',
  menu: '설정',
  closeMenu: '설정 닫기',
  copied: text => `복사함: ${text}`,
  ago: ({ value, unit }) => (value === 0 && unit === 'm' ? '방금' : `${value}${{ m: '분', h: '시간', d: '일' }[unit]} 전`),
  showDetails: '자세히 보기',
  hideDetails: '접기',
  loading: '읽는 중…',
  toPull: n => `↓ 받을 커밋 ${n}`,
  toPush: n => `↑ 보낼 커밋 ${n}`,
  upToDate: upstream => `${upstream}와 같음`,
  noUpstream: 'upstream 없음 — 아직 원격에 올리지 않은 브랜치',
  diverged: '갈라짐: push 전에 pull이 필요합니다',
  fetchedAgo: age => `마지막 fetch 기준 (${age})`,
  neverFetched: 'fetch 기록 없음 — git fetch로 원격의 새 커밋을 확인하세요',
  detachedHead: 'Detached HEAD — 브랜치가 아님',
  noCommitsYet: '아직 커밋 없음',
  networkGitdir: '건너뜀: git 폴더가 네트워크 경로에 있음',
  sectionIncoming: '받을 커밋',
  sectionOutgoing: '보낼 커밋',
  sectionChanges: '변경 파일',
  sectionRecentCommits: '최근 커밋',
  moreFiles: n => `외 ${n}개`,
  stashes: n => `stash ${n}개`,
  moreCommits: n => `${n}개 이상`,
  legendIcon: { repo: '저장소', folder: '폴더', worktree: '워크트리', submodule: '서브모듈', branch: '브랜치' },
}

export const STRINGS: Record<Lang, Strings> = { en, ko }
