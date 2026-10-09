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
- Use pnpm. Run affected tests first, then `pnpm test` for behavior changes and
  `pnpm run typecheck`; run `pnpm run build:web` when the web surface is affected.
- Keep changes scoped; preserve user-owned files and report verification failures.
- Store plans and reports in `plans/`, and documentation in `docs/`.
