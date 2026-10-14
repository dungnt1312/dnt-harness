import type { ReactNode } from 'react'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Button } from '../ui/Button.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { FileNameInput } from './FileNameInput.tsx'
import type { ProjectEntry, ProjectListing } from '../../lib/api.ts'
import type { Selection } from '../../lib/file-tree.ts'
import { writeProjectFileDrag } from '../../lib/file-tree.ts'
import { cn } from '../../lib/cn.ts'

export interface FolderNode {
  readonly status: 'loading' | 'ready' | 'error'
  readonly listing: ProjectListing | null
  readonly error: string | null
}

/** The one inline editor the tree shows at a time; `id` is unique per started editor so each gets a fresh input. */
export type TreeEditor =
  | { readonly id: number; readonly mode: 'create'; readonly folder: string; readonly kind: 'file' | 'dir' }
  | { readonly id: number; readonly mode: 'rename'; readonly path: string }

/** Everything the rows read and call; threaded as one object so the recursion stays narrow. */
export interface TreeActions {
  readonly nodes: Readonly<Record<string, FolderNode>>
  readonly open: ReadonlySet<string>
  readonly activeFile: string | null
  readonly selected: Selection | null
  readonly editor: TreeEditor | null
  /** Row click: select it, then toggle a folder or open a file. */
  readonly activate: (entry: ProjectEntry) => void
  readonly retry: (folder: string) => void
  readonly beginRename: (entry: ProjectEntry) => void
  readonly beginDelete: (entry: ProjectEntry) => void
  /** Copy the entry's path (relative or absolute) to the clipboard. */
  readonly copyPath: (path: string, absolute: boolean) => void
  readonly submitCreate: (name: string) => Promise<string | null>
  readonly submitRename: (entry: ProjectEntry, name: string) => Promise<string | null>
  readonly cancelEdit: () => void
}

const indent = (depth: number): number => 6 + depth * 14

const MENU_TRIGGER = 'absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-faint hover:text-fg opacity-0 invisible transition-opacity group-hover/row:visible group-hover/row:opacity-100 group-focus-within/row:visible group-focus-within/row:opacity-100 focus-visible:visible focus-visible:opacity-100 [@media(pointer:coarse)]:visible [@media(pointer:coarse)]:opacity-100'

/** The entries of one folder (`folder`, '' = root), with the create draft first when it lands here. */
export function FolderRows({ folder, entries, depth, actions }: {
  readonly folder: string
  readonly entries: readonly ProjectEntry[]
  readonly depth: number
  readonly actions: TreeActions
}) {
  const { editor, nodes, open } = actions
  const draft = editor?.mode === 'create' && editor.folder === folder ? editor : null
  if (entries.length === 0 && draft === null) return <p className="m-0 px-2.5 py-2 text-[13px] text-fg-faint" style={{ paddingLeft: 10 + depth * 14 }}>Empty folder</p>
  return (
    <ul aria-label={depth === 0 ? 'Project files' : undefined} className="m-0 flex list-none flex-col p-0">
      {draft !== null ? <li><DraftRow key={draft.id} kind={draft.kind} depth={depth} actions={actions} /></li> : null}
      {entries.map((entry) => {
        const expanded = entry.kind === 'dir' && open.has(entry.path)
        const node = nodes[entry.path]
        return (
          <li key={entry.path}>
            <FileRow entry={entry} depth={depth} expanded={expanded} actions={actions} />
            {expanded ? (
              node?.status === 'error' && node.listing === null ? (
                <div className="flex items-center gap-2 py-1 pr-2" style={{ paddingLeft: 24 + depth * 14 }}>
                  <span className="text-xs text-bad">Could not load</span>
                  <Button size="sm" variant="outline" onClick={() => actions.retry(entry.path)}>Retry</Button>
                </div>
              ) : node === undefined || (node.status === 'loading' && node.listing === null) ? (
                <div className="flex items-center gap-2 py-1 text-xs text-fg-muted" style={{ paddingLeft: 24 + depth * 14 }} role="status"><Spinner size={12} />Loading…</div>
              ) : (
                <FolderRows folder={entry.path} entries={node.listing?.entries ?? []} depth={depth + 1} actions={actions} />
              )
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/** One tree row: the open/toggle button, its hover menu, or the rename editor in its place. */
function FileRow({ entry, depth, expanded, actions }: {
  readonly entry: ProjectEntry
  readonly depth: number
  readonly expanded: boolean
  readonly actions: TreeActions
}) {
  const { editor, selected, activeFile } = actions
  const isDir = entry.kind === 'dir'
  if (editor?.mode === 'rename' && editor.path === entry.path) {
    return (
      <EditorShell depth={depth} icon={<FileTypeIcon path={entry.name} kind={isDir ? 'folder' : 'file'} open={expanded} size={16} />}>
        <FileNameInput
          key={editor.id}
          initial={entry.name}
          label={`New name for ${entry.name}`}
          selectStem={!isDir}
          onSubmit={(name) => actions.submitRename(entry, name)}
          onCancel={actions.cancelEdit}
        />
      </EditorShell>
    )
  }
  return (
    <div className="group/row relative">
      <button
        type="button"
        title={entry.path}
        aria-expanded={isDir ? expanded : undefined}
        onClick={() => actions.activate(entry)}
        onDragStart={(event) => writeProjectFileDrag(event.dataTransfer, entry)}
        draggable
        style={{ paddingLeft: indent(depth) }}
        className={cn('flex min-h-7 w-full items-center gap-1.5 rounded-md pr-8 text-left text-[13px] hover:bg-hover', (entry.path === activeFile || entry.path === selected?.path) && 'bg-hover', entry.path === activeFile && 'text-fg')}
      >
        {isDir
          ? <Icon name="chevronRight" size={12} className={cn('shrink-0 text-fg-faint transition-transform', expanded && 'rotate-90')} />
          : <span aria-hidden="true" className="w-3 shrink-0" />}
        <FileTypeIcon path={entry.name} kind={isDir ? 'folder' : 'file'} open={expanded} size={16} />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </button>
      <Menu label={`Actions for ${entry.name}`} align="end" triggerClassName={MENU_TRIGGER} trigger={() => <Icon name="dots" size={14} />}>
        {(close) => (
          <>
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); actions.copyPath(entry.path, false) }}>
              <Icon name="copy" size={14} />Copy relative path
            </button>
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); actions.copyPath(entry.path, true) }}>
              <Icon name="copy" size={14} />Copy absolute path
            </button>
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); actions.beginRename(entry) }}>
              <Icon name="pencil" size={14} />Rename
            </button>
            <button type="button" role="menuitem" className={cn(menuItemClass, 'text-bad')} onClick={() => { close(); actions.beginDelete(entry) }}>
              <Icon name="trash" size={14} />Delete
            </button>
          </>
        )}
      </Menu>
    </div>
  )
}

/** The "new file" / "new folder" row at the top of its folder. */
function DraftRow({ kind, depth, actions }: {
  readonly kind: 'file' | 'dir'
  readonly depth: number
  readonly actions: TreeActions
}) {
  return (
    <EditorShell depth={depth} icon={<FileTypeIcon path="new" kind={kind === 'dir' ? 'folder' : 'file'} size={16} />}>
      <FileNameInput
        initial=""
        label={kind === 'dir' ? 'New folder name' : 'New file name'}
        selectStem={false}
        onSubmit={actions.submitCreate}
        onCancel={actions.cancelEdit}
      />
    </EditorShell>
  )
}

/** Row chrome shared by the create and rename editors, aligned with a normal row's icon. */
function EditorShell({ depth, icon, children }: {
  readonly depth: number
  readonly icon: ReactNode
  readonly children: ReactNode
}) {
  return (
    <div className="flex min-h-7 items-start gap-1.5 pr-2" style={{ paddingLeft: indent(depth) }}>
      <span aria-hidden="true" className="w-3 shrink-0" />
      <span className="flex h-8 shrink-0 items-center">{icon}</span>
      {children}
    </div>
  )
}
