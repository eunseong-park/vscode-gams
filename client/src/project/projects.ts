// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Studio project concept for VS Code: .gsp discovery, main file selection, status bar, Projects tree.
 * Pure logic lives in gsp.ts and mainFile.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { notifyMainFile, onClientStarted } from '../lsp';
import { GspProject, parseGsp, projectParams, samePath, writeGsp } from './gsp';
import { findIncluders, projectMainFor, resolveMainFile } from './mainFile';
import { isGamsFile } from '../languages';

const MAIN_KEY = 'gams.mainFile';

export interface RunTarget {
  main: string;
  workDir: string;
  /** Project / main file run parameters (normalized key=value), applied after the Studio defaults. */
  params: string[];
  /** the work directory comes from a .gsp project (not from the legacy `GAMS.terminalCwd`) */
  fromProject?: boolean;
}

export class ProjectManager implements vscode.TreeDataProvider<string>, vscode.Disposable {
  private projects: GspProject[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly state: vscode.Memento) {
    this.status.command = 'gams.setMainFile';
    this.status.name = 'GAMS Main File';
    const w = vscode.workspace.createFileSystemWatcher('**/*.gsp');
    this.disposables.push(
      this.status,
      this.changed,
      w,
      onClientStarted(() => {
        this.sentMain.clear();
        this.syncMainFiles();
      }),
      w.onDidChange(() => void this.refresh()),
      w.onDidCreate(() => void this.refresh()),
      w.onDidDelete(() => void this.refresh()),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.updateStatus();
        this.syncMainFiles();
      }),
      vscode.commands.registerCommand('gams.setMainFile', (u?: vscode.Uri) => this.setMainFile(u)),
    );
    void this.refresh();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  async refresh(): Promise<void> {
    const uris = await vscode.workspace.findFiles('**/*.gsp', '**/node_modules/**', 100);
    const res: GspProject[] = [];
    for (const u of uris) {
      try {
        const p = parseGsp(fs.readFileSync(u.fsPath, 'utf8'), u.fsPath);
        if (p) res.push(p);
      } catch {
        // unreadable project file: ignored
      }
    }
    this.projects = res;
    this.changed.fire();
    this.updateStatus();
    this.syncMainFiles();
  }

  /** True for a file listed in a .gsp project (saved together with the modified GAMS files before a run). */
  isProjectFile(fsPath: string): boolean {
    return this.projects.some((p) => p.files.some((f) => samePath(f, fsPath)) || samePath(p.gspPath, fsPath));
  }

  /** file -> main file last sent to the language server (`gams/setMainFile`) */
  private readonly sentMain = new Map<string, string>();

  private sendMain(file: string, main: string | undefined): void {
    const target = main && !samePath(main, file) ? main : undefined;
    const key = path.normalize(file);
    if (this.sentMain.get(key) === target || (!target && !this.sentMain.has(key))) return;
    if (!notifyMainFile(vscode.Uri.file(file), target ? vscode.Uri.file(target) : undefined)) return; // client not running
    if (target) this.sentMain.set(key, target);
    else this.sentMain.delete(key);
  }

  /**
   * Tell the language server which main file each known include file belongs to: files of .gsp projects
   * (project main file), and the active file when the remembered workspace main file includes it directly.
   */
  private syncMainFiles(): void {
    const wanted = new Map<string, string>();
    for (const p of this.projects) {
      if (!p.mainFile) continue;
      for (const f of p.files) if (!samePath(f, p.mainFile)) wanted.set(path.normalize(f), p.mainFile);
    }
    const active = vscode.window.activeTextEditor?.document;
    const rem = this.remembered();
    if (active && isGamsFile(active) && rem && !wanted.has(path.normalize(active.uri.fsPath))) {
      try {
        const text = vscode.workspace.textDocuments.find((d) => samePath(d.uri.fsPath, rem))?.getText() ?? fs.readFileSync(rem, 'utf8');
        if (findIncluders(active.uri.fsPath, [{ path: rem, text }]).length) wanted.set(path.normalize(active.uri.fsPath), rem);
      } catch {
        // main file unreadable
      }
    }
    for (const [f, m] of wanted) this.sendMain(f, m);
    // assignments that no longer hold (project removed, main file changed)
    for (const f of [...this.sentMain.keys()]) if (!wanted.has(f)) this.sendMain(f, undefined);
  }

  private remembered(): string | undefined {
    return this.state.get<string>(MAIN_KEY);
  }

  private updateStatus(): void {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !isGamsFile(ed.document)) {
      this.status.hide();
      return;
    }
    const f = ed.document.uri.fsPath;
    const p = this.projects.find((x) => x.mainFile && x.files.some((y) => samePath(y, f)));
    const main = (p && projectMainFor(p, f)) ?? this.remembered();
    if (!main) {
      this.status.hide();
      return;
    }
    this.status.text = `$(file-code) Main: ${path.basename(main)}`;
    this.status.tooltip = p ? `GAMS project ${p.name} (${p.gspPath}).${p.dynamicMainFile ? ' Dynamic main file: the active GAMS file runs.' : ''} Click to change the main file.` : 'GAMS main file for this workspace. Click to change.';
    this.status.accessibilityInformation = { label: `GAMS main file ${path.basename(main)}. Change the main file`, role: 'button' };
    this.status.show();
  }

  private async gmsFiles(): Promise<{ path: string; text: string }[]> {
    const open = new Map(vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'file').map((d) => [d.uri.fsPath, d.getText()]));
    const uris = await vscode.workspace.findFiles('**/*.gms', '**/node_modules/**', 300);
    const res: { path: string; text: string }[] = [];
    for (const u of uris) {
      try {
        res.push({ path: u.fsPath, text: open.get(u.fsPath) ?? fs.readFileSync(u.fsPath, 'utf8') });
      } catch {
        // skip
      }
    }
    return res;
  }

  /** Studio: running any file of a project runs the project's main file. `undefined`: run the file itself; `null`: cancelled. */
  async resolveRunTarget(active: string): Promise<RunTarget | undefined | null> {
    const includers = findIncluders(active, await this.gmsFiles());
    const r = resolveMainFile({ active, projects: this.projects, remembered: this.remembered(), includers });
    switch (r.kind) {
      case 'self':
        return undefined;
      case 'project':
        return {
          main: r.main,
          workDir: r.project.workDir,
          fromProject: true,
          params: [...projectParams(r.project), ...(r.project.pf ? [`pf="${r.project.pf}"`] : [])],
        };
      case 'main':
        return { main: r.main, workDir: path.dirname(r.main), params: [] };
      case 'ask': {
        const main = await this.pickMain(active, r.candidates);
        if (!main) return null;
        await this.state.update(MAIN_KEY, main);
        this.updateStatus();
        this.syncMainFiles();
        return { main, workDir: path.dirname(main), params: [] };
      }
    }
  }

  private async pickMain(active: string, candidates: string[]): Promise<string | undefined> {
    const all = candidates.length ? candidates : (await this.gmsFiles()).map((f) => f.path);
    const items: (vscode.QuickPickItem & { file?: string })[] = all.map((f) => ({
      label: path.basename(f),
      description: vscode.workspace.asRelativePath(f),
      file: f,
    }));
    items.push({ label: '$(file) Run this file itself', description: path.basename(active) });
    const pick = await vscode.window.showQuickPick(items, {
      title: 'GAMS main file',
      placeHolder: `${path.basename(active)} is not a main file. Which file should GAMS run? (remembered for this workspace)`,
    });
    if (!pick) return undefined;
    return pick.file ?? active;
  }

  /** Studio "Set as main file": updates the owning .gsp if there is one, else the workspace main file. */
  async setMainFile(uri?: vscode.Uri): Promise<void> {
    const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file) return;
    const p = this.projects.find((x) => x.files.some((y) => samePath(y, file)));
    if (p && /\.gms$/i.test(file)) {
      fs.writeFileSync(p.gspPath, writeGsp(fs.readFileSync(p.gspPath, 'utf8'), p.gspPath, { mainFile: file }));
      await this.refresh();
      return;
    }
    await this.state.update(MAIN_KEY, file);
    this.updateStatus();
    this.syncMainFiles();
    void vscode.window.showInformationMessage(`GAMS main file: ${path.basename(file)}`);
  }

  // Projects tree: project -> files (ids: gsp path, or "gsp|file")
  getChildren(el?: string): string[] {
    if (!el) return this.projects.map((p) => p.gspPath);
    const p = this.projects.find((x) => x.gspPath === el);
    return p ? p.files.map((f) => `${el}|${f}`) : [];
  }

  getTreeItem(id: string): vscode.TreeItem {
    const [gsp, file] = id.split('|');
    const p = this.projects.find((x) => x.gspPath === gsp);
    if (!file) {
      const t = new vscode.TreeItem(p?.name ?? gsp, vscode.TreeItemCollapsibleState.Expanded);
      t.description = p?.mainFile ? path.basename(p.mainFile) : '';
      t.tooltip = gsp;
      t.iconPath = new vscode.ThemeIcon('project');
      return t;
    }
    const t = new vscode.TreeItem(path.basename(file));
    t.resourceUri = vscode.Uri.file(file);
    t.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(file)] };
    if (p?.mainFile && samePath(p.mainFile, file)) t.iconPath = new vscode.ThemeIcon('play');
    return t;
  }
}
