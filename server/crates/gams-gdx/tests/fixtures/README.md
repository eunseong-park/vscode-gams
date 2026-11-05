# GDX fixtures (gams-gdx / gdx-rs / gams-lsp tests)

- `mini.gdx`: `gdx=` output of GAMS 54.6.1 for the self-written model `server/tests/fixtures/mini.gms`
  (same file as there).
- `feat.gdx` / `feat_z.gdx` (uncompressed / compressed), `sets.gdx`, `cube.gdx`, `stats.gdx`: written
  with the pure Rust writer by `cargo run -p gams-gdx --example write_fixtures -- server/crates/gams-gdx/tests/fixtures`
  (no GAMS needed). Content: sets with element texts, 2-dim set, aliases (also of `*`), real and relaxed
  domains, 0-dim symbols, special values (EPS, NA, +INF, -INF, UNDF), an acronym, variables and equations
  of several types, 3-dim parameter.

Tests that need more data (capi-oracle comparisons, `read_all_shipped_samples`) read the files of
`$GAMS_SYSDIR` at runtime; nothing from there is copied into the repository.
