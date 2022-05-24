/**
 * Every ordering a caller can observe, pinned to the exact list it emits.
 *
 * Scanning this package's own source for `localeCompare` is not a test of
 * anything: substituting `Intl.Collator` gives the same locale-dependent
 * ordering under a different spelling. So each case below picks values whose
 * order genuinely differs between code units and collation -- 'Z' before 'a',
 * 'README' before 'assets', 'MAXB' before 'MAX_A', 'a-b' before 'a_b' -- pushes
 * them through the real entry point, and asserts what came out.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createEvent,
  historyReport,
  parseConfig,
  queryHistory,
  serializeEvent,
  validateEventShape,
  verifyLedgers,
} from '../src/index.mjs'

const CLI = fileURLToPath(new URL('../bin/content-change-ledger.mjs', import.meta.url))
const NEWLINE = String.fromCharCode(0x0a)
const H1 = `sha256:${'1'.repeat(64)}`

/* Two pairs that collation and code units disagree about. Under code units
   'MAXB' precedes 'MAX_A' ('B' is 0x42, '_' is 0x5f) and 'a-b' precedes 'a_b';
   collation calls the punctuation ignorable and reverses both. */
const FIRST_PAIR = Object.freeze(['MAX_A', 'MAXB'])
const SECOND_PAIR = Object.freeze(['a_b', 'a-b'])

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

/** One valid event line carrying the two unknown fields, in the hostile order. */
function lineWithUnknownFields(event, [first, second]) {
  return JSON.stringify({ ...event, [first]: 'x', [second]: 'x' })
}

function cli(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : error.code, stdout, stderr })
    })
  })
}

test('findings that tie on file, line, rule and pointer are ordered by message, by code unit', () => {
  const event = createEvent(draft())
  const text = `${lineWithUnknownFields(event, FIRST_PAIR)}${NEWLINE}${lineWithUnknownFields(event, SECOND_PAIR)}${NEWLINE}`
  const report = verifyLedgers([{ file: 'ledger.jsonl', text }])

  const unknown = report.findings.filter((item) => item.ruleId === 'event-field-unknown')
  assert.equal(unknown.length, 4)
  /* Same file, same line, same rule, same pointer for each pair: the message is
     the only key left, which is the comparator under test. */
  assert.deepEqual(unknown.map((item) => `${item.location.file}:${item.line}:${item.location.pointer}`), [
    'ledger.jsonl:1:/events/0',
    'ledger.jsonl:1:/events/0',
    'ledger.jsonl:2:/events/1',
    'ledger.jsonl:2:/events/1',
  ])
  assert.deepEqual(unknown.map((item) => /unknown field "([^"]+)"/.exec(item.message)[1]),
    ['MAXB', 'MAX_A', 'a-b', 'a_b'])
})

test('the problems of one line are ordered by code unit, and the first one is what history names', () => {
  const event = createEvent(draft())
  const problems = validateEventShape({ ...event, MAX_A: 'x', MAXB: 'x' })
  assert.deepEqual(problems.map((problem) => problem.field), ['MAXB', 'MAX_A'])

  /* `history` names one problem per unreadable line, so which one is first is
     visible in the report rather than an internal detail. */
  const report = historyReport([{ file: 'ledger.jsonl', text: `${lineWithUnknownFields(event, FIRST_PAIR)}${NEWLINE}` }], {})
  assert.equal(report.status, 'incomplete')
  assert.match(report.findings[0].message, /unknown field "MAXB"/)
})

test('an unknown key is named by code-unit order wherever one is refused', () => {
  assert.throws(() => createEvent({ ...draft(), MAX_A: 'x', MAXB: 'x' }), /Unknown event field "MAXB"/)
  assert.throws(() => createEvent({ ...draft(), 'a_b': 'x', 'a-b': 'x' }), /Unknown event field "a-b"/)

  assert.throws(() => parseConfig({ schemaVersion: '1', MAX_A: 1, MAXB: 1 }), /Unknown configuration key "MAXB"/)
  assert.throws(() => parseConfig({ schemaVersion: '1', 'a_b': 1, 'a-b': 1 }), /Unknown configuration key "a-b"/)

  assert.throws(() => parseConfig({ schemaVersion: '1', head: { MAX_A: 'x', MAXB: 'x' } }), /Unknown "head" key "MAXB"/)
  assert.throws(() => parseConfig({ schemaVersion: '1', head: { 'a_b': 'x', 'a-b': 'x' } }), /Unknown "head" key "a-b"/)

  assert.throws(() => queryHistory([], { MAX_A: 'x', MAXB: 'x' }), /Unknown query filter "MAXB"/)
  assert.throws(() => historyReport([], { 'a_b': 'x', 'a-b': 'x' }), /Unknown query filter "a-b"/)
})

test('two ledgers are reported in code-unit order of their paths, through the command line', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'content-change-ledger-order-'))
  try {
    /* 'README.jsonl' precedes 'assets.jsonl' by code unit and follows it under
       every collation: an upper-case initial is the classic way this breaks. */
    const text = `${serializeEvent(createEvent(draft()))}${NEWLINE}`
    for (const name of ['README.jsonl', 'assets.jsonl', 'Zeta.jsonl', 'alpha.jsonl']) {
      await writeFile(join(directory, name), text, 'utf8')
    }
    const result = await cli(
      ['verify', 'alpha.jsonl', 'README.jsonl', 'Zeta.jsonl', 'assets.jsonl', '--root', directory, '--json'],
      directory,
    )
    assert.equal(result.code, 0)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.findings.map((item) => item.location.file),
      ['README.jsonl', 'Zeta.jsonl', 'alpha.jsonl', 'assets.jsonl'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
