import { cn } from '../../lib/cn.ts'

/**
 * The DntHarness mark, taken as-is from the generated logo sheet (see
 * scripts/process-logo-icons.mjs). Two tiles ship so the mark stays visible on
 * both themes: the dark tile on the light sidebar, the light tile on the dark one.
 * The theme variant is chosen in CSS so the first paint never shows the wrong one.
 */
export function Logo({ size = 24, className }: { readonly size?: number; readonly className?: string }) {
  const base = cn('shrink-0 select-none', className)
  return (
    <>
      <img src="/icons/logo-dark.png" width={size} height={size} alt="" aria-hidden="true" draggable={false} className={cn(base, 'dark:hidden')} />
      <img src="/icons/logo-light.png" width={size} height={size} alt="" aria-hidden="true" draggable={false} className={cn(base, 'hidden dark:block')} />
    </>
  )
}
