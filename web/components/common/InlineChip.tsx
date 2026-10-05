import { chipLabel, chipTitle, isBuiltinCommand, type ChipSegment } from '../../lib/inline-chips.ts'
import { fileStyle, materialIconSrc } from '../../lib/file-icons.ts'
import { cn } from '../../lib/cn.ts'
import { FileTypeIcon } from './FileTypeIcon.tsx'

/**
 * One look for inline chips wherever they appear: the composer builds them as
 * plain DOM (see RichInput) and the transcript renders them with React, so the
 * classes and icon geometry live here as data both can use.
 */

/** Sized to sit inside a 24px text line without pushing it taller. */
export const CHIP_CLASS = 'inline-flex max-w-[16rem] items-center gap-1 whitespace-nowrap rounded-md border border-line px-1.5 align-middle text-[13px] leading-5'

/**
 * The editor sits on the composer surface and needs room for the caret beside
 * a chip; a user bubble is already muted and its text carries its own spaces.
 */
export const CHIP_TONE = { editor: 'mx-0.5 bg-hover', bubble: 'bg-surface' } as const

export const CHIP_LABEL_CLASS = 'truncate'

/** Kind colour for the icon: skills read as actions, files as references. */
export const CHIP_ICON_CLASS: Readonly<Record<ChipSegment['kind'], string>> = {
  command: 'shrink-0 text-link',
  mention: 'shrink-0 text-fg-muted',
}

/** 24x24 stroke paths (same drawings as the app's zap and fileText icons). */
export const CHIP_ICON_PATHS: Readonly<Record<ChipSegment['kind'], readonly string[]>> = {
  command: ['M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z'],
  mention: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4'],
}

export const CHIP_ICON_SIZE = 13

/** Material icon theme glyph — the same drawing the `@` picker row shows. */
export function mentionIconSrc(path: string): string {
  return fileStyle(path).src
}

/** Fallback when a mention's themed asset is missing. */
export const MENTION_ICON_FALLBACK = materialIconSrc('document')

/** Accessible name shared by both renderers. */
export function chipAriaLabel(segment: ChipSegment): string {
  if (segment.kind === 'mention') return `File mention ${segment.path}`
  return isBuiltinCommand(segment.name) ? `Command ${segment.name}` : `Skill command ${segment.name}`
}

/** A read-only chip for rendered messages. */
export function InlineChip({ segment }: { readonly segment: ChipSegment }) {
  return (
    <span className={cn(CHIP_CLASS, CHIP_TONE.bubble)} title={chipTitle(segment)} aria-label={chipAriaLabel(segment)} data-chip-kind={segment.kind}>
      {segment.kind === 'mention'
        ? <FileTypeIcon path={segment.path} size={CHIP_ICON_SIZE} />
        : (
          <svg
            className={CHIP_ICON_CLASS[segment.kind]}
            width={CHIP_ICON_SIZE}
            height={CHIP_ICON_SIZE}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {CHIP_ICON_PATHS[segment.kind].map((d) => <path key={d} d={d} />)}
          </svg>
        )}
      <span className={CHIP_LABEL_CLASS}>{chipLabel(segment)}</span>
    </span>
  )
}
