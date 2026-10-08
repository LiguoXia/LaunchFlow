# Phase 1 self-check before Phase 2

Date: 2026-10-01. Host: Windows x64. This check ran before Phase 2 implementation.

- Rust: 19/19 tests passed, including real child processes, launch/readiness, TCP, argument boundaries, timeout and cancellation.
- Frontend: 4/4 tests passed; production TypeScript/Vite build passed.
- Real Tauri/WebView2: 9 integration flows passed using isolated SQLite. Scene CRUD, Simple Editor, drafts, undo, live run events/history, cancellation, close-to-tray, single-instance foregrounding, hidden default startup run were exercised.
- Additional audit: ApplicationProfile save/read/delete round trip; login registration enable/read/disable; file/folder/URL nodes dispatched through native system associations. The localhost HTTP server received the browser request. File/folder dispatch success does not inspect the external application's UI.
- Windows tray is constructed successfully by the real app; hidden-window execution and second-launch restoration work. Manual tray menu clicking was not automated.
- Login registration was tested with an isolated registration name and removed afterwards. A full Windows sign-out/sign-in was not performed.
- macOS menu bar, launch association, login startup and runtime were source/configuration reviewed only; this Windows host cannot certify macOS execution.

Necessary audit fix: the debug test namespace now also isolates the autostart registration name. Production keeps its existing `launchflow` name. No unrelated Phase 1 refactor.

Evidence: `scripts/desktop-smoke.mjs` with `LAUNCHFLOW_PHASE1_AUDIT=1`, `test-results/desktop-smoke.json`; `cargo test -p launchflow-core`, `npm test`, `npm run build`.
