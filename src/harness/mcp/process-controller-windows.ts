/**
 * Windows hard containment requires a Job Object assigned before the child
 * can spawn anything else. This package does not ship that helper, so the
 * host must not claim a hard kill-on-close or a hard memory cap.
 */
import type { ContainmentReport } from './process-controller.ts'

export function detectWindowsJobObject(): ContainmentReport {
  return {
    level: 'best_effort',
    platform: 'win32',
    detail: 'Windows Job Object helper is not packaged; hard resource limits are refused and the watchdog is best effort, not a sandbox',
  }
}
