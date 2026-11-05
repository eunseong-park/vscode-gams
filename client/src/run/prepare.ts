/*
 * Steps every GAMS execution (run, compile, debug, profile) shares before it starts, so they behave the same:
 * Studio's MainWindow::executePrepare (save modified files, processMainFileDynamics, main file and project
 * parameters, src/mainwindow.cpp) and a checked GAMS system directory.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { requireSysdir } from '../sysdirUi';
import { terminalCwdSetting } from '../legacy/legacyVscode';
import { runWorkDir } from '../legacy/legacy';
import { isGamsSource } from '../languages';

export interface ResolvedRunTarget {
  main: string;
  workDir: string;
  params: string[];
  fromProject?: boolean;
}

/** Studio project / main file resolution (set by the extension). `undefined`: run the file itself; `null`: cancelled. */
export type TargetResolver = (active: string) => Promise<ResolvedRunTarget | undefined | null>;

let resolver: TargetResolver | undefined;
/** Files (besides GAMS language documents) that belong to a Studio project; saved with a run too. */
let projectFileTest: ((fsPath: string) => boolean) | undefined;

export function setTargetResolver(fn: TargetResolver | undefined, isProjectFile?: (fsPath: string) => boolean): void {
  resolver = fn;
  projectFileTest = isProjectFile;
}

/**
 * Studio saves all modified files before a run (autosave on run: `mFileMetaRepo.modifiedFiles()`).
 * Saves every dirty GAMS-language document and every dirty file of a project. False when a save failed.
 */
export async function saveAllDirty(): Promise<boolean> {
  for (const d of vscode.workspace.textDocuments) {
    if (!d.isDirty || d.uri.scheme !== 'file') continue;
    if (isGamsSource(d) || projectFileTest?.(d.uri.fsPath) || /\.(gms|inc|dmp|gsp)$/i.test(d.uri.fsPath)) {
      if (!(await d.save())) {
        void vscode.window.showWarningMessage(`Couldn't save file ${d.uri.fsPath}`);
        return false;
      }
    }
  }
  return true;
}

export interface PreparedRun {
  sysdir: string;
  /** file GAMS is started with (the project's / remembered main file, else the active file) */
  main: string;
  workDir: string;
  /** Settings defaults followed by project / main file parameters (not yet tokenized). */
  params: string[];
}

/**
 * Save, check the sysdir, resolve the main file and gather the parameters. Undefined when the run must not
 * start (already reported to the user, or cancelled in the main file picker).
 */
export async function prepareRun(active: string, what: string, sysdirOverride?: string): Promise<PreparedRun | undefined> {
  if (!(await saveAllDirty())) return undefined;
  const sysdir = sysdirOverride || requireSysdir(what);
  if (!sysdir) return undefined;
  const target = await resolver?.(active);
  if (target === null) return undefined;
  const main = target?.main ?? active;
  return {
    sysdir,
    main,
    // deprecated GAMS.terminalCwd applies unless a .gsp project decides the working directory
    workDir: runWorkDir(terminalCwdSetting(), target?.fromProject === true, target?.workDir, path.dirname(main)),
    params: [...vscode.workspace.getConfiguration('gams').get<string[]>('defaultParameters', []), ...(target?.params ?? [])],
  };
}
