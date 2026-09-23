import { useState } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import { DangerousCommandsPanel } from './DangerousCommandsPanel.tsx'
import { ModesPanel } from './ModesPanel.tsx'

type SubTab = 'modes' | 'guard'

export function PermissionsPanel(props: { readonly workspaceId: string | null; readonly onChanged?: () => Promise<void> | void }) {
  const [sub, setSub] = useState<SubTab>('modes')
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Tabs.Root value={sub} onValueChange={(v) => setSub(v as SubTab)} className="flex min-w-0 flex-col gap-4">
        <Tabs.List className="flex w-fit items-center gap-1 rounded-xl border border-line bg-muted p-1">
          <Tabs.Trigger
            value="modes"
            className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-fg-muted outline-none transition-colors hover:text-fg data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-sm"
          >
            Modes
          </Tabs.Trigger>
          <Tabs.Trigger
            value="guard"
            className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-fg-muted outline-none transition-colors hover:text-fg data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-sm"
          >
            Dangerous Commands
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="modes" className="min-w-0 outline-none">
          <ModesPanel workspaceId={props.workspaceId} onChanged={props.onChanged} />
        </Tabs.Content>
        <Tabs.Content value="guard" className="min-w-0 outline-none">
          <DangerousCommandsPanel workspaceId={props.workspaceId} />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}
