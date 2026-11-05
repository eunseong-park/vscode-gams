// SPDX-License-Identifier: GPL-3.0-or-later
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { releaseGdx } from '../../lsp';
import { detectSysdir, gamsEnvironment } from '../../sysdir';
import { currentSysdirCheck, reportSysdirProblem } from '../../sysdirUi';
import {
  DEFAULT_DIFF_FILE, DIFF_FIELDS, DiffField, GdxDiffOptions, defaultDiffOptions, gdxDiffArgs, normalizeDiffOptions,
  parseDiffOutput, prepopulateDiff, resolveDiffFile, validateDiffInputs,
} from './diffArgs';
const GDX_VIEW_TYPE = 'gams.gdxViewer';

export const GDX_DIFF_COMMAND = 'gams.gdxDiff';

let channel: vscode.OutputChannel | undefined;

const GDX_FILTER = { 'GDX files': ['gdx'], 'All files': ['*'] };

async function pickGdx(title: string, def?: string): Promise<string | undefined> {
  const r = await vscode.window.showOpenDialog({
    title, canSelectMany: false, filters: GDX_FILTER, defaultUri: def ? vscode.Uri.file(def) : undefined,
  });
  return r?.[0]?.fsPath;
}

/** Collect options with quick inputs (Studio: GdxDiffDialog). Returns undefined if cancelled. */
async function askOptions(first?: string): Promise<GdxDiffOptions | undefined> {
  let o = defaultDiffOptions();
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const in1 = first ?? (await pickGdx('GDX Diff: choose input file one'));
  if (!in1) return undefined;
  o.input1 = in1;
  const in2 = await pickGdx('GDX Diff: choose input file two', path.dirname(in1));
  if (!in2) return undefined;
  o.input2 = in2;

  const field = await vscode.window.showQuickPick(
    DIFF_FIELDS.map((f) => ({
      label: f,
      description: { All: 'All fields', L: 'Level', M: 'Marginal', Lo: 'Lower bound', Up: 'Upper bound', Prior: 'Prior', Scale: 'Scale' }[f],
    })),
    { title: 'Field to compare (the only field used to decide whether a variable or equation differs)' },
  );
  if (!field) return undefined;
  o.field = field.label as DiffField;
  o = normalizeDiffOptions(o, 'field');

  type Flag = vscode.QuickPickItem & { key: keyof GdxDiffOptions };
  const flags: Flag[] = [
    { key: 'fieldOnly', label: 'Field Only', description: 'Write variables/equations as parameters of the selected field (needs a field other than All; not with Diff Only)' },
    { key: 'diffOnly', label: 'Diff Only', description: 'Write only differing fields with an extra index for the field name (not with Field Only)' },
    { key: 'ignoreSetText', label: 'Ignore Set Text', description: 'Ignore explanatory text of set elements' },
    { key: 'cmpDefaults', label: 'Compare Defaults', description: 'Report default values present in only one file as differences' },
    { key: 'cmpDomains', label: 'Compare Domains', description: 'Report different domains of the same symbol' },
    { key: 'ignoreOrder', label: 'Ignore Order', description: 'Ignore UEL order of the input files (can reduce the output size)' },
  ];
  const picked = await vscode.window.showQuickPick(flags, { canPickMany: true, title: 'GDX Diff options' });
  if (!picked) return undefined;
  for (const f of picked) (o as unknown as Record<string, unknown>)[f.key] = true;
  if (o.fieldOnly && o.diffOnly) o = normalizeDiffOptions(o, 'diffOnly');
  if (o.fieldOnly && o.field === 'All') o = normalizeDiffOptions(o, 'fieldOnly');

  const num = (v: string): string | undefined => (v.trim() === '' || Number.isFinite(Number(v.trim().replace(',', '.'))) ? undefined : 'Enter a number');
  const eps = await vscode.window.showInputBox({ title: 'Eps (absolute difference; empty = default)', value: '', validateInput: num });
  if (eps === undefined) return undefined;
  o.eps = eps.replace(',', '.');
  const rel = await vscode.window.showInputBox({ title: 'RelEps (relative difference; empty = default)', value: '', validateInput: num });
  if (rel === undefined) return undefined;
  o.relEps = rel.replace(',', '.');

  const out = await vscode.window.showSaveDialog({
    title: 'Difference file', defaultUri: vscode.Uri.file(prepopulateDiff(o.input1, folder)), filters: { 'GDX files': ['gdx'] },
  });
  if (!out) return undefined;
  o.diffFile = out.fsPath;
  return o;
}

/** Run `gdxdiff` from the sysdir and open the result in the GDX viewer. */
export async function runGdxDiff(o: GdxDiffOptions, sysdir: string): Promise<string | undefined> {
  const bad = validateDiffInputs(o);
  if (bad) {
    void vscode.window.showErrorMessage(bad);
    return undefined;
  }
  const workingDir = path.dirname(o.diffFile || o.input1);
  for (const [n, f] of [['(1)', o.input1], ['(2)', o.input2]] as const) {
    if (!fs.existsSync(f)) {
      void vscode.window.showErrorMessage(`Input file ${n} does not exist:\n${f}`);
      return undefined;
    }
  }
  const diffFile = resolveDiffFile(o.diffFile, workingDir);
  if (fs.existsSync(diffFile)) {
    const a = await vscode.window.showWarningMessage(
      `${path.basename(diffFile)} already exists.\nDo you want to overwrite it?`, { modal: true }, 'Yes',
    );
    if (a !== 'Yes') return undefined;
  }
  const exe = path.join(sysdir, process.platform === 'win32' ? 'gdxdiff.exe' : 'gdxdiff');
  if (!fs.existsSync(exe)) {
    void vscode.window.showErrorMessage(`gdxdiff not found in the GAMS system directory: ${exe}`);
    return undefined;
  }
  channel ??= vscode.window.createOutputChannel('GAMS GDX Diff');
  const args = gdxDiffArgs({ ...o, diffFile }, workingDir);
  channel.appendLine(`Running: ${exe} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
  await releaseGdx(diffFile); // the viewer may hold the old diff file open (Studio: releaseFile)
  const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const p = cp.spawn(exe, args, { cwd: workingDir, env: gamsEnvironment(sysdir) });
    let out = '';
    const take = (b: Buffer): void => { out += b.toString(); channel?.append(b.toString()); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('error', (e) => { channel?.appendLine(String(e)); resolve({ code: -1, stdout: out }); });
    p.on('close', (c) => resolve({ code: c, stdout: out }));
  });
  const result = parseDiffOutput(stdout, workingDir) ?? (code === 0 ? diffFile : undefined);
  if (!result || !fs.existsSync(result)) {
    channel.show(true);
    void vscode.window.showErrorMessage(`Unable to create diff file. gdxdiff return code: ${code}. See the GAMS GDX Diff output for details.`);
    return undefined;
  }
  // colored side-by-side view of the result (the raw GDX viewer is one click away); setting gams.gdxDiff.coloredView
  const colored = vscode.workspace.getConfiguration('gams').get<boolean>('gdxDiff.coloredView', true);
  if (colored) await vscode.commands.executeCommand('gams.gdxOpenDiffView', vscode.Uri.file(result));
  else await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(result), GDX_VIEW_TYPE);
  return result;
}

export function registerGdxDiff(sysdir: () => string | undefined): vscode.Disposable {
  return vscode.commands.registerCommand(GDX_DIFF_COMMAND, async (arg?: unknown) => {
    const sd = detectSysdir(vscode.workspace.getConfiguration('gams').get<string>('sysdir', '')) ?? sysdir();
    if (!sd) {
      reportSysdirProblem(currentSysdirCheck().problem ?? 'GAMS system directory not found. Set "gams.sysdir".', 'GDX Diff');
      return;
    }
    const first = arg instanceof vscode.Uri && arg.fsPath.toLowerCase().endsWith('.gdx') ? arg.fsPath : undefined;
    const o = await askOptions(first);
    if (o) await runGdxDiff(o, sd);
  });
}

export { DEFAULT_DIFF_FILE };
