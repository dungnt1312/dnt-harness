/** Keyboard focus as a filled pill, not the global 2px offset outline: closing a
    menu hands focus back to its trigger, and the outline then floats around
    the chip like a selection. */
export const composerFocusClass = 'focus-visible:outline-none focus-visible:bg-hover focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-line-strong'

/** Pill trigger shared by every composer control chip (36px targets on touch,
    so one phone row fits the whole control set). */
export const composerChipClass = `flex h-8 min-w-0 max-w-[14rem] items-center justify-center gap-1 rounded-full px-2 text-[13px] text-fg-muted transition-colors hover:bg-hover hover:text-fg ${composerFocusClass} disabled:pointer-events-none disabled:opacity-40 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:min-w-9`
