# Final fix report (v0.3.0 release review)

Commits on dev (pushed fast-forward, 009bd03..d4a986f):
- 2e887bf ci(release): manual tag flow comment, self-review note matches live setting (off, sole maintainer)
- 251d6b1 docs(release): ordered "Cut the release (maintainer)" section (8 steps, OAuth steps kept)
- 854ecb4 docs(readme): macOS probe link now run 39193207884 (verified: conclusion success, head b966de3, Runtime probes)
- 3b69df2 docs(changelog): DeepSeek proxy-only caveat; also qualified macOS (re-checked on tag run), Windows ARM64/browser terminal unverified, trusted publisher/first tag run unconfirmed
- d4a986f fix(hooks): non-object `hooks` loads as {} (GET /hooks diagnostics report it); save with empty doc keeps the stored value and only applies disableAllHooks; a non-empty editor document replaces it explicitly. RED (readWorkspaceHooks threw) then GREEN in tests/harness/g5-hooks.spec.ts (2 new tests).

Item 6: already documented in docs/web.md (chunked body cut off, client may see connection close); skipped.

Verification: typecheck ok; `bun run test --maxWorkers=3`: 374 files, 5162 passed, 2 skipped. build:web skipped (no web code changed). `bun run test:browser`: chat-workflows.e2e 52/52 pass; full playwright run 66 passed, 24 failed in attachments/chat-shell/control-plane-auth/terminal/trajectory specs (fixture "Unexpected fixture API request GET /api/model-aliases"). web/ and tests/browser are untouched by my diff, so these are not caused by this work; not investigated further.

PR #1 runs on d4a986f all green: full-suite (run 39195852629), windows-smoke (39195852542), release dry run gates + pack (39195852597, publish skipped), runtime probes linux+macOS (39195852522).

Concerns: docs/release-checklist.md evidence links still point to b966de3 runs while the head now has a code change (hooks); links are older-but-valid. The 24 test:browser failures need a separate look.
