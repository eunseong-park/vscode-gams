// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Documentation location rules. Pure node (no vscode imports).
 * Port of GAMS Studio `src/help/helpdata.h` (HelpData) and the URL resolution in
 * `src/help/helpwidget.cpp` (`HelpWidget::on_helpContentRequested`, `getOnlineStartPageUrl`).
 */
import * as fs from 'fs';
import * as path from 'path';

/** Studio `help::DocumentType` (subset the extension reaches). */
export type DocumentType = 'Main' | 'DollarControl' | 'GamsCall' | 'Solvers' | 'Index' | 'StudioMain' | 'Connect' | 'Search';

/** Studio `HelpData::chapterLocation()` (file names below the docs directory). */
export const CHAPTER: Record<string, string> = {
  Main: 'index.html',
  ReleaseNotes: 'RN_MAIN.html',
  DollarControl: 'UG_DollarControlOptions.html',
  GamsCall: 'UG_GamsCall.html',
  Options: 'UG_OptionStatement.html',
  SolversMain: 'S_MAIN.html',
  APIsMain: 'API_MAIN.html',
  ToolsMain: 'T_MAIN.html',
  Index: 'keyword.html',
  StudioMain: 'T_STUDIO.html',
  Connect: 'UG_GAMSCONNECT.html',
  Search: 'search.html',
};

/** Studio `HelpData::studioSectionName()`. */
export const STUDIO_SECTION = {
  WelcomePage: 'Welcome Page',
  ProjectExplorer: 'Project Explorer',
  ListingViewer: 'Listing Viewer',
  GDXDiff: 'GDXDiff',
  GDXViewer: 'GDX Viewer',
  SearchAndReplace: 'Search and Replace',
  ReferenceFileViewer: 'Reference File Viewer',
  SolverOptionEditor: 'Solver Option Editor',
  GamsUserConfigEditor: 'GAMS Configuration Editor',
  OptionEditor: 'Option Editor',
  ProcessLog: 'Process Log',
  ParameterFile: 'Parameter File',
  ConnectEditor: 'Connect Editor',
  EFIEditor: 'GAMS Engine',
} as const;

/** `HelpData::getGamsCallOptionAnchor` */
export function gamsCallOptionAnchor(keyword: string): string {
  return keyword === '' ? '' : 'GAMSAO' + keyword.toLowerCase();
}

/** `HelpData::getDollarControlOptionAnchor` (on/off pairing: `offX` and `onX` share the `DOLLARonoffX` anchor). */
export function dollarControlOptionAnchor(keyword: string): string {
  if (keyword === '') return '';
  const lower = keyword.toLowerCase();
  if (lower.startsWith('off')) return 'DOLLARon' + lower;
  if (lower.startsWith('on')) return 'DOLLARonoff' + lower.slice(2);
  return 'DOLLAR' + lower;
}

/** `HelpData::getKeywordIndexAnchor` (a query string, not a fragment). */
export function keywordIndexQuery(keyword: string): string {
  return 'q=' + keyword.toLowerCase();
}

/** `HelpData::getSolverOptionAnchor`; `alias` is the solver's option-definition alias (see `solverAlias`). */
export function solverOptionAnchor(solver: string, keyword: string, alias?: string): string {
  if (keyword === '') return '';
  const str = keyword.replace(/ /g, '_').replace(/\//g, '_').replace(/\./g, 'DOT');
  return (alias ?? solver).toUpperCase() + str;
}

/** `HelpData::getStudioSectionAnchor` (`simplified()` = trim + collapse whitespace). */
export function studioSectionAnchor(section: string): string {
  if (section === '') return '';
  return 'STUDIO_' + section.toUpperCase().trim().replace(/\s+/g, ' ').replace(/ /g, '_');
}

/** `HelpData::getConnectAnchor` */
export function connectAnchor(agent: string, attribute?: string): string {
  if (agent === '') return '';
  return attribute ? `${agent.toUpperCase()}_${attribute.toUpperCase()}` : agent.toUpperCase();
}

/** `HelpData::getSearchQuery` (Qt `toPercentEncoding` leaves unreserved chars `A-Za-z0-9-._~`). */
export function searchQuery(keyword: string): string {
  const s = keyword.trim().replace(/\s+/g, ' ');
  if (s === '') return '';
  return 'q=' + encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export interface HelpRequest {
  type: DocumentType;
  keyword?: string;
  /** Solver name (type Solvers), Studio section name (StudioMain) or attribute (Connect). */
  submodule?: string;
}

export interface HelpTarget {
  /** File name relative to the docs directory, e.g. `UG_GamsCall.html`. */
  page: string;
  query?: string;
  fragment?: string;
}

export interface ResolveEnv {
  /** Does a page exist (offline: file in docs dir). Default: yes. */
  pageExists?: (page: string) => boolean;
  /** Option definition alias of the solver (`conopt4` -> `conopt`). */
  solverAlias?: (solver: string) => string | undefined;
  /** Map an option anchor to the exact id spelling used by the page (offline), `undefined` if unknown. */
  resolveId?: (page: string, anchor: string) => string | undefined;
}

/** `HelpData::getSolverChapterLocation`: `S_<ALIAS|NAME>.html`, `S_MAIN.html` when the solver has no page. */
export function solverChapter(solver: string, env: ResolveEnv = {}): string {
  const alias = env.solverAlias?.(solver.toLowerCase());
  const page = `S_${(alias ?? solver).toUpperCase()}.html`;
  return (env.pageExists ?? (() => true))(page) ? page : CHAPTER['SolversMain'];
}

/** Port of `HelpWidget::on_helpContentRequested`: request -> page + query/fragment. */
export function resolveHelp(req: HelpRequest, env: ResolveEnv = {}): HelpTarget {
  const keyword = req.keyword ?? '';
  const sub = req.submodule ?? '';
  const frag = (page: string, f: string): HelpTarget => (f ? { page, fragment: f } : { page });
  switch (req.type) {
    case 'DollarControl':
      return frag(CHAPTER['DollarControl'], dollarControlOptionAnchor(keyword));
    case 'GamsCall':
      return frag(CHAPTER['GamsCall'], gamsCallOptionAnchor(keyword));
    case 'Index':
      return { page: CHAPTER['Index'], query: keywordIndexQuery(keyword) };
    case 'Solvers': {
      const page = solverChapter(sub, env);
      let f: string;
      if (keyword === '') f = studioSectionAnchor(sub);
      else {
        f = solverOptionAnchor(sub, keyword, env.solverAlias?.(sub.toLowerCase()));
        f = env.resolveId?.(page, f) ?? f;
      }
      return frag(page, f);
    }
    case 'StudioMain':
      return frag(CHAPTER['StudioMain'], studioSectionAnchor(sub));
    case 'Connect':
      return frag(CHAPTER['Connect'], connectAnchor(keyword, sub));
    case 'Search': {
      const q = searchQuery(keyword);
      return q ? { page: CHAPTER['Search'], query: q } : { page: CHAPTER['Search'] };
    }
    default:
      return { page: CHAPTER['Main'] };
  }
}

/** Studio `getOnlineStartPageUrl`: `https://www.gams.com/<major>/` (major >= 26) or `<major.minor>` (older). */
export function onlineBase(version: string | undefined): string {
  const m = /^(\d+)\.(\d+)/.exec(version ?? '');
  if (!m) return 'https://www.gams.com/latest/';
  return Number(m[1]) >= 26 ? `https://www.gams.com/${m[1]}/` : `https://www.gams.com/${m[1]}.${m[2]}/`;
}

/** GAMS version of a system directory from its folder name (`gams54.6_<platform>`, `C:\GAMS\54`). */
export function versionFromSysdir(sysdir: string): string | undefined {
  const base = path.basename(sysdir.replace(/[\\/]+$/, ''));
  const m = /(?:gams)?(\d+)(?:\.(\d+))?/i.exec(base);
  return m ? `${m[1]}.${m[2] ?? '0'}` : undefined;
}

function targetSuffix(t: HelpTarget): string {
  return (t.query ? '?' + t.query : '') + (t.fragment ? '#' + t.fragment : '');
}

/** Online URL of a target (Studio maps `<local>/docs/X` to `<base>docs/X`). */
export function onlineUrl(t: HelpTarget, version: string | undefined): string {
  return onlineBase(version) + 'docs/' + t.page + targetSuffix(t);
}

/** Relative path `page?query#fragment` below the docs directory. */
export function relativeUrl(t: HelpTarget): string {
  return t.page + targetSuffix(t);
}

// ---- reading the installed docs (read-only) ----

const idCache = new Map<string, { mtime: number; ids: Map<string, string> }>();

/** Lower-case id -> id as spelled in the page (`id=` / `name=` attributes). */
export function pageIds(file: string): Map<string, string> {
  try {
    const mtime = fs.statSync(file).mtimeMs;
    const hit = idCache.get(file);
    if (hit && hit.mtime === mtime) return hit.ids;
    const ids = new Map<string, string>();
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/\b(?:id|name)="([^"]+)"/g)) {
      if (!ids.has(m[1].toLowerCase())) ids.set(m[1].toLowerCase(), m[1]);
    }
    idCache.set(file, { mtime, ids });
    return ids;
  } catch {
    return new Map();
  }
}

/** Whether `anchor` exists (case-insensitively) in `docsDir/page`. */
export function anchorExists(docsDir: string, page: string, anchor: string): boolean {
  return pageIds(path.join(docsDir, page)).has(anchor.toLowerCase());
}

/**
 * Solver -> option definition alias: Studio compares `opt<solver>.def` with the cfg library's definition file name
 * (`SolverConfigInfo::solverAliasNames`). Without the cfg library we use the longest `opt<prefix>.def` in the sysdir
 * that is a prefix of the solver name (`conopt4` -> `conopt`, `gurobiold` -> `gurobi`).
 */
export function solverAliasFromSysdir(sysdir: string): (solver: string) => string | undefined {
  let defs: string[] | undefined;
  return (solver) => {
    if (!defs) {
      try {
        defs = fs
          .readdirSync(sysdir)
          .map((f) => /^opt(.+)\.def$/i.exec(f)?.[1]?.toLowerCase())
          .filter((x): x is string => !!x);
      } catch {
        defs = [];
      }
    }
    const s = solver.toLowerCase();
    if (defs.includes(s)) return undefined;
    const cand = defs.filter((d) => s.startsWith(d)).sort((a, b) => b.length - a.length)[0];
    return cand;
  };
}

const optNameCache = new Map<string, { mtime: number; set: Set<string> }>();

/**
 * Normalized names (lower case, `_` -> space) and synonyms defined in the solver's `opt<solver>.def`
 * (aliased as in `solverAliasFromSysdir`). Option files may spell multi-word names with spaces
 * (`major iterations limit 5`); the longest match decides the option (Studio uses the full option name).
 */
export function solverOptionNames(sysdir: string, solver: string): Set<string> {
  const s = solver.toLowerCase();
  const alias = solverAliasFromSysdir(sysdir)(s) ?? s;
  const file = path.join(sysdir, `opt${alias}.def`);
  try {
    const mtime = fs.statSync(file).mtimeMs;
    const hit = optNameCache.get(file);
    if (hit && hit.mtime === mtime) return hit.set;
    const set = new Set<string>();
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (line === '' || /^[\s*]/.test(line) || /^\S+\s+lookup\s*$/.test(line)) continue;
      const name = /^(\S+)/.exec(line)?.[1];
      if (name) set.add(name.toLowerCase().replace(/_/g, ' '));
    }
    optNameCache.set(file, { mtime, set });
    return set;
  } catch {
    return new Set();
  }
}

/** Environment for resolving against an installed docs directory. */
export function docsEnv(sysdir: string): ResolveEnv {
  const docs = path.join(sysdir, 'docs');
  return {
    pageExists: (p) => fs.existsSync(path.join(docs, p)),
    solverAlias: solverAliasFromSysdir(sysdir),
    resolveId: (page, anchor) => pageIds(path.join(docs, page)).get(anchor.toLowerCase()),
  };
}

const kwCache = new Map<string, { mtime: number; set: Set<string> }>();

/** Lower-case keywords listed in `docs/keyword.html` (first column, linked rows). */
export function keywordIndex(docsDir: string): Set<string> {
  const file = path.join(docsDir, CHAPTER['Index']);
  try {
    const mtime = fs.statSync(file).mtimeMs;
    const hit = kwCache.get(file);
    if (hit && hit.mtime === mtime) return hit.set;
    const set = new Set<string>();
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/<td>\s*<a href="[^"]*">([^<]+)<\/a>/g)) set.add(m[1].trim().toLowerCase());
    kwCache.set(file, { mtime, set });
    return set;
  } catch {
    return new Set();
  }
}

export function docsDirOf(sysdir: string | undefined): string | undefined {
  if (!sysdir) return undefined;
  const d = path.join(sysdir, 'docs');
  return fs.existsSync(path.join(d, CHAPTER['Main'])) ? d : undefined;
}
