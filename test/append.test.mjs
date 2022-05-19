import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_LIMITS,
  appendEvent,
  historyReport,
  parseLedger,
  queryHistory,
  readLedgers,
  verifyLedgers,
} from '../src/index.mjs'

const NEWLINE = String.fromCharCode(0x0a)
const H1 = `sha256:${'1'.repeat(64)}`
const H2 = `sha256:${'2'.repeat(64)}`
const H3 = `sha256:${'3'.repeat(64)}`

function draft(overrides = {}) {
  return {
    subject: 'pricing.md',
    action: 'create',
    afterHash: H1,
    reason: 'first publication',
    owner: 'content-team',
    releaseId: '2026.09.0',
    recordedAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  }
}

async function withDirectory(body) {
  const directory = await mkdtemp(join(tmpdir(), 'content-change-ledger-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function seed(directory, name = 'ledger.jsonl') {
  const path = join(directory, name)
  await writeFile(path, '', 'utf8')
  const options = { cwd: directory, root: directory }
  await appendEvent(path, draft(), options)
  await appendEvent(path, draft({
    action: 'update', afterHash: H2, reason: 'price table corrected',
    releaseId: '2026.09.1', recordedAt: '2026-09-02T09:00:00.000Z',
  }), options)
  await appendEvent(path, draft({
    subject: 'install.md', afterHash: H3, reason: 'install page added', owner: 'docs-team',
    releaseId: '2026.09.1', recordedAt: '2026-09-03T09:00:00.000Z',
  }), options)
  return { path, options }
}

test('an append adds one line and leaves every earlier byte exactly as it was', async () => {
  await withDirectory(async (directory) => {
    const { path, options } = await seed(directory)
    const before = await readFile(path, 'utf8')

    const { event } = await appendEvent(path, draft({
      subject: 'install.md', action: 'update', afterHash: H1, reason: 'install page rewritten',
      owner: 'docs-team', releaseId: '2026.09.2', recordedAt: '2026-09-04T09:00:00.000Z',
    }), options)
    const after = await readFile(path, 'utf8')

    assert.equal(after.startsWith(before), true, 'the existing bytes were rewritten')
    assert.equal(after.length > before.length, true)
    assert.equal(after.slice(before.length).split(NEWLINE).filter((line) => line !== '').length, 1)
    assert.equal(event.id, 'evt-0004')
    assert.equal(event.previousHash, parseLedger(before).records.at(-1).event.hash)
    assert.equal(event.beforeHash, H3, 'beforeHash did not default to the last afterHash for the subject')
    assert.equal(verifyLedgers([{ file: 'ledger.jsonl', text: after }]).status, 'pass')
  })
})

test('no read path in the public API rewrites the ledger', async () => {
  await withDirectory(async (directory) => {
    const { path, options } = await seed(directory)
    const before = await readFile(path)

    const { ledgers, failures } = await readLedgers(['ledger.jsonl'], options)
    verifyLedgers(ledgers, { failures })
    historyReport(ledgers, { subject: 'pricing.md' })
    const { records } = parseLedger(ledgers[0].text)
    const history = queryHistory(records.map((record) => record.event), {})
    history.entries[0].reason = 'mutated through the query result'

    assert.deepEqual(await readFile(path), before)
    assert.equal(records[0].event.reason, 'first publication')
    assert.equal(queryHistory(records.map((record) => record.event), {}).entries[0].reason, 'first publication')
  })
})

test('a correction appends an event; the event it corrects keeps its bytes', async () => {
  await withDirectory(async (directory) => {
    const { path, options } = await seed(directory)
    const before = await readFile(path, 'utf8')
    const correctedLine = before.split(NEWLINE)[1]

    const { event } = await appendEvent(path, draft({
      action: 'correct', corrects: 'evt-0002', afterHash: H2, reason: 'evt-0002 named the wrong release',
      releaseId: '2026.09.2', recordedAt: '2026-09-05T09:00:00.000Z',
    }), options)
    const after = await readFile(path, 'utf8')

    assert.equal(after.split(NEWLINE)[1], correctedLine, 'the corrected event was edited in place')
    assert.equal(JSON.parse(correctedLine).releaseId, '2026.09.1')
    assert.equal(event.corrects, 'evt-0002')
    assert.equal(event.action, 'correct')

    const { ledgers } = await readLedgers(['ledger.jsonl'], options)
    assert.equal(verifyLedgers(ledgers).status, 'pass')
    const report = historyReport(ledgers, { subject: 'pricing.md' })
    assert.deepEqual(report.entries.map((entry) => `${entry.id}:${entry.supersededBy.join(',')}`), [
      'evt-0001:',
      'evt-0002:evt-0004',
      'evt-0004:',
    ])
    /* The annotation is for the reader only; it is never written to the file. */
    assert.equal(after.includes('supersededBy'), false)
  })
})

test('a duplicate id is refused, and nothing is written', async () => {
  await withDirectory(async (directory) => {
    const { path, options } = await seed(directory)
    const before = await readFile(path)
    await assert.rejects(
      () => appendEvent(path, draft({ id: 'evt-0002', subject: 'notes.md', afterHash: H1 }), options),
      /already in this ledger/,
    )
    assert.deepEqual(await readFile(path), before)
  })
})

test('an append that would not verify is refused, and nothing is written', async () => {
  await withDirectory(async (directory) => {
    const { path, options } = await seed(directory)
    const before = await readFile(path)

    await assert.rejects(
      () => appendEvent(path, draft({ recordedAt: '2026-09-04T09:00:00.000Z' }), options),
      /subject-state-invalid/,
      'creating a subject that already exists was accepted',
    )
    await assert.rejects(
      () => appendEvent(path, draft({
        subject: 'pricing.md', action: 'update', beforeHash: H1, afterHash: H3,
        recordedAt: '2026-09-04T09:00:00.000Z',
      }), options),
      /subject-hash-discontinuity/,
      'an update from a hash the ledger never recorded was accepted',
    )
    await assert.rejects(
      () => appendEvent(path, draft({
        action: 'correct', corrects: 'evt-9999', afterHash: H2, recordedAt: '2026-09-04T09:00:00.000Z',
      }), options),
      /records no such event/,
    )
    assert.deepEqual(await readFile(path), before)
  })
})

test('appending to a ledger that does not verify is refused', async () => {
  await withDirectory(async (directory) => {
    const { path, options } = await seed(directory)
    const lines = (await readFile(path, 'utf8')).split(NEWLINE).filter((line) => line !== '')
    const broken = `${[lines[0], lines[2]].join(NEWLINE)}${NEWLINE}`
    await writeFile(path, broken, 'utf8')

    await assert.rejects(
      () => appendEvent(path, draft({ subject: 'notes.md', afterHash: H3, recordedAt: '2026-09-04T09:00:00.000Z' }), options),
      /does not verify: chain-previous-hash-mismatch on line 2/,
    )
    assert.equal(await readFile(path, 'utf8'), broken)
  })
})

test('the clock is injected: an event without recordedAt is refused', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'ledger.jsonl')
    const options = { cwd: directory, root: directory }
    const without = draft()
    delete without.recordedAt
    await assert.rejects(() => appendEvent(path, without, options), /"recordedAt" must be a non-empty string/)
  })
})

test('a ledger created for the first time is confined by its real parent', async () => {
  await withDirectory(async (directory) => {
    const root = join(directory, 'root')
    const outside = join(directory, 'outside')
    await mkdir(root)
    await mkdir(outside)
    const options = { cwd: root, root }

    const { event } = await appendEvent(join(root, 'new.jsonl'), draft(), options)
    assert.equal(event.previousHash, null)
    assert.equal(event.id, 'evt-0001')
    const text = await readFile(join(root, 'new.jsonl'), 'utf8')
    assert.equal(text.split(NEWLINE).filter((line) => line !== '').length, 1)

    await assert.rejects(
      () => appendEvent(join(outside, 'escaped.jsonl'), draft(), options),
      /resolves outside the declared root/,
    )
    await assert.rejects(() => readFile(join(outside, 'escaped.jsonl'), 'utf8'), /ENOENT/)
  })
})

test('a symlink planted inside the root is not a way out of it', async () => {
  await withDirectory(async (directory) => {
    const root = join(directory, 'root')
    const outside = join(directory, 'outside')
    await mkdir(root)
    await mkdir(outside)
    const target = join(outside, 'secret.jsonl')
    await writeFile(target, '', 'utf8')
    await symlink(target, join(root, 'link.jsonl'))

    await assert.rejects(
      () => appendEvent(join(root, 'link.jsonl'), draft(), { cwd: root, root }),
      /resolves outside the declared root/,
    )
    assert.equal(await readFile(target, 'utf8'), '')

    /* The same write through a symlinked root is legitimate and must succeed. */
    await symlink(root, join(directory, 'root-link'))
    const linkedRoot = join(directory, 'root-link')
    const { event } = await appendEvent(join(linkedRoot, 'real.jsonl'), draft(), { cwd: linkedRoot, root: linkedRoot })
    assert.equal(event.subject, 'pricing.md')
    assert.match(await readFile(join(root, 'real.jsonl'), 'utf8'), /"id":"evt-0001"/)
  })
})

test('a query filters by subject, owner, release, action and time', async () => {
  await withDirectory(async (directory) => {
    const { options } = await seed(directory)
    const { ledgers } = await readLedgers(['ledger.jsonl'], options)
    const ids = (filters) => historyReport(ledgers, filters).entries.map((entry) => entry.id)

    assert.deepEqual(ids({}), ['evt-0001', 'evt-0002', 'evt-0003'])
    assert.deepEqual(ids({ subject: 'install.md' }), ['evt-0003'])
    assert.deepEqual(ids({ owner: 'content-team' }), ['evt-0001', 'evt-0002'])
    assert.deepEqual(ids({ releaseId: '2026.09.1' }), ['evt-0002', 'evt-0003'])
    assert.deepEqual(ids({ action: 'update' }), ['evt-0002'])
    assert.deepEqual(ids({ since: '2026-09-02T00:00:00.000Z' }), ['evt-0002', 'evt-0003'])
    assert.deepEqual(ids({ until: '2026-09-02T00:00:00.000Z' }), ['evt-0001'])
    assert.deepEqual(ids({ subject: 'install.md', owner: 'content-team' }), [])
    assert.equal(historyReport(ledgers, { subject: 'install.md' }).status, 'pass')
  })
})

test('a query the limit cut short is incomplete, never a quietly short answer', async () => {
  await withDirectory(async (directory) => {
    const { options } = await seed(directory)
    const { ledgers } = await readLedgers(['ledger.jsonl'], options)

    const cut = historyReport(ledgers, { limit: 2 })
    assert.equal(cut.entries.length, 2)
    assert.equal(cut.status, 'incomplete')
    const truncation = cut.findings.find((item) => item.ruleId === 'history-truncated')
    assert.match(truncation.message, /3 event\(s\) match this query but the limit of 2/)

    const whole = historyReport(ledgers, { limit: 3 })
    assert.equal(whole.status, 'pass')
    assert.equal(whole.summary.matched, 3)
  })
})

test('a query refuses an unknown filter, a bad limit and an unknown action', () => {
  const events = []
  assert.throws(() => queryHistory(events, { release: '2026.09.0' }), /Unknown query filter "release"/)
  assert.throws(() => queryHistory(events, { limit: 0 }), /must be a positive integer/)
  assert.throws(() => queryHistory(events, { action: 'edit' }), /must be one of create, update, delete, correct/)
  assert.throws(
    () => queryHistory(events, { limit: 5 }, { ...DEFAULT_LIMITS, maxQueryResults: 4 }),
    /at most the maxQueryResults limit of 4/,
  )
})

test('a malformed time window is refused, never answered with an authoritative nothing', async () => {
  await withDirectory(async (directory) => {
    const { options } = await seed(directory)
    const { ledgers } = await readLedgers(['ledger.jsonl'], options)

    /* A window that matches nothing because it is a typo would otherwise come
       back as a complete, green "no events changed" -- the same answer a real
       empty window gives, with none of the evidence. */
    for (const malformed of ['garbage', '2026-13-45', '2026-09-02', '2026-09-02T00:00:00Z',
      '2026-09-02T00:00:00.000+01:00', '2026-02-30T00:00:00.000Z', 42]) {
      for (const key of ['since', 'until']) {
        assert.throws(
          () => historyReport(ledgers, { [key]: malformed }),
          new RegExp(`Query "${key}" must be a UTC timestamp`),
          `${key}=${String(malformed)} was accepted`,
        )
        assert.throws(() => queryHistory([], { [key]: malformed }), new RegExp(`Query "${key}" must be a UTC timestamp`))
      }
    }

    /* The one spelling the ledger itself uses is still accepted, and still filters. */
    const window = historyReport(ledgers, { since: '2026-09-02T00:00:00.000Z', until: '2026-09-02T23:59:59.999Z' })
    assert.deepEqual(window.entries.map((entry) => entry.id), ['evt-0002'])
    assert.equal(window.status, 'pass')
  })
})

test('a query over a ledger it could not read in full says so', async () => {
  await withDirectory(async (directory) => {
    const { path, options } = await seed(directory)
    const lines = (await readFile(path, 'utf8')).split(NEWLINE)
    lines[1] = '{"id": "evt-0002" truncated'
    await writeFile(path, lines.join(NEWLINE), 'utf8')

    const { ledgers } = await readLedgers(['ledger.jsonl'], options)
    const report = historyReport(ledgers, { subject: 'pricing.md' })
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(report.entries.map((entry) => entry.id), ['evt-0001'])
    assert.deepEqual(report.findings.map((item) => item.ruleId), ['event-not-json'])

    const empty = historyReport([{ file: 'ledger.jsonl', text: '' }], {})
    assert.equal(empty.status, 'incomplete')
    assert.deepEqual(empty.findings.map((item) => item.ruleId), ['ledger-empty'])
    assert.deepEqual(empty.entries, [])
  })
})
