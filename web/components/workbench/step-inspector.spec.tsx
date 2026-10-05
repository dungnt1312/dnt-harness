// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { StepInspector } from './StepInspector.tsx'
import { projectTrajectory } from './trajectory.ts'
import type { ContextManifestView, SseEvent } from '../../lib/types.ts'
import type { TrajectoryStep } from './trajectory.ts'

const MANIFEST: ContextManifestView = {
  modeId: 'default',
  modeRevision: 2,
  model: 'glm-5.3',
  budget: { availableTokens: 994_880, usedTokens: 18_400, contextLimitTokens: 1_000_000, estimated: true },
  breakdown: { systemPrompt: 1_200, systemTools: 6_000, mcpTools: 0, metaContext: 1_200, skills: 2_000, messages: 8_000 },
  history: { setting: 'recent', includedTurns: 1, omittedTurns: 0, includedSeqRange: [1, 9] },
  sources: { skills: [], memory: [], toolNames: ['Read', 'Bash'], toolSchemas: 2 },
  omissions: ['memory: dropped for budget'],
}

const sectioned: ContextManifestView = {
  ...MANIFEST,
  sections: [{ kind: 'system', hash: 'a'.repeat(64), chars: 1_234 }],
}

function event(partial: SseEvent): SseEvent {
  return partial
}

/** One turn whose single request carries a manifest, two attempts and thinking. */
const EVENTS: readonly SseEvent[] = [
  event({ type: 'turn/start', seq: 1, timestamp: 1_000, turnId: 't1' }),
  event({ type: 'user/message', seq: 2, timestamp: 1_010, turnId: 't1', content: 'inspect me' }),
  event({ type: 'step/start', seq: 3, timestamp: 1_100, turnId: 't1', stepId: 's1' }),
  event({ type: 'context/manifest', seq: 4, timestamp: 1_150, turnId: 't1', manifest: sectioned }),
  event({ type: 'model/attempt', seq: 5, timestamp: 1_160, fact: { requestId: 'r1', attemptId: 'a1', attempt: 1, state: 'start', committed: false, transportSettled: false, queuedAt: 1_150, startedAt: 1_160, attribution: { sessionId: 'sess', turnId: 't1', stepId: 's1' }, provider: 'zai', model: 'glm-5.3' } }),
  event({ type: 'model/attempt', seq: 6, timestamp: 1_400, fact: { requestId: 'r1', attemptId: 'a1', attempt: 1, state: 'end', committed: true, transportSettled: true, queuedAt: 1_150, startedAt: 1_160, endedAt: 1_400, finish: 'stop', attribution: { sessionId: 'sess', turnId: 't1', stepId: 's1' }, provider: 'zai', model: 'glm-5.3' } }),
  event({ type: 'assistant/chunk', seq: 7, timestamp: 1_200, stepId: 's1', delta: 'quiet reasoning', thinking: true }),
  event({ type: 'assistant/message', seq: 8, timestamp: 1_400, stepId: 's1', content: 'the answer', controls: { model: 'glm-5.3' } }),
  event({ type: 'turn/end', seq: 9, timestamp: 1_500, turnId: 't1', reason: 'completed' }),
]

let root: Root | undefined
let host: HTMLDivElement

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
})

function stepOf(events: readonly SseEvent[]): { turn: ReturnType<typeof projectTrajectory>['turns'][number]; step: TrajectoryStep } {
  const trajectory = projectTrajectory(events)
  const turn = trajectory.turns[0]!
  return { turn, step: turn.steps[0]! }
}

async function mountInspector(events: readonly SseEvent[]): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const { turn, step } = stepOf(events)
  const trace = turn.traces?.find((candidate) => candidate.stepId === step.stepId)
  await act(async () => root!.render(
    <StepInspector turn={turn} step={step} trace={trace} calls={[]} workspaceId="ws-1" sessionId="s-1" onBack={() => {}} />,
  ))
  return host
}

it('the summary names the request, its model and the attempts it took', async () => {
  const view = await mountInspector(EVENTS)
  expect(view.textContent).toContain('Turn 1 · request 1')
  expect(view.textContent).toContain('s1')
  expect(view.textContent).toContain('glm-5.3')
  expect(view.textContent).toContain('18.4k')
  expect(view.textContent).toContain('est')
  expect(view.textContent).toContain('Attempt 1')
  expect(view.textContent).toContain('finish: stop')
  expect(view.textContent).toContain('committed to history')
})

it('the request tab shows the manifest and lists the raw context blocks by hash', async () => {
  const view = await mountInspector(EVENTS)
  await act(async () => {
    host.querySelectorAll<HTMLButtonElement>('[role="group"] button').forEach((button) => {
      if (button.textContent === 'Request') button.click()
    })
  })
  expect(view.textContent).toContain('18.4k/1M')
  expect(view.textContent).toContain('System block')
  expect(view.textContent).toContain('1.2k chars')
  expect(view.textContent).toContain('memory: dropped for budget')
})

it('the response tab shows the answer and the streamed thinking', async () => {
  const view = await mountInspector(EVENTS)
  await act(async () => {
    host.querySelectorAll<HTMLButtonElement>('[role="group"] button').forEach((button) => {
      if (button.textContent === 'Response') button.click()
    })
  })
  expect(view.textContent).toContain('the answer')
  expect(view.textContent).toContain('quiet reasoning')
})

it('a legacy step with no trace still renders, with honest empty states', async () => {
  const legacy = EVENTS.filter((item) => item.type !== 'model/attempt' && item.type !== 'context/manifest' && item.type !== 'assistant/chunk')
  const view = await mountInspector(legacy)
  expect(view.textContent).not.toContain('Attempt 1')
  expect(view.textContent).not.toContain('Window')
  // The request tab says plainly that nothing was recorded for it.
  await act(async () => {
    host.querySelectorAll<HTMLButtonElement>('[role="group"] button').forEach((button) => {
      if (button.textContent === 'Request') button.click()
    })
  })
  expect(view.textContent).toContain('No context manifest recorded')
})
