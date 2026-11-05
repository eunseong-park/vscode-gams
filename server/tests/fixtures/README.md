# Test fixtures (server/tests/fixtures)

All models are self-written for this project; no GAMS model library content.

| Family | Content |
|---|---|
| `mini` | 2x2 shipping LP, single file |
| `mini_inc` | same model, data via `$include mini_data.inc` |
| `mini_bat` | as `mini_inc`, plus `$batinclude mini_rep.inc d depot s` |
| `mini_err` | errors in the main file and in `mini_err_inc.inc`, plus a missing include (exit code 2) |
| `execerr` | execution errors (division by zero, abort), non-ASCII / tab / BEL / ESC in `$log` lines (exit code 3) |

Each family has `.gms`, `.lst`, `.lxi`, `.ref`, `.log` and `.gdx` (`execerr` has no `.gdx`).

Origin: the `.lst/.lxi/.ref/.log/.gdx` files are real outputs of GAMS 54.6.1 (Linux), generated from the
`.gms` files with the Studio default parameters

    gams <m>.gms logoption=3 ide=1 errorlog=99 errmsg=1 pagesize=0 lstTitleleftaligned=1 rf=<m>.ref gdx=<m>.gdx

`.log` is the captured stdout including the `[FIL:]`/`[ERR:]`/`[LST:]` link tags.

Redactions: paths rewritten to `/work`; license, machine and installation-path lines replaced by
`*** [removed]` placeholder lines keeping the line counts. Nothing else was edited.

`scripts/check-fixture-origin.js` (`npm run check:fixture-origin`) verifies that no file in the
repository is a byte copy of a file from `$GAMS_SYSDIR`.
