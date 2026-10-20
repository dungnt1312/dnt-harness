// jsdom lacks the browser CSS.escape API used by focus selectors.
if (typeof globalThis.CSS?.escape !== 'function') {
  const escape = (value: string): string =>
    value.replace(/^(\d)/, '\\3$1 ').replace(/[^a-zA-Z0-9_ -￿-]/g, (char) => `\\${char}`)
  ;(globalThis as { CSS?: unknown }).CSS = { ...(globalThis.CSS ?? {}), escape }
}
