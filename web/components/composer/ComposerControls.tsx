import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import { cn } from '../../lib/cn.ts'
import { composerChipClass } from './composer-chip.ts'

const staticChipClass = cn(composerChipClass, 'hover:bg-transparent hover:text-fg-muted')

export function ModeMenu({ modes, value, onChange }: {
  readonly modes: readonly { readonly value: string; readonly label: string }[]
  readonly value: string
  readonly onChange: (value: string) => void
}) {
  const label = modes.find((mode) => mode.value === value)?.label ?? value
  return (
    <Menu
      label="Workspace mode (next tool gate and request)"
      side="top"
      triggerClassName={cn(composerChipClass, value === 'full-access' && 'text-warn hover:text-warn')}
      trigger={() => (
        <>
          <Icon name="layers" size={15} />
          <span className="truncate">{label}</span>
          <Icon name="chevron" size={13} />
        </>
      )}
    >
      {(close) => (
        <>
          <div className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-fg-faint">Mode</div>
          {modes.map((mode) => (
            <button
              key={mode.value}
              type="button"
              role="menuitemradio"
              aria-checked={mode.value === value}
              className={cn(menuItemClass, mode.value === 'full-access' && 'text-warn')}
              onClick={() => { onChange(mode.value); close() }}
            >
              <span className="flex-1">{mode.label}</span>
              {mode.value === value ? <Icon name="check" size={15} /> : null}
            </button>
          ))}
        </>
      )}
    </Menu>
  )
}

/**
 * Session controls (model, thinking) failed to load or are still loading.
 * Sending waits for them; when a retry exists the chip says so.
 */
export function ControlsStatus({ message, onRetry }: { readonly message: string; readonly onRetry?: (() => void) | undefined }) {
  if (onRetry === undefined) {
    return (
      <span className={cn(staticChipClass, 'text-warn hover:text-warn')} title={message}>
        <Icon name="alertTriangle" size={14} />
        <span className="truncate">{message}</span>
      </span>
    )
  }
  return (
    <button type="button" className={cn(composerChipClass, 'text-warn hover:text-warn')} title={`${message} — retry`} onClick={onRetry}>
      <Icon name="refresh" size={14} />
      <span className="truncate">{message}</span>
      <span className="shrink-0 font-medium underline">Retry</span>
    </button>
  )
}

/**
 * The `+` menu: upload from this device, or mention a project file. Mention
 * reuses the `@` flow so there is one file-search surface, not two.
 */
export function AttachMenu({ uploading, onUpload, onMention }: {
  readonly uploading: boolean
  readonly onUpload?: (() => void) | undefined
  readonly onMention?: (() => void) | undefined
}) {
  return (
    <Menu
      label="Attach a file"
      side="top"
      align="start"
      triggerClassName="flex size-8 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40 [@media(pointer:coarse)]:size-11"
      trigger={() => (uploading ? <Spinner size={14} /> : <Icon name="plus" size={18} />)}
    >
      {(close) => (
        <>
          {onUpload !== undefined ? (
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onUpload() }}>
              <Icon name="fileImage" size={15} className="text-fg-muted" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span>Upload from this device</span>
                <span className="truncate text-xs text-fg-faint">Images and text files</span>
              </span>
            </button>
          ) : null}
          {onMention !== undefined ? (
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onMention() }}>
              <Icon name="fileText" size={15} className="text-fg-muted" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span>Mention a project file</span>
                <span className="truncate text-xs text-fg-faint">Inserts @ to search this project</span>
              </span>
            </button>
          ) : null}
        </>
      )}
    </Menu>
  )
}
