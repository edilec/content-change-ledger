/**
 * Reading, confining and parsing ledger files, and the one path that writes.
 *
 * Everything here is byte-exact on the way in: bytes are decoded with a strict
 * UTF-8 decoder, a file that cannot be decoded is reported rather than read,
 * and a limit that is reached stops the parse and says so. The only write in
 * the package is `appendFile` in O_APPEND mode at the end of this file.
 */

import { appendFile, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { DEFAULT_LIMITS, validateEventShape } from './event.mjs'

/** A declared bound was reached. Always an explicit finding, never a silent truncation. */
export class LimitExceeded extends Error {
  constructor(limit, allowed, observed, line = null) {
    super(`the ${limit} limit of ${allowed} was exceeded (observed ${observed})`)
    this.limit = limit
    this.allowed = allowed
    this.observed = observed
    this.line = line
  }
}

/** A refusal to read or write a ledger: outside the root, unreadable, or not verifying. */
export class LedgerError extends Error {}

/**
 * A strict UTF-8 decoder.
 *
 * `fatal` is the whole point. Undecodable bytes throw instead of becoming
 * U+FFFD, so encoding validity is never inferred from decoded text: a file that
 * legitimately contains U+FFFD is read exactly, and a file whose bytes are not
 * UTF-8 is always reported rather than quietly mangled. Every byte source in
 * this package -- ledgers and the configuration file alike -- goes through it.
 */
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Decode bytes as UTF-8 exactly, or return null when they are not UTF-8. */
export function decodeUtf8(bytes) {
  try {
    const text = UTF8_STRICT.decode(bytes)
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch {
    return null
  }
}

function toPosix(value) {
  return value.split(sep).join('/')
}

/**
 * Resolve a path and prove it is inside the root.
 *
 * Both sides are resolved to their real path before they are compared, because
 * a lexical check is not confinement: a symlink planted inside the root would
 * pass one and still read from outside the tree. Resolving only the target is
 * the matching mistake -- a root that is itself reached through a symlink would
 * then refuse files that really are inside it -- so both sides are realpath'd.
 *
 * A target that does not exist yet (a ledger about to be created) is confined
 * by its real parent directory plus its own name.
 */
export async function resolveInsideRoot(pathname, options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd())
  const realRoot = await realpath(resolve(options.root ?? cwd))
  const absolute = resolve(cwd, pathname)

  let real
  try {
    real = await realpath(absolute)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    real = join(await realpath(dirname(absolute)), basename(absolute))
  }

  const inside = real === realRoot || real.startsWith(realRoot + sep)
  return { absolute, real, realRoot, inside, file: toPosix(relative(realRoot, real)) }
}

const NUL = String.fromCharCode(0)

/**
 * Read the named ledger files, in the order given.
 *
 * No directory is ever walked, so nothing in the report depends on filesystem
 * enumeration order. A file that is outside the root, missing, too large, not
 * UTF-8 or not text becomes a named failure the caller reports as `incomplete`.
 * It is never a quietly skipped input, because a skipped input is exactly how
 * an unverified ledger comes to look verified.
 */
export async function readLedgers(paths, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
  if (paths.length > limits.maxFiles) {
    throw new LimitExceeded('maxFiles', limits.maxFiles, paths.length)
  }

  const ledgers = []
  const failures = []
  let realRoot = null

  for (const pathname of paths) {
    let resolved
    try {
      resolved = await resolveInsideRoot(pathname, options)
    } catch (error) {
      failures.push({ file: toPosix(pathname), ruleId: 'ledger-unreadable', message: `this path could not be resolved: ${error.message}` })
      continue
    }
    realRoot ??= resolved.realRoot

    if (!resolved.inside) {
      failures.push({
        file: toPosix(pathname),
        ruleId: 'ledger-outside-root',
        message: 'this path resolves outside the declared root, so it was not read',
      })
      continue
    }

    try {
      const stats = await stat(resolved.real)
      if (!stats.isFile()) throw new Error('not a regular file')
      if (stats.size > limits.maxBytes) {
        failures.push({
          file: resolved.file,
          ruleId: 'limit-exceeded',
          message: `the maxBytes limit of ${limits.maxBytes} was exceeded (observed ${stats.size}); this ledger was not read`,
        })
        continue
      }
      const text = decodeUtf8(await readFile(resolved.real))
      if (text === null) {
        failures.push({
          file: resolved.file,
          ruleId: 'ledger-not-utf8',
          message: 'these bytes are not valid UTF-8, so this ledger could not be read exactly',
        })
        continue
      }
      if (text.includes(NUL)) {
        failures.push({
          file: resolved.file,
          ruleId: 'ledger-not-text',
          message: 'this file contains NUL bytes, so it is not a JSON Lines ledger',
        })
        continue
      }
      ledgers.push({ file: resolved.file, absolute: resolved.real, text })
    } catch (error) {
      failures.push({ file: resolved.file, ruleId: 'ledger-unreadable', message: `this ledger could not be read: ${error.message}` })
    }
  }

  return { root: realRoot ?? resolve(options.root ?? options.cwd ?? process.cwd()), ledgers, failures }
}

const CLOCK_CHECK_INTERVAL = 128

/**
 * Parse one ledger's text into records, one per non-blank line.
 *
 * A record whose line could not be parsed or whose shape is wrong carries
 * `event: null` and its problems. The caller must treat such a record as
 * unknown -- not as a verdict about the chain -- because the evidence that
 * would settle the question was never obtained.
 *
 * Blank lines are skipped; they carry no event and mean nothing.
 */
export function parseLedger(text, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
  const clock = options.clock ?? (() => 0)
  const started = clock()
  const records = []
  let limitProblem = null

  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const line = index + 1
    if (raw.trim() === '') continue

    if (records.length >= limits.maxEvents) {
      limitProblem = new LimitExceeded('maxEvents', limits.maxEvents, records.length + 1, line)
      break
    }
    if (records.length % CLOCK_CHECK_INTERVAL === 0 && clock() - started > limits.timeLimitMs) {
      limitProblem = new LimitExceeded('timeLimitMs', limits.timeLimitMs, Math.round(clock() - started), line)
      break
    }

    const bytes = Buffer.byteLength(raw, 'utf8')
    if (bytes > limits.maxEventBytes) {
      records.push({
        line,
        index: records.length,
        raw,
        event: null,
        problems: [{
          kind: 'limit',
          field: null,
          detail: `the maxEventBytes limit of ${limits.maxEventBytes} was exceeded (observed ${bytes}); this event was not parsed`,
        }],
      })
      continue
    }

    let value
    try {
      value = JSON.parse(raw)
    } catch (error) {
      records.push({
        line,
        index: records.length,
        raw,
        event: null,
        problems: [{ kind: 'not-json', field: null, detail: `this line is not JSON: ${error.message}` }],
      })
      continue
    }

    const problems = validateEventShape(value, limits)
    records.push({
      line,
      index: records.length,
      raw,
      event: problems.length === 0 ? Object.freeze({ ...value }) : null,
      problems,
    })
  }

  return { records, limitProblem }
}

/**
 * Append one already-built event to a ledger file.
 *
 * This is the only write in the package, and it is an O_APPEND write of one
 * line. Existing bytes are never read back, rewritten, re-ordered or truncated:
 * a correction is a new line, and so is every other change of mind.
 */
export async function appendEventLine(absolutePath, line, existingText) {
  const needsNewline = existingText.length > 0 && !existingText.endsWith('\n')
  await appendFile(absolutePath, `${needsNewline ? '\n' : ''}${line}\n`, { encoding: 'utf8', flag: 'a' })
}

/** Read one ledger's text, or an empty string when the file does not exist yet. */
export async function readLedgerText(absolutePath, limits = DEFAULT_LIMITS) {
  let stats
  try {
    stats = await stat(absolutePath)
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw new LedgerError(`This ledger could not be read: ${error.message}`)
  }
  if (!stats.isFile()) throw new LedgerError('This ledger path is not a regular file')
  if (stats.size > limits.maxBytes) {
    throw new LimitExceeded('maxBytes', limits.maxBytes, stats.size)
  }
  const text = decodeUtf8(await readFile(absolutePath))
  if (text === null) throw new LedgerError('This ledger is not valid UTF-8, so it was not read')
  if (text.includes(NUL)) throw new LedgerError('This ledger contains NUL bytes, so it is not a JSON Lines ledger')
  return text
}
