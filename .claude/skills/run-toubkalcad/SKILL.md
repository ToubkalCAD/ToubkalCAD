---
name: run-toubkalcad
description: Build, run, and drive ToubkalCAD — the browser-based 3D CAD app. Use when asked to start the dev server, screenshot the UI (ribbon/toolbar/viewport), typecheck or build it, or interact with the running app headlessly.
---

ToubkalCAD is a browser app (React + Three.js + an OpenCascade WASM kernel, bundled by Rspack). "Running it" headlessly means starting the dev server (`npm run dev` on :8080) and driving it with `.claude/skills/run-toubkalcad/driver.mjs` — a small chromium-cli-style REPL over `playwright-core` + system Chrome that loads the page, waits for the kernel, clicks UI, and screenshots. There is no `chromium-cli` / `playwright` CLI on this box, which is why the driver exists.

All paths below are relative to the repo root.

## Prerequisites

- **Node** (used v22.22.2) and **npm** (10.9.7).
- **A Chromium-family browser.** Used the preinstalled `/usr/bin/google-chrome` (148). Check with `google-chrome --version`. If absent, install Chrome/Chromium and point the driver at it via `CHROME_PATH=...`.
- **`playwright-core`** — already in `node_modules` (1.60.0, a transitive dep). No Playwright browser download is needed; the driver uses system Chrome via `executablePath`.

No `apt-get` was required — Chrome and Node were already present.

## Setup

```bash
npm install      # once, after clone
```

## Build / typecheck

`npm run build` runs `tsc --noEmit` then an Rspack production build. For fast feedback, typecheck only (this is the project's only automated check — there is no test runner or linter):

```bash
npx tsc --noEmit     # passes clean
```

## Run (agent path)

Start the dev server in the background and **poll the port** (don't `sleep` — a cold first load downloads the ~48 MB kernel wasm):

```bash
npm run dev > /tmp/toubkal-dev.log 2>&1 &
echo $! > /tmp/toubkal-dev.pid
timeout 90 bash -c 'until curl -sf http://localhost:8080 >/dev/null; do sleep 1; done' && echo SERVING
```

Drive it by piping commands to the driver (each line is one action against one shared page):

```bash
node .claude/skills/run-toubkalcad/driver.mjs <<'EOF'
nav http://localhost:8080
ready                                   # waits for kernel + ribbon
shot app                                # full viewport
click .ribbon-tab:has-text("Model")
shot model 92                           # clip top 92px = the ribbon row
hover .cad-iconbtn                       # real mouse move → triggers tooltip
shot tooltip 130
errors                                  # only a benign favicon.ico 404 is expected
EOF
```

Screenshots land in `.claude/skills/run-toubkalcad/screenshots/` (gitignored). Override the dir with `OUT=/tmp/shots`, the browser with `CHROME_PATH=...`, the size with `VIEWPORT=1920x1080`.

Stop the server when done:

```bash
kill "$(cat /tmp/toubkal-dev.pid)" 2>/dev/null || pkill -f 'rspack serve'
```

### Driver commands

| command | what it does |
|---|---|
| `nav <url>` | navigate, wait for `domcontentloaded` |
| `ready` | poll up to 120s for `.ribbon-tab`; prints load time + `crossOriginIsolated` |
| `wait <selector>` | `waitForSelector` (visible), 60s |
| `click <selector>` | click (Playwright selectors incl. `:has-text(...)`) |
| `hover <selector>` | **real** `mouse.move` to element centre — needed for CSS `:hover` tooltips |
| `shot <name> [h]` | screenshot → `screenshots/<name>.png`; clip top `h`px from x=0 if given |
| `eval <js>` | evaluate in page, print JSON result |
| `sleep <ms>` | wait |
| `errors` | print collected console errors (deduped) |

Lines starting with `#` and blank lines are ignored.

## Run (human path)

```bash
npm run dev      # → http://localhost:8080 with HMR; Ctrl-C to stop
```

Useless headless (no window), but it's the normal dev loop on a desktop.

## Gotchas

- **Cold load is slow, warm load is ~4s.** The first headless load fetches the ~48 MB OCC `.wasm`; the `ready` command can take 45–90s. After that it's content-hash cached on disk and the ribbon appears in ~4s. Don't lower `ready`'s timeout because a warm run was fast.
- **The kernel runs on the main thread.** While it compiles/instantiates the wasm, the main thread is blocked — `page.screenshot()` taken too early **times out**. The driver uses a 60s screenshot timeout and `ready` polls first; keep both.
- **Tooltips need a real pointer.** Labels are CSS `:hover::after` on `data-tip`. Playwright's `.hover()` alone often won't repaint them headless — use the driver's `hover` command (it does `mouse.move` to the element centre), then screenshot.
- **Cross-origin isolation must hold.** The app needs `SharedArrayBuffer` (COOP+COEP headers from `rspack.config.ts`). `ready` reports `crossOriginIsolated=true` — if it ever prints `false`, the kernel will fail and the headers/dev-server config are the cause, not your script.
- **`playwright-core` import only resolves inside the repo tree.** Run the driver from the repo (e.g. `node .claude/skills/run-toubkalcad/driver.mjs`); Node walks up to the repo's `node_modules`. Copying it to `/tmp` breaks the bare import.
- **One benign `404` in `errors` is normal.** The browser auto-requests `/favicon.ico`; the app ships `favicon.svg`, so that one 404 always appears. Any *other* console error is real.

## Troubleshooting

- **`page.screenshot: Timeout ... exceeded` taking a screenshot**: shot fired while the kernel was compiling wasm. Run `ready` first; the bundled 60s timeout covers a busy main thread.
- **`ready: .ribbon-tab never appeared within 120s`**: dev server not actually serving, or a build error. Check `/tmp/toubkal-dev.log` and that `curl http://localhost:8080` returns HTML.
- **`Cannot find package 'playwright-core'`**: you ran the driver from outside the repo tree. Run it from the repo root.
- **`Failed to launch ... executable doesn't exist`**: Chrome isn't at `/usr/bin/google-chrome`. Set `CHROME_PATH=$(which chromium || which google-chrome)`.
