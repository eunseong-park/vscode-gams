# Debugging and profiling

Both features run GAMS, so you need GAMS and a license. They take the same first steps as `F9`: your files are saved, the main file and the project parameters are used, and errors go to the Problems panel.

## How do I debug a model?

1. Open the `.gms` file.
2. Click in the margin left of a line number to set a breakpoint (a red dot).
3. Press `F5`. VS Code starts the GAMS debugger on the open file.

You can also use the Command Palette:

- **GAMS: Run Debugger** runs until the first breakpoint.
- **GAMS: Step Debugger** stops at the first executable line.

GAMS pauses at your breakpoint. The line is marked. Use the debug toolbar at the top:

- **Continue** (`F5`) runs to the next breakpoint.
- **Step Over** (`F10`), **Step Into** (`F11`) and **Step Out** (`Shift+F11`) all do the same. They go to the next possible line.
- **Pause** stops a running model at the next line.
- **Stop** ends the debug session.

While a debug session is active, `F9`, `Shift+F9`, `F10` and `Shift+F10` have their normal VS Code meaning again (breakpoint, step over). They return to run and compile when the session ends.

## How do I look at values?

When GAMS is paused, open the **Variables** view in the Run and Debug sidebar (`Ctrl+Shift+D`).

- The scope **GDX snapshot** lists all symbols of the model at this moment.
- Expand a symbol to see its records. Each symbol shows the first 100 records.
- Type a symbol name in **Watch**, or point at it in the editor, to see its records.

To see all records, click **Open Snapshot in GDX Viewer** in the debug toolbar, or run **GAMS: Open Snapshot in GDX Viewer**. The viewer opens beside the editor. See [GDX files](05-gdx.md). It closes when the session ends.

## How do I set debug options?

Open **Run > Add Configuration...** and choose **GAMS: Debug**. This creates `.vscode/launch.json`. Example:

```json
{
  "type": "gams",
  "request": "launch",
  "name": "GAMS: Debug",
  "program": "${file}",
  "parameters": ["lo=3"],
  "stopOnEntry": false,
  "maxRecords": 200
}
```

- `program`: the `.gms` file. Default `${file}`.
- `parameters`: extra GAMS parameters.
- `cwd`: working folder. Default is the folder of the main file.
- `stopOnEntry`: stop at the first line, like **Step Debugger**.
- `maxRecords`: records shown per symbol in the Variables view. Default 100.

## How do I find slow statements?

Run **GAMS: Run with Profiler** from the Command Palette. GAMS runs the model and the extension collects timing for each statement.

- Each executed line shows time, memory, rows and steps at its end. Lines with a sigma are totals of an include file.
- Hover at the end of a line to see a table for the statements on that line.
- **GAMS: Show Profile Summary** lists the statements sorted by time. Pick one to jump to it. The same list is in the output channel **GAMS Profiler**.
- **GAMS: Clear Profile** removes the numbers from the editor.

A message tells you when profiling has finished. It has buttons for the summary and for clearing.
