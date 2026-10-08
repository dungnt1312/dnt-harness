import { useState } from 'react'
import { DangerousCommandsPanel } from './DangerousCommandsPanel.tsx'
import { ModesPanel } from './ModesPanel.tsx'
import { SubTabs } from './settings-kit.tsx'

export type PermissionsSubTab = 'modes' | 'guard'

export function PermissionsPanel(props: {
  readonly workspaceId: string | null
  readonly onChanged?: () => Promise<void> | void
  /** Sub-tab to open on; legacy `dangerous-commands` links land on the guard. */
  readonly initialSub?: PermissionsSubTab | undefined
}) {
  const [sub, setSub] = useState<PermissionsSubTab>(props.initialSub ?? 'modes')
  return (
    <div className="flex min-h-full min-w-0 flex-col gap-4">
      <SubTabs
        label="Permissions sections"
        value={sub}
        onChange={setSub}
        tabs={[
          { value: 'modes', label: 'Modes', icon: 'layers' },
          { value: 'guard', label: 'Dangerous Commands', icon: 'shieldCheck' },
        ]}
      />
      {/* Both stay mounted (inactive one hidden) so switching sub-tab never
          throws away a mode draft or unsaved guard edits. */}
      <div role="tabpanel" aria-label="Modes" hidden={sub !== 'modes'} className={sub === 'modes' ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}>
        <ModesPanel workspaceId={props.workspaceId} {...(props.onChanged !== undefined ? { onChanged: props.onChanged } : {})} />
      </div>
      <div role="tabpanel" aria-label="Dangerous Commands" hidden={sub !== 'guard'} className={sub === 'guard' ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}>
        <DangerousCommandsPanel workspaceId={props.workspaceId} />
      </div>
    </div>
  )
}
