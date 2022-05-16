/**
 * What each rule actually does to a run.
 *
 * Severity is only worth pinning where it can be observed: a rule whose
 * severity is `error` must turn a real run red, and one whose severity is
 * `warning` or `info` must not. Asserting the frozen table against a second
 * copy of the same values proves nothing -- three declarations can be edited
 * together -- so every rule here is driven through the command line and pinned
 * by what came back: the exit code, the status, and the counts the report gives
 * for errors, warnings and info.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RULES, assertEvidenceBacked, createEvent, serializeEvent } from '../src/index.mjs'

const CLI = fileURLToPath(new URL('../bin/content-change-ledger.mjs', import.meta.url))
const NEWLINE = String.fromCharCode(0x0a)
const NUL = String.fromCharCode(0x00)

const H1 = `sha256:${'1'.repeat(64)}`
const H2 = `sha256:${'2'.repeat(64)}`
const H3 = `sha256:${'3'.repeat(64)}`

function draft(overrides = {}) {
  return {
    id: 'evt-0001',
    subject: 'pricing.md',
    action: 'create',
    beforeHash: null,
    afterHash: H1,
    reason: 'first publication',
    owner: 'content-team',
    releaseId: '2026.09.0',
    recordedAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  }
}

function chain(drafts) {
  const events = []
  let previous = null
  for (const item of drafts) {
    const event = createEvent(item, previous)
    events.push(event)
    previous = event.hash
  }
  return events
}

function textOf(events) {
  return `${events.map((event) => serializeEvent(event)).join(NEWLINE)}${NEWLINE}`
}

/** Two unrelated creates that verify cleanly; the base every fail fixture bends. */
const CLEAN = [
  draft(),
  draft({ id: 'evt-0002', subject: 'install.md', afterHash: H2, recordedAt: '2026-09-02T09:00:00.000Z' }),
]

const cleanText = () => textOf(chain(CLEAN))

/**
 * One fixture per rule in the catalog.
 *
 * `findings` is the exact list the run must produce, so each fixture provokes
 * its own rule and nothing else stands in for it. `errors` / `warnings` / `info`
 * are the counts the report returned, which is where a severity actually shows
 * itself, and `exit` is what the shell saw.
 */
const FIXTURES = [
  {
    ruleId: 'event-id-duplicate',
    text: () => textOf(chain([draft(), draft({ subject: 'install.md', afterHash: H2, recordedAt: '2026-09-02T09:00:00.000Z' })])),
    exit: 1, status: 'fail', counts: [1, 0, 1], findings: ['tail-not-anchored@1', 'event-id-duplicate@2'],
  },
  {
    ruleId: 'event-hash-mismatch',
    text: () => `${serializeEvent({ ...chain([draft()])[0], reason: 'quietly reworded' })}${NEWLINE}`,
    exit: 1, status: 'fail', counts: [1, 0, 1], findings: ['event-hash-mismatch@1', 'tail-not-anchored@1'],
  },
  {
    ruleId: 'chain-genesis-invalid',
    text: () => `${serializeEvent(createEvent(draft(), H3))}${NEWLINE}`,
    exit: 1, status: 'fail', counts: [1, 0, 1], findings: ['chain-genesis-invalid@1', 'tail-not-anchored@1'],
  },
  {
    ruleId: 'chain-previous-hash-mismatch',
    text: () => {
      const events = chain([
        draft(),
        draft({ id: 'evt-0002', subject: 'install.md', afterHash: H2, recordedAt: '2026-09-02T09:00:00.000Z' }),
        draft({ id: 'evt-0003', subject: 'notes.md', afterHash: H3, recordedAt: '2026-09-03T09:00:00.000Z' }),
      ])
      return textOf([events[0], events[2]])
    },
    exit: 1, status: 'fail', counts: [1, 0, 1], findings: ['tail-not-anchored@1', 'chain-previous-hash-mismatch@2'],
  },
  {
    ruleId: 'subject-hash-discontinuity',
    text: () => textOf(chain([
      draft(),
      draft({ id: 'evt-0002', action: 'update', beforeHash: H3, afterHash: H2, recordedAt: '2026-09-02T09:00:00.000Z' }),
    ])),
    exit: 1, status: 'fail', counts: [1, 0, 1], findings: ['tail-not-anchored@1', 'subject-hash-discontinuity@2'],
  },
  {
    ruleId: 'subject-state-invalid',
    text: () => textOf(chain([draft(), draft({ id: 'evt-0002', afterHash: H2, recordedAt: '2026-09-02T09:00:00.000Z' })])),
    exit: 1, status: 'fail', counts: [1, 0, 1], findings: ['tail-not-anchored@1', 'subject-state-invalid@2'],
  },
  {
    ruleId: 'correction-target-unknown',
    text: () => textOf(chain([
      draft(),
      draft({ id: 'evt-0002', action: 'correct', corrects: 'evt-9999', beforeHash: H1, afterHash: H1,
        recordedAt: '2026-09-02T09:00:00.000Z' }),
    ])),
    exit: 1, status: 'fail', counts: [1, 0, 1], findings: ['tail-not-anchored@1', 'correction-target-unknown@2'],
  },
  {
    ruleId: 'correction-target-invalid',
    text: () => textOf(chain([
      draft(),
      draft({ id: 'evt-0002', action: 'correct', corrects: 'evt-0002', beforeHash: H1, afterHash: H1,
        recordedAt: '2026-09-02T09:00:00.000Z' }),
    ])),
    exit: 1, status: 'fail', counts: [1, 0, 1], findings: ['tail-not-anchored@1', 'correction-target-invalid@2'],
  },
  {
    ruleId: 'event-owner-not-allowed',
    text: cleanText,
    config: { schemaVersion: '1', owners: ['docs-team'] },
    exit: 1, status: 'fail', counts: [2, 0, 1],
    findings: ['event-owner-not-allowed@1', 'tail-not-anchored@1', 'event-owner-not-allowed@2'],
  },
  {
    ruleId: 'event-release-id-not-allowed',
    text: cleanText,
    config: { schemaVersion: '1', releaseIdPattern: '^2027\\.' },
    exit: 1, status: 'fail', counts: [2, 0, 1],
    findings: ['event-release-id-not-allowed@1', 'tail-not-anchored@1', 'event-release-id-not-allowed@2'],
  },
  {
    ruleId: 'checkpoint-mismatch',
    text: cleanText,
    config: { schemaVersion: '1', head: { id: 'evt-0009', hash: H3 } },
    exit: 1, status: 'fail', counts: [1, 0, 0], findings: ['checkpoint-mismatch@2'],
  },
  {
    ruleId: 'ledger-unreadable',
    absent: true,
    exit: 2, status: 'incomplete', counts: [1, 0, 0], findings: ['ledger-unreadable@1'],
  },
  {
    ruleId: 'ledger-outside-root',
    escape: true,
    exit: 2, status: 'incomplete', counts: [1, 0, 0], findings: ['ledger-outside-root@1'],
  },
  {
    ruleId: 'ledger-not-utf8',
    bytes: () => Buffer.from([0x7b, 0xff, 0x7d, 0x0a]),
    exit: 2, status: 'incomplete', counts: [1, 0, 0], findings: ['ledger-not-utf8@1'],
  },
  {
    ruleId: 'ledger-not-text',
    text: () => `{}${NUL}${NEWLINE}`,
    exit: 2, status: 'incomplete', counts: [1, 0, 0], findings: ['ledger-not-text@1'],
  },
  {
    ruleId: 'ledger-empty',
    text: () => '',
    exit: 2, status: 'incomplete', counts: [0, 1, 0], findings: ['ledger-empty@1'],
  },
  {
    ruleId: 'limit-exceeded',
    text: cleanText,
    config: { schemaVersion: '1', limits: { maxEvents: 1 } },
    exit: 2, status: 'incomplete', counts: [1, 0, 1], findings: ['tail-not-anchored@1', 'limit-exceeded@2'],
  },
  {
    ruleId: 'event-not-json',
    text: () => `${cleanText()}{"id": "evt-0003" oops${NEWLINE}`,
    exit: 2, status: 'incomplete', counts: [1, 0, 1], findings: ['tail-not-anchored@1', 'event-not-json@3'],
  },
  {
    ruleId: 'event-not-object',
    text: () => `${cleanText()}12345${NEWLINE}`,
    exit: 2, status: 'incomplete', counts: [1, 0, 1], findings: ['tail-not-anchored@1', 'event-not-object@3'],
  },
  {
    ruleId: 'event-field-missing',
    text: () => {
      const broken = { ...chain(CLEAN)[0] }
      delete broken.owner
      return `${JSON.stringify(broken)}${NEWLINE}${cleanText()}`
    },
    exit: 2, status: 'incomplete', counts: [1, 0, 1], findings: ['event-field-missing@1', 'tail-not-anchored@1'],
  },
  {
    ruleId: 'event-field-invalid',
    text: () => `${JSON.stringify({ ...chain(CLEAN)[0], owner: 42 })}${NEWLINE}${cleanText()}`,
    exit: 2, status: 'incomplete', counts: [1, 0, 1], findings: ['event-field-invalid@1', 'tail-not-anchored@1'],
  },
  {
    ruleId: 'event-field-unknown',
    text: () => `${JSON.stringify({ ...chain(CLEAN)[0], surprise: 'extra' })}${NEWLINE}${cleanText()}`,
    exit: 2, status: 'incomplete', counts: [1, 0, 1], findings: ['event-field-unknown@1', 'tail-not-anchored@1'],
  },
  {
    ruleId: 'history-truncated',
    text: cleanText,
    verb: 'history',
    extra: ['--limit', '1'],
    exit: 2, status: 'incomplete', counts: [0, 1, 0], findings: ['history-truncated@1'],
  },
  {
    ruleId: 'event-recorded-at-out-of-order',
    text: () => textOf(chain([
      draft({ recordedAt: '2026-09-02T09:00:00.000Z' }),
      draft({ id: 'evt-0002', subject: 'install.md', afterHash: H2, recordedAt: '2026-09-01T09:00:00.000Z' }),
    ])),
    exit: 0, status: 'pass', counts: [0, 1, 1],
    findings: ['tail-not-anchored@1', 'event-recorded-at-out-of-order@2'],
  },
  {
    ruleId: 'tail-not-anchored',
    text: cleanText,
    exit: 0, status: 'pass', counts: [0, 0, 1], findings: ['tail-not-anchored@1'],
  },
]

function cli(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : error.code, stdout, stderr })
    })
  })
}

async function withDirectory(body) {
  const directory = await mkdtemp(join(tmpdir(), 'content-change-ledger-severity-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Materialise one fixture on disk and return the command line that reads it. */
async function prepare(fixture, directory) {
  const args = [fixture.verb ?? 'verify']
  if (fixture.absent === true) {
    args.push('absent.jsonl')
  } else if (fixture.escape === true) {
    const outside = join(directory, 'outside')
    const root = join(directory, 'root')
    await mkdir(outside)
    await mkdir(root)
    await writeFile(join(outside, 'secret.jsonl'), cleanText(), 'utf8')
    await symlink(join(outside, 'secret.jsonl'), join(root, 'link.jsonl'))
    args.push('link.jsonl', '--root', root)
    return { args: [...args, '--json'], cwd: root }
  } else {
    await writeFile(join(directory, 'ledger.jsonl'),
      fixture.bytes === undefined ? fixture.text() : fixture.bytes(),
      fixture.bytes === undefined ? 'utf8' : undefined)
    args.push('ledger.jsonl')
  }
  if (fixture.config !== undefined) {
    await writeFile(join(directory, 'policy.json'), JSON.stringify(fixture.config), 'utf8')
    args.push('--config', 'policy.json')
  }
  args.push(...(fixture.extra ?? []), '--root', directory, '--json')
  return { args, cwd: directory }
}

test('every rule in the catalog has a fixture that shows what it does to a run', () => {
  assert.deepEqual(FIXTURES.map((fixture) => fixture.ruleId).sort(), Object.keys(RULES).sort())
  assert.equal(new Set(FIXTURES.map((fixture) => fixture.ruleId)).size, FIXTURES.length)
})

test('a rule that made a real run incomplete can never ride on a report that is not', () => {
  /* The list of incomplete rules is pinned the same way as severity: to what
     the fixtures were observed to do. A rule quietly dropped from the list
     would leave the report builder willing to emit it on a passing report,
     which is how an unread input turns green. */
  for (const fixture of FIXTURES) {
    const carried = { summary: { checked: 3 }, findings: [{ ruleId: fixture.ruleId }] }
    if (fixture.status === 'incomplete') {
      assert.throws(
        () => assertEvidenceBacked({ ...carried, status: 'fail' }),
        new RegExp(`Finding "${fixture.ruleId}" means evidence was missing`),
        `${fixture.ruleId} made a run incomplete but is accepted on a report that is not`,
      )
      assert.doesNotThrow(() => assertEvidenceBacked({ ...carried, status: 'incomplete' }))
      continue
    }
    /* And a rule that did not make a run incomplete is not on the list either,
       or the run it came from could never have been reported at all. */
    assert.doesNotThrow(
      () => assertEvidenceBacked({ ...carried, status: 'fail' }),
      `${fixture.ruleId} did not make a run incomplete but is treated as missing evidence`,
    )
  }
})

for (const fixture of FIXTURES) {
  test(`${fixture.ruleId} exits ${fixture.exit} with status ${fixture.status}`, async () => {
    await withDirectory(async (directory) => {
      const { args, cwd } = await prepare(fixture, directory)
      const result = await cli(args, cwd)

      assert.equal(result.code, fixture.exit, `exit code for ${fixture.ruleId}: ${result.stderr}`)
      const report = JSON.parse(result.stdout)
      assert.equal(report.status, fixture.status, `status for ${fixture.ruleId}`)
      assert.deepEqual(report.findings.map((item) => `${item.ruleId}@${item.line}`), fixture.findings)
      assert.deepEqual(
        [report.summary.errors, report.summary.warnings, report.summary.info],
        fixture.counts,
        `${fixture.ruleId} did not count as ${fixture.counts.join('/')} error/warning/info`,
      )
      /* And the severity carried by the finding is the one that produced those
         counts, so the report cannot say one thing and behave as another. */
      for (const item of report.findings) {
        if (item.ruleId !== fixture.ruleId) continue
        assert.equal(item.severity, RULES[fixture.ruleId])
      }
    })
  })
}
