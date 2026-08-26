# Lottie test fixtures (`anims/`)

The demo viewer (`pnpm demo`) and the measurement bench (`pnpm measure`) read Lottie `*.json`
animations from this directory. Fixture files are intentionally not committed, so each developer can
use animations they are licensed to test. Only this README is tracked (see the package `.gitignore`).

## How to use

Drop any Lottie `*.json` files here, named however you like, e.g.:

```text
anims/
  my-splash.json
  logo.json
```

Then:

- **Demo** — `pnpm demo` stages every `*.json` present here into the viewer's dropdown (alongside
  the always-available synthetic `_stroketest` / `_masktest` entries, which need no files).
- **Measure** — `pnpm measure` measures every animation present here. Restrict a run with
  `$env:ANIMS="foo,bar"; pnpm measure` in PowerShell or `ANIMS="foo,bar" pnpm measure` in a POSIX
  shell.

## Nothing here?

The tooling still runs: the demo falls back to the bundled synthetic tests, and the bench simply
measures whichever named fixtures exist. Add files here to get real numbers.
