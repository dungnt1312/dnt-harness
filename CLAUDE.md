# dnt-harness project context

Read `docs/agent-guide.md` when creating skills or custom agents, choosing their
scope, or changing harness onboarding. It is the agent-facing documentation entrypoint.

- Use `docs/README.md` for the subsystem map and `docs/prompt-contract.md` for
  context assembly, trust, budgeting and prompt overrides.
- Skills and custom agents for this project belong in `.claude/skills/` and
  `.claude/agents/`. Top-level `skills/` contains skills shipped with the product;
  change it only when the task explicitly concerns bundled harness behavior.
- Follow nearby implementation and tests. Instructions and skills never grant
  permissions; mode/tool/policy enforcement remains independent of prose.
- Use Bun (package manager and runtime). Run affected tests first, then `bun run test`
  for behavior changes and `bun run typecheck`; run `bun run build:web` when the web
  surface is affected. `bun test` is Bun's own runner, not this suite; use `bun run test`.
- Keep changes scoped; preserve user-owned files and report verification failures.
- Store plans and reports in `plans/`, and documentation in `docs/`.
