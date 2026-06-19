---
name: gosom NixOS fix
description: How to make gosom Google Maps scraper work in Replit/NixOS — chrome-headless-shell workaround and NDJSON output format.
---

# gosom NixOS fix

## The problems
1. **Missing shared libraries**: gosom v1.12.1 uses playwright-go 1.57.0 which downloads `chrome-headless-shell` revision 1200 to `$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell`. This ELF binary fails with `libglib-2.0.so.0: cannot open shared object file` on NixOS because system libs are under `/nix/store/`, not `/lib`.
2. **NDJSON output**: gosom `-json` flag writes one JSON object per line (NDJSON/JSON Lines), NOT a JSON array `[...]`. Parsing as a single `JSON.parse()` fails with "Unexpected non-whitespace character after JSON".
3. **`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` doesn't work**: playwright-go ignores this env var at runtime; it always downloads if the marker files aren't present.

## The fix

### Chrome wrapper (`setupChromiumWrapper()` in gmapsScraper.ts)
- After chrome-headless-shell is downloaded (first failed run OR at `ensureGmapsBinary()` time), replace the ELF binary with a POSIX sh script:
  ```sh
  #!/bin/sh
  exec "/nix/store/…/bin/chromium" "$@"
  ```
- Detect replacement: read first 2 bytes — if `#!/` it's already the wrapper.
- The Nix Chromium path is found dynamically via `ls /nix/store/*/bin/chromium | head -1` (timeout 5s).
- Known path: `/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium` (may change with Nix updates).
- Wrapper path: `/tmp/pw-browsers/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell` — revision `1200` is specific to playwright-go 1.57.0 (gosom 1.12.1).

### Auto-retry in `scrapeGmaps()`
- First attempt fails with shared-library error → call `setupChromiumWrapper()` → retry once.
- On subsequent runs, `ensureGmapsBinary()` calls `setupChromiumWrapper()` at startup so no retry is needed.

### NDJSON parsing
```typescript
if (trimmed.startsWith("[")) {
  entries = JSON.parse(trimmed) as GosomEntry[];  // future-proof
} else {
  entries = trimmed.split("\n").filter(Boolean).map(l => JSON.parse(l) as GosomEntry);
}
```

**Why:** playwright-go ignores `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` env vars at runtime (those are for the Node.js Playwright CLI, not for Go). The Nix Chromium wrapper is the only reliable approach in NixOS.

**How to apply:** Any time you touch gmapsScraper.ts or upgrade gosom, verify the chrome revision (1200) still matches what playwright-go downloads.
