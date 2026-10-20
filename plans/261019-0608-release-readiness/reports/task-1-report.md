# Task 1 report: CI runner and action hygiene

Status: DONE

Commits (pushed to origin/dev, fast-forward):
- 5603f6f docs(plans): release readiness plan for v0.3.0
- a439826 ci: pin ubuntu-24.04 and move actions to node24 releases

Changes (.github/workflows/release.yml, runtime-probes.yml):
- All 5 `runs-on: ubuntu-latest` -> `ubuntu-24.04`.
- checkout v4.2.2 -> v7.0.1 (3d3c42e5aac5ba805825da76410c181273ba90b1)
- setup-node v4.4.0 -> v7.1.0 (949feb2413d6458794dcd2491c4babbbce0c15c1)
- upload-artifact v4.6.2 -> v7.0.2 (cf430e030ddbb5b0abf93d22962f4752f3646cd9)
- download-artifact v4.3.0 -> v8.0.2 (9000827ccba6bdab643e8b6fd33ac0654aef8333)
- setup-bun v2.2.0 unchanged (already `using: node24`, not flagged).
SHAs resolved via `gh api repos/<r>/commits/<tag>`; each action.yml at that SHA verified `using: node24`.

Evidence: previous run 39144987217 annotations flagged checkout and setup-node (Node 20) plus the ubuntu-latest migration notice.
New run https://github.com/dungnt1312/dnt-harness/actions/runs/39176494240 on head a439826: success, zero annotations.

Concerns: release.yml jobs (including upload/download-artifact and npm publish path) are not exercised by the PR run; only runtime-probes ran. Inputs used (name, path, node-version, registry-url, persist-credentials) are unchanged across the major bumps.
