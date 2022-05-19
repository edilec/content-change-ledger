/**
 * The event record: its fields, its canonical form, and its hash.
 *
 * An event is deliberately flat. Every field is a string or null, there is no
 * nesting, and the key order of the canonical form is fixed in code rather than
 * derived from the object. That is what makes the hash reproducible on another
 * machine, in another Node build, in another locale.
 */

import { createHash } from 'node:crypto'

/** The hashed fields, in canonical order. `hash` is not one of them: it covers them. */
export const EVENT_FIELDS = Object.freeze([
  'id',
  'subject',
  'action',
  'beforeHash',
  'afterHash',
  'reason',
  'owner',
  'releaseId',
  'recordedAt',
  'corrects',
  'previousHash',
])

/** Every key a stored event line carries. Anything else is rejected, never ignored. */
export const EVENT_KEYS = Object.freeze([...EVENT_FIELDS, 'hash'])

export const ACTIONS = Object.freeze(['create', 'update', 'delete', 'correct'])

/** Fields that must be a non-empty string. The rest are a string or null. */
const REQUIRED_STRINGS = Object.freeze(['id', 'subject', 'action', 'reason', 'owner', 'releaseId', 'recordedAt', 'hash'])
const NULLABLE_STRINGS = Object.freeze(['beforeHash', 'afterHash', 'corrects', 'previousHash'])
const HASH_FIELDS = Object.freeze(['beforeHash', 'afterHash', 'previousHash', 'hash'])

export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 64,
  maxBytes: 8_000_000,
  maxEvents: 50_000,
  maxEventBytes: 16_384,
  maxFieldLength: 512,
  maxReasonLength: 1024,
  maxQueryResults: 1_000,
  timeLimitMs: 10_000,
})

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** A refusal to build or append an event. Never a silently dropped record. */
export class EventError extends Error {}

/**
 * Order by UTF-16 code unit, deliberately not by locale.
 *
 * `localeCompare` depends on ICU data that varies between Node builds, so two
 * correct machines can disagree about the order of the same list. Sorting by
 * code unit is the only ordering this tool ever uses.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function isForbiddenCodePoint(code) {
  return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029
}

/** True when a string carries no control character, DEL, or line separator. */
export function isControlFree(text) {
  for (const character of text) {
    if (isForbiddenCodePoint(character.codePointAt(0))) return false
  }
  return true
}

/**
 * Bound and escape an untrusted string on its way into output.
 *
 * Every untrusted string reaches the report through this function -- ids,
 * subjects, owners, release ids, paths, raw lines -- not only the evidence
 * field. An id carrying a newline must not be able to forge an extra line in
 * the human report, and a line separator must not split a JSON value in a
 * consumer that treats U+2028 as a break.
 */
export function sanitize(text, max = 120) {
  const characters = Array.from(String(text))
  const bounded = characters.length > max ? [...characters.slice(0, max), ' [...]'] : characters
  let out = ''
  for (const character of bounded) {
    const code = character.codePointAt(0)
    out += isForbiddenCodePoint(code) ? `\\u${code.toString(16).padStart(4, '0')}` : character
  }
  return out
}

/** True when a string is a UTC instant in the one spelling this tool accepts. */
export function isUtcTimestamp(value) {
  return typeof value === 'string' && TIMESTAMP_PATTERN.test(value) && new Date(value).toISOString() === value
}

/** `sha256:<hex>` over raw bytes. The one content-hash spelling this tool writes. */
export function hashContent(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** The hashed projection of an event: the declared fields, in the declared order. */
export function canonicalEvent(event) {
  const ordered = {}
  for (const field of EVENT_FIELDS) ordered[field] = event[field] ?? null
  return ordered
}

/**
 * The hash of one event, covering `previousHash`.
 *
 * Because the previous event's hash is inside this event's hash, changing any
 * event changes every hash after it. JSON.stringify escapes quotes, backslashes
 * and control characters, so no field value can imitate the framing of another.
 */
export function eventHash(event) {
  return hashContent(Buffer.from(JSON.stringify(canonicalEvent(event)), 'utf8'))
}

/**
 * One event as one line of the ledger file.
 *
 * U+2028 and U+2029 are written as escape text. Field validation already
 * refuses them, so this is the second of two defences rather than the only one.
 */
export function serializeEvent(event) {
  const ordered = {}
  for (const key of EVENT_KEYS) ordered[key] = event[key] ?? null
  return JSON.stringify(ordered).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
}

function fieldProblem(field, detail) {
  return { kind: 'invalid', field, detail }
}

/**
 * Check one decoded line against the event shape.
 *
 * Returns every problem it finds rather than the first, so one malformed event
 * does not hide the next. It never repairs, defaults or coerces a value: an
 * event that is not exactly what it claims to be is reported, not fixed.
 */
export function validateEventShape(value, limits = DEFAULT_LIMITS) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [{ kind: 'not-object', field: null, detail: 'an event must be a JSON object' }]
  }

  const problems = []
  for (const key of Object.keys(value).sort(byCodeUnit)) {
    if (!EVENT_KEYS.includes(key)) {
      problems.push({ kind: 'unknown', field: key, detail: `unknown field "${sanitize(key, 64)}"` })
    }
  }

  for (const field of EVENT_KEYS) {
    if (!Object.hasOwn(value, field)) {
      problems.push({ kind: 'missing', field, detail: `required field "${field}" is missing` })
      continue
    }
    const raw = value[field]
    const nullable = NULLABLE_STRINGS.includes(field)
    if (raw === null) {
      if (!nullable) problems.push(fieldProblem(field, `"${field}" must be a non-empty string`))
      continue
    }
    if (typeof raw !== 'string') {
      problems.push(fieldProblem(field, `"${field}" must be a ${nullable ? 'string or null' : 'string'}`))
      continue
    }
    if (raw === '') {
      problems.push(fieldProblem(field, `"${field}" must not be empty; use null where a value does not apply`))
      continue
    }
    if (!isControlFree(raw)) {
      problems.push(fieldProblem(field, `"${field}" contains a control character or line separator`))
      continue
    }
    /* Hashes and the timestamp are bounded by their own exact formats, checked
       below. The configurable length limits govern the free-text fields only,
       so lowering one can never make a well-formed hash unrepresentable. */
    if (!HASH_FIELDS.includes(field) && field !== 'recordedAt') {
      const allowed = field === 'reason' ? limits.maxReasonLength : limits.maxFieldLength
      if (Array.from(raw).length > allowed) {
        problems.push(fieldProblem(field, `"${field}" is longer than the ${
          field === 'reason' ? 'maxReasonLength' : 'maxFieldLength'} limit of ${allowed}`))
        continue
      }
    }
    if (HASH_FIELDS.includes(field) && !HASH_PATTERN.test(raw)) {
      problems.push(fieldProblem(field, `"${field}" must look like sha256:<64 lowercase hex digits>`))
      continue
    }
    if (field === 'action' && !ACTIONS.includes(raw)) {
      problems.push(fieldProblem(field, `"action" must be one of ${ACTIONS.join(', ')}`))
      continue
    }
    if (field === 'recordedAt' && !isUtcTimestamp(raw)) {
      problems.push(fieldProblem(field, '"recordedAt" must be a UTC timestamp such as 2026-09-13T09:30:00.000Z'))
    }
  }

  if (problems.length > 0) return problems
  return actionProblems(value)
}

/** What each action promises about the before and after hashes it records. */
function actionProblems(event) {
  const problems = []
  const { action, beforeHash, afterHash, corrects } = event
  if (action === 'create') {
    if (beforeHash !== null) problems.push(fieldProblem('beforeHash', 'a "create" event must record beforeHash null'))
    if (afterHash === null) problems.push(fieldProblem('afterHash', 'a "create" event must record an afterHash'))
  }
  if (action === 'update') {
    if (beforeHash === null) problems.push(fieldProblem('beforeHash', 'an "update" event must record a beforeHash'))
    if (afterHash === null) problems.push(fieldProblem('afterHash', 'an "update" event must record an afterHash'))
  }
  if (action === 'delete') {
    if (beforeHash === null) problems.push(fieldProblem('beforeHash', 'a "delete" event must record a beforeHash'))
    if (afterHash !== null) problems.push(fieldProblem('afterHash', 'a "delete" event must record afterHash null'))
  }
  if (action === 'correct') {
    if (corrects === null) problems.push(fieldProblem('corrects', 'a "correct" event must name the event id it corrects'))
  } else if (corrects !== null) {
    problems.push(fieldProblem('corrects', '"corrects" belongs to a "correct" event; history is never rewritten in place'))
  }
  return problems
}

/**
 * Build one finished event from a draft and the hash of the event before it.
 *
 * `previousHash` is derived here and may not be supplied: a caller that could
 * choose its own predecessor could forge a chain. `recordedAt` must come from
 * the caller, because this library never reads the clock -- the command line
 * injects one, and a test injects a fixed one.
 */
export function createEvent(draft, previousHash = null, limits = DEFAULT_LIMITS) {
  if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new EventError('An event draft must be an object')
  }
  for (const key of Object.keys(draft).sort(byCodeUnit)) {
    if (key === 'previousHash' || key === 'hash') {
      throw new EventError(`"${key}" is derived from the ledger and must not be supplied`)
    }
    if (!EVENT_FIELDS.includes(key)) throw new EventError(`Unknown event field "${sanitize(key, 64)}"`)
  }

  const event = {}
  for (const field of EVENT_FIELDS) {
    event[field] = field === 'previousHash' ? previousHash : (draft[field] ?? null)
  }
  event.hash = eventHash(event)

  const problems = validateEventShape(event, limits)
  if (problems.length > 0) throw new EventError(problems.map((problem) => problem.detail).join('; '))
  return Object.freeze(event)
}
