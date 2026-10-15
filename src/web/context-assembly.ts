import type { AgentScope } from '../harness/agent/scope.ts'
import type { AttachmentLookup } from '../harness/attachments/store.ts'
import type { ActiveSkill, BuildContextInput, MemorySnippet } from '../harness/context/builder.ts'
import type { SessionEvent } from '../harness/session/events.ts'

export interface PrefixSnapshot {
  readonly key: string
  skillCatalog?: NonNullable<BuildContextInput['skillCatalog']>
  memory?: readonly MemorySnippet[]
}
export interface AssemblyOptions {
  readonly scope: AgentScope
  readonly events: readonly SessionEvent[]
  readonly signal: AbortSignal
  readonly purpose: 'dispatch'|'preview'
  readonly squeeze?: number
  readonly checkpoint?: { readonly summary: string; readonly coversSeq: number }
}
export interface AssemblyControls {
  readonly provider?: string
  readonly model?: string
  readonly thinkingLevel?: string
  readonly nativeVision: boolean
}
type FixedInput = Omit<BuildContextInput,'events'|'activeSkills'|'skillCatalog'|'pinnedMemory'|'attachments'>
export interface ContextAssemblyDeps {
  resolve(scope: AgentScope): Promise<{ input: FixedInput; controls: AssemblyControls; revision: string; prefixKey: string }>
  catalog(scope: AgentScope): Promise<BuildContextInput['skillCatalog']>
  memory(scope: AgentScope): Promise<readonly MemorySnippet[]>
  skills(scope: AgentScope): Promise<readonly ActiveSkill[]>
  attachments(scope: AgentScope,events: readonly SessionEvent[]): Promise<AttachmentLookup|undefined>
  prefix(scope: AgentScope): { current?: PrefixSnapshot; install(snapshot: PrefixSnapshot): void }
  validate(scope: AgentScope,revision: string): Promise<void>
}
export interface PreparedAssembly {
  readonly input: BuildContextInput
  readonly controls: AssemblyControls
  readonly prefix: PrefixSnapshot
  readonly revision: string
  validate(): Promise<void>
  commitPrefix(): void
}

/** Coordinate the same gated source loaders for dispatch and private preview. */
export async function prepareContextAssembly(options: AssemblyOptions,deps: ContextAssemblyDeps): Promise<PreparedAssembly> {
  const {scope,signal} = options
  signal.throwIfAborted()
  const fixed = await deps.resolve(scope)
  signal.throwIfAborted()
  const slot = deps.prefix(scope)
  // Always copy: a failed preview must not mutate an installed catalog/memory prefix.
  const prefix: PrefixSnapshot = slot.current?.key === fixed.prefixKey ? {...slot.current} : {key:fixed.prefixKey}
  const catalog = prefix.skillCatalog ?? await deps.catalog(scope)
  signal.throwIfAborted()
  if (catalog !== undefined) prefix.skillCatalog = catalog
  const memory = prefix.memory ?? await deps.memory(scope)
  signal.throwIfAborted()
  if (memory.length > 0) prefix.memory = memory
  const skills = await deps.skills(scope)
  signal.throwIfAborted()
  const attachments = await deps.attachments(scope,options.events)
  signal.throwIfAborted()
  const prepared: PreparedAssembly = {
    controls:fixed.controls,prefix,revision:fixed.revision,
    input:{...fixed.input,events:options.events,activeSkills:skills,pinnedMemory:memory,
      nativeVision:fixed.controls.nativeVision,
      ...(catalog !== undefined ? {skillCatalog:catalog}: {}),
      ...(attachments !== undefined ? {attachments}: {}),
      ...(options.squeeze !== undefined ? {squeeze:options.squeeze}: {})},
    validate:async()=>{signal.throwIfAborted();await deps.validate(scope,fixed.revision);signal.throwIfAborted()},
    commitPrefix:()=>slot.install(prefix),
  }
  if (options.purpose === 'dispatch') prepared.commitPrefix()
  return prepared
}
