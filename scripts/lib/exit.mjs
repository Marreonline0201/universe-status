// A gate's final exit. On Windows, process.exit() while a libuv async handle is still closing — Playwright's socket
// teardown right after browser.close() — aborts with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file
// src\win\async.c, line 76" and exit status 0xC0000409 instead of the gate's own code (nodejs/node#56645, no released
// fix; seen here on Node v25.1.0 after obs1-t1 on 2026-09-29, the report already written). exitGate sets the code and
// yields before exiting, so the closing handles finish first (the workaround used for the same abort in
// actions/ai-inference#227).
export function exitGate(code) {
  process.exitCode = code
  if (process.platform === 'win32') setTimeout(() => process.exit(code), 250)
  else process.exit(code)
}
