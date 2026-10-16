# Guard reviewer defects #1–#3 — fixed

1. find -exec exemption — `src/harness/guard/matcher.ts` `commandOperands`: find with -exec/-execdir/-ok/-okdir → operands unknown → no path exemption. Test: guard-matcher.spec.ts "keeps the match: find -exec/-execdir payload outside the prefix".
2. Unparsable + split / git global options — `src/harness/guard/bash-risky.ts` `lineMatch`: unparsable branch no longer returns early; falls through to splitExpansions variant. `src/harness/guard/presets.ts`: gitDestructive regexes accept git global options (`-C dir`, `-c k=v`, `--git-dir x`, `--no-pager`, `--x=y`). Tests: guard-bash-classify.spec.ts (`(git${IFS}-C…clean -fdx)` → unanalyzable-delete, etc.), guard-matcher.spec.ts "git global options before the subcommand".
3. Brace growth — `src/harness/guard/shell-parse.ts` `splitExpansions` projects size per replacement before building; over limit → returns `undefined`. Callers: bash-risky → `unanalyzable-delete`; matcher → no exemption, and `ask` (`ruleId: unanalyzable-expansion`) when nothing else matched. Tests: timing + conservative result in both spec files.

Verify: guard-*.spec.ts + server-guard.spec.ts 7 files / 304 tests passed; `pnpm run typecheck` clean.
