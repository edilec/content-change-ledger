import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_LIMITS,
  INCOMPLETE_RULES,
  RULES,
  assertEvidenceBacked,
  createEvent,
  parseConfig,
  parseLedger,
  historyReport,
  readLedgers,
  serializeEvent,
  severityOf,
  verifyLedgers,
} from '../src/index.mjs'

const NEWLINE = String.fromCharCode(0x0a)
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const NUL = String.fromCharCode(0x00)

const H1 = `sha256:${'1'.repeat(64)}`
const H2 = `sha256:${'2'.repeat(64)}`
const H3 = `sha256:${'3'.repeat(64)}`
const H4 = `sha256:${'4'.repeat(64)}`

const DRAFTS = [
  { id: 'evt-0001', subject: 'pricing.md', action: 'create', beforeHash: null, afterHash: H1,
    reason: 'first publication', owner: 'content-team', releaseId: '2026.09.0', recordedAt: '2026-09-01T09:00:00.000Z' },
  { id: 'evt-0002', subject: 'pricing.md', action: 'update', beforeHash: H1, afterHash: H2,
    reason: 'price table corrected', owner: 'content-team', releaseId: '2026.09.1', recordedAt: '2026-09-02T09:00:00.000Z' },
  { id: 'evt-0003', subject: 'install.md', action: 'create', beforeHash: null, afterHash: H4,
    reason: 'install page added', owner: 'docs-team', releaseId: '2026.09.1', recordedAt: '2026-09-03T09:00:00.000Z' },
  { id: 'evt-0004', subject: 'pricing.md', action: 'correct', beforeHash: H2, afterHash: H2, corrects: 'evt-0002',
    reason: 'evt-0002 named the wrong release', owner: 'content-team', releaseId: '2026.09.2', recordedAt: '2026-09-04T09:00:00.000Z' },
]

function chain(drafts) {
  const events = []
  let previous = null
  for (const draft of drafts) {
    const event = createEvent(draft, previous)
    events.push(event)
    previous = event.hash
  }
  return events
}

function textOf(events) {
  return `${events.map((event) => serializeEvent(event)).join(NEWLINE)}${NEWLINE}`
}

function run(text, options = {}) {
  return verifyLedgers([{ file: 'ledger.jsonl', text }], options)
}

function ruleIds(report) {
  return report.findings.map((item) => `${item.ruleId}@${item.line}`)
}

test('a whole chain verifies, and the summary counts what was actually read', () => {
  const report = run(textOf(chain(DRAFTS)))
  assert.deepEqual(ruleIds(report), ['tail-not-anchored@1'])
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.summary, {
    checked: 4, errors: 0, warnings: 0, info: 1, events: 4, corrections: 1, files: 1, filesRead: 1, subjects: 2,
  })
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'content-change-ledger')
})

test('a duplicate event id is an error naming the line that already used it', () => {
  const drafts = [...DRAFTS, { ...DRAFTS[2], id: 'evt-0002', subject: 'install.md', action: 'update',
    beforeHash: H4, afterHash: H3, recordedAt: '2026-09-05T09:00:00.000Z' }]
  const report = run(textOf(chain(drafts)))
  const duplicate = report.findings.find((item) => item.ruleId === 'event-id-duplicate')
  assert.equal(duplicate.line, 5)
  assert.equal(duplicate.severity, 'error')
  assert.match(duplicate.message, /already recorded on line 2/)
  assert.equal(report.status, 'fail')
})

test('an event lifted out of the middle breaks the chain at the line after it', () => {
  const events = chain(DRAFTS)
  const report = run(textOf([events[0], events[2], events[3]]))
  assert.deepEqual(ruleIds(report), [
    'tail-not-anchored@1',
    'chain-previous-hash-mismatch@2',
    'correction-target-unknown@3',
    'subject-hash-discontinuity@3',
  ])
  const broken = report.findings.find((item) => item.ruleId === 'chain-previous-hash-mismatch')
  assert.match(broken.message, /follows line 1 in the file/)
  assert.match(broken.evidence, /recorded sha256:[0-9a-f]{64}, expected sha256:[0-9a-f]{64}/)
  assert.equal(report.status, 'fail')
})

test('a removed event is visible as a hash discontinuity in the subject it changed', () => {
  const events = chain([DRAFTS[0], DRAFTS[1],
    { id: 'evt-0003', subject: 'pricing.md', action: 'update', beforeHash: H2, afterHash: H3,
      reason: 'third revision', owner: 'content-team', releaseId: '2026.09.2', recordedAt: '2026-09-03T09:00:00.000Z' }])
  const report = run(textOf([events[0], events[2]]))
  const gap = report.findings.find((item) => item.ruleId === 'subject-hash-discontinuity')
  assert.equal(gap.line, 2)
  assert.equal(gap.severity, 'error')
  assert.match(gap.evidence, new RegExp(`beforeHash ${H2}, last afterHash ${H1}`))
})

test('an edited event no longer matches its own hash', () => {
  const events = chain(DRAFTS)
  const tampered = { ...events[1], reason: 'quietly reworded after the fact' }
  const report = run(textOf([events[0], tampered, events[2], events[3]]))
  const mismatch = report.findings.filter((item) => item.ruleId === 'event-hash-mismatch')
  assert.deepEqual(mismatch.map((item) => item.line), [2])
  assert.equal(mismatch[0].severity, 'error')
  assert.deepEqual(ruleIds(report).filter((entry) => entry.startsWith('chain-')), [])
  assert.equal(report.status, 'fail')
})

test('an event missing from the front of the file is reported at the genesis', () => {
  const events = chain(DRAFTS)
  const report = run(textOf(events.slice(1)))
  const genesis = report.findings.find((item) => item.ruleId === 'chain-genesis-invalid')
  assert.equal(genesis.line, 1)
  assert.match(genesis.message, /missing from the front of the file/)
  assert.equal(report.status, 'fail')
})

test('a subject cannot be created twice, updated before it exists, or deleted twice', () => {
  const drafts = [
    DRAFTS[0],
    { ...DRAFTS[0], id: 'evt-0002', recordedAt: '2026-09-02T09:00:00.000Z' },
    { id: 'evt-0003', subject: 'missing.md', action: 'update', beforeHash: H3, afterHash: H4,
      reason: 'edited a page the ledger never saw created', owner: 'docs-team', releaseId: '2026.09.1',
      recordedAt: '2026-09-03T09:00:00.000Z' },
  ]
  const report = run(textOf(chain(drafts)))
  const invalid = report.findings.filter((item) => item.ruleId === 'subject-state-invalid')
  assert.deepEqual(invalid.map((item) => item.line), [2, 3])
  assert.match(invalid[0].message, /already exists/)
  assert.match(invalid[1].message, /does not exist/)
})

test('a correction must name an earlier event, and never itself', () => {
  const unknown = chain([DRAFTS[0],
    { ...DRAFTS[3], id: 'evt-0002', corrects: 'evt-9999', beforeHash: H1, afterHash: H1 }])
  assert.deepEqual(ruleIds(run(textOf(unknown))).filter((entry) => entry.startsWith('correction-')),
    ['correction-target-unknown@2'])

  const itself = chain([DRAFTS[0],
    { ...DRAFTS[3], id: 'evt-0002', corrects: 'evt-0002', beforeHash: H1, afterHash: H1 }])
  assert.deepEqual(ruleIds(run(textOf(itself))).filter((entry) => entry.startsWith('correction-')),
    ['correction-target-invalid@2'])
})

test('a correction is an extra event; the event it corrects is left exactly as it was', () => {
  const events = chain(DRAFTS)
  const before = textOf(events.slice(0, 3))
  const after = textOf(events)
  assert.equal(after.startsWith(before), true)
  assert.equal(run(after).status, 'pass')
  assert.equal(run(after).summary.corrections, 1)
  const corrected = JSON.parse(after.split(NEWLINE)[1])
  assert.deepEqual(corrected, JSON.parse(before.split(NEWLINE)[1]))
  assert.equal(corrected.releaseId, '2026.09.1')
})

test('a line that could not be parsed is unknown, not a verdict about the line after it', () => {
  const events = chain(DRAFTS)
  const lines = textOf(events).split(NEWLINE)
  lines[1] = '{"id": "evt-0002", oops'
  const report = run(lines.join(NEWLINE))

  assert.deepEqual(ruleIds(report), ['tail-not-anchored@1', 'event-not-json@2'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 3)
  /* The evidence is bounded and escaped, and it is never treated as a chain claim. */
  assert.equal(report.findings[1].evidence.includes(NEWLINE), false)
  assert.equal(report.findings.some((item) => item.ruleId === 'chain-previous-hash-mismatch'), false)
})

test('an event with an unknown or missing field is incomplete, never a pass', () => {
  const events = chain(DRAFTS)
  const lines = textOf(events).split(NEWLINE)
  const broken = { ...events[1], surprise: 'extra' }
  delete broken.owner
  lines[1] = JSON.stringify(broken)
  const report = run(lines.join(NEWLINE))

  assert.deepEqual(ruleIds(report).filter((entry) => entry.startsWith('event-field')).sort(), [
    'event-field-missing@2',
    'event-field-unknown@2',
  ])
  assert.equal(report.status, 'incomplete')
  for (const ruleId of ['event-field-missing', 'event-field-unknown']) {
    assert.ok(INCOMPLETE_RULES.includes(ruleId))
  }
})

test('an empty ledger is incomplete, because a run that verified nothing is never green', () => {
  const report = run('')
  assert.deepEqual(ruleIds(report), ['ledger-empty@1'])
  assert.equal(report.summary.checked, 0)
  assert.equal(report.findings[0].severity, 'warning')
  /* The warning alone would leave this a pass: the incomplete flag is the only
     thing standing between "no evidence" and "green". */
  assert.equal(report.status, 'incomplete')

  const blank = run(`${NEWLINE}   ${NEWLINE}`)
  assert.equal(blank.status, 'incomplete')
  assert.equal(blank.summary.checked, 0)
})

test('a report that names missing evidence can only be incomplete', () => {
  const healthy = { status: 'fail', summary: { checked: 3 }, findings: [{ ruleId: 'event-id-duplicate' }] }
  assert.equal(assertEvidenceBacked(healthy), healthy)

  for (const ruleId of INCOMPLETE_RULES) {
    assert.throws(
      () => assertEvidenceBacked({ status: 'fail', summary: { checked: 3 }, findings: [{ ruleId }] }),
      new RegExp(`Finding "${ruleId}" means evidence was missing`),
      `${ruleId} was allowed on a report that is not incomplete`,
    )
    assert.doesNotThrow(
      () => assertEvidenceBacked({ status: 'incomplete', summary: { checked: 3 }, findings: [{ ruleId }] }),
    )
  }
  assert.throws(
    () => assertEvidenceBacked({ status: 'pass', summary: { checked: 0 }, findings: [] }),
    /Refusing to report a pass with no verified event/,
  )
})

test('a run with nothing at all to verify refuses to report a pass', () => {
  /* The last guard, reached when there is not even an empty ledger to name:
     "checked: 0" can never be green, whatever the flags say. */
  assert.throws(() => verifyLedgers([]), /Refusing to report a pass with no verified event/)
  assert.throws(() => historyReport([], {}), /Refusing to report a pass with no verified event/)
  assert.equal(run('').status, 'incomplete')
})

test('each declared bound is enforced and named, and none truncates in silence', () => {
  const events = chain(DRAFTS)
  const text = textOf(events)

  const tooMany = run(text, { limits: { ...DEFAULT_LIMITS, maxEvents: 2 } })
  assert.equal(tooMany.status, 'incomplete')
  assert.equal(tooMany.summary.checked, 2)
  assert.match(tooMany.findings.find((item) => item.ruleId === 'limit-exceeded').message, /maxEvents limit of 2/)

  const tooLong = run(text, { limits: { ...DEFAULT_LIMITS, maxEventBytes: 100 } })
  assert.equal(tooLong.status, 'incomplete')
  assert.equal(tooLong.summary.checked, 0)
  assert.equal(tooLong.findings.filter((item) => item.ruleId === 'limit-exceeded').length, 4)

  let tick = 0
  const clock = () => {
    tick += 5_000
    return tick
  }
  const tooSlow = run(text, { clock, limits: { ...DEFAULT_LIMITS, timeLimitMs: 1_000 } })
  assert.equal(tooSlow.status, 'incomplete')
  assert.match(tooSlow.findings.find((item) => item.ruleId === 'limit-exceeded').message, /timeLimitMs limit of 1000/)

  assert.deepEqual(Object.keys(DEFAULT_LIMITS).sort(), [
    'maxBytes', 'maxEventBytes', 'maxEvents', 'maxFieldLength', 'maxFiles', 'maxQueryResults', 'maxReasonLength', 'timeLimitMs',
  ])
})

test('the head checkpoint is what detects a truncated tail', () => {
  const events = chain(DRAFTS)
  const head = { schemaVersion: '1', head: { id: events.at(-1).id, hash: events.at(-1).hash } }

  const whole = run(textOf(events), { config: parseConfig(head) })
  assert.deepEqual(ruleIds(whole), [])
  assert.equal(whole.status, 'pass')

  const truncated = run(textOf(events.slice(0, 3)), { config: parseConfig(head) })
  assert.deepEqual(ruleIds(truncated), ['checkpoint-mismatch@3'])
  assert.equal(truncated.status, 'fail')

  /* Without the checkpoint the same truncation is invisible, and the report
     says so rather than implying the tail was checked. */
  const unanchored = run(textOf(events.slice(0, 3)))
  assert.deepEqual(ruleIds(unanchored), ['tail-not-anchored@1'])
  assert.equal(unanchored.status, 'pass')
  assert.equal(unanchored.findings[0].severity, 'info')
})

test('a checkpoint is not claimed when the tail was never read', () => {
  const events = chain(DRAFTS)
  const config = parseConfig({ schemaVersion: '1', head: { id: 'evt-0004', hash: events.at(-1).hash } })
  const report = run(textOf(events), { config, limits: { ...DEFAULT_LIMITS, maxEvents: 2 } })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.some((item) => item.ruleId === 'checkpoint-mismatch'), false)
})

test('configured owners and release ids are enforced, and a typo in a key is refused', () => {
  const events = chain(DRAFTS)
  const config = parseConfig({
    schemaVersion: '1',
    owners: ['content-team'],
    releaseIdPattern: '^2026\\.09\\.[01]$',
  })
  const report = run(textOf(events), { config })
  assert.deepEqual(ruleIds(report).filter((entry) => entry.startsWith('event-')), [
    'event-owner-not-allowed@3',
    'event-release-id-not-allowed@4',
  ])
  assert.equal(report.status, 'fail')

  assert.throws(() => parseConfig({ schemaVersion: '1', owner: ['content-team'] }), /Unknown configuration key "owner"/)
  assert.throws(() => parseConfig({ schemaVersion: '1', limits: { maxEvent: 5 } }), /Unknown limit "maxEvent"/)
  assert.throws(() => parseConfig({ schemaVersion: '1', head: { id: 'evt-0001' } }), /head.hash/)
  assert.throws(() => parseConfig({ schemaVersion: '2' }), /schemaVersion must be "1"/)
  assert.throws(() => parseConfig({ schemaVersion: '1', limits: { maxEvents: 0 } }), /must be a positive integer/)
  assert.throws(() => parseConfig({ schemaVersion: '1', releaseIdPattern: '(' }), /not a valid regular expression/)
})

test('a head checkpoint refuses to stand for more than the one ledger it anchors', () => {
  const config = parseConfig({ schemaVersion: '1', head: { id: 'evt-0001', hash: H1 } })
  const text = textOf(chain(DRAFTS))
  assert.throws(
    () => verifyLedgers([{ file: 'a.jsonl', text }, { file: 'b.jsonl', text }], { config }),
    /anchors a single ledger/,
  )
})

test('findings are ordered by file, then line, then rule id -- by code unit', () => {
  const events = chain(DRAFTS)
  const duplicated = chain([...DRAFTS, { ...DRAFTS[3], id: 'evt-0002', corrects: 'evt-9999',
    recordedAt: '2026-09-01T00:00:00.000Z' }])
  const report = verifyLedgers([
    { file: 'alpha.jsonl', text: textOf(events.slice(1)) },
    { file: 'Zeta.jsonl', text: textOf(duplicated) },
  ])
  const order = report.findings.map((item) => `${item.location.file}:${item.line}:${item.ruleId}`)
  assert.deepEqual(order, [
    'Zeta.jsonl:1:tail-not-anchored',
    'Zeta.jsonl:5:correction-target-unknown',
    'Zeta.jsonl:5:event-id-duplicate',
    'Zeta.jsonl:5:event-recorded-at-out-of-order',
    'alpha.jsonl:1:chain-genesis-invalid',
    'alpha.jsonl:1:subject-state-invalid',
    'alpha.jsonl:1:tail-not-anchored',
  ])
})

test('the same ledger produces a byte-identical report twice', () => {
  const text = textOf(chain(DRAFTS))
  const first = JSON.stringify(run(text, { clock: () => 0 }))
  const second = JSON.stringify(run(text, { clock: () => 1_000 }))
  assert.equal(first, second)
  assert.ok(first.length > 200)
})

test('every finding takes its severity from the frozen catalog, and an unknown rule throws', () => {
  const events = chain(DRAFTS)
  const lines = textOf([...events, events[0]]).split(NEWLINE)
  lines.push('not json at all')
  const report = run(lines.join(NEWLINE), { limits: { ...DEFAULT_LIMITS, maxEventBytes: 400 } })
  assert.ok(report.findings.length >= 4)
  for (const item of report.findings) {
    assert.equal(item.severity, RULES[item.ruleId], `${item.ruleId} did not take its severity from the catalog`)
  }
  assert.ok(Object.isFrozen(RULES))
})

test('a rule id the catalog does not know throws instead of inventing a severity', () => {
  /* The lookup every finding goes through, called directly. Asserting that
     RULES['no-such-rule'] is undefined would assert JavaScript, not this
     package: the guard is the throw, so the throw is what is called here. */
  assert.equal(severityOf('event-id-duplicate'), 'error')
  assert.equal(severityOf('ledger-empty'), 'warning')
  assert.equal(severityOf('tail-not-anchored'), 'info')
  assert.throws(() => severityOf('no-such-rule'), /Unknown ruleId "no-such-rule"/)
  assert.throws(() => severityOf(undefined), /Unknown ruleId "undefined"/)
  /* Including when the unknown id is hostile: the refusal quotes it escaped. */
  assert.throws(() => severityOf(`evt${String.fromCharCode(0x2028)}x`), /Unknown ruleId "evt\\u2028x"/)
})

test('every rule in the catalog is documented, and every documented rule exists', async () => {
  const docs = await readFile(fileURLToPath(new URL('../docs/ledger-rules.md', import.meta.url)), 'utf8')
  const documented = new Map()
  for (const line of docs.split(NEWLINE)) {
    const match = /^\| `([a-z0-9-]+)` \| (error|warning|info) \| (yes|no) \|/.exec(line)
    if (match !== null) documented.set(match[1], { severity: match[2], incomplete: match[3] === 'yes' })
  }
  assert.equal(documented.size, Object.keys(RULES).length)
  assert.deepEqual([...documented.keys()].sort(), Object.keys(RULES).sort())
  for (const [ruleId, entry] of documented) {
    assert.equal(RULES[ruleId], entry.severity, `docs and code disagree about the severity of ${ruleId}`)
    assert.equal(INCOMPLETE_RULES.includes(ruleId), entry.incomplete,
      `docs and code disagree about whether ${ruleId} forces an incomplete run`)
  }
  assert.deepEqual([...INCOMPLETE_RULES].sort(),
    [...documented].filter(([, entry]) => entry.incomplete).map(([ruleId]) => ruleId).sort())
})

test('an untrusted identifier cannot forge a line in the human report', () => {
  /* U+2028 survives JSON.stringify as a literal character, so this is the one
     way a crafted id really can carry a line break into a report. It is
     rejected as a field, and the evidence that quotes the line escapes it. */
  const separated = JSON.stringify({
    ...chain(DRAFTS)[0],
    id: `evt-0001${LINE_SEPARATOR}ERROR   something that never happened`,
  })
  const report = run(`${separated}${NEWLINE}`)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report), ['event-field-invalid@1', 'ledger-empty@1'])
  const evidence = report.findings.find((item) => item.evidence !== undefined).evidence
  assert.equal(evidence.includes(LINE_SEPARATOR), false)
  assert.match(evidence, /\\u2028/)
  for (const item of report.findings) {
    assert.equal(item.message.includes(NEWLINE), false)
    assert.equal(item.message.includes(LINE_SEPARATOR), false)
  }

  /* And a raw control character in a line that is not JSON at all. */
  const raw = run(`{"id": "evt-0001${String.fromCharCode(0x1f)}broken`)
  const rawEvidence = raw.findings.find((item) => item.ruleId === 'event-not-json').evidence
  assert.equal(rawEvidence.includes(String.fromCharCode(0x1f)), false)
  assert.match(rawEvidence, /\\u001f/)
  assert.equal(raw.status, 'incomplete')
})

test('reading names each input failure instead of skipping it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'content-change-ledger-'))
  try {
    const text = textOf(chain(DRAFTS))
    await writeFile(join(directory, 'good.jsonl'), text, 'utf8')
    await writeFile(join(directory, 'latin1.jsonl'), Buffer.from([0x7b, 0xff, 0x7d, 0x0a]))
    await writeFile(join(directory, 'binary.jsonl'), `{}${NUL}${NEWLINE}`, 'utf8')

    const { ledgers, failures } = await readLedgers(
      ['good.jsonl', 'latin1.jsonl', 'binary.jsonl', 'absent.jsonl'],
      { cwd: directory, root: directory },
    )
    assert.deepEqual(ledgers.map((ledger) => ledger.file), ['good.jsonl'])
    assert.deepEqual(failures.map((failure) => `${failure.ruleId}:${failure.file}`), [
      'ledger-not-utf8:latin1.jsonl',
      'ledger-not-text:binary.jsonl',
      'ledger-unreadable:absent.jsonl',
    ])

    const report = verifyLedgers(ledgers, { failures })
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.files, 4)
    assert.equal(report.summary.filesRead, 1)
    assert.equal(report.summary.checked, 4)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('bytes that are not UTF-8 are reported even when the file also carries U+FFFD', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'content-change-ledger-'))
  try {
    const path = join(directory, 'mixed.jsonl')
    await writeFile(path, Buffer.concat([
      Buffer.from(`{"note":"${String.fromCharCode(0xfffd)}"}`, 'utf8'),
      Buffer.from([0xc3, 0x28, 0x0a]),
    ]))
    const { ledgers, failures } = await readLedgers(['mixed.jsonl'], { cwd: directory, root: directory })
    assert.deepEqual(ledgers, [])
    assert.deepEqual(failures.map((failure) => failure.ruleId), ['ledger-not-utf8'])

    /* The same file without the undecodable bytes is read normally, so the
       guard is about the bytes, never about what the text happens to contain. */
    await writeFile(path, `{"note":"${String.fromCharCode(0xfffd)}"}${NEWLINE}`, 'utf8')
    const second = await readLedgers(['mixed.jsonl'], { cwd: directory, root: directory })
    assert.deepEqual(second.failures, [])
    assert.equal(second.ledgers[0].text.includes(String.fromCharCode(0xfffd)), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('confinement compares two real paths, so a symlinked root is not a false refusal', async () => {
  const base = await mkdtemp(join(tmpdir(), 'content-change-ledger-'))
  try {
    const root = join(base, 'root')
    const outside = join(base, 'outside')
    await writeFile(join(base, 'placeholder'), '', 'utf8')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(root)
    await mkdir(outside)
    const text = textOf(chain(DRAFTS))
    await writeFile(join(root, 'inside.jsonl'), text, 'utf8')
    await writeFile(join(outside, 'secret.jsonl'), text, 'utf8')
    await symlink(join(outside, 'secret.jsonl'), join(root, 'escape.jsonl'))
    await symlink(root, join(base, 'root-link'))

    const escaped = await readLedgers(['escape.jsonl'], { cwd: root, root })
    assert.deepEqual(escaped.ledgers, [])
    assert.deepEqual(escaped.failures.map((failure) => failure.ruleId), ['ledger-outside-root'])

    /* And the over-correction: a legitimate file reached through a symlinked
       root must still be read. A false refusal is a bug too. */
    const linked = await readLedgers(['inside.jsonl'], { cwd: join(base, 'root-link'), root: join(base, 'root-link') })
    assert.deepEqual(linked.failures, [])
    assert.deepEqual(linked.ledgers.map((ledger) => ledger.file), ['inside.jsonl'])
    assert.equal(verifyLedgers(linked.ledgers).status, 'pass')

    const traversal = await readLedgers(['../outside/secret.jsonl'], { cwd: root, root })
    assert.deepEqual(traversal.failures.map((failure) => failure.ruleId), ['ledger-outside-root'])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the byte and file bounds on reading are enforced', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'content-change-ledger-'))
  try {
    await writeFile(join(directory, 'big.jsonl'), textOf(chain(DRAFTS)), 'utf8')
    const { failures } = await readLedgers(['big.jsonl'], {
      cwd: directory, root: directory, limits: { ...DEFAULT_LIMITS, maxBytes: 10 },
    })
    assert.deepEqual(failures.map((failure) => failure.ruleId), ['limit-exceeded'])
    assert.match(failures[0].message, /maxBytes limit of 10/)

    await assert.rejects(
      () => readLedgers(['big.jsonl', 'big.jsonl'], {
        cwd: directory, root: directory, limits: { ...DEFAULT_LIMITS, maxFiles: 1 },
      }),
      /maxFiles limit of 1/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('parsing keeps every line it read, and freezes what it returns', () => {
  const text = textOf(chain(DRAFTS))
  const { records, limitProblem } = parseLedger(text)
  assert.equal(limitProblem, null)
  assert.deepEqual(records.map((record) => record.line), [1, 2, 3, 4])
  assert.ok(Object.isFrozen(records[0].event))
  assert.throws(() => {
    records[0].event.reason = 'rewritten'
  }, TypeError)
})
