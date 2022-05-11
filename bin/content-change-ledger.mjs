#!/usr/bin/env node

/**
 * The command line: three verbs over one append-only file.
 *
 * stdout carries JSON and nothing else when --json is given, so it can be piped
 * straight into a parser. Diagnostics go to stderr. An invalid invocation
 * leaves stdout empty and exits 2; an input that could not be read still
 * produces a report, because a consumer needs to know WHICH ledger was not
 * read.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  ACTIONS,
  LimitExceeded,
  appendEvent,
  decodeUtf8,
  formatHistory,
  formatReport,
  hashContent,
  historyReport,
  parseConfig,
  readLedgers,
  resolveInsideRoot,
  sanitize,
  serializeEvent,
  verifyLedgers,
} from '../src/index.mjs'

/**
 * The one clock in the tool.
 *
 * The library never reads a clock: `timeLimitMs` is enforced against an
 * injected monotonic clock, and `recordedAt` is injected too, so a test can fix
 * both and two runs over the same bytes stay byte-identical.
 */
const clock = () => performance.now()

const HELP = `content-change-ledger

An append-only local ledger of content change events, chained by hash. Each
event records the before and after content hashes, the reason, the owner, the
release id and the hash of the event before it.

Usage:
  content-change-ledger verify  <ledger.jsonl> [ledger.jsonl ...] [options]
  content-change-ledger history <ledger.jsonl> [filters] [options]
  content-change-ledger append  <ledger.jsonl> --subject S --action A --reason R
                                --owner O --release ID [event options]

Common options:
  --root DIR          Confine ledger paths to this directory (default: cwd)
  --json              Emit the machine-readable report on stdout
  -h, --help          Show this help

verify options:
  --config FILE       Policy and head checkpoint (JSON)

history filters:
  --subject S         Only events about this subject
  --owner O           Only events recorded by this owner
  --release ID        Only events in this release
  --action A          Only ${ACTIONS.join(' | ')} events
  --since TS          Only events recorded at or after this UTC timestamp
  --until TS          Only events recorded at or before this UTC timestamp
  --limit N           Bound on the answer; a cut answer is incomplete (exit 2)

append options:
  --subject S         The content item that changed (required)
  --action A          ${ACTIONS.join(' | ')} (required)
  --reason R          Why it changed (required)
  --owner O           Who is accountable (required)
  --release ID        The release this change belongs to (required)
  --after HASH        sha256:<hex> of the content after the change
  --after-file FILE   Hash this file's bytes as the after hash instead
  --before HASH       Override the before hash (default: the ledger's last
                      afterHash for this subject)
  --id ID             Event id (default: evt-NNNN by position)
  --corrects ID       The earlier event this correction refers to
  --recorded-at TS    UTC timestamp (default: now, from this process)

A correction never rewrites history: it appends a new event naming the event it
corrects. The existing chain is verified before anything is written, and an
append that would not verify is refused.

Exit codes:
  0  the ledger verified, or the query answered in full
  1  the ledger failed verification
  2  invalid usage or configuration, or evidence that could not be read in full
`

const COMMANDS = new Set(['verify', 'history', 'append'])

const OPTION_SPEC = Object.freeze({
  verify: ['--config', '--root'],
  history: ['--root', '--subject', '--owner', '--release', '--action', '--since', '--until', '--limit'],
  append: [
    '--root', '--subject', '--action', '--reason', '--owner', '--release',
    '--after', '--after-file', '--before', '--id', '--corrects', '--recorded-at',
  ],
})

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) return { help: true }

  const command = argv[0]
  if (!COMMANDS.has(command)) throw new Error(`Unknown command "${sanitize(command, 40)}"`)

  const allowed = OPTION_SPEC[command]
  const options = { command, json: false, files: [], values: {} }

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') {
      options.json = true
      continue
    }
    if (argument.startsWith('-')) {
      if (!allowed.includes(argument)) throw new Error(`Unknown option "${sanitize(argument, 40)}" for "${command}"`)
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a value`)
      if (Object.hasOwn(options.values, argument)) throw new Error(`${argument} was given twice`)
      options.values[argument] = value
      index += 1
      continue
    }
    options.files.push(argument)
  }

  if (options.files.length === 0) throw new Error('a ledger path is required')
  if (command !== 'verify' && options.files.length > 1) {
    throw new Error(`"${command}" takes exactly one ledger path`)
  }
  return options
}

async function loadConfig(path) {
  let bytes
  try {
    bytes = await readFile(resolve(path))
  } catch (error) {
    throw new Error(`Could not read configuration: ${error.message}`)
  }
  /* The configuration is decoded as strictly as the data. A lossy config path
     is exactly how a hardened tool ends up trusting bytes it never read. */
  const text = decodeUtf8(bytes)
  if (text === null) throw new Error('Configuration file is not valid UTF-8')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Configuration is not valid JSON: ${error.message}`)
  }
  return parseConfig(parsed)
}

function requireValue(values, flag) {
  const value = values[flag]
  if (value === undefined) throw new Error(`${flag} is required`)
  return value
}

async function runVerify(options) {
  const config = options.values['--config'] === undefined ? undefined : await loadConfig(options.values['--config'])
  const { ledgers, failures } = await readLedgers(options.files, {
    root: options.values['--root'],
    limits: config?.limits,
  })
  const report = verifyLedgers(ledgers, { config, failures, clock })
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

function historyFilters(values) {
  const filters = {}
  if (values['--subject'] !== undefined) filters.subject = values['--subject']
  if (values['--owner'] !== undefined) filters.owner = values['--owner']
  if (values['--release'] !== undefined) filters.releaseId = values['--release']
  if (values['--action'] !== undefined) filters.action = values['--action']
  if (values['--since'] !== undefined) filters.since = values['--since']
  if (values['--until'] !== undefined) filters.until = values['--until']
  if (values['--limit'] !== undefined) {
    const limit = Number(values['--limit'])
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer')
    filters.limit = limit
  }
  return filters
}

async function runHistory(options) {
  const filters = historyFilters(options.values)
  const { ledgers, failures } = await readLedgers(options.files, { root: options.values['--root'] })
  const report = historyReport(ledgers, filters, { failures, clock })
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatHistory(report))
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

async function runAppend(options) {
  const values = options.values
  const root = values['--root']
  const draft = {
    subject: requireValue(values, '--subject'),
    action: requireValue(values, '--action'),
    reason: requireValue(values, '--reason'),
    owner: requireValue(values, '--owner'),
    releaseId: requireValue(values, '--release'),
    recordedAt: values['--recorded-at'] ?? new Date().toISOString(),
  }
  if (values['--id'] !== undefined) draft.id = values['--id']
  if (values['--corrects'] !== undefined) draft.corrects = values['--corrects']
  if (values['--before'] !== undefined) draft.beforeHash = values['--before']

  if (values['--after'] !== undefined && values['--after-file'] !== undefined) {
    throw new Error('--after and --after-file name the same field; give one of them')
  }
  if (values['--after'] !== undefined) draft.afterHash = values['--after']
  if (values['--after-file'] !== undefined) {
    const resolved = await resolveInsideRoot(values['--after-file'], { root })
    if (!resolved.inside) throw new Error(`Refusing to read ${sanitize(values['--after-file'], 120)}: it resolves outside the declared root`)
    draft.afterHash = hashContent(await readFile(resolved.real))
  }

  const { event, file } = await appendEvent(options.files[0], draft, { root, clock })
  if (options.json) {
    process.stdout.write(`${JSON.stringify(event, null, 2)}\n`)
  } else {
    process.stdout.write(`${serializeEvent(event)}\n`)
  }
  process.stderr.write(`appended ${sanitize(event.id, 80)} to ${sanitize(file, 200)}\n`)
  return 0
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  try {
    if (options.command === 'verify') return await runVerify(options)
    if (options.command === 'history') return await runHistory(options)
    return await runAppend(options)
  } catch (error) {
    const detail = error instanceof LimitExceeded ? `limit exceeded: ${error.message}` : error.message
    process.stderr.write(`${detail}\n`)
    return 2
  }
}

process.exitCode = await main(process.argv.slice(2))
