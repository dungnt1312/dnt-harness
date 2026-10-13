import { describe, expect, it } from 'vitest'
import { parseShell } from '../../src/harness/guard/shell-parse.ts'
import { isReadOnlyBashCommand } from '../../src/harness/guard/bash-readonly.ts'
import { matchRiskyCommand } from '../../src/harness/guard/bash-risky.ts'

describe('parseShell', () => {
  it('splits simple commands on separators and removes quotes', () => {
    const parsed = parseShell(`git status && echo 'a b' | wc -l; ls "x y"\nnext`)
    expect(parsed.unsupported).toBe(false)
    expect(parsed.commands.map((command) => command.words.map((word) => word.value))).toEqual([
      ['git', 'status'], ['echo', 'a b'], ['wc', '-l'], ['ls', 'x y'], ['next'],
    ])
  })

  it('records assignments, redirects, expansions and globs', () => {
    const [command] = parseShell('FOO=1 cat *.ts "$HOME" 2>/dev/null').commands
    expect(command!.assignments).toEqual(['FOO=1'])
    expect(command!.words.map((word) => [word.value, word.expands, word.glob])).toEqual([
      ['cat', false, false], ['*.ts', false, true], ['$HOME', true, false],
    ])
    expect(command!.redirects.map((redirect) => [redirect.op, redirect.target.value])).toEqual([['2>', '/dev/null']])
  })

  it.each([
    'echo $(whoami)', 'echo `id`', '(cd x && ls)', 'cat <<EOF\nx\nEOF', 'sleep 1 &', "echo 'open", 'diff <(ls) <(ls)', 'echo "$(id)"', '{ ls; }',
  ])('marks %j unsupported', (source) => {
    expect(parseShell(source).unsupported).toBe(true)
  })

  it('treats quoted glob characters and quoted braces as literal', () => {
    const [command] = parseShell(`grep '*' "{x}"`).commands
    expect(command!.words.map((word) => word.glob)).toEqual([false, false, false])
  })
})

describe('isReadOnlyBashCommand', () => {
  it.each([
    'ls -la',
    'git status',
    'git log --oneline -n 5',
    'git diff HEAD~1 -- src',
    'git branch -a',
    'git branch --show-current',
    'git remote -v',
    'git stash list',
    'cat package.json | grep version',
    'rg -n "TODO" src',
    'find src -name "*.ts" -type f',
    'wc -l src/index.ts && head -n 20 README.md',
    'ls 2>/dev/null',
    'grep -r foo . 2>&1 | head',
    'sort -u names.txt',
    'pwd',
    'echo done',
  ])('allows %j', (command) => {
    expect(isReadOnlyBashCommand(command)).toBe(true)
  })

  it.each([
    ['writes a file', 'echo x > out.txt'],
    ['appends', 'ls >> log'],
    ['unknown program', 'npm test'],
    ['rm', 'rm file'],
    ['sort writes via -o', 'sort -o out in'],
    ['sort combined -uo', 'sort -uo out in'],
    ['find -delete', 'find . -name x -delete'],
    ['find -exec', 'find . -exec rm {} ;'],
    ['rg preprocessor', 'rg --pre ./x foo'],
    ['git global option', 'git -c core.pager=sh log'],
    ['git -C escapes the folder', 'git -C /etc status'],
    ['git write subcommand', 'git commit -m x'],
    ['git branch creates', 'git branch feature'],
    ['git push', 'git push'],
    ['git ext-diff', 'git diff --ext-diff'],
    ['git grep -O pager', 'git grep -Ovim foo'],
    ['git reflog expire', 'git reflog expire --all'],
    ['absolute path', 'cat /etc/passwd'],
    ['home path', 'cat ~/.ssh/id_rsa'],
    ['parent escape', 'ls ../other'],
    ['expansion', 'cat "$FILE"'],
    ['assignment prefix', 'PAGER=sh git log'],
    ['command substitution', 'echo $(rm -rf x)'],
    ['program path', './script.sh'],
    ['input from outside', 'wc -l < /etc/hosts'],
    ['empty', ''],
  ])('refuses: %s', (_why, command) => {
    expect(isReadOnlyBashCommand(command)).toBe(false)
  })
})

describe('matchRiskyCommand', () => {
  it.each([
    ['rm -rf build', 'remove-bulk'],
    ['rm -r -f build', 'remove-bulk'],
    ['rm a b', 'remove-bulk'],
    ['rm *.log', 'remove-bulk'],
    ['sudo -u root rm -r /var/x', 'remove-bulk'],
    ['env FOO=1 rm --recursive x', 'remove-bulk'],
    ['ls | xargs rm', 'remove-bulk'],
    ['bash -c "rm -rf x"', 'remove-bulk'],
    ['sh -lc \'git reset --hard\'', 'git-reset-hard'],
    ['dd if=/dev/zero of=disk', 'system-storage'],
    ['mkfs.ext4 /dev/sdb', 'system-storage'],
    ['rsync -a --delete src/ dst/', 'rsync-delete'],
    ['find . -delete', 'find-delete'],
    ['find . -exec rm {} ;', 'find-delete'],
    ['git reset --hard HEAD~1', 'git-reset-hard'],
    ['git -C repo clean -fd', 'git-clean-force'],
    ['git push --force origin main', 'git-push-force'],
    ['git push -f', 'git-push-force'],
    ['git push origin +main', 'git-push-force'],
    ['git push --force-with-lease', 'git-push-force'],
    ['git checkout .', 'git-discard-tree'],
    ['git checkout -f main', 'git-discard-tree'],
    ['git restore .', 'git-discard-tree'],
    ['git stash clear', 'git-stash-clear'],
    ['git worktree remove --force wt', 'git-worktree-force-remove'],
    ['git branch -D topic', 'git-branch-force-delete'],
    ['echo ok && git reset --hard', 'git-reset-hard'],
    ['rm $(cat list)', 'unanalyzable-delete'],
  ])('matches %j as %s', (command, ruleId) => {
    expect(matchRiskyCommand(command)?.ruleId).toBe(ruleId)
  })

  it.each([
    'rm file.txt',
    'git status',
    'git reset HEAD~1',
    'git reset --soft HEAD~1',
    'git clean -n',
    'git push origin main',
    'git push --dry-run --force',
    'git checkout main',
    'git restore --staged .',
    'git stash',
    'git branch -d topic',
    'rsync -a --delete --dry-run a/ b/',
    'find . -name x',
    'mount',
    'dd --help',
    'echo "rm -rf /"',
    'npm test',
    'echo $(date)',
  ])('does not match %j', (command) => {
    expect(matchRiskyCommand(command)).toBeNull()
  })
})
