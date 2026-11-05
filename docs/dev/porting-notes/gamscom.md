# GAMScom: debugger and profiler protocol

Port of GAMS Studio `src/gamscom/` (official GAMS-dev/studio). Implementation:
`client/src/debug/` (`protocol.ts`, `comServer.ts`, `continuousLineData.ts`, `profiler.ts`,
`debugSession.ts`, `profileSession.ts`, VS Code glue in `vscodeDebug.ts`, `profileView.ts`).
Tests: `client/test/unit/debugProtocol.test.ts` (real transcripts), `debugSession.test.ts`
(adapter against a fake `gams` replaying a real transcript).

Everything under "Observed" was recorded from GAMS 54.6.1 (LEX-LEG x86 64bit/Linux) on
2026-11-04 with a probe that behaves like Studio's `gamscom::Server` (paths redacted to `/work`).

## Activation (Studio)

| | Debug (Run/Step Debugger) | Profiler ("Run with selected" + Profiling flag) |
|---|---|---|
| ComFeature (`server.h`) | `cfRunDebug`=1, `cfStepDebug`=3 | `cfProfiler`=4 |
| GAMS parameter (`pexgroupnode.cpp` `analyzeParameters` ~L1138-1146) | `DebugPort=<port>` appended to the Studio defaults `logoption=3 ide=1 errorlog=99 errmsg=1 pagesize=0 lstTitleleftaligned=1` | `ComPort=<port>` (same place) |
| extra | – | `Profile=300` prepended unless the user gave `profile` (`gamsparameterwidget.cpp` `on_runAction` L141-148) |

`optgams.def`: `DebugPort integer 0 0 0 65535 ... "port for socket communication with GAMS Studio to be used for the interactive debugger"`, `ComPort ... "to be used for various purposes, like profiling"`.

Studio listens on `QHostAddress::LocalHost`, first free port from 3563 to 4563, at most 100 servers (`server.cpp` `CFirstDebugPort`, `CLastDebugPort`, `CMaxOpenPorts`). GAMS connects after compilation.

## Framing

* GAMS -> IDE: packets separated by NUL (`\0`); a packet is processed when the accumulated data ends with `\n` (`Server::newConnection` readyRead lambda). One TCP chunk can hold several packets; a packet never spanned two chunks in the observed runs, but `linesMap` data is split over several packets.
* IDE -> GAMS: `keyword[\nargument]*` terminated by TAB (`\t`); a packet must stay below 255 characters, longer argument lists are split into several packets that repeat the keyword (`Server::callProcedure`).
* Inside a packet: line 1 keyword, further lines data, fields separated by `|`, assignments `line=contLN`.

## Calls (IDE -> GAMS), observed

| call | example | effect |
|---|---|---|
| `addBP` | `addBP\n43\|64\t` | add breakpoints at continuous lines |
| `delBP` | `delBP\n18\t` / `delBP\t` | remove one / all breakpoints |
| `run` | `run\t` | continue (first one starts execution after `linesMapDone`) |
| `stepLine` | `stepLine\t` | run to the next breakable line (also the first one when sent after `linesMapDone`) |
| `pause` | `pause\t` | pause at the next breakable line (sent while running) |
| `writeGDX` | `writeGDX\n/work/temp3563.gdx\t` | write all symbols to the file; Studio uses `<workdir>/temp<port>.gdx` (`Server::gdxTempFile`) |
| `invalidReply` | `invalidReply\n<the packet>\t` | sent by Studio for packets it cannot parse |

## Replies (GAMS -> IDE), observed

```
features\n1\n            debug session (DebugPort)      features\n2\n  profiler session (ComPort)
linesMap\n<file>|line=contLN|...\n[<file>|...\n]
linesMapDone\n
paused\n<contLN>\n
gdxReady\n<file>\n
profileData\n<contLN>|<statement>|<seconds>|<memory MB>[|<rows>]\n
```

Studio's `server.h` comment says the `features` flags are "+1=debug, +2=profiler"; `Server::handleReply` switches the profiler on for `flags & 2`.

### trnsport.gms (DebugPort), complete inbound transcript

```
features\n1\n\0linesMap\n/work/trnsport.gms|43=43|56=56|58=58|60=60|64=64|66=66\n\0linesMapDone\n\0
                                         <- addBP\n43|64\t  run\t
paused\n43\n\0                           <- writeGDX\n/work/temp3563.gdx\t
gdxReady\n/work/temp3563.gdx\n\0         <- stepLine\t
paused\n64\n\0                           (solve)  ... gdxReady ... <- stepLine\t
paused\n56\n\0                           (cost.. is generated during the solve) ... <- delBP\t run\t
```

Only execution-time statements are breakable (declarations/data statements are not in the map). Equation definitions (`cost..` line 56) are reached while the `solve` (line 64) generates the model: stepping from 64 stops at 56; with a breakpoint on 56, `run` from 43 stops at 56 before the solve log appears.

### Include model (DebugPort)

```
main.gms: 4 $include data1.inc   7 $batinclude bat.inc q   (9 loop, 10 body, 12 display, 13 assignment)
data1.inc: 2 assignment  3 $include data2.inc  4 assignment
data2.inc: 3 assignment          bat.inc: 2 assignment
```
```
features\n1\n\0
linesMap\n/work/main.gms|!4=4\n/work/data1.inc|0=4|2=6\n\0
|!3=7\n/work/data2.inc|0=7|3=10\n/work/data1.inc|?3=10\n\0
|4=11\n/work/main.gms|?4=11|5=12|!7=14\n\0
/work/bat.inc|0=14|2=16\n/work/main.gms|?7=16|9=18\n\0|10=19|12=21|13=22\n\0linesMapDone\n\0
```

* Continuation packets carry no keyword and start either with `|` or with a file name; Studio treats any packet with an unknown first line as `linesMap` data if the previous reply was `linesMap` (`handleReply`, `mLastReply`).
* `!L=C`: line L of the current file is an `$include`/`$batinclude` at contLN C (not breakable).
* `<child>|0=C`: the included file starts at contLN C (Studio `addIncludeFrom`).
* `<parent>|?L=C`: back in the parent after the include of line L; the include occupied contLNs up to C (`addIncludeEnd`, `IncludeLine::outerContLine`).
* contLN = listing line number: the include statement keeps its own number, the included lines follow (`data1.inc` line k = contLN 4+k), lines after the include are shifted (`main.gms` 5 = contLN 12). Stepping showed `paused` 6, 10, 11, 12, 16, 18, 19, 19, 19 (loop body once per element).
* Studio's `parseLinesMap` keeps the last `line=contLN` token of every line in `mRemainData` (it may be cut by a packet boundary) and emits it with the next file name or at `linesMapDone` (`parseLinesMap(" ")`). `ContinuousLineData::addLinesMap` merges consecutive segments of the same file.

### Pause (long `while` loop, DebugPort)

```
<- run\t   ... 1.7 s later  <- pause\t
paused\n3\n\0   <- writeGDX ...   gdxReady ...   <- stepLine\t   paused\n3\n\0 ... <- run\t
```

### Profiler (ComPort + Profile=300)

trnsport:
```
features\n2\n\0linesMap\n/work/trnsport.gms|43=43|56=56|...|66=66\n\0linesMapDone\n\0   <- run\t
profileData\n43|Assignment c|0|4.140616|6\n\0
profileData\n64|Solve Init transport|0|4.140968\n\0profileData\n56|Equation cost|0.001|4.140968|1\n\0
profileData\n58|Equation supply|0|4.140968|2\n\0profileData\n60|Equation demand|0|4.140968|3\n\0
profileData\n64|Solve Fini transport|0.002|4.140616|19\n\0
profileData\n64|Solver transport|0.0559994950890541|4.140616\n\0
profileData\n64|Solve Read transport|0|4.140616\n\0
profileData\n66|Display |0|4.140616\n\0profileData\n66|GAMS Fini  |0|4.13956\n\0
```
Include model: `6|Assignment p|0|4.139648|5`, ..., five times `19|Assignment k|0|4.139648|1`, then `18|Loop |0|4.139648` (the compound statement after its body), `21|Display |...`, `22|Assignment p|...|5`, `22|GAMS Fini  |0|4.138592`.
The linesMap is sent in profiler mode too (identical to the debug one). Memory is MB with 6 decimals; Studio converts to bytes (`qRound64(mb / .000001)`). The rows field is absent for statements without rows (solve init/read, display, loop).

## Studio logic ported

* `ContinuousLineData` (contLN <-> file/line; breakpoints active/aimed; `adjustBreakpoint` = next valid line `>=` requested, else the last valid line, `-1` for files not in the map). Studio adjusts breakpoints set before the run on `signalMapDone` (`adjustBreakpoints`) and while running in `addBreakpoint(..., isRunning)`.
* Map-done handler (`PExProjectNode::startComServer` L1475-1491): debug -> `addBreakpoints(bpContinuousLines())`, then `stepLine` (cfStepDebug) or `run`; profiler -> `run`.
* `gotoPaused` (L1572-1601): mark the file line, `writeGDX` to the temp file if contLN > 0. `DebugWidget::setContLine` shows "LST line: <contLN>". Stop = `PExProjectNode::terminate` (kill the process); `MainWindow::stopDebugServer` closes the temp GDX editors and deletes the file 200 ms later.
* `Profiler::add` (per-statement `ProfileData`, line sum `""`, "File SUM" on the include statement for every contLN inside `(contLine, outerContLine]`, sums exclude the aggregate statements `for/loop/repeat/until/while`, top-10 by time/steps), `getProfile`, `getProfileText`, and `FileMeta getProfileShort` (contLNs of a line, falling back to the include map) for the per-line values. `EditorHelper::formatTime/formatMemory`.

## Mapping to DAP / VS Code

* `initialized` is sent after `linesMapDone`, so `setBreakpoints` is answered with already adjusted lines (`verified:false, reason:"failed"` for files without breakable lines); `configurationDone` sends `addBP` + `run`/`stepLine` (launch `stopOnEntry` = Studio "Step Debugger"). `breakpointLocations` returns the valid lines.
* `continue` -> `run`; `next`/`stepIn`/`stepOut` -> `stepLine` (GAMS has one step kind); `pause` -> `pause`; `terminate`/`disconnect` -> kill like Studio.
* One thread, one frame `main  (LST line: <contLN>)`. Scope "GDX snapshot": symbols from `gams/gdxSymbols`, first `maxRecords` (100) records from `gams/gdxRecords` of `<workdir>/temp<port>.gdx`; command "GAMS: Open Snapshot in GDX Viewer" (debug toolbar) opens it with `gams.gdxViewer`.
* Profiler: command `gams.profile`; end-of-line decorations (time · memory · rows · steps), hover table (getProfileText), summary in the "GAMS Profiler" output and `gams.profile.summary` QuickPick sorted by time.

## Deviations / notes

* `encodeCall`: Studio would emit a bare keyword (e.g. `addBP\t`) when the first argument alone exceeds 255 characters; the port drops such a packet.
* `Profiler::add` removes from `mMaxSingleSteps` without `i--` (Studio); a contLN appears at most once there, so filtering is equivalent.
* A `writeGDX` that was not sent yet when the user resumes is skipped (GAMS is running again).
* Killing GAMS (stop) leaves its network-license session open for a while: the next run in this environment failed with "Node limit exceeded" (license server 403) a few minutes after a SIGKILLed debug run. Studio terminates the same way.
