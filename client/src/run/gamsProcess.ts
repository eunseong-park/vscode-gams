// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Port of GAMS Studio src/process/abstractprocess.cpp + gamsprocess.cpp and the
 * argument construction of PExProjectNode::analyzeParameters (src/file/pexgroupnode.cpp).
 * No vscode imports.
 */
import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import { tokenize } from '../options/commandLine';
import { gamsEnvironment } from '../sysdir';

/** Studio default parameters, in order (pexgroupnode.cpp analyzeParameters). */
export const STUDIO_DEFAULT_PARAMETERS: readonly string[] = [
  'logoption=3',
  'ide=1',
  'errorlog=99',
  'errmsg=1',
  'pagesize=0',
  'lstTitleleftaligned=1',
];

/** Key of a `key=value` parameter, lower-cased; leading `--` / `-` flags are returned as-is. */
function keyOf(p: string): string {
  const i = p.indexOf('=');
  return (i < 0 ? p : p.substring(0, i)).trim().toLowerCase();
}

/**
 * Build the argument list: gms file, Studio defaults, user parameters.
 * `compile` prepends ACTION=C unless the user already set action/a
 * (option/gamsparameterwidget.cpp, RunActionState::Compile).
 */
/**
 * Windows command line for GAMS tools, as Studio builds it: arguments joined by blanks
 * without C-runtime escaping. Like CommonPaths::nativePathForProcess (which quotes the
 * .gms path), a bare token containing whitespace is wrapped in double quotes, and for
 * `key=value` only the value is quoted (`key="a b"`, GAMS syntax). Already quoted
 * tokens/values are left untouched.
 */
export function windowsCommandLine(args: string[]): string {
  const quoted = (v: string): boolean => v.length >= 2 && v.startsWith('"') && v.endsWith('"');
  return args
    .map((a) => {
      if (!/\s/.test(a) || quoted(a)) return a;
      const i = a.indexOf('=');
      if (i > 0 && !/\s/.test(a.substring(0, i))) {
        const v = a.substring(i + 1);
        return quoted(v) ? a : `${a.substring(0, i + 1)}"${v}"`;
      }
      return `"${a}"`;
    })
    .join(' ');
}

/**
 * Split parameter strings the way Studio's command line is tokenized (OptionTokenizer::tokenize), so that a
 * single setting entry such as `lo=3 reslim=10` yields two parameters, and write every item as `key=value`
 * (`analyzeParameters`: `QString("%1=%2")`, also for an empty value: `lo` -> `lo=`). A leading `-` / `/` of
 * the key is dropped except for `--name` / `//name` style (double dash) parameters.
 */
export function expandParameters(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const p = raw.trim();
    if (!p) continue;
    // a single-quoted value with blanks cannot be split by Studio's tokenizer (no single quote support): keep as is
    if (/\s/.test(p) && p.includes("'")) {
      out.push(p);
      continue;
    }
    for (const it of tokenize(p)) {
      const dbl = /^[-/][-/]/.test(it.key);
      const key = dbl ? it.key : it.key.replace(/^[-/]/, '');
      if (key === '' && it.value === '') continue;
      out.push(`${key}=${it.value}`);
    }
  }
  return out;
}

export function buildGamsArgs(gmsFile: string, userParams: string[], compile: boolean): string[] {
  const params = expandParameters(userParams);
  const args = [gmsFile, ...STUDIO_DEFAULT_PARAMETERS];
  if (compile && !params.some((p) => ['action', 'a'].includes(keyOf(p)))) args.push('ACTION=C');
  args.push(...params);
  return args;
}

/** Value of the last `key=value` among args (case-insensitive), with quotes removed. */
export function paramValue(args: string[], ...keys: string[]): string | undefined {
  let v: string | undefined;
  for (const a of args) {
    const i = a.indexOf('=');
    if (i > 0 && keys.includes(a.substring(0, i).toLowerCase())) v = a.substring(i + 1).replace(/^"(.*)"$/, '$1');
  }
  return v;
}

/**
 * Studio's `PExProjectNode::analyzeParameters` (pexgroupnode.cpp) replaces the value
 * `default` of the GDX, Reference and ParmFile options by `"<filestem>.gdx|.ref|.pf"`
 * before GAMS is called; GAMS itself would take `default` as a literal file name.
 */
export function resolveDefaultFileParams(args: string[], stem: string): string[] {
  const suffix: Record<string, string> = { gdx: 'gdx', rf: 'ref', reference: 'ref', pf: 'pf', parmfile: 'pf' };
  return args.map((a) => {
    const i = a.indexOf('=');
    if (i <= 0) return a;
    const ext = suffix[a.substring(0, i).toLowerCase()];
    const value = a.substring(i + 1).replace(/^"(.*)"$/, '$1');
    return ext && value.toLowerCase() === 'default' ? `${a.substring(0, i)}="${stem}.${ext}"` : a;
  });
}

/** Directories and output file locations of a run (Studio `PExProjectNode::analyzeParameters`). */
export interface RunPaths {
  /** Directory of the output files: `curdir` / `workdir` combined, relative to the project work dir. */
  dir: string;
  /** File stem of the output files: `filestem` parameter, else the gms file's base name. */
  stem: string;
  /** Listing file; undefined when `output=nul` (`/dev/null`). */
  lst?: string;
  log: string;
  gdx?: string;
  ref?: string;
  pf?: string;
}

/** Studio `PExProjectNode::cleanPath`: quotes removed, relative names resolved against `dir` (itself against the work dir). */
function cleanPath(dir: string, file: string, workDir: string): string {
  let d = dir.replace(/"/g, '');
  if (!path.isAbsolute(d)) d = workDir + '/' + d;
  const f = file.replace(/"/g, '').trim();
  let ret = '';
  if (f === '' || !path.isAbsolute(f)) ret = d.endsWith('/') ? d : d + '/';
  return path.resolve(ret + f);
}

/**
 * Port of the path part of `PExProjectNode::analyzeParameters` (pexgroupnode.cpp): the output directory is
 * `curdir`, replaced by `workdir` (a relative `workdir` is appended to `curdir`), relative to the work dir;
 * the stem is `filestem` or the gms file's base name; `output` / `gdx` / `reference` / `parmfile` / `logfile`
 * values are resolved against that directory (backslashes become slashes, a dot at the end of a file name
 * is removed, `default` stands for `<stem>.gdx|.ref|.pf`). `args` are `key=value` strings.
 */
export function analyzePaths(args: readonly string[], gmsFile: string, workDir: string): RunPaths {
  const unq = (v: string | undefined): string => (v ?? '').replace(/"/g, '').trim();
  const val = (...keys: string[]): string => unq(paramValue([...args], ...keys));
  const cdir = val('curdir', 'cdir');
  const wdir = val('workdir', 'wdir');
  const stem = val('filestem', 'fs') || path.basename(gmsFile, path.extname(gmsFile));
  let dir = cdir;
  if (wdir) dir = cdir && !path.isAbsolute(wdir) ? cdir + '/' + wdir : wdir;
  if (!dir) dir = workDir;
  else if (!path.isAbsolute(dir)) dir = workDir + '/' + dir;
  dir = path.resolve(dir);
  const res: RunPaths = { dir, stem, lst: cleanPath(dir, stem + '.lst', workDir), log: cleanPath(dir, stem + '.log', workDir) };
  for (const a of args) {
    const i = a.indexOf('=');
    if (i <= 0) continue;
    const key = a.substring(0, i).toLowerCase();
    let value = a.substring(i + 1).replace(/\\/g, '/');
    value = value.replace(/(\w)\.(["\\ ]*)$/, '$1$2');
    switch (key) {
      case 'o':
      case 'output':
        res.lst = /^(nul|\/dev\/null)$/i.test(value) ? undefined : cleanPath(dir, value, workDir);
        break;
      case 'gdx':
        res.gdx = cleanPath(dir, value === 'default' ? stem + '.gdx' : value, workDir);
        break;
      case 'rf':
      case 'reference':
        res.ref = cleanPath(dir, value === 'default' ? stem + '.ref' : value, workDir);
        break;
      case 'pf':
      case 'parmfile':
        res.pf = value === '' ? undefined : cleanPath(dir, value === 'default' ? stem + '.pf' : value, workDir);
        break;
      case 'lf':
      case 'logfile':
        res.log = cleanPath(dir, /\.log$/i.test(unq(value)) ? value : value + '.log', workDir);
        break;
      default:
        break;
    }
  }
  return res;
}

/**
 * Studio gets a reference file only through the `Reference` option (`rf`/`reference`):
 * `PExProjectNode::analyzeParameters` maps that option to the project's `ref` parameter
 * (`default` => `<filestem>.ref`, a `.ref` suffix is appended when missing; pexgroupnode.cpp)
 * and the reference viewer (`MainWindow` / reference/referenceviewer.cpp) reads that file.
 * This extension needs the file for the language server, so unless the user set
 * `reference`/`rf` we append `rf="<filestem>.ref"` to every run/compile.
 * Returns the argument list, the absolute path of the .ref GAMS will write and the run's other paths.
 */
export function withReference(args: string[], gmsFile: string, workDir: string): { args: string[]; refPath: string; paths: RunPaths } {
  const stem = analyzePaths(args, gmsFile, workDir).stem;
  args = resolveDefaultFileParams(args, stem);
  if (paramValue(args, 'rf', 'reference') === undefined) args = [...args, `rf="${stem}.ref"`];
  const paths = analyzePaths(args, gmsFile, workDir);
  let refPath = paths.ref ?? cleanPath(paths.dir, stem + '.ref', workDir);
  if (path.extname(refPath) === '') refPath += '.ref';
  return { args, refPath, paths: { ...paths, ref: refPath } };
}

const WIN_INTERRUPT_PS = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class GmsInt {
  [StructLayout(LayoutKind.Sequential)] public struct COPYDATASTRUCT { public IntPtr dwData; public int cbData; public IntPtr lpData; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, ref COPYDATASTRUCT l);
  public static int Send(string title) {
    IntPtr h = FindWindow(null, title);
    if (h == IntPtr.Zero) return 1;
    byte[] b = System.Text.Encoding.ASCII.GetBytes("GAMS Message Interrupt\\0");
    IntPtr p = Marshal.AllocHGlobal(b.Length);
    Marshal.Copy(b, 0, p, b.Length);
    COPYDATASTRUCT c; c.dwData = (IntPtr)1; c.cbData = b.Length; c.lpData = p;
    SendMessage(h, 0x4A, IntPtr.Zero, ref c);
    Marshal.FreeHGlobal(p);
    return 0;
  }
}
"@
exit [GmsInt]::Send("___GAMSMSGWINDOW___" + $env:GAMS_INTERRUPT_PID)
`;

export interface GamsProcessEvents {
  stdout: [string];
  stderr: [string];
  /** exit code (null when killed by signal), signal */
  exit: [number | null, NodeJS.Signals | null];
  /** stdio streams closed (may be much later than exit if a grandchild holds them open) */
  close: [number | null, NodeJS.Signals | null];
  error: [Error];
}

export class GamsProcess extends EventEmitter<GamsProcessEvents> {
  private child?: ChildProcess;

  constructor(
    readonly sysdir: string,
    readonly args: string[],
    readonly cwd: string,
  ) {
    super();
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  get exePath(): string {
    return path.join(this.sysdir, process.platform === 'win32' ? 'gams.exe' : 'gams');
  }

  /** Human readable command line (Studio "Running:" line). */
  get commandLine(): string {
    // as GAMS receives it: key="a b" values and quoted tokens are shown once, not quoted again
    const exe = /\s/.test(this.exePath) ? `"${this.exePath}"` : this.exePath;
    return `${exe} ${windowsCommandLine(this.args)}`;
  }

  start(): void {
    // Unix: own process group (Studio: setpgid(0,0) in the child) so signals reach solver children.
    const win = process.platform === 'win32';
    // Windows: Studio passes the joined GAMS parameters verbatim (gamsprocess.cpp:
    // setNativeArguments(parameters().join(" "))) because GAMS parses its own command
    // line; Node's default MSVC-style escaping would turn rf="x.ref" into "rf=\"x.ref\"".
    this.child = spawn(this.exePath, win ? [windowsCommandLine(this.args)] : this.args, {
      cwd: this.cwd,
      env: gamsEnvironment(this.sysdir),
      detached: !win,
      windowsHide: true,
      windowsVerbatimArguments: win,
      ...(win ? { argv0: `"${this.exePath}"` } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout?.setEncoding('utf8').on('data', (d: string) => this.emit('stdout', d));
    this.child.stderr?.setEncoding('utf8').on('data', (d: string) => this.emit('stderr', d));
    this.child.on('error', (e) => this.emit('error', e));
    this.child.on('exit', (code, sig) => this.emit('exit', code, sig));
    this.child.on('close', (code, sig) => this.emit('close', code, sig));
  }

  /** Studio interrupt: SIGINT (to the process, like the Linux branch) / GAMS message window on Windows. */
  interrupt(): void {
    const pid = this.child?.pid;
    if (!pid || pid <= 1 || !this.running) return;
    if (process.platform === 'win32') {
      this.windowsInterrupt(pid);
    } else if (process.platform === 'darwin') {
      // Studio macOS branch signals the pid with abs(pid) (i.e. the process); same here.
      try { process.kill(pid, 'SIGINT'); } catch { /* already gone */ }
    } else {
      try { process.kill(pid, 'SIGINT'); } catch { /* already gone */ }
    }
  }

  /** Default grace period for stop(); set from the gams.stopGracePeriod setting. */
  static defaultGraceMs = 10000;
  private killTimer?: NodeJS.Timeout;

  /**
   * Graceful stop (deviation from Studio, whose Stop is an immediate hard kill):
   * send the GAMS interrupt first and hard-kill only if the job has not ended
   * within `graceMs`. A job that ends normally closes its network-license session
   * at once; a killed job keeps its license reservation until the license server
   * times the session out (~5 minutes, GAMS docs UG_License.html).
   * A second stop() while waiting kills immediately. graceMs <= 0 => hard kill
   * right away (Studio behaviour).
   */
  stop(graceMs = GamsProcess.defaultGraceMs): void {
    if (!this.running) return;
    if (graceMs <= 0 || this.killTimer) {
      this.kill();
      return;
    }
    this.interrupt();
    this.killTimer = setTimeout(() => {
      this.killTimer = undefined;
      if (this.running) this.kill();
    }, graceMs);
    this.child?.once('exit', () => {
      if (this.killTimer) clearTimeout(this.killTimer);
      this.killTimer = undefined;
    });
  }

  /** Studio terminate: SIGKILL to the process group, falling back to the pid; taskkill /F /T on Windows. */
  kill(): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = undefined;
    const pid = this.child?.pid;
    if (!pid || pid <= 1) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }

  /**
   * Windows interrupt as in abstractprocess.cpp: find the hidden window titled
   * ___GAMSMSGWINDOW___<pid> and send WM_COPYDATA "GAMS Message Interrupt".
   * Done through a PowerShell P/Invoke helper. UNTESTED (no Windows host available);
   * falls back to a plain taskkill (no /F) if the helper fails.
   */
  private windowsInterrupt(pid: number): void {
    const encoded = Buffer.from(WIN_INTERRUPT_PS, 'utf16le').toString('base64');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      env: { ...process.env, GAMS_INTERRUPT_PID: String(pid) },
      windowsHide: true,
      stdio: 'ignore',
    });
    ps.on('error', () => this.windowsFallbackInterrupt(pid));
    ps.on('exit', (code) => {
      if (code !== 0) this.windowsFallbackInterrupt(pid);
    });
  }

  // TODO(windows): verify the message-window interrupt on a real Windows host.
  private windowsFallbackInterrupt(pid: number): void {
    spawn('taskkill', ['/T', '/PID', String(pid)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
}
