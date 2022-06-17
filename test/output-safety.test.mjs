/**
 * What an untrusted string may not do on its way out.
 *
 * The hazard is not only the excerpt of a bad line. An identifier -- an event
 * id, a configuration key, a ledger's own file name -- travels into the report
 * too, and a report is read by a person in a terminal as often as by a parser.
 * These tests drive each class of character through the real entry points and
 * assert that none of it survives raw.
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
  isControlFree,
  sanitize,
  serializeEvent,
  verifyLedgers,
} from '../src/index.mjs'

const CLI = fileURLToPath(new URL('../bin/content-change-ledger.mjs', import.meta.url))
const NEWLINE = String.fromCharCode(0x0a)

/* Every hostile character is built from its code point, so this file itself
   carries none of them and a diff of it cannot hide one. */
const UNIT_SEPARATOR = String.fromCharCode(0x1f)
const DEL = String.fromCharCode(0x7f)
const NEL = String.fromCharCode(0x85)
const CSI = String.fromCharCode(0x9b)
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)
const LEFT_TO_RIGHT_MARK = String.fromCharCode(0x200e)
const RIGHT_TO_LEFT_MARK = String.fromCharCode(0x200f)
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e)
const FIRST_STRONG_ISOLATE = String.fromCharCode(0x2068)

/** One member of each class the report must never print raw, with its escape text. */
const UNSAFE = Object.freeze([
  ['C0', UNIT_SEPARATOR, '\\u001f'],
  ['DEL', DEL, '\\u007f'],
  ['C1 NEL', NEL, '\\u0085'],
  ['C1 CSI', CSI, '\\u009b'],
  ['line separator', LINE_SEPARATOR, '\\u2028'],
  ['paragraph separator', PARAGRAPH_SEPARATOR, '\\u2029'],
  ['left-to-right mark', LEFT_TO_RIGHT_MARK, '\\u200e'],
  ['right-to-left mark', RIGHT_TO_LEFT_MARK, '\\u200f'],
  ['right-to-left override', RIGHT_TO_LEFT_OVERRIDE, '\\u202e'],
  ['first strong isolate', FIRST_STRONG_ISOLATE, '\\u2068'],
])

const H1 = `sha256:${'1'.repeat(64)}`
const H2 = `sha256:${'2'.repeat(64)}`

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

function cli(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : error.code, stdout, stderr })
    })
  })
}

async function withDirectory(body) {
  const directory = await mkdtemp(join(tmpdir(), 'content-change-ledger-safety-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('every class of unsafe character leaves output as escape text, never raw', () => {
  for (const [name, character, escaped] of UNSAFE) {
    const out = sanitize(`before${character}after`)
    assert.equal(out.includes(character), false, `${name} survived sanitize raw`)
    assert.equal(out, `before${escaped}after`, `${name} was not escaped as ${escaped}`)
  }
  /* The bound is still there, and it counts characters rather than UTF-16 units. */
  assert.equal(sanitize('x'.repeat(20), 8), 'xxxxxxxx [...]')
  assert.equal(sanitize(`${RIGHT_TO_LEFT_OVERRIDE.repeat(3)}tail`, 2), '\\u202e\\u202e [...]')
})

test('a field refuses every control character, and keeps the bidi marks real text uses', () => {
  for (const [name, character] of UNSAFE.slice(0, 6)) {
    assert.equal(isControlFree(`a${character}b`), false, `${name} was accepted inside a field`)
    assert.throws(
      () => createEvent(draft({ reason: `a${character}b` })),
      /"reason" contains a control character or line separator/,
      `${name} was accepted in a reason`,
    )
  }
  /* A right-to-left mark is legitimate content in right-to-left text, so it is
     stored exactly and escaped on the way out rather than refused on the way
     in. A refusal here would be a false refusal of real prose. */
  const arabicish = `a${RIGHT_TO_LEFT_MARK}b`
  assert.equal(isControlFree(arabicish), true)
  assert.equal(createEvent(draft({ reason: arabicish })).reason, arabicish)
  assert.equal(serializeEvent(createEvent(draft({ reason: arabicish }))).includes('\\u200f'), true)
  assert.equal(serializeEvent(createEvent(draft({ reason: arabicish }))).includes(RIGHT_TO_LEFT_MARK), false)
})

test('a bidi-marked duplicate identifier is located without being quoted', () => {
  /* An override is valid inside an event id, so a duplicate finding must name
     source lines without copying that identity into the report. */
  const id = `evt-0001${RIGHT_TO_LEFT_OVERRIDE}${FIRST_STRONG_ISOLATE}error   nothing is wrong here`
  const first = createEvent(draft({ id }))
  const second = createEvent(draft({ id, subject: 'install.md', afterHash: H2 }), first.hash)
  const text = `${serializeEvent(first)}${NEWLINE}${serializeEvent(second)}${NEWLINE}`

  const report = verifyLedgers([{ file: 'ledger.jsonl', text }])
  const duplicate = report.findings.find((item) => item.ruleId === 'event-id-duplicate')
  assert.ok(duplicate !== undefined, 'the duplicate id was not reported at all')
  for (const [name, character] of UNSAFE) {
    assert.equal(duplicate.message.includes(character), false, `${name} reached the message raw`)
  }
  assert.match(duplicate.message, /line 2.*line 1/u)
  assert.equal(duplicate.message.includes('evt-0001'), false)
  assert.equal(JSON.stringify(report).includes(RIGHT_TO_LEFT_OVERRIDE), false)
})

test('an id carrying a C1 control is refused, and the line quoting it is escaped', () => {
  /* Hand-written rather than built: the writer that produced this line was not
     this package, which is the only way such an id reaches a ledger at all. */
  const forged = JSON.stringify({ ...createEvent(draft()), id: `evt-0001${CSI}2K${NEL}error   nothing is wrong here` })
  const report = verifyLedgers([{ file: 'ledger.jsonl', text: `${forged}${NEWLINE}` }])

  assert.equal(report.status, 'incomplete')
  const invalid = report.findings.find((item) => item.ruleId === 'event-field-invalid')
  assert.match(invalid.message, /"id" contains a control character or line separator/)
  assert.match(invalid.evidence, /\\u009b2K\\u0085error/)
  for (const [name, character] of UNSAFE) {
    assert.equal(JSON.stringify(report).includes(character), false, `${name} reached the report raw`)
  }
})

test('a ledger path is escaped in the human report, in verify --json and in history --json', async () => {
  await withDirectory(async (directory) => {
    const name = `led${LINE_SEPARATOR}${NEL}${RIGHT_TO_LEFT_OVERRIDE}ger.jsonl`
    const first = createEvent(draft())
    await writeFile(join(directory, name), `${serializeEvent(first)}${NEWLINE}`, 'utf8')
    const escapedName = 'led\\u2028\\u0085\\u202eger.jsonl'

    const human = await cli(['verify', name, '--root', directory], directory)
    assert.equal(human.code, 0)
    /* Two lines of report, one blank, one summary: an identifier cannot add a
       third that reads like a finding. */
    assert.equal(human.stdout.split(NEWLINE).length, 4)
    assert.ok(human.stdout.startsWith(`${escapedName}:1 info`), human.stdout.slice(0, 80))

    for (const verb of ['verify', 'history']) {
      const result = await cli([verb, name, '--root', directory, '--json'], directory)
      assert.equal(result.code, 0, `${verb} did not exit 0`)
      for (const [className, character] of UNSAFE) {
        assert.equal(result.stdout.includes(character), false, `${verb} --json emitted ${className} raw`)
      }
      const report = JSON.parse(result.stdout)
      const located = verb === 'verify' ? report.findings[0].location.file : report.entries[0].file
      assert.equal(located, escapedName, `${verb} --json did not escape the ledger path`)
    }

    /* And the path in an entry is bounded like every other untrusted string. */
    const long = 'p'.repeat(400)
    const entry = historyReport([{ file: long, text: `${serializeEvent(first)}${NEWLINE}` }], {}).entries[0]
    assert.ok(entry.file.startsWith('p'.repeat(90)))
    assert.ok(entry.file.length <= 200)
    assert.match(entry.file, /utf16len:400,sha256:[0-9a-f]{64}/u)
  })
})

test('a diagnostic on stderr is one line, whatever the caller named', async () => {
  await withDirectory(async (directory) => {
    const missing = `conf${NEL}ig${LINE_SEPARATOR}.json`
    const result = await cli(['verify', 'examples/ledger.jsonl', '--config', join(directory, missing)], directory)
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Could not read configuration/)
    assert.equal(result.stderr.split(NEWLINE).filter((line) => line !== '').length, 1)
    for (const [name, character] of UNSAFE) {
      assert.equal(result.stderr.includes(character), false, `${name} reached stderr raw`)
    }
    assert.match(result.stderr, /conf\\u0085ig\\u2028\.json/)
  })
})
