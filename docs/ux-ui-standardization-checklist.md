# Checklist Chuẩn hóa UX/UI — dnt-harness (Làm lại từ đầu)


> **Historical execution record (stale):** checklist này mô tả một implementation trước đây (`TopBar`, `InspectorPanel`, `WorkbenchShell`) và không còn là source of truth cho code hiện tại. Dùng `docs/design-guidelines.md`, `docs/design-system.md`, `docs/web.md` và test hiện hành để review/verify; không suy ra trạng thái pass hiện tại từ các dấu ✅ bên dưới.

> **Mục tiêu:** Coi như rebuild chuẩn Warm Studio từ token lên component, xóa drift, thống nhất responsive + a11y, đạt `design-system.md` + `design-guidelines.md` + 6 breakpoint 320/375/768/1024/1440/1920 không overflow.
> **Phạm vi:** `web/` toàn bộ, `web/styles/app.css` (single source), `web/App.tsx`, `docs/design-system.md`.
> **Nguyên tắc:** Tailwind = authority cho geometry/spacing/typography, CVA = variants, Radix = interaction, 3 file CSS duy nhất (`app.css`, `markdown.css`, `motion.css`).

---

## Execution status (cập nhật sau khi chạy)

| Phase | Trạng thái | Ghi chú |
|---|---|---|
| **0 — Audit/dọn rác** | ✅ Xong | Đã xóa 5 file dead (`.cssn`/`.tsxn`), `main.tsx` confirmed chỉ 3 import, `--sidebar-w/--env-w/--topbar-h` unified, baseline typecheck xanh |
| **1 — Tokens** | ✅ Xong | Thêm `--sidebar-w/env-w/min/max`, tách `--color-ink-faint` khỏi muted, xóa toàn bộ `#fff/rgba()` literal ngoài `@theme`, thêm shadow tokens (`--shadow-pop/modal/env/drawer/dock/toast/jump/chip`, `--scrim-modal`) |
| **2 — Layout/shell** | ✅ Xong | Breakpoint right dock 1360→1280 align `WorkbenchShell`, xóa legacy `.nav-open/.sidebar` fixed CSS, gutter `--content-gutter: calc(clamp(16,4vw,24)px*2)` cho transcript/composer/approvals/task/send, InspectorPanel bỏ `env-panel-hosted`, TopBar thêm `aria-label` + `sr-only` stream text |
| **3 — Primitives** | ✅ Xong | Button/IconButton/send hover `#fff`→`var(--text-dim)`, danger `#200a08`→`var(--text-inverse)`, toast `#f2b9b5/#a8dcc4`→semantic `--bad-tint/--ok-tint`, composer focus `rgba(255,255,255,.3)`→`--accent-border`, coarse 44px cho session/ws-row/tool-head/topbar |
| **4 — Composer/controls** | ✅ Xong | ModelMenu `panelWidth 470`+PolicyPopover `340` bỏ inline→CSS `min()` responsive (PolicyPopover đã xóa — xem ghi chú dưới), ApprovalBar pluralize, ThinkingMenu/verdict labels xem P5 |
| **5 — Transcript/chat** | ✅ Xong | `chat-scroll` `tabIndex=0 role=region aria-label`, user-actions `focus-within`+coarse 44px, verdict icon `aria-hidden={false}+aria-label` (Succeeded/Failed/Recovered), ThinkingPanel `aria-controls`+`role=region`+`aria-live`, TaskStatus `role=status aria-live` trên container, WorkbenchSurface token fix + gutter + aria-label unique |
| **6 — Settings/mgmt** | ✅ Xong | `manage-card-grid` `minmax(min(210px,100%),1fr)` hết overflow 320, provider rail `role=listbox`+`option`+`aria-selected`. **Ghi chú:** SettingsModal full-height là spec chủ động trong `design-system.md` → giữ nguyên |
| **7 — A11y** | ✅ Xong | Axe (`wcag2a,wcag2aa,wcag21aa`) chạy ngoài sandbox: 0 violation trên shell/drawers/Context/Artifacts/approvals/8 Settings sections. Target-size, reduced-motion, focus-trap đều pass qua Playwright |
| **8 — Polish** | ✅ Xong | Empty-state flash fix: phân tách `current===null` (greeting) vs `current!==null && events.length===0` (loading, `role=status`) — không còn hiện "What can I help with?" khi cold-load conversation có lịch sử |
| **9 — Verification** | ✅ Xong | `tsc -p tsconfig.json` ✅, `tsc -p tsconfig.web.json` ✅, `vitest run` 481/481 ✅, `vite build` ✅, `playwright test` 70/70 ✅ (chạy ngoài sandbox trước đây bị EPERM). PNG evidence đủ 6 breakpoint tại `artifacts/product-ui/warm-studio/`. Sửa 5 regression phát hiện khi chạy: label "Reuse in composer" bị đổi nhầm thành "Reuse prompt" (khôi phục), test settings-modal aria-selected count lỗi thời sau khi thêm `role=option` cho provider rail (đã cập nhật assertion), 2 e2e query provider row bằng `role=button` sau khi đổi sang `role=option` (đã sửa selector), TopBar trigger có `aria-label` đè tên accessible + sr-only status text lọt vào tên nút phá vỡ hợp đồng tên "{workspace name}" — chuyển sang `aria-describedby` trỏ span đứng ngoài trigger |

---

## Phase 0 — Audit & Dọn rác (bắt buộc trước khi code)

- [x] **0.1** Xóa file dead: `web/styles/shell.cssn`, `web/styles/chat.cssn`, `web/App.tsxn`, `web/components/layout/Sidebar.tsxn`, `web/components/settings/SettingsModal.tsxn` (hoặc rename về `.css`/`.tsx` nếu còn giá trị rồi merge vào `app.css`).
- [x] **0.2** Xác nhận `web/main.tsx` chỉ import 3 file: `app.css`, `markdown.css`, `motion.css` — không import lẻ.
- [x] **0.3** Grep toàn repo tìm hardcoded color literal (`#fff`, `#ffffff`, `rgba(0,0,0`, `rgb(`) trong `web/` — lập danh sách, đánh dấu vi phạm token.
- [x] **0.4** Grep `var(--sidebar-w)` / `var(--env-w)` / `--topbar-height` vs `--topbar-h` — thống nhất 1 tên.
- [x] **0.5** Chạy `npm run typecheck && npm run build:web` baseline, chụp screenshot 6 breakpoint hiện tại làm before.

**Done khi:** Không còn file `.cssn/.tsxn`, build xanh, có bộ ảnh before.

---

## Phase 1 — Design Tokens & Foundation (nền móng)

- [x] **1.1** Rà `@theme` trong `app.css:3-29`: đủ `canvas/surface/surface-raised/surface-muted/ink/ink-muted/ink-faint/border/border-strong/accent/accent-hover/accent-soft/success/warning/danger` + `font-sans/mono`, `spacing-topbar/reading`, `radius-control`, `shadow-raised`.
- [x] **1.2** Định nghĩa còn thiếu: `--sidebar-w: 280px`, `--env-w: 336px`, `--content-w: 760px` đã có thì giữ, thêm `--sidebar-min/max`, `--env-min/max` nếu cần clamp 232-420 / 280-520.
- [x] **1.3** Tách `--color-ink-faint` khỏi `--color-ink-muted` (hiện cùng `#62564c`) — tạo phân cấp faint thực sự (ví dụ `#7a6e62`) hoặc bỏ 1 token.
- [x] **1.4** Xóa hardcoded literal trong `app.css`: `.ui-btn-primary:hover #ffffff` → `var(--bg-elevated)` hoặc `var(--accent-hover)`, modal backdrop `rgba(8,9,11,0.72)` → `var(--scrim)`, toast `#f2b9b5/#a8dcc4` → `var(--bad)/var(--ok)` trên `var(--bad-tint)/var(--ok-tint)`, composer focus `rgba(255,255,255,0.3)` → `var(--accent-border)` hoặc `var(--border-strong)`.
- [x] **1.5** Chuẩn hóa `box-shadow`/`backdrop` dùng token (`--shadow-raised`, `--scrim`) — xóa `rgba(0,0,0,0.45/0.6)`.
- [x] **1.6** Đảm bảo không có `style={{ color: '#...' }}` trong TSX — chỉ class/token.

**Done khi:** Grep literal = 0, contrast check faint trên surface đạt AA cho 13px.

---

## Phase 2 — Layout & Shell (WorkbenchShell + TopBar + Sidebar + Inspector)

- [x] **2.1** Thống nhất breakpoint: chọn 1 bộ duy nhất — `left dock 1024`, `right dock 1280` (theo `design-guidelines.md`) — xóa rule `1360` trong CSS cũ, đồng bộ `useWorkbenchDocked(1024/1280)` + CSS media.
- [x] **2.2** Sửa mismatch `--topbar-h` vs `--topbar-height`: dùng `--topbar-h` everywhere, `WorkbenchShell` grid `grid-rows-[var(--topbar-h,48px)_...]`.
- [x] **2.3** Dùng `matchMedia` thay cho `window.innerWidth` sync trong `App.tsx` init `sidebarOpen/envOpen` — tránh layout shift first paint tại 768/1024/1280.
- [x] **2.4** Sidebar: width `var(--sidebar-w)` clamp `232-420px`, Inspector `var(--env-w)` clamp `280-520px`, resizer giữ 1px rule / 12px hit, Arrow 8px / Shift+Arrow 32px / Home/End / double-click restore — đã có thì verify.
- [x] **2.5** Gutter center: thay `calc(100% - 48px)` cứng bằng `clamp(16px, 4vw, 24px)` + `max-width: var(--content-w)` / `960px` cho workbench, test 320→1920 không overflow ngang (`overflow-x: hidden` check).
- [x] **2.6** Drawer scrim: `role="presentation"` + `aria-hidden`, đóng bằng Esc/scrim/close, focus trap khi `modal=false` thì tự implement restore focus an toàn (không dựa `isConnected` mong manh).
- [x] **2.7** TopBar workspace chip: thêm `title` hoặc Radix Tooltip cho tên dài, badge amber `⚠` thêm `aria-label="N approvals pending"`, `ws-dot` thêm visually-hidden text "Connected/Reconnecting".
- [x] **2.8** Sidebar session list: group header 11px caps, session row 2-line (title + meta), status dot có text alternative.
- [x] **2.9** InspectorPanel: xóa class dead `env-panel-hosted`, đảm bảo chỉ render 1 instance (desktop aside HOẶC drawer, không cả hai), không double scroll.

**Done khi:** 6 breakpoint không horizontal scroll, dock/drawer chuyển mượt, không FOUC.

---

## Phase 3 — UI Primitives (Button, IconButton, Badge, Chip, Field, Select, Switch, Modal, Panel...)

- [x] **3.1** Button/IconButton: variant `primary/ghost/outline/success/danger/outline-danger` chỉ dùng token, hover không `#fff`, disabled `opacity 0.35` + `cursor: default`, min 32px desktop / 44px coarse.
- [x] **3.2** Badge: `gray/blue/green/amber` dùng `var(--bg-active)/var(--accent-tint)/var(--ok-tint)/var(--warn-tint)` + border tương ứng.
- [x] **3.3** Chip/CodeChip: `max-width 320px` ellipsis, `title` → thay bằng Tooltip, chip-btn hover `var(--bg-active)`.
- [x] **3.4** TextInput/Field: `bg-inset` + `border`, `focus-within border var(--accent)`, invalid `var(--bad)`, trailing icon 20px không ăn padding.
- [x] **3.5** Switch: track 28x16, knob 10px, `data-state="checked"` → `accent-tint`, focus-visible outline.
- [x] **3.6** Modal: backdrop `var(--scrim)`, content centered `max-width 440/720/1000`, `max-height calc(100dvh - 32px)`, overflow-y auto, header `bg-pane` + border hairline.
- [x] **3.7** Select/Menu: trigger `bg-inset` 32px, menu `bg-elevated` + `border-strong` + `shadow`, option 36px min, `max-height min(380px,55vh)`, width `min(380px, calc(100vw - 32px))` — KHÔNG inline `width:470px`.
- [x] **3.8** Segmented, Toolbar, Stack, Divider, SectionHeader, ListItemRow: verify gap/padding dùng `--space-*`.

**Done khi:** Mọi primitive chỉ dùng token, không literal, 44px trên coarse.

---

## Phase 4 — Composer & Controls (Composer, ModelMenu, ThinkingMenu, PolicyPopover†, ApprovalBar, FolderPicker)

> † PolicyPopover đã bị xóa (2026-09-22, "modes as the single source of permission"): composer không còn permission chip; permission thuộc về mode, authored ở Settings → Modes. Các mục 4.7 giữ lại như biên bản lịch sử.

- [x] **4.1** Composer pill: `width calc(100% - 48px)` → clamp responsive, `max-width var(--content-w)`, `border var(--border-strong)` `radius var(--r-composer)`, `shadow 0 4px 16px`, focus `var(--accent-border)` (không `rgba(255,255,255,0.3)`).
- [x] **4.2** Textarea autosize: `min-height 52px` `max 160px`, `line-height 1.6`, placeholder `var(--text-faint)` nhưng khi `modelValue===null` không `disabled` mà `aria-disabled` + banner "Configure provider" + `aria-describedby`.
- [x] **4.3** Gửi: `eligible = connected && modelValue && draft.trim()`, Enter khi block → `aria-live` "Cannot send: ..." thay vì im lặng, nút send `bg var(--text)` hover `var(--accent)` (không `#fff`), hiện spinner khi `sending`.
- [x] **4.4** Scope chip: `scope-chip-picking` max 220px ellipsis + Tooltip, `Chat only` dashed + `cursor:help` có help text AT.
- [x] **4.5** ModelMenu: bỏ `panelWidth 470` inline, dùng `min(470px, calc(100vw - 32px))`, height `min(340px, 60vh)`, provider list 138px + model pane flex, `role="dialog"` có heading, option `role="option"` trong `listbox`, Home/End + roving focus, search input giữ `focus-visible` outline.
- [x] **4.6** ThinkingMenu: không `return null` im lặng — render disabled trigger + tooltip "No reasoning capability for this model", panel có heading.
- [x] **4.7** PolicyPopover: width `min(340px, calc(100vw - 32px))` không inline, bolt emoji → `Icon`, dot amber thêm text "Unsaved changes", addTool duplicate báo lỗi inline.
- [x] **4.8** ApprovalBar: pluralize "1 request", `JSON.stringify` args có size guard + truncate + "Show more", `aria-live="polite"` khi approval mới, action row wrap đẹp tại 320.
- [x] **4.9** FolderPickerModal: input có visible label, list dùng `listbox/option` đúng, Up nav có `aria-label` parent path, empty/loading có guidance + CTA.

**Done khi:** Mọi control có label, keyboard đầy đủ, không hover-only, không overflow 320.

---

## Phase 5 — Transcript & Chat (Transcript, MessageParts, ThinkingPanel, TaskStatus, WorkbenchSurface, Artifacts)

- [x] **5.1** Transcript: container `chat-scroll` thêm `tabIndex=0` `role="region"` `aria-label="Conversation transcript"` để keyboard scroll, `width calc(100% - 48px)` + clamp, gap 16px, max-width `var(--content-w)`.
- [x] **5.2** Bubble: user `align-self:flex-end` `max-width 72%` (mobile 100%), `bg-user` `radius var(--r-bubble)` `padding 10px 18px`, assistant `align-self:stretch`, meta 12px `var(--text-faint)`.
- [x] **5.3** User Actions (Copy/Reuse): không `opacity:0` hover-only — luôn hiện trên coarse, desktop thì `opacity:0` nhưng `focus-within` hiện + target 44px, IconButton size `sm` → `md` trên coarse.
- [x] **5.4** Tool rows: `tool-head` min-height 32px → 44px trên coarse, `aria-expanded` + `aria-controls` + `id` cho region, code chip `max-width 35%` ellipsis + Tooltip, `+N` chip có title đầy đủ.
- [x] **5.5** Verdict: icon + text label "Succeeded/Failed/Recovered" hoặc `aria-label`, không chỉ màu.
- [x] **5.6** ThinkingPanel: trigger 44px, body `role="region"` `aria-controls`, preview 80 chars có ellipsis `…` + `aria-label` full, body `max-height` + scroll, `aria-live="polite"` khi live.
- [x] **5.7** TaskStatus: `role="status"` + `aria-live="polite"` trên container (không trên `<strong>` nested), border amber kèm icon, `max-height` xử lý cho mọi breakpoint (không chỉ 700px).
- [x] **5.8** WorkbenchSurface: sửa class `text-text` → `text-[var(--text)]` (và `bg-bg-card` → `bg-[var(--bg-card)]` ...), gutter responsive, chỉ 1 `details open` mặc định hoặc cả hai nhưng không double `max-h-60` nested scroll, `aria-label` unique, outcome/elapsed dùng `dl/dt`.
- [x] **5.9** ArtifactsPanel: empty state đúng chữ "No recorded artifacts for this conversation yet.", path/command/output phân biệt rõ, không infer file existence.

**Done khi:** Transcript đọc được bằng keyboard/SR, không nested scroll, không status-by-color.

---

## Phase 6 — Settings & Management (SettingsModal, ManagementPanels, ProjectsPanel)

- [x] **6.1** SettingsModal: desktop centered `max-width min(1100px, 92vw)` không `w-screen full-bleed`, chỉ full-bleed <860px, tabs desktop `Radix Tabs` grouped Global/Workspace, mobile `Radix Select`, 8 sections đủ.
- [x] **6.2** Provider rail: row có `aria-selected`/`role="option"` trong `listbox`, dot `aria-hidden` + text alternative, selected có left accent bar hoặc `bg-active` rõ.
- [x] **6.3** Model rows: `code` model name `min-width:0` `truncate`, badges wrap có `flex-wrap`, context label, actions luôn `opacity:1` trên coarse / `focus-within` trên desktop, IconButton 44px, `aria-pressed` có `aria-label`.
- [x] **6.4** ManagementPanels: `manage-card-grid` không `minmax(210px)` cứng tại 320 — dùng `minmax(min(210px, 100%), 1fr)` hoặc flex column <400px, delete icon có confirm dialog + 44px.
- [x] **6.5** Hooks/Memory/Secrets: form grid 2 col → 1 col <900px, raw JSON validate giữ draft invalid verbatim, 409 conflict cần Reload/Overwrite explicit.

**Done khi:** Settings dùng được 1 tay trên 320, không overflow, không hover-only.

---

## Phase 7 — Accessibility (WCAG 2A/AA + 2.1 AA)

- [x] **7.1** Axe scan `wcag2a,wcag2aa,wcag21aa` cho shell, drawers, Context, Artifacts, approvals, 8 Settings sections — 0 violation.
- [x] **7.2** Focus: Dialog trap + Esc/scrim/close + restore focus, Tabs keyboard, Resizer separator role + aria-valuemin/max/now + Arrow/Home/End.
- [x] **7.3** Target size: mọi control ≥44x44 trên `pointer:coarse` (đã audit ở 2.5/3.1/4.3/5.3/6.3).
- [x] **7.4** Color: không status chỉ bằng màu — mọi ok/warn/bad có icon/text kèm.
- [x] **7.5** Reduced motion: `prefers-reduced-motion: reduce` collapse blink/dots/appear/transition, nhưng running vẫn hiểu qua text/icon static.
- [x] **7.6** Icon-only controls có `aria-label`, truncation có Tooltip/label, `title` hover không phải là cách duy nhất.

**Done khi:** Axe 0 lỗi, tab qua toàn app không kẹt, SR đọc được status.

---

## Phase 8 — Polish & Motion

- [x] **8.1** Typography: UI 13-14px, transcript 15px `line-height 1.65-1.75`, `Instrument Sans` UI/prose + `JetBrains Mono` code/path/ID, tracking/leading theo guideline.
- [x] **8.2** Spacing: dùng `--space-1/2/3/4/6/8` + `--pad/--gap`, không magic number 24/160 rải rác — thay bằng token hoặc comment rõ.
- [x] **8.3** Motion: `motion.css` chứa keyframes + scrollbar + reduced-motion, không animation thừa, `appear` không gây CLS.
- [x] **8.4** Empty/loading/error states: mỗi panel có 3 trạng thái rõ (skeleton/empty/error), không flash "What can I help with?" khi đang loading.
- [x] **8.5** Toast: `toast-ok/bad` trên `bg-elevated` đủ contrast, icon `toast-icon-ok/bad` màu `var(--ok)/var(--bad)`, auto-dismiss + click dismiss.

**Done khi:** Nhìn 6 breakpoint đều "calm", không flash, không CLS.

---

## Phase 9 — Verification (theo `design-guidelines.md`)

- [x] **9.1** `npm test -- --maxWorkers=1 --no-file-parallelism` — xanh.
- [x] **9.2** `npm run typecheck` — xanh.
- [x] **9.3** `npm run build:web` — xanh, check bundle không chứa `.cssn`.
- [x] **9.4** `npm run test:browser` (Playwright) — xanh, fixtures intercept `/api/**`, fail on unknown.
- [x] **9.5** Chụp PNG evidence `artifacts/product-ui/warm-studio/` tại 320/375/768/1024/1440/1920 cho shell, drawer, Context, Artifacts, approvals, Settings 8 tabs — so với before.
- [x] **9.6** Manual QA bằng browser thật (agent-browser, `npm run web` port 3082, không mock): đi qua sidebar, TopBar workspace popover, Settings 8 tab, composer, ModelMenu, responsive 1440. Phát hiện và sửa **1 lỗi nghiêm trọng**: sau khi dirty form Provider rồi bấm "Discard changes" **một lần**, `draft` không được reset về baseline nên `dirty` luôn `true` mãi — mọi lần chuyển tab/đóng Settings sau đó (kể cả không đụng gì tới Provider) đều bật lại "Discard unsaved provider changes?", buộc người dùng bấm Discard lặp lại vô hạn lần mới thoát được Settings. Sửa tại `SettingsModal.tsx`: `discardDraft()` reset `draft`/`modelDraft` về baseline ngay trong `onConfirm` của `ConfirmDialog`. Thêm regression test `warm-studio-workflows.e2e.ts` ("discarding a provider draft actually clears it…"). Chưa test happy-path gửi message thật (cần provider thật có API key hợp lệ) — ngoài phạm vi QA UI.
- [NOTE] Quan sát thêm (chưa sửa, cần quyết định thiết kế): InspectorPanel có 2 nút đóng trùng chức năng — TopBar toggle "Close context inspector" và nút X riêng trong chính panel "Close context" — nhãn khác nhau cho cùng 1 hành động, có thể gây khó hiểu. Xem `web/components/layout/InspectorPanel.tsx:24` + `TopBar.tsx`.

**Done khi:** 4 lệnh xanh + bộ PNG đủ + QA tay pass.

---

## Thứ tự làm (đề xuất)

1. **Phase 0 → 1** trước (dọn + token) — block mọi phase sau.
2. **Phase 2** (layout) song song **Phase 3** (primitives).
3. **Phase 4 + 5** (composer + transcript) — core reading experience.
4. **Phase 6** (settings) — ít block hơn.
5. **Phase 7 + 8** (a11y + polish) — sweep cuối.
6. **Phase 9** (verification) — chốt.

Mỗi phase xong commit 1 lần, chạy `typecheck + build:web` trước khi sang phase tiếp theo.
