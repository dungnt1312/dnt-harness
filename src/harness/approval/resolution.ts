import { canonicalPolicy, canonicalToolName } from '../tools/names.ts'

export type ApprovalMode = 'allow' | 'ask' | 'deny'

export interface PermissionResolutionOptions {
  readonly defaultMode?: ApprovalMode
  /** Only configured entries transform; an omitted key retains defaultMode. */
  readonly yolo?: boolean
}

/** Pure lookup shared by initial, pending and final authority evaluation. */
export function resolvePermission(
  policy: Readonly<Record<string, ApprovalMode>>,
  tool: string,
  options: PermissionResolutionOptions = {},
): ApprovalMode {
  const normalized = canonicalPolicy(policy)
  const name = canonicalToolName(tool)
  const server = name.startsWith('mcp__') && name.split('__').length >= 3
    ? normalized[`mcp__${name.split('__')[1]}__*`] : undefined
  const configured = normalized[name] ?? server ?? normalized['*']
  if (configured === undefined) return options.defaultMode ?? 'ask'
  return options.yolo === true && configured !== 'deny' ? 'allow' : configured as ApprovalMode
}
