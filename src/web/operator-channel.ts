/**
 * The operator channel: a file in the data home that lets the OS user who
 * runs the host mint a fresh pairing code for the live process (`npm run
 * pair`). Reading it requires that user's filesystem access, which is the
 * trust boundary the local control plane already accepts — it does not
 * claim protection from same-user malware.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const OPERATOR_HEADER = 'x-mini-dsh-operator'

export interface OperatorChannel {
  readonly url: string
  readonly key: string
}

export function operatorChannelPath(home: string): string {
  return path.join(home, 'auth', 'operator.json')
}

/** Publish the channel for this host; the returned disposer removes it only while it is still ours. */
export async function publishOperatorChannel(home: string, channel: OperatorChannel): Promise<() => Promise<void>> {
  const file = operatorChannelPath(home)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, JSON.stringify(channel), { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temp, file)
  return async () => {
    const current = await readOperatorChannel(home).catch(() => undefined)
    if (current?.key === channel.key) await fs.rm(file, { force: true })
  }
}

export async function readOperatorChannel(home: string): Promise<OperatorChannel> {
  const parsed = JSON.parse(await fs.readFile(operatorChannelPath(home), 'utf8')) as Partial<OperatorChannel>
  if (typeof parsed.url !== 'string' || typeof parsed.key !== 'string') throw new Error('operator channel file is malformed')
  return { url: parsed.url, key: parsed.key }
}
