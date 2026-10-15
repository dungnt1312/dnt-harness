/**
 * One compact scale for every Git panel control, so toolbar rows share a
 * height (h-8 rows, 24px controls) and line up. cn() (tailwind-merge) lets
 * these override the shared Button / IconButton sizes.
 */
/** Row height of the panel's toolbars; the list pane and the diff pane headers must match. */
export const GIT_BAR = 'h-8'
/** Text button (Button size="sm"). */
export const GIT_BUTTON = 'h-6 px-2 text-xs'
/** Left half of a split button: the label button joined to GIT_CHEVRON. */
export const GIT_BUTTON_LEFT = `${GIT_BUTTON} rounded-r-none border-r-0`
/** Right half of a split button: the dropdown chevron. */
export const GIT_CHEVRON = 'inline-flex h-6 w-5 shrink-0 items-center justify-center rounded-l-none rounded-r-full border border-line-strong text-fg hover:bg-hover'
/** IconButton, and the className of a Menu trigger that is only an icon. */
export const GIT_ICON = 'size-6 rounded-md'
export const GIT_ICON_TRIGGER = 'inline-flex size-6 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg'
