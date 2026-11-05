// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Parameter handling, job document and log rewriting of the NEOS run.
 * Port of GAMS Studio src/neos/neosprocess.cpp (compileParameters, remoteParameters,
 * solverToCategories, convertReferences, parseUnzipStdOut), src/neos/neosmanager.cpp (mRawJob)
 * and src/neos/neosstartdialog.cpp (validateEmail).
 * Pure module: no vscode imports.
 * Original: Copyright (c) 2017-2026 GAMS Software GmbH / GAMS Development Corp., GPL-3.0-or-later.
 */
import * as path from 'path';
import { buildGamsArgs } from '../run/gamsProcess';
import { escapeXml } from './xmlrpc';

export type NeosPriority = 'short' | 'long';

const lower = (p: string): string => p.toLowerCase();
const is = (p: string, ...keys: string[]): boolean => keys.some((k) => lower(p).startsWith(k + '='));

/**
 * Arguments of the local preparation run (NeosProcess::compileParameters): the normal GAMS
 * arguments (gms file first) with action=c, xsave="<stem>" and previousWork=1 enforced.
 * Studio overrides a user supplied action/xsave and keeps a user previousWork.
 */
export function compileArgs(gmsFile: string, userParams: string[], stem: string): string[] {
  const params = buildGamsArgs(gmsFile, userParams, false);
  let needsXSave = true;
  let needsActC = true;
  let hasPw = false;
  const out = params.map((p) => {
    if (is(p, 'xsave', 'xs')) { needsXSave = false; return `xsave="${stem}"`; }
    if (is(p, 'action', 'a')) { needsActC = false; return 'action=c'; }
    if (is(p, 'previouswork')) hasPw = true;
    return p;
  });
  if (needsXSave) out.push(`xsave="${stem}"`);
  if (!hasPw) out.push('previousWork=1');
  if (needsActC) out.push('action=c');
  return out;
}

/**
 * Parameter string sent to NEOS (NeosProcess::remoteParameters): the run's arguments without
 * the gms file, action, reference, xsave, previousWork and gdx; `gdx=default` is added when
 * a GDX file is forced. `hasGdx` (forced or user gdx=) becomes the job's wantgdx.
 */
export function remoteArgs(gmsFile: string, userParams: string[], forceGdx: boolean): { params: string[]; hasGdx: boolean } {
  const all = buildGamsArgs(gmsFile, userParams, false).slice(1);
  let hasGdx = forceGdx;
  let needsGdx = forceGdx;
  const params = all.filter((p) => {
    if (is(p, 'action', 'a', 'reference', 'rf', 'xsave', 'xs', 'previouswork')) return false;
    if (is(p, 'gdx')) { hasGdx = true; needsGdx = false; return false; }
    return true;
  });
  if (needsGdx) params.push('gdx=default');
  return { params, hasGdx };
}

/** Solvers and their model types from `gmscmpun.txt` (solver capability file, header documented in the file). */
export function parseSolverCapabilities(text: string): Map<string, string[]> {
  const res = new Map<string, string[]>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('*') || l.trim() === '') continue;
    if (l.trim().toUpperCase() === 'DEFAULTS') break;
    const t = l.trim().split(/\s+/);
    const follow = parseInt(t[6] ?? '', 10);
    if (t.length < 7 || Number.isNaN(follow)) continue;
    res.set(t[0].toLowerCase(), t.slice(7));
    i += follow;
  }
  return res;
}

/**
 * NeosProcess::solverToCategories: replace `solver=X` by one `<modelType>=X` per model type X
 * supports (NEOS selects the solver per category), dropping categories the user already set.
 * An unknown solver yields no categories, i.e. the parameter is removed (as in Studio).
 * Studio asks the GAMS configuration library (user config included); we read the sysdir's gmscmpun.txt.
 */
export function solverToCategories(params: string[], caps: Map<string, string[]>): string[] {
  const out = [...params];
  for (let i = 0; i < out.length; i++) {
    if (!is(out[i], 'solver')) continue;
    const solver = out[i].split('=').pop() ?? '';
    const types = caps.get(solver.toLowerCase()) ?? [];
    let cats = types.map((t) => `${t}=${solver}`);
    for (const p of params) {
      const pre = p.split('=')[0].toLowerCase() + '=';
      cats = cats.filter((c) => !lower(c).startsWith(pre));
    }
    if (cats.length === 0) out.splice(i--, 1);
    else { out.splice(i, 1, ...cats); i += cats.length - 1; }
  }
  return out;
}

/** CDATA with a split for a literal "]]>". */
function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

/** NeosManager::mRawJob filled as in NeosManager::submitJob. */
export function buildJobXml(g00: Buffer, params: string, priority: NeosPriority, wantGdx: boolean, email: string): string {
  return `
<document>
<category>milp</category>
<solver>cbc</solver>
<inputType>GAMS</inputType>
<email>${escapeXml(email)}</email>
<priority>${priority}</priority>
<model><![CDATA[]]></model>
<options><![CDATA[]]></options>
<parameters>${cdata(params)}</parameters>
<restart><base64>${g00.toString('base64')}</base64></restart>
<wantlog><![CDATA[yes]]></wantlog>
<wantlst><![CDATA[yes]]></wantlst>
<wantgdx>${cdata(wantGdx ? 'yes' : '')}</wantgdx>
</document>
`;
}

/** NeosStartDialog::validateEmail. Empty string = valid. */
export function validateEmail(email: string): string {
  const s = email.trim();
  if (s === '') return 'Set "gams.neos.email" to your email address (NEOS requires one).';
  const invalid = 'Invalid email.';
  if (s.indexOf(' ') > 0 || s.indexOf('\t') > 0) return invalid;
  const at = s.indexOf('@');
  if (at < 1) return invalid;
  const dot = s.indexOf('.', at + 2);
  if (dot < 0 || dot === s.length - 1) return invalid;
  return '';
}

const REMOTE_PATH = /\/var\/lib\/condor\/execute\/dir_\d+\/gamsexec\/(MODEL\.)?/g;
const LOG_CLONE = '%% GAMS LOGFILE %%%%';

/**
 * NeosProcess::convertReferences. Rewrites the remote log: the NEOS execute directory becomes
 * the local output directory (`.../gamsexec/MODEL.` => `<out>.`), `[LST:` becomes `[LS2:` (link to
 * solve.lst) and everything from the "%% GAMS LOGFILE %%%%" marker on is dropped (the log is
 * repeated there). Studio converts each received chunk on its own; this converter buffers
 * incomplete lines so a pattern split across two chunks is still found.
 */
export class RefConverter {
  private inLogClone = false;
  private pending = '';

  constructor(private readonly outPath: string) {}

  /**
   * Studio only rewrites the execute directory and `[LST:` (NeosProcess::convertReferences). The remote text is
   * untrusted: every other link tag (`[FIL:"..."`, `[DIR:`, `[REF:`, `[ERR:`, `[LS2:`, ...) would become a clickable
   * link to an arbitrary local file, so it is neutralized with a zero-width space. The one exception are `[FIL:"`
   * tags whose target lies in the local output directory after the path rewrite (what Studio's rewrite produces).
   */
  private convertLine(line: string): string {
    const rewritten = line.replace(REMOTE_PATH, (_m, model: string | undefined) => this.outPath + (model ? '.' : path.sep));
    return rewritten.replace(/\[([A-Z][A-Z0-9]{2}):/g, (m, code: string, off: number) => {
      if (code === 'LST') return '[LS2:';
      if (code === 'FIL') {
        const target = rewritten.substring(off + 6);
        if (target.startsWith(this.outPath) && /^[./\\\\]/.test(target.substring(this.outPath.length)) && !target.substring(this.outPath.length).split('"')[0].includes('..')) return m;
      }
      return `[\u200b${code}:`;
    });
  }

  /** Feed text; returns complete converted lines (with their newline). */
  push(text: string): string {
    if (this.inLogClone) return '';
    this.pending += text;
    let res = '';
    let idx: number;
    while (!this.inLogClone && (idx = this.pending.indexOf('\n')) >= 0) {
      res += this.take(this.pending.substring(0, idx + 1));
      this.pending = this.pending.substring(idx + 1);
    }
    return res;
  }

  /** Flush an unterminated last line. */
  end(): string {
    const rest = this.inLogClone ? '' : this.pending;
    this.pending = '';
    return rest ? this.take(rest) : '';
  }

  private take(line: string): string {
    const i = line.indexOf(LOG_CLONE);
    if (i >= 0) {
      this.inLogClone = true;
      this.pending = '';
      return this.convertLine(line.substring(0, i));
    }
    return this.convertLine(line);
  }
}

/**
 * NeosProcess::parseUnzipStdOut for one gmsunzip output line: extracted files become
 * `--- extracting: .<sep><folder><sep><file>[FIL:"<outPath><sep><file>",0,0]` (clickable), .lxi are
 * skipped, other output is passed through.
 */
export function unzipLogLine(line: string, outPath: string): string {
  if (line.startsWith(' extracting: ') || line.startsWith('  inflating: ')) {
    const t = line.trim();
    const file = path.sep + t.substring(t.indexOf(':') + 2);
    const folder = path.sep + path.basename(outPath);
    if (file.endsWith('lxi')) return `--- skipping: .${folder}${file}`;
    return `--- extracting: .${folder}${file}[FIL:"${outPath}${file}",0,0]`;
  }
  return line;
}

export const NEOS_TERMS_URL = 'https://neos-server.org/neos/termofuse.html';

/** Pure consent decision: skipping the dialog is only allowed for the very server the user consented to. */
export function maySkipConfirmation(accepted: boolean, dontAskServer: unknown, server: string): boolean {
  return accepted && typeof dontAskServer === 'string' && dontAskServer === server;
}

/** Only the user-level (global) value counts: a workspace .vscode/settings.json must not redirect submissions. */
export function userSetting<T>(cfg: { inspect<T>(key: string): { globalValue?: T; defaultValue?: T } | undefined }, key: string, fallback: T): T {
  const v = cfg.inspect<T>(key)?.globalValue;
  return v === undefined ? (cfg.inspect<T>(key)?.defaultValue ?? fallback) : v;
}
