import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACTIONS,
  DEFAULT_LIMITS,
  EVENT_FIELDS,
  EVENT_KEYS,
  byCodeUnit,
  canonicalEvent,
  createEvent,
  eventHash,
  hashContent,
  isControlFree,
  sanitize,
  serializeEvent,
  validateEventShape,
} from '../src/event.mjs'

/* Built from code points rather than written as escapes, so this file itself
   never carries a control character that could hide in a diff. */
const NEWLINE = String.fromCharCode(0x0a)
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)
const NUL = String.fromCharCode(0x00)
const DEL = String.fromCharCode(0x7f)

const DRAFT = Object.freeze({
  id: 'evt-0001',
  subject: 'content/pricing.md',
  action: 'create',
  beforeHash: null,
  afterHash: `sha256:${'a'.repeat(64)}`,
  reason: 'first publication',
  owner: 'content-team',
  releaseId: '2026.09.0',
  recordedAt: '2026-09-01T09:00:00.000Z',
})

function draft(overrides = {}) {
  return { ...DRAFT, ...overrides }
}

test('the hash covers every declared field, and each field changes it', () => {
  const event = createEvent(draft())
  const baseline = eventHash(event)
  const seen = new Map([[baseline, 'baseline']])

  const alternatives = {
    id: 'evt-9999',
    subject: 'content/install.md',
    action: 'update',
    beforeHash: `sha256:${'b'.repeat(64)}`,
    afterHash: `sha256:${'c'.repeat(64)}`,
    reason: 'a different reason',
    owner: 'docs-team',
    releaseId: '2026.10.0',
    recordedAt: '2026-09-02T09:00:00.000Z',
    corrects: 'evt-0000',
    previousHash: `sha256:${'d'.repeat(64)}`,
  }
  assert.deepEqual(Object.keys(alternatives).sort(byCodeUnit), [...EVENT_FIELDS].sort(byCodeUnit))

  for (const field of EVENT_FIELDS) {
    const mutated = eventHash({ ...event, [field]: alternatives[field] })
    assert.ok(!seen.has(mutated), `changing ${field} did not change the hash (collides with ${seen.get(mutated)})`)
    seen.set(mutated, field)
  }
  assert.equal(seen.size, EVENT_FIELDS.length + 1)
})

test('the recorded hash is not part of what it covers', () => {
  const event = createEvent(draft())
  assert.equal(eventHash({ ...event, hash: `sha256:${'f'.repeat(64)}` }), event.hash)
  assert.deepEqual(Object.keys(canonicalEvent(event)), [...EVENT_FIELDS])
  assert.equal(Object.hasOwn(canonicalEvent(event), 'hash'), false)
})

test('the canonical form fixes key order, so a reordered object hashes the same', () => {
  const event = createEvent(draft())
  const reversed = {}
  for (const key of [...EVENT_KEYS].reverse()) reversed[key] = event[key]
  assert.notDeepEqual(Object.keys(reversed), [...EVENT_KEYS])
  assert.equal(eventHash(reversed), event.hash)
})

test('an event chains to its predecessor and is frozen once built', () => {
  const first = createEvent(draft())
  const second = createEvent(draft({ id: 'evt-0002', action: 'update', beforeHash: DRAFT.afterHash }), first.hash)
  assert.equal(second.previousHash, first.hash)
  assert.notEqual(second.hash, first.hash)
  assert.ok(Object.isFrozen(second))
  assert.throws(() => {
    second.reason = 'rewritten'
  }, TypeError)
  assert.equal(second.reason, 'first publication')
})

test('previousHash and hash are derived, never supplied by the caller', () => {
  assert.throws(() => createEvent(draft({ previousHash: null })), /derived/)
  assert.throws(() => createEvent(draft({ hash: `sha256:${'a'.repeat(64)}` })), /derived/)
  assert.throws(() => createEvent(draft({ releaseID: '2026.09.0' })), /Unknown event field "releaseID"/)
})

test('each action promises something about its before and after hashes', () => {
  assert.throws(() => createEvent(draft({ beforeHash: `sha256:${'b'.repeat(64)}` })), /"create" event must record beforeHash null/)
  assert.throws(() => createEvent(draft({ afterHash: null })), /"create" event must record an afterHash/)
  assert.throws(() => createEvent(draft({ action: 'update', beforeHash: null })), /"update" event must record a beforeHash/)
  assert.throws(() => createEvent(draft({ action: 'delete', beforeHash: DRAFT.afterHash })), /"delete" event must record afterHash null/)
  assert.throws(() => createEvent(draft({ action: 'correct' })), /must name the event id it corrects/)
  assert.throws(() => createEvent(draft({ corrects: 'evt-0000' })), /"corrects" belongs to a "correct" event/)
  assert.deepEqual([...ACTIONS], ['create', 'update', 'delete', 'correct'])
})

test('every string field refuses a control character or line separator', () => {
  const intruders = [NEWLINE, LINE_SEPARATOR, PARAGRAPH_SEPARATOR, NUL, DEL]
  for (const field of ['id', 'subject', 'reason', 'owner', 'releaseId']) {
    for (const intruder of intruders) {
      assert.throws(
        () => createEvent(draft({ [field]: `x${intruder}y` })),
        new RegExp(`"${field}" contains a control character`),
        `${field} accepted ${JSON.stringify(intruder)}`,
      )
    }
  }
  assert.equal(isControlFree('plain text'), true)
  assert.equal(isControlFree(`two${NEWLINE}lines`), false)
})

test('a hash field must be sha256 and 64 lowercase hex digits', () => {
  assert.throws(() => createEvent(draft({ afterHash: `sha256:${'A'.repeat(64)}` })), /sha256:<64 lowercase hex digits>/)
  assert.throws(() => createEvent(draft({ afterHash: `sha1:${'a'.repeat(40)}` })), /sha256:<64 lowercase hex digits>/)
  assert.throws(() => createEvent(draft({ afterHash: `sha256:${'a'.repeat(63)}` })), /sha256:<64 lowercase hex digits>/)
  assert.equal(hashContent(Buffer.from('', 'utf8')),
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('recordedAt must be a real UTC instant in one spelling', () => {
  assert.throws(() => createEvent(draft({ recordedAt: '2026-09-01T09:00:00Z' })), /UTC timestamp/)
  assert.throws(() => createEvent(draft({ recordedAt: '2026-09-01T09:00:00.000+01:00' })), /UTC timestamp/)
  assert.throws(() => createEvent(draft({ recordedAt: '2026-02-30T09:00:00.000Z' })), /UTC timestamp/)
  assert.equal(createEvent(draft({ recordedAt: '2026-02-28T09:00:00.000Z' })).recordedAt, '2026-02-28T09:00:00.000Z')
})

test('the documented field length limits are enforced, and counted in code points', () => {
  const limits = { ...DEFAULT_LIMITS, maxFieldLength: 20, maxReasonLength: 4 }
  const smile = String.fromCodePoint(0x1f600)
  const short = (overrides) => draft({ reason: 'ok', ...overrides })
  assert.equal(createEvent(short({ owner: 'ab'.repeat(10) }), null, limits).owner, 'ab'.repeat(10))
  assert.throws(() => createEvent(short({ owner: 'ab'.repeat(11) }), null, limits), /maxFieldLength limit of 20/)
  assert.throws(() => createEvent(short({ id: 'e'.repeat(21) }), null, limits), /maxFieldLength limit of 20/)
  assert.throws(() => createEvent(short({ reason: 'abcde' }), null, limits), /maxReasonLength limit of 4/)
  /* Four astral code points are eight UTF-16 units: the limit counts characters. */
  assert.equal(createEvent(short({ reason: smile.repeat(4) }), null, limits).reason.length, 8)
  assert.throws(() => createEvent(short({ reason: smile.repeat(5) }), null, limits), /maxReasonLength limit of 4/)
  /* A hash is bounded by its own format, so a small maxFieldLength never makes
     a well-formed event unrepresentable. */
  const tiny = { ...limits, maxFieldLength: 10 }
  assert.equal(createEvent(short({ subject: 'p.md', owner: 'me', id: 'e1', releaseId: 'r1' }), null, tiny).afterHash,
    DRAFT.afterHash)
})

test('a missing, empty, unknown or wrongly typed field is reported, not repaired', () => {
  const event = createEvent(draft())
  const broken = { ...event, extra: 'x', owner: 42, reason: '' }
  delete broken.id
  const problems = validateEventShape(broken)
  assert.deepEqual(problems.map((problem) => `${problem.kind}:${problem.field}`).sort(byCodeUnit), [
    'invalid:owner',
    'invalid:reason',
    'missing:id',
    'unknown:extra',
  ])
  assert.deepEqual(validateEventShape([event]).map((problem) => problem.kind), ['not-object'])
  assert.deepEqual(validateEventShape(null).map((problem) => problem.kind), ['not-object'])
  assert.deepEqual(validateEventShape(event), [])
})

test('sanitize escapes every untrusted character instead of printing it', () => {
  const smile = String.fromCodePoint(0x1f600)
  assert.equal(sanitize(`evt${NEWLINE}0001`), 'evt\\u000a0001')
  assert.equal(sanitize(`a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c${NUL}d${DEL}e`), 'a\\u2028b\\u2029c\\u0000d\\u007fe')
  assert.equal(sanitize('plain'), 'plain')
  assert.equal(sanitize('x'.repeat(20), 8), 'xxxxxxxx [...]')
  assert.equal(sanitize(smile.repeat(2), 1), `${smile} [...]`)
})

test('a serialized event is one line whose separators are escape text', () => {
  const event = createEvent(draft())
  const line = serializeEvent({ ...event, reason: `a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c` })
  const bytes = Buffer.from(line, 'utf8')
  assert.equal(bytes.includes(Buffer.from(LINE_SEPARATOR, 'utf8')), false)
  assert.equal(bytes.includes(Buffer.from(PARAGRAPH_SEPARATOR, 'utf8')), false)
  assert.equal(line.includes('\\u2028'), true)
  assert.equal(line.split(NEWLINE).length, 1)
  assert.deepEqual(Object.keys(JSON.parse(serializeEvent(event))), [...EVENT_KEYS])
})

test('ordering is by code unit, which is not what a locale would do', () => {
  /* '_' (0x5f) follows 'B' (0x42) by code unit, while collation treats the
     underscore as ignorable punctuation and puts MAX_A first. This exact pair
     produced a real ordering difference in this catalog. */
  assert.equal(byCodeUnit('MAX_A', 'MAXB'), 1)
  assert.equal(byCodeUnit('MAXB', 'MAX_A'), -1)
  assert.equal(byCodeUnit('MAXB', 'MAXB'), 0)
  assert.deepEqual(['MAX_A', 'MAXB'].sort(byCodeUnit), ['MAXB', 'MAX_A'])
  assert.deepEqual(['alpha.jsonl', 'Zeta.jsonl'].sort(byCodeUnit), ['Zeta.jsonl', 'alpha.jsonl'])
})
