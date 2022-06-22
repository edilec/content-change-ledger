/**
 * content-change-ledger: an append-only local record of content change events,
 * chained by hash so a missing or altered event in the middle is detectable.
 *
 * Three promises hold this tool together.
 *
 * Append-only: nothing in this package rewrites an event. A correction is a new
 * event that names the event it corrects, and the only write is one O_APPEND
 * line.
 *
 * Honesty: evidence that was not obtained is `unknown`, never a verdict. A line
 * that could not be parsed makes the run `incomplete`; it never becomes a
 * chain-break claim about the event after it, and it is never a pass.
 *
 * Determinism: the library never reads the clock, never walks a directory and
 * never orders anything by locale.
 */

import { createHash } from 'node:crypto'
import {
  ACTIONS,
  DEFAULT_LIMITS,
  EVENT_FIELDS,
  EVENT_KEYS,
  EventError,
  byCodeUnit,
  canonicalEvent,
  createEvent,
  eventHash,
  hashContent,
  isControlFree,
  isUtcTimestamp,
  parseFailureDetail,
  sanitize,
  serializeEvent,
  validateEventShape,
} from './event.mjs'
import {
  LedgerError,
  LimitExceeded,
  appendEventLine,
  decodeUtf8,
  parseLedger,
  readLedgerText,
  readLedgers,
  resolveInsideRoot,
} from './ledger.mjs'

export {
  ACTIONS,
  DEFAULT_LIMITS,
  EVENT_FIELDS,
  EVENT_KEYS,
  EventError,
  LedgerError,
  LimitExceeded,
  byCodeUnit,
  canonicalEvent,
  createEvent,
  decodeUtf8,
  eventHash,
  hashContent,
  isControlFree,
  isUtcTimestamp,
  parseFailureDetail,
  parseLedger,
  readLedgers,
  resolveInsideRoot,
  sanitize,
  serializeEvent,
  validateEventShape,
}

export const TOOL_ID = 'content-change-ledger'
export const REPORT_SCHEMA_VERSION = '1'
export const CONFIG_SCHEMA_VERSION = '1'

/**
 * The rule catalog: one frozen ruleId -> severity table.
 *
 * Severity decides pass or fail, so it is pinned here and read from here at
 * every construction site. An unknown rule id throws rather than defaulting,
 * and `docs/ledger-rules.md` is asserted against this table in both directions.
 */
export const RULES = Object.freeze({
  'ledger-unreadable': 'error',
  'ledger-outside-root': 'error',
  'ledger-not-utf8': 'error',
  'ledger-not-text': 'error',
  'ledger-empty': 'warning',
  'limit-exceeded': 'error',
  'event-not-json': 'error',
  'event-not-object': 'error',
  'event-field-missing': 'error',
  'event-field-invalid': 'error',
  'event-field-unknown': 'error',
  'event-id-duplicate': 'error',
  'event-hash-mismatch': 'error',
  'chain-genesis-invalid': 'error',
  'chain-previous-hash-mismatch': 'error',
  'subject-hash-discontinuity': 'error',
  'subject-state-invalid': 'error',
  'correction-target-unknown': 'error',
  'correction-target-invalid': 'error',
  'event-owner-not-allowed': 'error',
  'event-release-id-not-allowed': 'error',
  'checkpoint-mismatch': 'error',
  'event-recorded-at-out-of-order': 'warning',
  'history-truncated': 'warning',
  'history-identity-ambiguous': 'warning',
  'tail-not-anchored': 'info',
})

/** Rules that mean evidence was missing, truncated or unparsable: the run is `incomplete`. */
export const INCOMPLETE_RULES = Object.freeze([
  'ledger-unreadable',
  'ledger-outside-root',
  'ledger-not-utf8',
  'ledger-not-text',
  'ledger-empty',
  'limit-exceeded',
  'event-not-json',
  'event-not-object',
  'event-field-missing',
  'event-field-invalid',
  'event-field-unknown',
  'history-truncated',
  'history-identity-ambiguous',
])

const CONFIG_KEYS = Object.freeze(['schemaVersion', 'limits', 'head', 'owners', 'releaseIdPattern'])
const HEAD_KEYS = Object.freeze(['id', 'hash'])
const MAX_PATTERN_LENGTH = 200
const EVIDENCE_CODE_POINTS = 120

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

/** Keep ordinary paths readable, but make escaped and shortened paths distinct. */
function pathLabel(value) {
  const raw = String(value)
  let shown = ''
  let consumed = 0
  for (const character of raw) {
    const code = character.codePointAt(0)
    const piece = character === '\\' ? '\\\\'
      : /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(character)
        ? code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\u{${code.toString(16)}}`
        : character
    if (shown.length + piece.length > 90) break
    shown += piece
    consumed += character.length
  }
  if (consumed === raw.length) return shown
  const digest = createHash('sha256').update(raw, 'utf16le').digest('hex')
  return `${shown}… [utf16len:${raw.length},sha256:${digest}]`
}

/**
 * The severity of one rule, read from the frozen catalog.
 *
 * A rule id the catalog does not know throws here instead of yielding a finding
 * with an invented severity, so a typo cannot quietly downgrade a refusal into
 * a warning. It is exported because a guard no caller can reach is a guard no
 * test can prove.
 */
export function severityOf(ruleId) {
  const severity = RULES[ruleId]
  if (severity === undefined) throw new Error(`Unknown ruleId "${sanitize(ruleId, 64)}"`)
  return severity
}

/** Build one finding, taking its severity from the catalog and nowhere else. */
function finding(ruleId, message, where, extra = {}) {
  return {
    ruleId,
    severity: severityOf(ruleId),
    message,
    location: { file: pathLabel(where.file), pointer: where.pointer },
    line: where.line,
    ...extra,
  }
}

function evidenceOf(text) {
  return sanitize(text, EVIDENCE_CODE_POINTS)
}

/**
 * Validate a configuration object. Anything unexpected is a usage error.
 *
 * Unknown keys are refused rather than ignored: a one-character typo in
 * `owners` must not silently drop the owner policy and turn a real failure into
 * a green run.
 */
export function parseConfig(value) {
  if (!isRecord(value)) throw new Error('Configuration must be a JSON object')
  for (const key of Object.keys(value).sort(byCodeUnit)) {
    if (!CONFIG_KEYS.includes(key)) throw new Error(`Unknown configuration key "${sanitize(key, 64)}"`)
  }
  if (value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error(`Configuration schemaVersion must be "${CONFIG_SCHEMA_VERSION}"`)
  }

  const limits = { ...DEFAULT_LIMITS }
  if (value.limits !== undefined) {
    if (!isRecord(value.limits)) throw new Error('Configuration "limits" must be an object')
    for (const [key, limit] of Object.entries(value.limits)) {
      if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new Error(`Unknown limit "${sanitize(key, 64)}"`)
      if (!positiveInteger(limit)) throw new Error(`Limit "${key}" must be a positive integer`)
      limits[key] = limit
    }
  }

  const config = { schemaVersion: CONFIG_SCHEMA_VERSION, limits, head: null, owners: null, releaseIdPattern: null }

  if (value.head !== undefined) {
    if (!isRecord(value.head)) throw new Error('Configuration "head" must be an object')
    for (const key of Object.keys(value.head).sort(byCodeUnit)) {
      if (!HEAD_KEYS.includes(key)) throw new Error(`Unknown "head" key "${sanitize(key, 64)}"`)
    }
    for (const key of HEAD_KEYS) {
      if (typeof value.head[key] !== 'string' || value.head[key] === '' || !isControlFree(value.head[key])) {
        throw new Error(`Configuration "head.${key}" must be a non-empty single-line string`)
      }
    }
    config.head = { id: value.head.id, hash: value.head.hash }
  }

  if (value.owners !== undefined) {
    if (!Array.isArray(value.owners) || value.owners.length === 0
      || value.owners.some((owner) => typeof owner !== 'string' || owner === '' || !isControlFree(owner))) {
      throw new Error('Configuration "owners" must be a non-empty array of non-empty single-line strings')
    }
    config.owners = [...value.owners]
  }

  if (value.releaseIdPattern !== undefined) {
    if (typeof value.releaseIdPattern !== 'string' || value.releaseIdPattern === '') {
      throw new Error('Configuration "releaseIdPattern" must be a non-empty string')
    }
    if (value.releaseIdPattern.length > MAX_PATTERN_LENGTH) {
      throw new Error(`Configuration "releaseIdPattern" must be at most ${MAX_PATTERN_LENGTH} characters`)
    }
    try {
      config.releaseRegExp = new RegExp(value.releaseIdPattern, 'u')
    } catch (error) {
      throw new Error(`Configuration "releaseIdPattern" is not a valid regular expression: ${error.message}`)
    }
    config.releaseIdPattern = value.releaseIdPattern
  }

  return Object.freeze(config)
}

export const EMPTY_CONFIG = parseConfig({ schemaVersion: CONFIG_SCHEMA_VERSION })

const PROBLEM_RULES = Object.freeze({
  'not-object': 'event-not-object',
  'not-json': 'event-not-json',
  missing: 'event-field-missing',
  invalid: 'event-field-invalid',
  unknown: 'event-field-unknown',
  limit: 'limit-exceeded',
})

function sortFindings(findings) {
  findings.sort((left, right) => byCodeUnit(left.location.file, right.location.file)
    || left.line - right.line
    || byCodeUnit(left.ruleId, right.ruleId)
    || byCodeUnit(left.location.pointer, right.location.pointer)
    || byCodeUnit(left.message, right.message))
  return findings
}

/**
 * Verify one ledger's records: identity, chain, per-subject continuity and
 * corrections.
 *
 * `knownPrevious` is the honest part. After a record that could not be parsed
 * or validated, the hash of the event before the next one is unknown, so the
 * chain comparison is skipped rather than reported as a break. Reporting it
 * would be inventing a verdict out of evidence the run never had; the run is
 * already `incomplete`, which is what says so.
 */
function verifyRecords(ledger, records, config, state) {
  const { findings } = state
  const file = ledger.file
  const ids = new Map()
  const subjects = new Map()
  let previousEvent = null
  let knownPrevious = true
  let stateKnown = true
  let lastRecordedAt = null
  let checkedHere = 0

  for (const record of records) {
    const pointer = `/events/${record.index}`
    const where = { file, pointer, line: record.line }

    if (record.event === null) {
      state.incomplete = true
      for (const problem of record.problems) {
        const ruleId = PROBLEM_RULES[problem.kind]
        if (ruleId === undefined) throw new Error(`Unknown problem kind "${problem.kind}"`)
        findings.push(finding(
          ruleId,
          `This line could not be read as an event: ${sanitize(problem.detail, 200)}.`,
          where,
          {
            evidence: evidenceOf(record.raw),
            suggestion: 'Restore the line from the writer that produced it; never hand-edit a ledger.',
          },
        ))
      }
      knownPrevious = false
      /* The contents of that line are now unknown for good. Every later check
         that compares against what this ledger has recorded so far -- the
         subject state machine, the before/after continuity, and whether a
         correction names an event this file holds -- would be answering from
         evidence the run never obtained, so they stop here. The chain link
         across the gap is skipped for the same reason, and the run is already
         `incomplete`, which is what says so. */
      stateKnown = false
      continue
    }

    const event = record.event
    checkedHere += 1
    state.checked += 1

    if (ids.has(event.id)) {
      findings.push(finding(
        'event-id-duplicate',
        `Event on line ${record.line} reuses an id first recorded on line ${ids.get(event.id)}; an event id identifies one event forever.`,
        where,
        { suggestion: 'Give the new event its own id. A change of mind is a correction event, not a reused id.' },
      ))
    } else {
      ids.set(event.id, record.line)
    }

    const recomputed = eventHash(event)
    const hashIsSound = recomputed === event.hash
    if (!hashIsSound) {
      findings.push(finding(
        'event-hash-mismatch',
        `This event does not match its own recorded hash, so its fields were changed after it was written.`,
        where,
        {
          evidence: `recorded ${sanitize(event.hash, 80)}, recomputed ${recomputed}`,
          suggestion: 'Append a correction event instead of editing a recorded one.',
        },
      ))
    }

    if (previousEvent === null && knownPrevious) {
      if (event.previousHash !== null) {
        findings.push(finding(
          'chain-genesis-invalid',
          'The first event in this ledger records a previousHash, so at least one earlier event is missing from the front of the file.',
          where,
          {
            evidence: `previousHash ${sanitize(event.previousHash, 80)}`,
            suggestion: 'Restore the earlier events; the first event of a chain records previousHash null.',
          },
        ))
      }
    } else if (knownPrevious && event.previousHash !== previousEvent.hash) {
      findings.push(finding(
        'chain-previous-hash-mismatch',
        `This event follows line ${state.previousLine} in the file but records a different previousHash, so an event between them was removed or replaced.`,
        where,
        {
          evidence: `recorded ${sanitize(event.previousHash ?? 'null', 80)}, expected ${sanitize(previousEvent.hash, 80)}`,
          suggestion: 'Restore the missing event; the chain is only continuous when each event names the hash before it.',
        },
      ))
    }

    if (lastRecordedAt !== null && event.recordedAt < lastRecordedAt) {
      findings.push(finding(
        'event-recorded-at-out-of-order',
        `This event records ${sanitize(event.recordedAt, 40)}, which is earlier than ${sanitize(lastRecordedAt, 40)} on the line before it.`,
        where,
        { suggestion: 'Append events in the order they happened; the file order is the history.' },
      ))
    }
    lastRecordedAt = event.recordedAt

    checkSubject(event, subjects, where, findings, stateKnown)
    checkCorrection(event, ids, where, findings, stateKnown)

    if (config.owners !== null && !config.owners.includes(event.owner)) {
      findings.push(finding(
        'event-owner-not-allowed',
        `Owner "${sanitize(event.owner, 80)}" is not one of the owners this ledger accepts.`,
        where,
        { suggestion: 'Record an owner from the configured list, or add the owner to the configuration.' },
      ))
    }
    if (config.releaseRegExp !== undefined && !config.releaseRegExp.test(event.releaseId)) {
      findings.push(finding(
        'event-release-id-not-allowed',
        `Release id "${sanitize(event.releaseId, 80)}" does not match the configured releaseIdPattern.`,
        where,
        { suggestion: `Record a release id matching ${sanitize(config.releaseIdPattern, 80)}.` },
      ))
    }

    previousEvent = event
    state.previousLine = record.line
    knownPrevious = true
  }

  state.corrections += records.filter((record) => record.event !== null && record.event.action === 'correct').length
  return { checkedHere, lastEvent: previousEvent, knownTail: knownPrevious, subjectCount: subjects.size }
}

/** The state machine every subject follows, and the before/after hash continuity it implies. */
function checkSubject(event, subjects, where, findings, stateKnown) {
  const current = subjects.get(event.subject) ?? { exists: false, hash: null }
  let stateValid = true

  if (!stateKnown) {
    subjects.set(event.subject, { exists: event.afterHash !== null, hash: event.afterHash })
    return
  }

  if (event.action === 'create' && current.exists) {
    stateValid = false
    findings.push(finding(
      'subject-state-invalid',
      `Subject "${sanitize(event.subject, 80)}" already exists in this ledger, so it cannot be created again.`,
      where,
      { suggestion: 'Record an "update" event, or a "delete" before a second "create".' },
    ))
  }
  if ((event.action === 'update' || event.action === 'delete') && !current.exists) {
    stateValid = false
    findings.push(finding(
      'subject-state-invalid',
      `Subject "${sanitize(event.subject, 80)}" does not exist in this ledger at this point, so it cannot be ${event.action === 'update' ? 'updated' : 'deleted'}.`,
      where,
      { suggestion: 'Record the "create" event that introduced this subject first.' },
    ))
  }

  if (stateValid && event.beforeHash !== current.hash) {
    findings.push(finding(
      'subject-hash-discontinuity',
      `This event records a beforeHash that is not the afterHash this ledger last recorded for "${sanitize(event.subject, 80)}", so a change to it was never written down.`,
      where,
      {
        evidence: `beforeHash ${sanitize(event.beforeHash ?? 'null', 80)}, last afterHash ${sanitize(current.hash ?? 'null', 80)}`,
        suggestion: 'Append the missing event for this subject, or correct the hash with a correction event.',
      },
    ))
  }

  subjects.set(event.subject, { exists: event.afterHash !== null, hash: event.afterHash })
}

/** A correction names an earlier event, about the same subject, and never itself. */
function checkCorrection(event, ids, where, findings, stateKnown) {
  if (event.corrects === null) return
  const targetLine = ids.get(event.corrects)

  if (targetLine === undefined) {
    if (!stateKnown) return
    findings.push(finding(
      'correction-target-unknown',
      `This correction names event id "${sanitize(event.corrects, 80)}", which no earlier event in this ledger records.`,
      where,
      { suggestion: 'A correction may only refer to an event already written above it.' },
    ))
    return
  }
  if (event.corrects === event.id) {
    findings.push(finding(
      'correction-target-invalid',
      'This correction names itself; a correction refers to an earlier event.',
      where,
      { suggestion: 'Name the id of the event being corrected.' },
    ))
  }
}

/**
 * Verify already-loaded ledgers.
 *
 * `ledgers` is an ordered list of `{ file, text }` supplied by the caller, so
 * the report never depends on how a directory happens to enumerate. `failures`
 * carries inputs that could not be read at all; each becomes a finding and each
 * makes the run `incomplete`.
 */
export function verifyLedgers(ledgers, options = {}) {
  const config = options.config ?? EMPTY_CONFIG
  const limits = { ...config.limits, ...(options.limits ?? {}) }
  const failures = options.failures ?? []
  const state = {
    findings: [],
    incomplete: false,
    checked: 0,
    corrections: 0,
    subjects: 0,
    previousLine: 0,
  }

  if (config.head !== null && ledgers.length + failures.length > 1) {
    throw new Error('Configuration "head" anchors a single ledger; verify one ledger at a time when it is set')
  }

  for (const failure of failures) {
    state.incomplete = true
    state.findings.push(finding(
      failure.ruleId,
      `This input was not verified: ${sanitize(failure.message, 200)}.`,
      { file: failure.file, pointer: '/ledger', line: 1 },
      { suggestion: 'Name a readable UTF-8 JSON Lines ledger inside the declared root.' },
    ))
  }

  let subjectTotal = 0
  for (const ledger of ledgers) {
    const { records, limitProblem } = parseLedger(ledger.text, { limits, clock: options.clock })
    const result = verifyRecords(ledger, records, config, state)
    subjectTotal += result.subjectCount

    if (limitProblem !== null) {
      state.incomplete = true
      state.findings.push(finding(
        'limit-exceeded',
        `The ${limitProblem.limit} limit of ${limitProblem.allowed} was exceeded (observed ${limitProblem.observed}); this ledger was not verified to the end.`,
        { file: ledger.file, pointer: '/ledger', line: limitProblem.line ?? 1 },
        { suggestion: `Split the ledger, or raise "${limitProblem.limit}" in the configuration.` },
      ))
    }

    if (result.checkedHere === 0) {
      state.incomplete = true
      state.findings.push(finding(
        'ledger-empty',
        'This ledger records no verifiable event, so there was nothing to verify; an empty ledger is never a pass.',
        { file: ledger.file, pointer: '/ledger', line: 1 },
        { suggestion: 'Append the events this ledger is meant to hold.' },
      ))
      continue
    }

    const tailKnown = limitProblem === null && result.knownTail && result.lastEvent !== null
    if (config.head === null) {
      state.findings.push(finding(
        'tail-not-anchored',
        'No head checkpoint is configured, so events removed from the END of this ledger cannot be detected here.',
        { file: ledger.file, pointer: '/ledger', line: 1 },
        { suggestion: 'Record the head id and hash of the last event in the configuration, kept somewhere the ledger writer cannot reach.' },
      ))
    } else if (tailKnown) {
      const head = result.lastEvent
      if (head.id !== config.head.id || head.hash !== config.head.hash) {
        const mismatchedFields = [
          head.id !== config.head.id ? 'id' : null,
          head.hash !== config.head.hash ? 'hash' : null,
        ].filter(Boolean)
        state.findings.push(finding(
          'checkpoint-mismatch',
          `The last event of this ledger is not the configured head checkpoint, so events were removed from or added after the checkpoint.`,
          { file: ledger.file, pointer: `/events/${records.length - 1}`, line: records.at(-1).line },
          {
            evidence: `ledger /events/${records.length - 1} at line ${records.at(-1).line} vs configuration /head: ${mismatchedFields.join(' and ')} ${mismatchedFields.length === 1 ? 'differs' : 'differ'}; values withheld`,
            suggestion: 'Update the checkpoint from a trusted copy, or investigate why the tail changed.',
          },
        ))
      }
    }
  }

  return buildReport(state, {
    files: ledgers.length + failures.length,
    filesRead: ledgers.length,
    subjects: subjectTotal,
  })
}

function buildReport(state, counts, extra = {}) {
  const findings = sortFindings(state.findings)
  const errors = findings.filter((item) => item.severity === 'error').length
  const warnings = findings.filter((item) => item.severity === 'warning').length
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status: state.incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass',
    summary: {
      checked: state.checked,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      events: state.checked,
      corrections: state.corrections,
      ...counts,
    },
    findings,
    ...extra,
  }
  return assertEvidenceBacked(report)
}

/**
 * The two invariants every report must satisfy before it leaves this module.
 *
 * A run that verified nothing is never a pass, and a finding that means
 * evidence was missing is never carried by anything but an `incomplete` report.
 * Both are checked here rather than trusted at each construction site, so a
 * flag forgotten anywhere above fails loudly instead of quietly turning an
 * unread input green.
 */
export function assertEvidenceBacked(report) {
  if (report.status === 'pass' && report.summary.checked === 0) {
    throw new Error('Refusing to report a pass with no verified event')
  }
  if (report.status !== 'incomplete') {
    for (const item of report.findings) {
      if (INCOMPLETE_RULES.includes(item.ruleId)) {
        throw new Error(`Finding "${item.ruleId}" means evidence was missing, so the report must be incomplete`)
      }
    }
  }
  return report
}

const QUERY_KEYS = Object.freeze(['subject', 'owner', 'releaseId', 'action', 'since', 'until', 'limit'])

const TIME_FILTERS = Object.freeze(['since', 'until'])

/**
 * Check every filter of a query and resolve the limit it will answer under.
 *
 * Every filter is validated, not merely the ones that are easy to validate. A
 * malformed time window is refused here rather than compared as text, because
 * a window nothing can match would otherwise answer "nothing changed" in the
 * authoritative green of a complete run.
 */
function resolveQuery(filters, limits) {
  for (const key of Object.keys(filters).sort(byCodeUnit)) {
    if (!QUERY_KEYS.includes(key)) throw new Error(`Unknown query filter "${sanitize(key, 64)}"`)
  }
  const limit = filters.limit ?? limits.maxQueryResults
  if (!positiveInteger(limit)) throw new Error('Query "limit" must be a positive integer')
  if (limit > limits.maxQueryResults) {
    throw new Error(`Query "limit" must be at most the maxQueryResults limit of ${limits.maxQueryResults}`)
  }
  if (filters.action !== undefined && !ACTIONS.includes(filters.action)) {
    throw new Error(`Query "action" must be one of ${ACTIONS.join(', ')}`)
  }
  for (const key of TIME_FILTERS) {
    if (filters[key] !== undefined && !isUtcTimestamp(filters[key])) {
      throw new Error(`Query "${key}" must be a UTC timestamp such as 2026-09-13T09:30:00.000Z`)
    }
  }
  return limit
}

/**
 * Query the history held in already-parsed events.
 *
 * The result is a list of copies. Each copy is annotated with `supersededBy`,
 * the ids of later correction events that name it -- computed for the reader,
 * never stored, because annotating a stored event would be rewriting it.
 */
function queryHistoryIndexed(events, filters = {}, limits = DEFAULT_LIMITS) {
  const limit = resolveQuery(filters, limits)

  const corrections = new Map()
  for (const event of events) {
    if (event.corrects === null) continue
    const list = corrections.get(event.corrects) ?? []
    list.push(event.id)
    corrections.set(event.corrects, list)
  }

  const matched = events.map((event, index) => ({ event, index })).filter(({ event }) => {
    if (filters.subject !== undefined && event.subject !== filters.subject) return false
    if (filters.owner !== undefined && event.owner !== filters.owner) return false
    if (filters.releaseId !== undefined && event.releaseId !== filters.releaseId) return false
    if (filters.action !== undefined && event.action !== filters.action) return false
    if (filters.since !== undefined && event.recordedAt < filters.since) return false
    if (filters.until !== undefined && event.recordedAt > filters.until) return false
    return true
  })

  const selected = matched.slice(0, limit)
  const entries = selected.map(({ event }) => {
    const copy = {}
    for (const key of EVENT_KEYS) copy[key] = event[key]
    copy.supersededBy = [...(corrections.get(event.id) ?? [])]
    return copy
  })

  return {
    entries, sourceIndices: selected.map(({ index }) => index),
    matched: matched.length, truncated: matched.length > entries.length, limit,
  }
}

export function queryHistory(events, filters = {}, limits = DEFAULT_LIMITS) {
  const { sourceIndices, ...result } = queryHistoryIndexed(events, filters, limits)
  void sourceIndices
  return result
}

/**
 * Query the loaded ledgers and report one answer.
 *
 * A query over a ledger that could not be read in full is `incomplete`, and so
 * is a result the limit cut short: an answer that silently omits events is how
 * a history comes to look complete when it is not. The limit bounds the answer,
 * not each ledger separately, because a caller that asked for at most N events
 * asked about the answer it is given.
 */
export function historyReport(ledgers, filters = {}, options = {}) {
  const config = options.config ?? EMPTY_CONFIG
  const limits = { ...config.limits, ...(options.limits ?? {}) }
  const failures = options.failures ?? []
  const state = { findings: [], incomplete: false, checked: 0, corrections: 0, subjects: 0, previousLine: 0 }
  const limit = resolveQuery(filters, limits)
  const answers = []
  const entries = []

  for (const failure of failures) {
    state.incomplete = true
    state.findings.push(finding(
      failure.ruleId,
      `This input was not read: ${sanitize(failure.message, 200)}.`,
      { file: failure.file, pointer: '/ledger', line: 1 },
      { suggestion: 'Name a readable UTF-8 JSON Lines ledger inside the declared root.' },
    ))
  }

  for (const ledger of ledgers) {
    const { records, limitProblem } = parseLedger(ledger.text, { limits, clock: options.clock })
    if (limitProblem !== null) {
      state.incomplete = true
      state.findings.push(finding(
        'limit-exceeded',
        `The ${limitProblem.limit} limit of ${limitProblem.allowed} was exceeded (observed ${limitProblem.observed}); this history stops early.`,
        { file: ledger.file, pointer: '/ledger', line: limitProblem.line ?? 1 },
        { suggestion: `Split the ledger, or raise "${limitProblem.limit}" in the configuration.` },
      ))
    }

    const events = []
    const positions = []
    for (const record of records) {
      if (record.event === null) {
        state.incomplete = true
        const problem = record.problems[0]
        state.findings.push(finding(
          PROBLEM_RULES[problem.kind],
          `This line could not be read as an event, so the history below is missing it: ${sanitize(problem.detail, 200)}.`,
          { file: ledger.file, pointer: `/events/${record.index}`, line: record.line },
          { evidence: evidenceOf(record.raw), suggestion: 'Verify the ledger before trusting a query over it.' },
        ))
        continue
      }
      events.push(record.event)
      positions.push({ index: record.index, line: record.line })
      state.checked += 1
      if (record.event.action === 'correct') state.corrections += 1
    }

    if (events.length === 0) {
      state.incomplete = true
      state.findings.push(finding(
        'ledger-empty',
        'This ledger records no readable event, so this query answered from nothing; an empty history is never a pass.',
        { file: ledger.file, pointer: '/ledger', line: 1 },
        { suggestion: 'Append the events this ledger is meant to hold.' },
      ))
    }

    answers.push({ file: ledger.file, events, positions, result: queryHistoryIndexed(events, filters, limits) })
  }

  /* The limit is spent across the whole answer, in the order the ledgers were
     named, and what it cut off is reported once. Spending it per ledger would
     return N times the bound and call the result complete. */
  let matched = 0
  let cutAt = null
  const representedSubjects = new Set()
  for (const answer of answers) {
    matched += answer.result.matched
    let taken = 0
    const pointerFor = (position) => `/events/${answer.positions[position].index}`
    const idPositions = new Map()
    const correctingPositions = new Map()
    const firstIdPosition = new Map()
    for (const [position, event] of answer.events.entries()) {
      if (firstIdPosition.has(event.id)) {
        const first = firstIdPosition.get(event.id)
        state.incomplete = true
        state.findings.push(finding(
          'history-identity-ambiguous',
          `Events on lines ${answer.positions[first].line} and ${answer.positions[position].line} share an id; correction relationships cannot be unique.`,
          { file: answer.file, pointer: pointerFor(position), line: answer.positions[position].line },
        ))
      } else {
        firstIdPosition.set(event.id, position)
      }
      const owners = idPositions.get(event.id) ?? []
      owners.push(pointerFor(position))
      idPositions.set(event.id, owners)
      if (event.corrects !== null) {
        const correcting = correctingPositions.get(event.corrects) ?? []
        correcting.push(pointerFor(position))
        correctingPositions.set(event.corrects, correcting)
      }
    }
    for (const position of answer.result.sourceIndices) {
      if (entries.length >= limit) break
      const event = answer.events[position]
      representedSubjects.add(event.subject)
      entries.push({
        file: pathLabel(answer.file), pointer: pointerFor(position), line: answer.positions[position].line,
        subject: sanitize(event.subject, 80), action: sanitize(event.action, 10),
        beforeHash: event.beforeHash, afterHash: event.afterHash,
        reason: sanitize(event.reason, 120), owner: sanitize(event.owner, 40),
        releaseId: sanitize(event.releaseId, 40), recordedAt: sanitize(event.recordedAt, 40),
        correctionTargetCandidates: event.corrects === null ? null : [...(idPositions.get(event.corrects) ?? [])],
        supersededByCandidates: [...(correctingPositions.get(event.id) ?? [])],
      })
      taken += 1
    }
    if (cutAt === null && taken < answer.result.matched) cutAt = answer.file
  }
  if (matched > entries.length) {
    state.incomplete = true
    state.findings.push(finding(
      'history-truncated',
      `${matched} event(s) match this query but the limit of ${limit} cut the answer short.`,
      { file: cutAt, pointer: '/ledger', line: 1 },
      { suggestion: 'Raise --limit, or narrow the query.' },
    ))
  }

  const report = buildReport(state, {
    files: ledgers.length + failures.length,
    filesRead: ledgers.length,
    subjects: representedSubjects.size,
    matched: entries.length,
  }, { schemaVersion: '2', entries })
  return report
}

/**
 * Append one event to a ledger file.
 *
 * The existing ledger is verified first and the append is refused when it
 * carries any error: a chain is only worth appending to while it is whole.
 * `beforeHash` defaults to the afterHash this ledger last recorded for the
 * subject, so continuity is right by construction rather than by discipline.
 * The event id must be new; an id already in the ledger is refused, never
 * reused, because a reused id would make two events indistinguishable.
 */
export async function appendEvent(ledgerPath, draft, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
  const resolved = await resolveInsideRoot(ledgerPath, options)
  if (!resolved.inside) {
    throw new LedgerError(`Refusing to write ${sanitize(ledgerPath, 120)}: it resolves outside the declared root`)
  }

  const text = await readLedgerText(resolved.real, limits)
  const { records, limitProblem } = parseLedger(text, { limits, clock: options.clock })
  if (limitProblem !== null) throw limitProblem

  const report = verifyLedgers([{ file: resolved.file, text }], { limits, clock: options.clock })
  if (report.summary.errors > 0) {
    const first = report.findings.find((item) => item.severity === 'error')
    throw new LedgerError(
      `Refusing to append to a ledger that does not verify: ${first.ruleId} on line ${first.line}. Run "verify" first.`,
    )
  }

  const events = records.map((record) => record.event)
  const ids = new Set(events.map((event) => event.id))
  const last = events.at(-1) ?? null

  const id = draft.id ?? `evt-${String(events.length + 1).padStart(4, '0')}`
  if (ids.has(id)) {
    throw new LedgerError(`Event id "${sanitize(id, 80)}" is already in this ledger; choose a new id`)
  }
  if (draft.corrects != null && !ids.has(draft.corrects)) {
    throw new LedgerError(`Cannot correct "${sanitize(draft.corrects, 80)}": this ledger records no such event`)
  }

  let stateHash = null
  for (const event of events) {
    if (event.subject !== draft.subject) continue
    stateHash = event.afterHash
  }

  /* A create starts from nothing by definition, so it never inherits a state
     hash: creating a subject the ledger already holds must be refused as a
     state error rather than quietly turned into something else. */
  const inherited = draft.action === 'create' ? null : stateHash
  const beforeHash = draft.beforeHash === undefined ? inherited : draft.beforeHash
  const event = createEvent({ ...draft, id, beforeHash }, last === null ? null : last.hash, limits)

  const check = verifyLedgers(
    [{ file: resolved.file, text: `${text.endsWith('\n') || text === '' ? text : `${text}\n`}${serializeEvent(event)}\n` }],
    { limits, clock: options.clock },
  )
  if (check.summary.errors > 0) {
    const first = check.findings.find((item) => item.severity === 'error')
    throw new LedgerError(`Refusing to append an event that would not verify: ${first.ruleId}. ${first.message}`)
  }

  await appendEventLine(resolved.real, serializeEvent(event), text)
  return { event, file: resolved.file, path: resolved.real }
}

/** A short human summary. The JSON report is the machine-readable output. */
export function formatReport(report) {
  const lines = report.findings.map((item) =>
    `${item.location.file}:${item.line} ${item.severity.padEnd(7)} ${item.ruleId} ${item.message}`)
  if (lines.length > 0) lines.push('')
  lines.push(`${report.summary.events} event(s) across ${report.summary.subjects} subject(s) `
    + `in ${report.summary.filesRead} of ${report.summary.files} ledger(s): `
    + `${report.summary.errors} error, ${report.summary.warnings} warning, ${report.summary.info} info, `
    + `status ${report.status}.`)
  return `${lines.join('\n')}\n`
}

/** A short human history. Every untrusted field is escaped on the way out. */
export function formatHistory(report) {
  const lines = report.entries.map((entry) => [
    sanitize(entry.recordedAt, 40),
    `${entry.file}:${entry.line}`,
    sanitize(entry.action, 10).padEnd(6),
    sanitize(entry.subject, 80),
    `owner=${sanitize(entry.owner, 40)}`,
    `release=${sanitize(entry.releaseId, 40)}`,
    entry.correctionTargetCandidates !== null
      ? `correction-target-candidates=${entry.correctionTargetCandidates.join(',') || 'none'}` : '',
    entry.supersededByCandidates.length > 0
      ? `superseded-by-candidates=${entry.supersededByCandidates.join(',')}` : '',
    `reason=${sanitize(entry.reason, 120)}`,
  ].filter((part) => part !== '').join(' '))
  lines.push(...report.findings.map((item) =>
    `${item.location.file}:${item.line} ${item.severity.padEnd(7)} ${item.ruleId} ${item.message}`))
  if (lines.length > 0) lines.push('')
  lines.push(`${report.summary.matched} matching event(s) of ${report.summary.events} read, status ${report.status}.`)
  return `${lines.join('\n')}\n`
}
