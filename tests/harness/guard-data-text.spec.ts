import { describe, expect, it } from 'vitest'
import { maskDataText } from '../../src/harness/guard/data-text.ts'
import { matchCommand } from '../../src/harness/guard/matcher.ts'
import { matchRiskyCommand } from '../../src/harness/guard/bash-risky.ts'
import { DEFAULT_CONFIG } from '../../src/harness/guard/defaults.ts'

const cfg = { ...DEFAULT_CONFIG, presets: { ...DEFAULT_CONFIG.presets, gitDestructive: 'deny' as const } }

describe('data text is not matched as a command', () => {
  it.each([
    // The commit that the guard itself blocked.
    `git add a && git commit -q -F - <<'EOF'\nfeat: x\n\nThe git branch -D regex was wrong; rm -rf is fine now.\nEOF\ngit log -1`,
    'git commit -m "docs: explain rm -rf and git reset --hard"',
    "git commit -am 'fix: git push --force no longer allowed'",
    'git commit --message="mention git branch -D"',
    'git tag -a v1 -m "drop table notes: DROP TABLE users"',
    'gh pr create --title "rm -rf cleanup" --body "runs git reset --hard in CI"',
    `gh pr create --body-file - <<EOF\ngit push --force\nEOF`,
    `cat > notes.md <<'MD'\nrm -rf build\nMD`,
    `cat <<-EOF > x.txt\n\tgit clean -fdx\n\tEOF`,
    `tee doc.txt <<EOF\nsudo rm -rf /\nEOF\necho done`,
  ])('allows %j', (command) => {
    expect(matchCommand(command, cfg), command).toBeNull()
    expect(matchRiskyCommand(command), command).toBeNull()
  })

  it.each([
    ['heredoc fed to a shell', `bash <<'EOF'\nrm -rf build\nEOF`],
    ['heredoc fed to ssh', `ssh host <<EOF\nrm -rf /srv\nEOF`],
    ['heredoc piped to a shell', `cat <<EOF | sh\nrm -rf build\nEOF`],
    ['unterminated heredoc', `cat <<EOF\nrm -rf build`],
    ['command after the heredoc', `cat <<EOF > x\nhello\nEOF\nrm -rf build`],
    ['executing message', 'git commit -m "$(rm -rf build)"'],
    ['backtick message', 'git commit -m "`git reset --hard`"'],
    ['message flag then a real command', 'git commit -m "wip" && git reset --hard'],
    ['quoted args of other programs', 'bash -c "rm -rf build"'],
    ['echo is not exempt', 'echo "x" ; rm -rf build'],
  ])('keeps matching: %s', (_why, command) => {
    const preset = matchCommand(command, cfg)
    const risky = matchRiskyCommand(command)
    expect(preset !== null || risky !== null, command).toBe(true)
  })

  it('masks only the message values and the data heredoc', () => {
    expect(maskDataText('git commit -m "rm -rf x" --amend')).toBe('git commit -m "MSG" --amend')
    expect(maskDataText("cat > f <<'EOF'\nrm -rf x\nEOF\nls")).toBe('cat > f \nls')
    expect(maskDataText('bash <<EOF\nrm -rf x\nEOF')).toBe('bash <<EOF\nrm -rf x\nEOF')
  })
})
