---
title: "Runtime & provider hardening"
description: "Implement the runtime/provider hardening spec at the current HEAD without weakening security, data-safety, or migration guarantees."
status: in-review
priority: P1
effort: "~68h + Linux/macOS gate setup"
branch: main
tags: [backend, api, security, runtime, provider]
created: 2026-10-17
---

# Runtime & provider hardening

## Overview

Implementation plan for [`../261017-spec-runtime-provider-hardening.md`](../261017-spec-runtime-provider-hardening.md).

- Baseline: `337af2d618cc6e9c2b34e9a1abf108e78c4dafb7`, `main`, 22 commits ahead of `origin/main` when revalidated.
- Source tree had no tracked modifications when revalidated. Preserve every untracked plan/script/user directory.
- `135ae5b` already contains the CLI/provider-store parity changes. `337af2d` introduces guarded learning for rejected 32k guesses; Phase 3 must characterize it before changing output-cap policy.

## Phases

| # | Phase | Status | Effort | Link |
|---|---|---|---:|---|
| 0 | Baseline, runtimes, platform gates | Done – gates pending (Linux CI first run) | 6h | [phase-00](./phase-00-baseline-and-safeguards.md) |
| 1 | Outbound transport security | Done – gates pending (RH1-G live smoke, Linux DNS probe) | 12h | [phase-01](./phase-01-outbound-transport-security.md) |
| 2 | Benchmark repository safety | Done – gates pending (POSIX special-name tests on Linux) | 8h | [phase-02](./phase-02-benchmark-repository-safety.md) |
| 3 | PTY lifecycle | Done – gates pending (Linux RH3-A/C, macOS evidence) | 12h | [phase-03](./phase-03-pty-lifecycle.md) |
| 4 | Shared model resolution, caps, errors | Done | 12h | [phase-04](./phase-04-model-caps-and-errors.md) |
| 5 | Reasoning round-trip + history compatibility | Done – gates pending (PH4-G live DeepSeek smoke) | 14h | [phase-05](./phase-05-reasoning-round-trip.md) |
| 6 | Metrics, prompt, docs, release gates | Done – gates pending (release env/tag protection; behavioral prompt eval not met) | 4h | [phase-06](./phase-06-metrics-docs-release.md) |

Final report: [reports/phase-06-final-report.md](./reports/phase-06-final-report.md)

## Implementation log

Baseline `337af2d`. Commits (oldest first), each after code review with findings fixed:

| Commit | Scope |
|---|---|
| `2ff6eff` | Phase 0: Node 22.19 preflight, Bun resolver, runtime probes, Linux CI job |
| `075c50c` | Phase 1: outbound transport via real Undici, connect-time DNS policy |
| `2033415` | Phase 2: bench never mutates source; independent HEAD-only copies |
| `7059b43` | Phase 3: awaitable idempotent PTY teardown, bounded shutdown |
| `bb358c2` | Fix: stop accepting before dropping connections on shutdown |
| `31239c3` | Phase 4: effective-model resolver, bounded cap relearn, classifier |
| `355056f` | Phase 5: DeepSeek reasoning round-trip, no fabrication |
| `529264a` | Fix: no OAuth token writes after shutdown begins |
| `16eb829` | Phase 6: bench cache metrics normalization + prompt softening |
| `58153cc` | Phase 6: release gates, pinned actions, migration notes, checklist |
| `593cfc4` | Post-plan (user request): Windows terminal backend node-pty → bun-pty 0.5.1 |

## Dependencies

- Phase 0 blocks every implementation phase.
- Phase 1 and Phase 2 are independent after Phase 0.
- Phase 3 requires a working Linux Bun environment from Phase 0. macOS gate is separate.
- Phase 4 must land before Phase 5 because reasoning lineage uses resolved route identity.
- Pending HC plan `plans/261017-0018-harness-core-hardening/` must not run concurrently with Phase 4/5. Re-run PH4 attempt-boundary tests after any rebase onto HC changes.
- Phase 6 follows all functional phases and precedes any version/tag/publish.

## Release gates

- Real Undici must be proven loaded under Bun; no native-fetch fallback for policy-owned outbound requests.
- No benchmark command may reset, restore, checkout, add, delete, or refresh indexes in a user source repository.
- GitHub Linux CI Bun actual-process PTY and DNS gates are required. Windows launcher/PM2 smoke is required. macOS terminal support requires real evidence.
- External SIGKILL/host crash during terminal teardown is a documented limitation, not a release claim.
- Strict reasoning replay must never fabricate missing reasoning.
- New full-suite failures versus the pinned-runtime baseline block completion.

## Spec deviations

- Output cap: plan keeps `337af2d` 32k fallback + bounded relearning, superseding spec §3 decision 6 and §8 unknown-omit default.
- RH-1 transport: real Undici must be loaded by resolved package entry under Bun; bare `undici` import is forbidden for this path.
- Phase 5 replay window: default native DeepSeek window is the whole conversation (official docs: "all previous turns" when `tools` present); strict pre-network gate covers only the active tool loop. `tool-loop` stays an explicit profile value.
- Phase 2 copies are HEAD-only (HEAD + index + worktree layers rebuilt; no history).
- Phase 6 prompt eval: string-level tests plus an opt-in live behavioral eval (`scripts/prompt-eval/`); spec §11.3 eval implemented 2026-10-19. Gap: nonexistent-feature FAILS live under the hardened scorer. Evidence is one live sample per case, one model via the `ocproxy` proxy (`ocproxy-2`), and the rule was narrowed after run 1 (see final report).
- Post-plan: Windows terminal backend replaced node-pty with bun-pty 0.5.1 (exact pin, user request); spec RH3-D "Windows node-pty smoke" is satisfied by equivalent bun-pty smoke.

## Release gates status

- [x] Real Undici under Bun, fail closed (Bun probe 13/13; runtime-probes 7/7 on Windows).
- [x] Bench never mutates source repo (Windows tests).
- [x] Windows terminal smoke (bun-pty, `pty-smoke-windows.mjs` 14/14, repeated).
- [x] Strict reasoning replay never fabricates (fake strict gateway tests).
- [x] No new full-suite failures vs baseline (5 non-baseline files triaged as load flakes / pre-existing intermittent).
- [ ] GitHub Linux CI first green run (Bun DNS + PTY probes, RH3-A/C, POSIX RH2 tests) — branch not pushed.
- [ ] macOS terminal evidence — none; no macOS terminal support claim.
- [ ] RH1-G live public HTTPS MCP/OAuth/media smoke under Bun.
- [ ] PH4-G live DeepSeek smoke (needs `DEEPSEEK_API_KEY`).
- [ ] Protected `release` environment + tag protection configured by repo admin.
- [ ] Behavioral prompt eval (spec §11.3): implemented. Live run 3 passed 3/3 under the narrowed rule (narrowed after run 1). Run 4 under the hardened scorer FAILS nonexistent-feature. One live sample per case, one model (`deepseek-v4.1-flash-free`) via the `ocproxy-2` proxy (2026-10-19).

## Red Team Review

### Session — 2026-10-17
**Findings:** 15 after dedup (15 accepted, 0 rejected)
**Severity breakdown:** 1 Critical, 11 High, 3 Medium

| # | Finding | Severity | Disposition | Applied To |
|---|---|---|---|---|
| 1 | Bare `undici` under Bun is native shim | Critical | Accept | Phase 0, 1 |
| 2 | Baseline/runtime stale; Node 18 invalid | High | Accept | Plan, Phase 0 |
| 3 | No Linux gate environment | High | Accept | Phase 0, 3, 6 |
| 4 | Missing outbound call sites; seam bypass | High | Accept | Phase 1 |
| 5 | Media redirect to private configured origin | Medium | Accept | Phase 1 |
| 6 | Untrusted Git config/untracked secret leak | High | Accept | Phase 2 |
| 7 | Windows copy semantics and RH2 effort | Medium | Accept | Phase 2 |
| 8 | PTY ownership contradicts job cleanup | High | Accept | Phase 3 |
| 9 | Failed teardown state undefined | High | Accept | Phase 3 |
| 10 | Shutdown budget/serial teardown | High | Accept | Phase 3 |
| 11 | Output-cap conflict with `337af2d` | High | Accept | Phase 4 |
| 12 | Unknown-cap/thinking coupling | High | Accept | Phase 4 |
| 13 | Strict reasoning locks legacy/length sessions | High | Accept | Phase 5 |
| 14 | Route fingerprint lacks stability/account identity | High | Accept | Phase 4, 5 |
| 15 | Compaction/consumer migration and release enforcement | High | Accept | Phase 5, 6 |

## Validation Log

### Session 1 — 2026-10-17
**Trigger:** User requested plan creation and validation after red-team review.
**Questions asked:** 4

#### Questions & Answers

1. **[Tradeoffs]** Plan ban đầu đề xuất model chưa biết output limit thì không gửi cap, còn HEAD mới (337af2d) giữ fallback 32k và chỉ sửa một lần nếu provider từ chối cap đoán. Chọn hướng nào cho Phase 4?
   - Options: Giữ relearn có giới hạn (Recommended) | Không gửi cap mặc định | Giữ 337af2d nguyên trạng
   - **Answer:** Giữ relearn có giới hạn (Recommended)
   - **Rationale:** Preserves landed gateway compatibility while bounding retry, learning and lineage risks.
2. **[Risks]** PTY và DNS policy phải được kiểm chứng trên Linux, nhưng máy hiện chưa có môi trường Linux dùng được. Dùng môi trường nào làm gate?
   - Options: GitHub Linux CI (Recommended) | WSL Ubuntu cục bộ | VPS/Linux máy khác
   - **Answer:** GitHub Linux CI (Recommended)
   - **Rationale:** Provides repeatable Linux evidence and can become a publish dependency.
3. **[Scope]** Nếu PM2 hoặc host bị SIGKILL trong lúc đang dọn terminal, process con có thể còn sót. Có thêm cơ chế dọn orphan lúc khởi động lại không?
   - Options: Ghi nhận giới hạn (Recommended) | Thêm orphan reaping
   - **Answer:** Ghi nhận giới hạn (Recommended)
   - **Rationale:** Keeps scope bounded; graceful teardown remains release-blocking.
4. **[Scope]** Bản release này có cần tiếp tục tuyên bố hỗ trợ terminal trên macOS không?
   - Options: Bắt buộc có evidence (Recommended) | Tạm giới hạn Windows/Linux
   - **Answer:** Bắt buộc có evidence (Recommended)
   - **Rationale:** Prevents support claims without real platform verification.

#### Confirmed Decisions
- Output cap: keep bounded `337af2d` relearning — compatibility with current HEAD.
- Linux gate: GitHub Linux CI — repeatable probes and enforceable dependency.
- Orphan reaping: out of scope — crash/SIGKILL limitation documented.
- macOS: evidence required — no unsupported claim.

#### Action Items
- [x] Supersede unknown-omit cap default in Phase 4.
- [x] Make GitHub Linux CI the Phase 0/6 gate.
- [x] Remove orphan-reaping scope from Phase 3.
- [x] Keep macOS evidence as release requirement.

#### Impact on Phases
- Phase 0: Linux CI baseline/probes; macOS evidence requirement.
- Phase 3: graceful teardown only; crash limitation documented.
- Phase 4: bounded relearning replaces unknown-omit.
- Phase 6: CI/publish dependencies include Linux probes and macOS evidence for support claims.

## Validation status

- Red-team: complete; accepted findings applied.
- User decision interview: complete; decisions propagated.
- Implementation: Phases 0–6 committed (`2ff6eff`..`58153cc`, plus `593cfc4`). Status `in-review`: release-blocking gates above remain open; do not tag/publish until they pass.
