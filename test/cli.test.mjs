import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NEWLINE = String.fromCharCode(0x0a)
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLI = fileURLToPath(new URL('../bin/content-change-ledger.mjs', import.meta.url))

function cli(args, cwd = ROOT) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : error.code, stdout, stderr })
    })
  })
}

async function withDirectory(body) {
  const directory = await mkdtemp(join(tmpdir(), 'content-change-ledger-cli-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const APPEND = [
  'append', 'ledger.jsonl',
  '--subject', 'pricing.md',
  '--action', 'create',
  '--reason', 'first publication',
  '--owner', 'content-team',
  '--release', '2026.09.0',
  '--after', `sha256:${'1'.repeat(64)}`,
  '--recorded-at', '2026-09-01T09:00:00.000Z',
]

test('--help explains the three verbs and exits 0', async () => {
  const result = await cli(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /content-change-ledger/)
  for (const verb of ['verify', 'history', 'append']) assert.match(result.stdout, new RegExp(`content-change-ledger ${verb}`))
  assert.match(result.stdout, /never rewrites history/)
  assert.equal(result.stderr, '')
})

test('the clean example verifies and exits 0', async () => {
  const result = await cli(['verify', 'examples/ledger.jsonl', '--config', 'examples/ledger-policy.json'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /status pass/)
  assert.match(result.stdout, /4 event\(s\) across 2 subject\(s\)/)
})

test('--json puts a parseable report on stdout and nothing else', async () => {
  const result = await cli(['verify', 'examples/ledger.jsonl', '--config', 'examples/ledger-policy.json', '--json'])
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'content-change-ledger')
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 4)
  assert.equal(report.summary.corrections, 1)
})

test('the tampered example reports the duplicate id and the broken chain, and exits 1', async () => {
  const result = await cli(['verify', 'examples/broken-ledger.jsonl', '--json'])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'fail')
  const located = report.findings.map((item) => `${item.ruleId}@${item.location.file}:${item.line}`)
  for (const expected of [
    'chain-previous-hash-mismatch@examples/broken-ledger.jsonl:2',
    'subject-hash-discontinuity@examples/broken-ledger.jsonl:2',
    'event-id-duplicate@examples/broken-ledger.jsonl:4',
  ]) assert.ok(located.includes(expected), `missing ${expected}`)
  assert.equal(report.summary.errors, 3)
})

test('an unknown command or option leaves stdout empty and exits 2', async () => {
  for (const args of [['rewrite', 'examples/ledger.jsonl'], ['verify', 'examples/ledger.jsonl', '--quiet'],
    ['verify'], ['history', 'a.jsonl', 'b.jsonl'], ['verify', 'examples/ledger.jsonl', '--config']]) {
    const result = await cli(args)
    assert.equal(result.code, 2, `${args.join(' ')} did not exit 2`)
    assert.equal(result.stdout, '', `${args.join(' ')} wrote to stdout`)
    assert.notEqual(result.stderr, '')
  }
})

test('an invalid configuration leaves stdout empty; an unreadable input still reports', async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, 'typo.json'), '{"schemaVersion":"1","owner":["content-team"]}', 'utf8')
    const config = await cli(['verify', 'examples/ledger.jsonl', '--config', join(directory, 'typo.json')])
    assert.equal(config.code, 2)
    assert.equal(config.stdout, '')
    assert.match(config.stderr, /Unknown configuration key "owner"/)

    /* The configuration file is decoded as strictly as the ledger is. */
    await writeFile(join(directory, 'latin1.json'), Buffer.from([0x7b, 0xff, 0x7d]))
    const encoding = await cli(['verify', 'examples/ledger.jsonl', '--config', join(directory, 'latin1.json')])
    assert.equal(encoding.code, 2)
    assert.equal(encoding.stdout, '')
    assert.match(encoding.stderr, /not valid UTF-8/)

    const missing = await cli(['verify', 'absent.jsonl', '--json'])
    assert.equal(missing.code, 2)
    const report = JSON.parse(missing.stdout)
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(report.findings.map((item) => item.ruleId), ['ledger-unreadable'])
    assert.equal(report.findings[0].location.file, 'absent.jsonl')
  })
})

test('distinct unsafe and literal-escape ledger filenames have safe distinct locations', async () => {
  await withDirectory(async (directory) => {
    const clean = await cli(['verify', 'examples/ledger.jsonl', '--config', 'examples/ledger-policy.json', '--json'])
    assert.equal(clean.code, 0)
    const names = ['dirty\u0085.jsonl', 'dirty\\u0085.jsonl',
      'a'.repeat(190) + 'A.jsonl', 'a'.repeat(190) + 'B.jsonl']
    const labels = []
    for (const name of names) {
      await writeFile(join(directory, name), 'not-json\n', 'utf8')
      const result = await cli(['verify', name, '--root', directory, '--json'], directory)
      assert.equal(result.code, 2, name)
      const report = JSON.parse(result.stdout)
      assert.equal(report.status, 'incomplete')
      assert.deepEqual(report.findings.map(f => f.ruleId), ['event-not-json', 'ledger-empty'])
      assert.equal(report.findings.every(f => f.location.file === report.findings[0].location.file), true)
      const label = report.findings[0].location.file
      assert.ok(label.length <= 200)
      assert.equal(label.includes('\u0085'), false)
      labels.push(label)
    }
    assert.notEqual(labels[0], labels[1])
    assert.notEqual(labels[2], labels[3])
    assert.match(labels[2], /sha256:[0-9a-f]{64}/u)
    assert.match(labels[3], /sha256:[0-9a-f]{64}/u)
  })
})

test('a ledger outside the declared root is reported, not read', async () => {
  await withDirectory(async (directory) => {
    const root = join(directory, 'root')
    const outside = join(directory, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(outside, 'secret.jsonl'), '', 'utf8')
    await symlink(join(outside, 'secret.jsonl'), join(root, 'link.jsonl'))

    const result = await cli(['verify', 'link.jsonl', '--root', root, '--json'], root)
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.findings.map((item) => item.ruleId), ['ledger-outside-root'])
    assert.equal(report.status, 'incomplete')
  })
})

test('append writes exactly one line and never touches the lines already there', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'ledger.jsonl')
    const first = await cli([...APPEND, '--root', directory], directory)
    assert.equal(first.code, 0)
    assert.match(first.stderr, /appended evt-0001/)
    const afterFirst = await readFile(path, 'utf8')
    assert.equal(JSON.parse(first.stdout.trim()).id, 'evt-0001')
    assert.equal(afterFirst.trim(), first.stdout.trim())

    await writeFile(join(directory, 'pricing.md'), 'a price table', 'utf8')
    const second = await cli([
      'append', 'ledger.jsonl', '--subject', 'pricing.md', '--action', 'update',
      '--reason', 'price table corrected', '--owner', 'content-team', '--release', '2026.09.1',
      '--after-file', 'pricing.md', '--recorded-at', '2026-09-02T09:00:00.000Z', '--root', directory,
    ], directory)
    assert.equal(second.code, 0)
    const afterSecond = await readFile(path, 'utf8')
    assert.equal(afterSecond.startsWith(afterFirst), true)
    assert.equal(JSON.parse(second.stdout.trim()).beforeHash, JSON.parse(first.stdout.trim()).afterHash)

    const verified = await cli(['verify', 'ledger.jsonl', '--root', directory, '--json'], directory)
    assert.equal(verified.code, 0)
    assert.equal(JSON.parse(verified.stdout).status, 'pass')

    const duplicate = await cli([...APPEND, '--id', 'evt-0001', '--root', directory], directory)
    assert.equal(duplicate.code, 2)
    assert.equal(duplicate.stdout, '')
    assert.match(duplicate.stderr, /already in this ledger/)
    assert.equal(await readFile(path, 'utf8'), afterSecond)
  })
})

test('a correction is appended through the CLI, and the corrected line is untouched', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'ledger.jsonl')
    await cli([...APPEND, '--root', directory], directory)
    const before = await readFile(path, 'utf8')

    const corrected = await cli([
      'append', 'ledger.jsonl', '--subject', 'pricing.md', '--action', 'correct', '--corrects', 'evt-0001',
      '--reason', 'evt-0001 named the wrong owner', '--owner', 'content-team', '--release', '2026.09.1',
      '--after', `sha256:${'1'.repeat(64)}`, '--recorded-at', '2026-09-02T09:00:00.000Z', '--root', directory,
    ], directory)
    assert.equal(corrected.code, 0)

    const after = await readFile(path, 'utf8')
    assert.equal(after.split(NEWLINE)[0], before.split(NEWLINE)[0])
    assert.equal(JSON.parse(after.split(NEWLINE)[0]).owner, 'content-team')
    assert.equal(JSON.parse(after.split(NEWLINE)[1]).corrects, 'evt-0001')

    const history = await cli(['history', 'ledger.jsonl', '--root', directory, '--json'], directory)
    assert.equal(history.code, 0)
    const report = JSON.parse(history.stdout)
    assert.deepEqual(report.entries.map((entry) => entry.supersededBy), [['evt-0002'], []])
  })
})

test('a history the limit cut short exits 2 and says which limit cut it', async () => {
  const cut = await cli(['history', 'examples/ledger.jsonl', '--limit', '2', '--json'])
  assert.equal(cut.code, 2)
  const report = JSON.parse(cut.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.entries.length, 2)
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['history-truncated'])

  const whole = await cli(['history', 'examples/ledger.jsonl', '--subject', 'content/pricing.md'])
  assert.equal(whole.code, 0)
  assert.match(whole.stdout, /3 matching event\(s\) of 4 read, status pass/)
  assert.match(whole.stdout, /corrected-by=evt-0004/)

  const bad = await cli(['history', 'examples/ledger.jsonl', '--limit', 'many'])
  assert.equal(bad.code, 2)
  assert.equal(bad.stdout, '')
})

test('a malformed --since or --until leaves stdout empty and exits 2', async () => {
  /* Every other filter is validated, and an unvalidated one is worse than a
     rejected one: it answers "nothing changed" with the authority of a
     complete run. */
  for (const flag of ['--since', '--until']) {
    for (const value of ['garbage', '2026-13-45', '2026-09-02', '2026-09-02T00:00:00Z']) {
      const result = await cli(['history', 'examples/ledger.jsonl', flag, value, '--json'])
      assert.equal(result.code, 2, `${flag} ${value} did not exit 2`)
      assert.equal(result.stdout, '', `${flag} ${value} wrote a report`)
      assert.match(result.stderr, new RegExp(`Query "${flag.slice(2)}" must be a UTC timestamp`))
    }
  }

  const windowed = await cli(['history', 'examples/ledger.jsonl', '--since', '2026-09-04T00:00:00.000Z', '--json'])
  assert.equal(windowed.code, 0)
  assert.equal(JSON.parse(windowed.stdout).entries.length, 3)
})

test('a history over an input that could not be read still reports which one, and exits 2', async () => {
  const missing = await cli(['history', 'absent.jsonl', '--json'])
  assert.equal(missing.code, 2)
  const report = JSON.parse(missing.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['ledger-unreadable'])
  assert.equal(report.findings[0].location.file, 'absent.jsonl')
  assert.deepEqual(report.entries, [])

  const human = await cli(['history', 'absent.jsonl'])
  assert.equal(human.code, 2)
  assert.match(human.stdout, /absent.jsonl:1 error   ledger-unreadable/)
  assert.match(human.stdout, /status incomplete/)
})

test('more ledger paths than maxFiles is a usage error: no report, empty stdout, exit 2', async () => {
  /* The one bound that is not a finding, because it is reached before any
     evidence is read: there is no run to report on. docs/ledger-rules.md says
     so, and this is what it looks like. */
  const many = new Array(65).fill('examples/ledger.jsonl')
  const result = await cli(['verify', ...many, '--json'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /limit exceeded: the maxFiles limit of 64 was exceeded \(observed 65\)/)

  /* One under the bound is read normally, so the refusal is the limit and not
     a wrong comparison. */
  const allowed = await cli(['verify', ...new Array(64).fill('examples/ledger.jsonl'), '--json'])
  assert.equal(allowed.code, 0)
  assert.equal(JSON.parse(allowed.stdout).summary.files, 64)
})

test('the documented time budget is wired through the command line', async () => {
  await withDirectory(async (directory) => {
    /* The bug this guards against is a limit that the library enforces and the
       CLI never wires a clock through, so the documented budget is accepted and
       ignored. Five thousand lines cannot be parsed inside one millisecond. */
    const line = (await readFile(join(ROOT, 'examples/ledger.jsonl'), 'utf8')).split(NEWLINE)[0]
    await writeFile(join(directory, 'long.jsonl'), `${new Array(5_000).fill(line).join(NEWLINE)}${NEWLINE}`, 'utf8')
    await writeFile(join(directory, 'fast.json'), '{"schemaVersion":"1","limits":{"timeLimitMs":1}}', 'utf8')

    const result = await cli(['verify', 'long.jsonl', '--config', 'fast.json', '--root', directory, '--json'], directory)
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    const limit = report.findings.find((item) => item.ruleId === 'limit-exceeded')
    assert.match(limit.message, /timeLimitMs limit of 1 was exceeded/)
    assert.ok(report.summary.checked < 5_000, 'the run claimed to have read past the budget')
  })
})

test('the one clock in the tool is the command line default for --recorded-at', async () => {
  await withDirectory(async (directory) => {
    /* The library refuses a draft without recordedAt; the command line is the
       only part of this tool that reads a clock, and the README says so. */
    const dated = APPEND.slice(0, APPEND.indexOf('--recorded-at'))
    const result = await cli([...dated, '--root', directory], directory)
    assert.equal(result.code, 0)
    const { recordedAt } = JSON.parse(result.stdout)
    assert.equal(new Date(recordedAt).toISOString(), recordedAt, 'the default was not a UTC instant')
    assert.ok(Math.abs(Date.parse(recordedAt) - Date.now()) < 120_000,
      `the default recordedAt ${recordedAt} did not come from this machine's clock`)

    /* And a supplied one is taken exactly, so the claim is the caller's. */
    const supplied = await cli([
      'append', 'ledger.jsonl', '--subject', 'install.md', '--action', 'create',
      '--reason', 'install page added', '--owner', 'docs-team', '--release', '2026.09.1',
      '--after', `sha256:${'2'.repeat(64)}`, '--recorded-at', '2026-09-01T09:00:00.000Z', '--root', directory,
    ], directory)
    assert.equal(supplied.code, 0, supplied.stderr)
    assert.equal(JSON.parse(supplied.stdout).recordedAt, '2026-09-01T09:00:00.000Z')
  })
})

test('two runs over the same ledger produce byte-identical output', async () => {
  const args = ['verify', 'examples/broken-ledger.jsonl', '--json']
  const first = await cli(args)
  const second = await cli(args)
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
  assert.ok(first.stdout.length > 500)
})

test('an --after-file outside the root is refused before anything is written', async () => {
  await withDirectory(async (directory) => {
    const root = join(directory, 'root')
    await mkdir(root)
    await writeFile(join(directory, 'secret.md'), 'not for the ledger', 'utf8')

    const result = await cli([
      'append', 'ledger.jsonl', '--subject', 'pricing.md', '--action', 'create',
      '--reason', 'first publication', '--owner', 'content-team', '--release', '2026.09.0',
      '--after-file', '../secret.md', '--recorded-at', '2026-09-01T09:00:00.000Z', '--root', root,
    ], root)
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /resolves outside the declared root/)
    await assert.rejects(() => readFile(join(root, 'ledger.jsonl'), 'utf8'), /ENOENT/)
  })
})
