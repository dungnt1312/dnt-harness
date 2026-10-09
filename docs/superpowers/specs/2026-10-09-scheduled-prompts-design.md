# Automations: scheduled prompts with Web Push

Status: approved. The user delegated the remaining decisions on 2026-10-09 ("chốt theo đề xuất, làm nốt tự động").

## Goal

The user schedules work for the agent. Two examples: "remind me to take my
medicine at 07:00", and "at 08:30 every day, summarize yesterday's mail and
draft today's to-do list". Each time a schedule fires, the agent runs the
prompt in a **fresh session**. The result reaches the user's phone as a **Web
Push** notification through the installed PWA.

## Decisions

| Topic | Decision |
|---|---|
| Where it runs | In the web server process (approach A). There is no launchd integration and no separate daemon. Schedules only fire while the host runs. |
| Execution unit | One new root session per run, in the automation's project, with the automation's mode, model and thinking level. Title: `⏰ {title} · dd/MM HH:mm`. |
| Schedules per task | A task can have several schedules (`schedules: [{ cron }]`). It fires at the earliest due one. |
| Schedule input | Friendly rules, so no one needs to know cron syntax: Once (date + time), Every few minutes / hours (optional "only between" hour window and day chips), Every day / weekday / week (day chips and several times), Every month (day or last day), and Custom cron as an escape hatch. The rules are stored as `{ cron }` or `{ at }` and evaluated in the host timezone (`web/lib/automation-schedule.ts` maps both ways). |
| End condition | Recurring plans end Never, After N runs (`maxRuns`, counting only runs that started) or On a date (`endsAt`, end of that local day). When nothing is left to run, the task turns itself off and shows as Finished. Create and enable refuse a plan with no future runs. Editing the plan resets the run count. |
| Missed runs | On boot and on wake: if the latest missed due time is within `catchUpMinutes` (default 120), run once; otherwise record `missed`. Several missed due times never cause several runs. |
| Overlap | If the previous run of the same automation is still busy, record `skipped-busy`. |
| Unattended approvals | The automation's mode decides. When the agent waits on an approval or a question, push "needs your approval" and record `needs-approval`. |
| Notification | Web Push with VAPID, sent to every subscribed device. Done shows the title and about 140 chars of the last assistant message (markdown stripped). Failures also notify. Clicking opens the run's session. |
| Notify switch | Each automation has a `notify` flag (on by default) and `notifyTargets`: `'push'` and/or channel ids, chosen as toggle chips in the editor. `null` (older rows) means push plus every enabled channel. When notify is on, the final reply goes to the selected targets: Web Push gets a ~140-char excerpt that opens the session, and channels get the full text. When it is off, a successful result stays only in the conversation. Failures and waiting approvals always go to the selected targets. A channel that is turned off globally is skipped even if it is selected. |
| Channels | Host-global `<home>/notify/channels.json` (0600), managed in the Notifications card of the Automations view. Supported: a **Telegram bot** (`botToken` and `chatId`, using `sendMessage` as plain text), a **Microsoft Teams** webhook (a Workflows or Incoming Webhook URL, posted as an Adaptive Card) and a **Discord** webhook (`content` with `allowed_mentions: { parse: [] }`). Secrets are write-only: the API returns a masked summary, and saving an edit with a blank field keeps the saved value. Adding a channel sends a test message. |
| Agent context | Before the prompt, the run injects an `origin: 'context'` block (`automationContext()`). It tells the agent that the task is unattended, that it should not ask questions, whether its approvals would block, and that its final reply is delivered as the notification (listing the channels). It also asks the agent to lead with the result in one or two short sentences. |
| Run now | Runs immediately and also sends a push. It does not shift the schedule. |
| Cleanup | Sessions created by runs are never auto-deleted. |
| Libraries | `croner` (cron math with timezones, no dependencies) and `web-push` (VAPID and payload encryption). |

## Data

`<home>/workspaces/<ws>/automations.json`, written atomically (temp file then rename):

```jsonc
{ "v": 1, "automations": [{
  "id": "auto-…", "title": "Uống thuốc", "prompt": "Nhắc anh uống thuốc",
  "schedules": [{ "cron": "0 7 * * *" }, { "at": 1791532800000 }],
  "endsAt": null, "maxRuns": 20, "runCount": 3,
  "projectId": "proj-…" | null, "modeId": "ask-before-changes",
  "controls": { "provider": "zcode", "model": "GLM-5.3", "thinkingLevel": "max" } | null,
  "enabled": true, "catchUpMinutes": 120,
  "lastDueAt": 1791500000000,      // last due instant handled (fired/missed/skipped)
  "createdAt": 0, "updatedAt": 0
}]}
```

`<home>/workspaces/<ws>/automation-runs.jsonl` is append-only, one line per state change:
`{ v:1, runId, automationId, dueAt|null, at, status, sessionId?, error? }`.
The statuses are `started`, `done`, `failed`, `needs-approval`, `missed` and
`skipped-busy`. History is built by folding the lines by `runId`, keeping the
last status.

`<home>/push/vapid.json` (mode 0600) holds the key pair generated on first use.
`<home>/push/subscriptions.json` holds the device list
`[{ id, endpoint, keys, label, createdAt }]`. Push is host-global, not per workspace.

## Server

- `src/web/automations.ts` contains the store, the cron helpers (`nextRuns`,
  `latestDueBetween`, `describe`) and the `AutomationScheduler`. The scheduler
  gets injected `now()`, `setTimer`, and `fire(automation, dueAt|null)`, so it
  can be unit-tested with a fake clock.
  - It keeps one timer aimed at the earliest next due time across all enabled
    automations, capped at 1 hour so sleep and wake recompute.
  - On each tick, for each automation whose latest due time in `(lastDueAt, now]`
    is set: if `now - due <= catchUpMinutes` it fires, otherwise it records `missed`.
    `lastDueAt` advances either way.
  - A new automation starts with `lastDueAt = createdAt`. It never back-fires.
- `src/web/push.ts` handles VAPID keys, subscriptions and
  `send(payload)`. It drops a subscription that answers 404 or 410.
- `src/web/server.ts`:
  - It extracts `createRootSession(deps, wsId, { projectId, controls, modeId? })`
    out of `POST …/sessions`, and `submitMessage(entry, deps, { content, … })`
    out of `acceptMessage`. HTTP handlers and the scheduler share them.
  - The run watcher subscribes to `session/event` for run sessions. `turn/end`
    marks the run `done`, `turn/error` marks it `failed`, and a pending
    approval or question marks it `needs-approval`. Each change pushes a
    notification.
  - Routes (same auth and CSRF as other routes):
    - `GET|POST /api/workspaces/:ws/automations`
    - `GET|PATCH|DELETE /api/workspaces/:ws/automations/:id`
    - `POST …/automations/:id/run`
    - `GET …/automations/:id/runs`
    - `POST /api/automations/preview` takes `{ cron }` and returns `{ next: [ms…], error? }`
    - `GET /api/push/key`
    - `GET|POST /api/push/subscriptions`
    - `DELETE /api/push/subscriptions/:id`
    - `POST /api/push/test`
  - The scheduler starts with the server and stops in `close()`.

## Web

- **Sidebar**: an **Automations** row below "New conversation".
- **Route** `/workspaces/:ws/automations[/:id|/new]` replaces the main column
  with the Automations view.
- **List view**:
  - a notification card (enable on this device, send a test, iOS
    "Add to Home Screen" hint when not standalone)
  - a "New scheduled task" button
  - one row per automation: title, schedule description, next run, last
    status, enabled switch
- **Editor**, following the reference screenshots:
  - header, then **Settings / History** segmented tabs, then a Create/Save button
  - Task title, defaulting to "Untitled Automation"
  - Schedule chips with a "+ Add schedule" preset menu. Each chip has inline
    time, weekday or day fields, or a raw cron field for Custom. A "Next: …"
    preview sits below.
  - Instructions textarea with a footer: project select, `ModeMenu`,
    `ModelMenu`, `ThinkingMenu`
  - History tab: runs with time, status and an open-session link, plus a
    **Run now** button
- **Service worker**: `push` shows the notification. `notificationclick`
  focuses an open client and navigates it, or opens `data.url`.

## Testing

- Unit tests for the scheduler with a fake clock: due fire, catch-up inside and
  outside the window, multiple missed due times firing once, skipped-busy,
  disabled automations, no back-fire on create, and restart from a persisted
  `lastDueAt`.
- Unit tests for the store and run-history fold.
- Unit tests for push: send fan-out and dropping a subscription on 410, using a
  fake sender.
- Server tests: CRUD validation (bad cron is a 400), run-now creates a session
  with the title and the prompt, and the run status reaches `done` with the
  fake LLM.
- Web unit tests: the preset-to-cron mapping and back.
