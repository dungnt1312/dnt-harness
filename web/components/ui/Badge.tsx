import { cva } from 'class-variance-authority'
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'

const badgeStyles = cva('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4', {
  variants: {
    tone: {
      gray: 'bg-muted text-fg-muted',
      blue: 'bg-muted text-link',
      green: 'bg-ok-soft text-ok',
      amber: 'bg-warn-soft text-warn',
      red: 'bg-bad-soft text-bad',
    },
  },
  defaultVariants: { tone: 'gray' },
})

export function Badge({ tone = 'gray', children, className, ...rest }: {
  readonly tone?: 'gray' | 'blue' | 'green' | 'amber' | 'red'
  readonly children: ReactNode
  readonly className?: string
} & HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn(badgeStyles({ tone }), className)} {...rest}>{children}</span>
}
