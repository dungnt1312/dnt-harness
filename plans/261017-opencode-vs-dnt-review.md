# Đối chiếu A/B: opencode CLI vs dnt-harness — cùng prompt, cùng model

> Phép thử: **cùng một repo lab, cùng một prompt, cùng một model, cùng một endpoint** — chạy qua
> `opencode` CLI (bản cài npm **v1.2.24**) và qua headless CLI của **dnt-harness** (working tree hiện tại,
> chạy bằng `tsx`). Mục đích: so hành vi end-to-end khi review một "local change" thật, không so code.
>
> Script tái lập: `node scripts/e2e/compare-opencode-dnt.mjs [--rounds N] [--repo <dir>] [--timeout S] [--only opencode|dnt]`
> · Transcript Case 1 (2 lượt scripted cuối): `plans/261017-opencode-vs-dnt/round-{1,2}-{opencode,dnt}.txt`
> · **Case 2 — review nhánh thật (bản đóng băng)**: §6; transcript `plans/261017-opencode-vs-dnt/case2-*.txt`
> · **Đề xuất fix tổng hợp cho dnt-harness (khử trùng 2 danh sách)**: §7

---

## 1. Thiết kế phép thử

| Yếu tố | opencode | dnt-harness |
|---|---|---|
| Harness | `opencode run` (CLI v1.2.24, bản cài tại `node-v22.20.0\node_modules\opencode-ai`) | `tsx src/bins/headless.ts --yolo` (working tree, gồm các fix SR) |
| Model | `deepseek-v4.1-flash-free` | `deepseek-v4.1-flash-free` |
| Endpoint | gateway local `http://127.0.0.1:6536/v1` — cấu hình tạm `OPENCODE_CONFIG` với provider `ocproxy` (`@ai-sdk/openai-compatible`) | provider `ocproxy` trong store của harness (cùng baseURL) |
| Thư mục làm việc | repo lab (như nhau) | repo lab (như nhau) |
| Prompt | cố định, tiếng Anh (bên dưới) | y hệt |

Prompt dùng chung:

> *Review the local uncommitted changes in this repository. List every concrete issue you find, ordered by
> severity (high/medium/low), each with a file:line reference and a one-line fix. Do not modify any files.*

**Repo lab** (script tự dựng lại mỗi lần chạy, `%TEMP%\opencode-dnt-compare\review-lab`): commit nền là
`src/cart.js` sạch; working tree có "local change" gồm 1 file sửa (`cart.js`) + 1 file **untracked**
(`sync.js`) với **5 lỗi cài sẵn** (ground truth để chấm recall):

| # | Vị trí | Lỗi |
|---|---|---|
| 1 | `src/sync.js:3` | secret hardcode `sk_live_…` trong source |
| 2 | `src/cart.js:20` | `slice(0, cart.items.length - 1)` — off-by-one, bỏ sót item cuối khi tính discount |
| 3 | `src/sync.js:14` | `persist` gọi `pushOrder` **thiếu await/return** — floating promise, lỗi bị nuốt |
| 4 | `src/cart.js:26` | `cart.items.sort(…)` — mutate mảng của caller (in-place sort) |
| 5 | `src/sync.js:20-21` | `catch (error) {}` rỗng — swallow mọi lỗi |

Việc phát hiện được **file untracked** cũng là điểm chấm: `git diff` thuần sẽ bỏ sót `sync.js`.

---

## 2. Kết quả — 6 lượt chạy mỗi bên

Hai lượt đầu chạy tay qua PowerShell; 4 lượt sau chạy bằng script (`--rounds 1` ×2, `--rounds 2`).
Mọi lượt: **exit 0**, không bên nào sửa file (lab vẫn đúng `M src/cart.js` + `?? src/sync.js`).

| Lượt | opencode: thời gian / tool calls / findings | dnt: thời gian / tool calls / findings | Recall |
|---|---|---|---|
| M1 (tay) | 17.8s / 6 / 12 | 26.8s / 8 / 13 | 5/5 vs 5/5 |
| M2 (tay) | 14.6s / 3 / 10 | 19.1s / 7 / 12 | 5/5 vs 5/5 |
| S1 (script) | 26.5s / 11 / 11 | 14.4s / 5 / 12 | 5/5 vs 5/5 |
| S2 (script) | 16.8s / 7 / 10 | 17.3s / 6 / 11 | 5/5 vs 5/5 |
| S3 (script) | 15.6s / 6 / 10 | 28.4s / 8 / 15 | 5/5 vs 5/5 |
| S4 (script) | 18.4s / 8 / 10 | 22.0s / 8 / 14 | 5/5 vs 5/5 |
| **Trung bình** | **≈18.3s / ≈6.8 / ≈10.5** | **≈21.3s / ≈7.0 / ≈12.8** | **30/30 vs 30/30** |

- **Recall tuyệt đối**: cả hai tìm đủ **5/5 lỗi gốc ở mọi lượt** (20 lượt-điểm mỗi bên qua 4 lượt scripted
  + 10 lượt-điểm qua 2 lượt tay), và cả hai đều đọc file untracked `sync.js`.
- Chênh lệch thời gian (TB ~3s) **nhỏ hơn biên độ giữa các lượt** (opencode 14.6–26.5s, dnt 14.4–28.4s) —
  không bên nào nhanh hơn một cách ổn định.
- Số tool calls tương đương (TB ~6.8 vs ~7.0).
- dnt nêu **nhiều finding hơn ~2 mục/lượt** (10–15 vs 10–12): các mục phụ đều **chính đáng**
  (thiếu `Content-Type`, thiếu timeout/`AbortSignal`, base-URL lặp, tên `persist` gây nhầm, doc comment,
  thiếu test, thứ tự sort không ổn định khi đồng giá…), không có false positive kiểm tra được.

## 3. Phân tích định tính

**Giống nhau**

- Đều chạy `git status/diff/log`, đọc cả file sửa lẫn file untracked, trả lời đúng format yêu cầu
  (severity → `file:line` → fix một dòng), kết thúc bằng khẳng định không sửa file.
- Đều phát hiện cả 5 lỗi, kể cả các lỗi tinh tế (off-by-one bỏ item cuối; quên `await`; sort in-place).
- Không bên nào tự ý sửa hay tạo file trong lab.

**Khác nhau**

- **Severity**: lệch nhẹ ở lỗi floating-promise — dnt luôn xếp **High** (hợp lý: mất đơn hàng âm thầm);
  opencode khi High khi Medium. Sort in-place: opencode có lượt xếp High, dnt luôn Medium.
- **Độ "thêm thắt"**: dnt chủ động soi thêm (flag `openItem`, `Glob`, đọc `README`); opencode gọn hơn —
  có lượt gộp 1 lệnh duy nhất `git status && git diff` rồi chỉ đọc 2 file.
- **Văn phong & output**: opencode in câu trả lời cuối ra **stdout**, tiến trình tool ra **stderr** (gọn,
  dễ pipe). dnt headless in **cả diễn giải trung gian + trace tool** ra stdout (đúng thiết kế) — cuối cùng
  là câu trả lời hoàn chỉnh cùng format.
- **Chi tiết phụ lệch nhau**: opencode nhấn `addItem` thiếu default `qty`, rounding tiền, `refreshCatalog`
  trả `undefined`; dnt nhấn thiếu `Content-Type`, timeout, base URL, naming, thiếu test. Tập phụ khác nhau
  nhưng đều hợp lệ.

**Sự cố môi trường ghi nhận (không phải lỗi harness)**

- opencode 1 lượt bị plugin toàn cục của người dùng (`.ckignore` "Scout Block") chặn `glob **/*`
  (`✗ glob failed — Access to 'undefined' blocked`); nó tự fallback sang `git ls-files` + Read và vẫn
  hoàn thành.
- dnt 1 lượt ghi chú tự chặn đọc store nội bộ (`the host refuses that path as application-internal
  storage`) — guard bảo vệ dữ liệu của chính app, chỉ là noise minh bạch.

## 4. Kết luận

Trên **cùng model + cùng endpoint**, hai harness cho **chất lượng review ngang nhau** (recall 5/5 tuyệt
đối, format đúng yêu cầu, không sửa file) trong toàn bộ 6 lượt đối chiếu. Khác biệt còn lại thuộc về
"tính cách" mỗi harness: dnt lặn sâu hơn/viết dài hơn và luôn đánh giá floating promise là High; opencode
gọn hơn, tách sạch stdout/stderr. Không phát hiện bug nào mới của dnt-harness qua phép thử này.

## 5. Tái lập

```powershell
# tiền đề: gateway :6536 đang chạy; chạy script bằng node22 (nơi có opencode-ai)
node scripts/e2e/compare-opencode-dnt.mjs --rounds 2
```

- Script tự: kiểm tra gateway (đủ model `deepseek-v4.1-flash-free`) → dựng lại lab → chạy 2 bên → chấm
  recall 5 lỗi + metrics → ghi transcript vào `%TEMP%\opencode-dnt-compare\` → exit code 0 khi mọi lượt
  exit 0 và đủ 5/5 recall mỗi bên.
- Override khi cần: `GATEWAY_BASE`, `OPENCODE_JS`, `COMPARE_WORKDIR`.
- Config tạm của opencode nằm ở `%TEMP%\opencode-dnt-compare\oc-config\opencode.json` (provider `ocproxy`).

---

## 6. Case 2 — review nhánh thật (`fix/effort-vocabulary-and-prompt-discipline`)

### 6.1 Thiết lập

- **Đối tượng**: nhánh `fix/effort-vocabulary-and-prompt-discipline` — **4 commit** so với `main` (9 file, +93/−12, có 1 merge) **cộng toàn bộ working tree chưa commit** (12 file tracked đang sửa, +906/−103, và 42 file untracked). Prompt yêu cầu review *"both the committed changes and the uncommitted work"* → cả hai bên phải xử lý đúng trạng thái hỗn hợp này.
- **Bản đóng băng**: cả hai harness review **cùng một bản sao** — worktree detached `c44486d` tại `%TEMP%\dnt-branch-review` (patch của phần tracked + copy nguyên trạng 42 file untracked; `git status --porcelain` khớp repo thật **28=28 dòng**). Mục đích: không đua với phiên ghi song song. Script snapshot 54 file trước khi chạy và **verify không drift** sau mỗi lượt.
- **Prompt** (soạn riêng cho Case 2; giữ nguyên cho cả hai bên):

> *Review this branch compared to main - both the committed changes and the uncommitted work. Focus on code and scripts (src/, tests/, scripts/); skip the plans/ folder. List every concrete issue you find, ordered by severity (high/medium/low), each with a file:line reference and a one-line fix. Do not modify any files.*

- Timeout **1500s/lượt**; chạy nối tiếp, cùng gateway/model như Case 1. Bản đóng băng không có `node_modules` → cả hai bên đều không chạy được test/tsc (đối xứng).
- Cả hai harness đều tự nạp `CLAUDE.md` của project (opencode: danh sách `AGENTS.md/CLAUDE.md/CONTEXT.md` trong `src/session/instruction.ts`; dnt: `src/harness/instructions/claude-md.ts`) → không có bất đối xứng instruction-file.

### 6.2 Kết quả

| | opencode — lượt A (mặc định) | opencode — lượt B (quyền mở) | dnt |
|---|---|---|---|
| Exit code | 0 | 0 | 0 |
| Thời gian | 50.4s | 663.5s | 893.3s |
| Tool calls | 25 | 72 | 95 |
| Findings cuối | **0 — không có câu trả lời cuối** | **16 mục** (High 2 / Medium 6 / Low 8) | **24 mục** (High 4 / Medium 8 / Low 12) |
| Sửa file trong bản đóng băng | none | none | none |
| Cách kết thúc | chết vì permission auto-reject (§6.3) | hoàn tất review đầy đủ (§6.4) | chạm trần 48 bước → vẫn giao review đầy đủ (§6.5) |

### 6.3 Lượt A — opencode tự dừng vì permission false-positive (điều tra tới source)

Chuỗi nhân quả, đối chiếu source opencode **v1.2.24** + log + session db:

1. Model chạy `for f in scripts/bench/tasks/discount-bug/…; do echo …; cat "$f"; done` — lệnh **chỉ đọc file trong project**.
2. `src/tool/bash.ts` soi lệnh dạng `cat/cd/rm/…` bằng static analysis: chạy `realpath` cho từng arg qua Git-Bash (`C:\laragon\bin\git\bin\bash.exe`). Git-Bash map `/tmp` → `%TEMP%` (log: `arg="$f" resolved=/tmp/dnt-branch-review/"$f"`), nên kết quả trả về dạng MSYS `/tmp/...` (arg là literal `"$f"` nên không bị expand).
3. `Filesystem.windowsPath()` chỉ map các dạng `/c/...`; `/tmp/...` không khớp → sau chuẩn hoá thành `\tmp\dnt-branch-review\...`; `Instance.containsPath()` không nhận ra → bị coi là **ngoài project**.
4. → xin quyền `external_directory (\tmp\dnt-branch-review\*)`. Mặc định của opencode: `external_directory → ask` (`src/agent/agent.ts` defaults).
5. Headless `opencode run` **auto-reject mọi ask** (log `~/.local/share/opencode/log/2026-10-17T003552.log`): `… permission requested: external_directory (\tmp\dnt-branch-review\*); auto-rejecting` → tool fail → `RejectedError` — theo thiết kế v1.2.24 lỗi này **kết thúc luôn phiên** (không trả về model như tool error thường).
6. Hệ quả: session `ses_eb8b6a37…` dừng ở tool call thứ 25 (50.4s); stdout chỉ có 5 dòng narration (dòng cuối: *"Let me read the untracked scripts."*); **không có review**; exit code vẫn 0.

Đây là **false positive gắn với vị trí repo dưới `%TEMP%`**: repo thật (`C:\laragon\…`) cho MSYS path `/c/laragon/…` — được map đúng — nên lớp lỗi này không lộ ra (Case 1 vì thế không thấy). Với bản đóng băng trong `%TEMP%`, mọi lệnh `cat/cd/…` chạm đường dẫn tương đối đều có thể bị phân loại "external".

**Đối sách cho lượt B**: config tạm của script thêm `permission: { external_directory: "allow", doom_loop: "allow" }` — tương đương chế độ không-hỏi của `--yolo` phía dnt. Kiểm chứng bằng source: user permission merge **sau** defaults (biến `user` trong `src/agent/agent.ts:81-88`) và `PermissionNext.evaluate` dùng **`findLast`** (`src/permission/next.ts:236-242`) → rule `allow` của rig thắng default `ask`. Script cũng được bổ sung flag `--only opencode|dnt|both` để chạy lại riêng một bên.

> ⚠️ Đây là hành vi của **opencode v1.2.24** (bản npm đang dùng), không phải của dnt-harness. Với người dùng thật: `opencode run` trên repo nằm dưới `%TEMP%` (hoặc path có mapping MSYS lạ) có thể **chết giữa chừng không có output** ngay khi model chạm một lệnh `cat/cd/…` — không retry, exit 0.

### 6.4 Lượt B — opencode với quyền mở

Chạy lại trên **đúng bản đóng băng**, chỉ khác duy nhất 3 dòng `permission` trong config tạm (`external_directory: allow`, `doom_loop: allow`); model/gateway/prompt giữ nguyên. **Hoàn tất trọn vẹn**: 663.5s, 72 tool call, exit 0, không drift, **không còn dòng `auto-reject` nào** — trong khi lượt A từng chết vì đúng loại ask này.

Bản cuối (stdout) gồm **16 finding đánh số 1–16** — High 2 / Medium 6 / Low 8 — cộng mục *"Notes on things that are not issues"* và *"Unresolved questions"* (hỏi ngược: trần bước có nên chặn input đang queue không; các seam provider option là test-only hay nên cấu hình được).

**Kiểm chứng chất lượng: 16/16 mục đúng.** Trùng với dnt: #2 ↔ dnt #1–#3 (trần `limit` "misfiled as failed"), #5 ↔ #7 (affinity), #6 ↔ #5 (responseFormat), #8 ↔ #4 (curl suite), #9 ↔ #9 (lockfile/libc), #10 ↔ #21 (cachedTokens), #11 ↔ #12 (`log.length === 49`), #14 ≈ #13 (toolCallId counter), #16 ≈ #22 (+ bench scripts ghi markdown vào `plans/`). Các mục **riêng của opencode** (dnt bỏ sót) đều là phát hiện thật:

- **#1** — `src/harness/llm/openai.ts:401-404`: khi `headerTimeoutMs` được set, listener `forwardAbort` bị remove ngay khi headers đến → **caller abort không dừng được stream giữa chừng** (body reader bám `attemptController`, không phải signal của caller).
- **#4** — `model-catalog.ts:212` + `:316-318`: thêm `'medium'` vào vocabulary DeepSeek đổi **default thinking level từ `high` thành `medium`** (main không khai báo `medium`); không test nào chốt default riêng của DeepSeek → thay đổi hành vi âm thầm, cần xác nhận ý định.
- **#7** — `scripts/e2e/compare-opencode-dnt.mjs:146` (safety-net của chính rig A/B): xử lý rename staged sai. **Đã kiểm chứng bằng thực nghiệm** (`git status --porcelain=v1 -z` trả *new-name trước, origin sau*): code cũ gán `file = origin` → snapshot bỏ qua file mới, drift của file rename **không bị phát hiện**.
- **#12** — cùng file: helper `run()` thiếu listener `'error'` → spawn fail làm promise treo.
- #13 (`provider-store.ts:10` doc stale), #15 (`--provider` không validate với enabled set), #3 (mở rộng dnt #6: toàn bộ seam `supportsPromptCacheKey/supportsStore/maxTokensField/headerTimeoutMs/wire/providerOptions` chỉ được test chạm).

Hai phát hiện trên script so sánh (#7, #12) **đã được fix trong script live** (chưa commit). Góc nhìn khác biệt đáng chú ý: opencode kết luận EFFORT_6/`applyThinkingOverride` (`model-catalog.ts:544`) *"consistent with its tests"* (⇒ không phải issue) — đúng chỗ dnt #24 lại cờ (chính sách + cast `as readonly string[]`); hai phán đoán ở hai tầng (tests-pass ≠ chính sách đúng), hữu ích đọc cạnh nhau.

### 6.5 Lượt dnt — chi tiết & chất lượng

- 893.3s, 95 tool calls, exit 0, **không sửa file** trong bản đóng băng.
- **Chạm trần `maxStepsPerTurn = 48` của chính nhánh này**: harness chèn notice *"reached its limit of model steps"*, model **vẫn viết câu trả lời cuối hoàn chỉnh trong một message** (đúng đường thiết kế "recovered"); turn kết thúc `reason='limit'` → headless in `[turn hit a limit]` (`src/bins/headless.ts:157`). Bản cuối = **24 finding đánh số 1–24** (High 4, Medium 8, Low 12); metric regex của script đếm thô 42 vì quét cả mục nháp giữa transcript.
- **Chất lượng — đã đối chiếu cả 24 mục vào code bản đóng băng: 23 đúng, 1 sai**:
  - Sai duy nhất **#20** ("kill timers never cleared on close"): cả 3 file được dẫn đều **có** `clearTimeout` trong handler `close` (`scripts/bench/run-bench.mjs:57`, `scripts/e2e/run-fake-e2e.mjs:120`, `scripts/e2e/compare-opencode-dnt.mjs:224`).
  - Lệch nhỏ số dòng: #5 (lệch 2 dòng), #11 (`:233` → thực tế `:231`).
  - Ví dụ đúng sắc sảo: **#1** (`server.ts:4447-4453` + `4470-4482`: mọi reason ≠ `completed` → `status:'failed'` + alert — đúng luôn với `limit`); **#3** (`limits.ts:116`: bật 48 mặc định); **#4** (curl suite còn mặc định store cũ `~/.mini-dsh` trong khi app đã đổi home); **#17** (test compaction 1100→1220 khớp chính xác diff); **#24** (EFFORT_6 + cast `as readonly string[]` — soi đúng feature chính của nhánh).
  - Trung thực: ghi chú cuối *"Not verified: npm test / tsc (no node_modules); memory folders host-blocked"* — không bịa kết quả test.

### 6.6 So sánh tổng hợp Case 2

- **Điều kiện đã cân bằng**: cùng bản đóng băng, cùng prompt/model/gateway; khác biệt duy nhất giữa lượt A và B là quyền (mở để tương đương `--yolo` phía dnt). Cả ba lượt đều **không sửa file** (violations: none).
- **Hiệu quả**: opencode 663.5s / 72 tool call so với dnt 893.3s / 95 — opencode nhanh hơn ~26% trên bài này và không chạm trần; dnt chạm trần 48 bước, nhưng nhờ đó harness tự chứng minh hành vi "chạm trần vẫn giao bài" (và 3 finding High của nó nói về đúng hành vi `limit`).
- **Chất lượng danh sách**: dnt 24 mục (23 đúng, 1 sai — #20, false-positive trên chính rig so sánh); opencode 16 mục (16/16 đúng theo kiểm chứng, kèm mục "not issues" + câu hỏi mở). Khoảng **10 lớp chung**: trần 48 + mapping `'failed'`, responseFormat verbatim, affinity vô điều kiện, curl suite trỏ store cũ, lockfile/libc, cachedTokens chết, `log.length === 49`, toolCallId counter, default path máy cụ thể, …
  - **~6 mục riêng của opencode**: 2 bug thật (abort mid-stream khi `headerTimeoutMs` set; rename `-z` của safety-net rig) + 1 thay đổi hành vi âm thầm (DeepSeek `high`→`medium`) + doc stale, `--provider` thiếu validate, seam option chết.
  - **~10 mục riêng của dnt**: nghiêng scripts/tests/docs và chính sách — verifier bắt token trần, va chạm port 6797/6798, excerpt lỗi HTTP có thể lộ secret vào log bền, `--config`/`--data-dir` lệch base, đổi adapter provider store, test bám con số mặc định (1100→1220), notice string bám literal, windowsHide còn thiếu ở spawn trong scripts, `bash.exe.stackdump`, góc nhìn EFFORT_6 (#24).
- **Sự cố đối xứng trớ trêu**: bản mặc định của opencode **chết đứng không output** vì false-positive permission của chính nó khi repo nằm dưới `%TEMP%` (§6.3) — Case 1 không lộ vì repo thật cho MSYS path map được; còn dnt, dù chạm trần, **luôn giao câu trả lời cuối**, với duy nhất 1 mục sai trong 24.
- **Kết luận**: không bên nào thắng tuyệt đối. opencode trội **precision** (số dòng chuẩn, bug tầng transport/cancellation) khi được cấp quyền đủ; dnt trội **độ phủ + tự chủ cuối phiên** (không bao giờ kết thúc mà không có review trong phép đo này). Như Case 1, khác biệt chủ yếu đến từ **hành vi harness** (quyền, trần bước, cách kết phiên) chứ không phải model: đọc chéo hai danh sách phủ được ~26 nhóm vấn đề với tổng cộng 1 false-positive.

### 6.7 Tái lập

```powershell
# 1) Đóng băng nhánh (pattern "frozen copy" — mô tả trong header compare-opencode-dnt.mjs):
#    git worktree add --detach <dir> <sha>  →  apply patch phần tracked (file patch ghi bằng công cụ binary-safe)
#    →  copy toàn bộ file untracked từ `git status -uall` (42 file)
# 2) Chạy lại phép đo (prompt truyền qua --prompt, nguyên văn ở §6.1):
node scripts/e2e/compare-opencode-dnt.mjs --repo %TEMP%\dnt-branch-review --timeout 1500 --rounds 1 [--only opencode]
```

---

## 7. Đề xuất fix tổng hợp cho dnt-harness (từ cả hai danh sách review)

Tổng hợp **24 mục dnt + 16 mục opencode**, khử trùng lặp và đối chiếu code; nguồn ghi theo số mục gốc (§6.4–6.5). Mục #20 của dnt đã bị bác bỏ qua kiểm chứng (timers thực tế có `clearTimeout`) nên không nằm dưới đây. Phần lớn các mục thuộc **chính nhánh đang làm (uncommitted)** — nên chốt trước khi commit nhánh.

### 7.1 Ưu tiên cao (hành vi `limit` + bug hủy stream + an toàn store)

1. **`limit` bị ghi nhận là thất bại**: automations map mọi reason ≠ `completed` → `status:'failed'` + alert dù đã có câu trả lời wrap-up — `src/web/server.ts:4447-4453`, `4470-4482` (`src/harness/agent/agent.ts:543-546`). Fix: coi `limit` là "done-with-summary" trong projection. *[dnt #1, oc #2]*
2. **Input đang queue bị treo sau `limit`**: UI báo `'preparing'` + QueuedBar hứa "queue sẽ chạy khi kết thúc" nhưng run đã stop (`agent.ts:316`) — `web/lib/project.ts:919`. Fix: thêm `'limit'` vào nhánh giữ `cancelled|interrupted`; chốt luôn ngữ nghĩa queue khi `limit` (câu hỏi mở của oc). *[dnt #2, oc]*
3. **Default `maxStepsPerTurn = 48` quá thấp**: cắt ngang turn hợp lệ (chính lượt review này chạm trần) và theo #1 bị đánh dấu thất bại — `src/harness/limits.ts:116`. Fix: về `0` (tắt) hoặc nâng trần tới khi mapping outcome chốt; thêm test turn dài thật. *[dnt #3, oc #2]*
4. **Cancel giữa stream không hoạt động khi `headerTimeoutMs` được set**: `forwardAbort` bị remove ngay khi headers đến — `src/harness/llm/openai.ts:401-404`. Fix: giữ forwarding tới hết stream (outer `finally`) hoặc race reader với signal của caller. *[oc #1 — bug thật, dnt bỏ sót]*
5. **curl suite thao tác trên store sống nhưng backup/no-op sai chỗ**: mặc định `~/.mini-dsh/providers.json` trong khi home là `.dnt-harness` — `scripts/e2e/curl-api-suite.mjs:23`. Fix: mặc định theo `resolveAppHome()`, `.mini-dsh` chỉ là fallback. *[dnt #4, oc #8]*

### 7.2 Trung bình

6. **`responseFormat` forward verbatim, trái hợp đồng "drop unknown"** — `src/harness/llm/openai.ts:209-211`. Fix: validate `{type:'json_schema',…}` hoặc drop. *[dnt #5, oc #6]*
7. **Các seam provider option chỉ được test chạm** (`supportsPromptCacheKey/supportsStore/maxTokensField/headerTimeoutMs/wire/providerOptions` không host path nào set) — `types.ts:152-156`, `headless.ts:319-327`, `server.ts:933-940`. Fix: stamp từ `ProviderConfig` hoặc xóa tới khi có caller thật. *[dnt #6, oc #3]*
8. **`x-session-affinity` gửi vô điều kiện tới mọi provider** — `server.ts:3964` + `openai.ts:389`. Fix: gate theo declared support, hoặc hash session id. *[dnt #7, oc #5]*
9. **`isOpenAiNative` khớp theo tên provider chứa `'openai'`** — `openai.ts:134`. Fix: chỉ theo host, hoặc option tường minh. *[dnt #8]*
10. **Thêm `'medium'` đổi default thinking DeepSeek `high`→`medium` âm thầm** — `model-catalog.ts:212` + `:316-318`. Fix: chốt default mong muốn + assert trong test. *[oc #4]*
11. **Lockfile churn (npm khác version xoá `libc`)** — `package-lock.json` (~20 chỗ). Fix: regenerate bằng npm của dự án (dự án dùng pnpm). *[dnt #9, oc #9]*
12. **Verifier bench bắt token trần `no|not|doesn't|isn't`** — `run-bench.mjs:100`, `ab-prompt.mjs:54`. Fix: đòi wording tường minh + đối chiếu tool sequence. *[dnt #10]*
13. **Va chạm port e2e 6797/6798** — `run-real-e2e.mjs:32`, `run-fake-e2e.mjs:231,247`, `ab-wire-compat.mjs:34`. Fix: bind port 0 + đọc lại port đã cấp. *[dnt #11]*
14. **`log.length === 49` bám default trần** — `run-fake-e2e.mjs:174`. Fix: derive từ `DEFAULT_LIMITS`. *[dnt #12, oc #11]*

### 7.3 Thấp / vệ sinh (làm khi tiện)

15. `toolCallIdReissues` là process-global — `openai.ts:176-186`: instance field hoặc bỏ. *[dnt #13, oc #14]*
16. `httpErrorExcerpt` có thể ghi secret relay vào log bền — `openai.ts:606-633`: redact trước khi ghi. *[dnt #14]*
17. `--config`/`--data-dir` lệch base (homedir vs cwd) — `headless.ts:96,100`: cùng base hoặc log cặp đã resolve. *[dnt #15]*
18. Store provider bị ép `OpenAiCompletionsProvider` (mất adapter DeepSeek cũ) — `headless.ts:181-183`: giữ adapter theo `entry.id` hoặc document wire change. *[dnt #16]*
19. Test compaction bám con số 1100→1220 (coupling prompt length) — `g3-compaction.spec.ts:480`: tính floor từ system prompt. *[dnt #17]*
20. `fake-gateway` khớp literal notice `'reached its limit of model steps'` — `fake-gateway.mjs:90`: truyền kỳ vọng qua env. *[dnt #18]*
21. Spawn `node` thiếu `windowsHide: true` trong scripts e2e — `run-fake-e2e.mjs:74-78,105-113`, `run-real-e2e.mjs:71`, `repro-toolid.mjs:63`: thêm. *[dnt #19]*
22. `cachedTokens ?? cachedInputTokens` chết — `run-bench.mjs:191`: chọn key theo run thực tế. *[dnt #21, oc #10]*
23. Default path máy cụ thể (`C:\laragon\…`) — `run-bench.mjs:19`, `ab-prompt.mjs:20-21`, `ab-wire-compat.mjs:19`: env-only hoặc discover; cân nhắc không ghi report vào `plans/` từ script bench. *[dnt #22, oc #16]*
24. `bash.exe.stackdump` ở repo root: xoá + thêm `*.stackdump` vào `.gitignore`. *[dnt #23]*
25. **Chính sách EFFORT_6**: vocabulary đầy đủ đang áp cho mọi id chứa `deepseek` (kể cả alias gateway) + cast `as readonly string[]` — `model-catalog.ts:212,544`: gate theo đúng vendor ID, dùng list typed thay cast. *[dnt #24 — oc cho là "consistent with tests"; cần chốt chính sách]*
26. Doc stale `provider-store.ts:10` ("sent as `max_tokens`" — giờ detection-dependent): cập nhật comment. *[oc #13]*
27. `--provider` không validate với enabled set — `headless.ts:194-234`: error sớm khi không tồn tại/không enabled. *[oc #15]*

### 7.4 Đã fix ngay trong session này (rig so sánh — chưa commit)

- `scripts/e2e/compare-opencode-dnt.mjs:146` — xử lý rename `-z` (giữ new-name, chỉ consume origin). *[oc #7]*
- `scripts/e2e/compare-opencode-dnt.mjs:239-259` — thêm `child.on('error')` cho helper `run()`. *[oc #12]*

> Trạng thái: đây là **đề xuất**, chưa thực thi (trừ 7.4). Thứ tự gợi ý: 7.1 → 7.2 → 7.3.
