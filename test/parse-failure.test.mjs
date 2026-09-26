/**
 * What a `JSON.parse` failure may not repeat back.
 *
 * V8 answers an unparseable document two ways and one of them quotes the
 * input: `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. A
 * configuration file short enough to be only a credential was therefore
 * reproduced in full on stderr by `Configuration is not valid JSON: ...`, and a
 * ledger line by the `event-not-json` finding on stdout.
 *
 * `sanitize` does not catch it. It escapes control characters and cuts from the
 * end at 120 characters; the quoted span is at the *front* of the message and
 * survives both. Worse for the ledger line: V8 quotes a window around the
 * offending character wherever it sits, so the message could show bytes from
 * past the 120-character bound that the `evidence` excerpt deliberately stops
 * at.
 *
 * `AKIAIOSFODNN7EXAMPLE` is the AWS documentation placeholder, not a key.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseFailureDetail } from '../src/index.mjs'

const CLI = fileURLToPath(new URL('../bin/content-change-ledger.mjs', import.meta.url))
const NEWLINE = String.fromCharCode(0x0a)

const CANARY = 'AKIAIOSFODNN7EXAMPLE'

// Longer than V8's ten-character window, so a leak is a prefix rather than the
// whole string. Truncating the message would not have caught this one.
const LONG_SECRET = 'password=hunter2-correct-horse-battery-staple'

const MIN_RUN = 8

/**
 * Assert that no run of `secret` eight characters or longer survives.
 *
 * Every run, not only every prefix: the quoted window is drawn around the
 * offending character, so a secret in the middle of a document leaks from its
 * middle. Asserting on the whole string alone would pass against output that
 * echoed `AKIAIOSF` and called it truncation.
 */
function assertNoLeak(secret, ...streams) {
  const haystack = streams.join(NEWLINE)
  for (let length = secret.length; length >= MIN_RUN; length -= 1) {
    for (let start = 0; start + length <= secret.length; start += 1) {
      const window = secret.slice(start, start + length)
      assert.equal(haystack.includes(window), false, `output echoed ${JSON.stringify(window)}`)
    }
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
  const directory = await mkdtemp(join(tmpdir(), 'content-change-ledger-parse-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('a configuration file that is only a credential is not quoted back on stderr', async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, 'ledger.jsonl'), '')
    await writeFile(join(directory, 'config.json'), CANARY)

    const { code, stdout, stderr } = await cli(
      ['verify', 'ledger.jsonl', '--config', 'config.json'],
      directory,
    )
    assert.equal(code, 2)
    assert.match(stderr, /Configuration is not valid JSON/)
    assertNoLeak(CANARY, stdout, stderr)
  })
})

test("a configuration longer than V8's window does not leak its prefix either", async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, 'ledger.jsonl'), '')
    await writeFile(join(directory, 'config.json'), LONG_SECRET)

    const { stdout, stderr } = await cli(['verify', 'ledger.jsonl', '--config', 'config.json'], directory)
    assertNoLeak(LONG_SECRET, stdout, stderr)
    assert.equal(stderr.includes('password=h'), false)
  })
})

test('a ledger line does not leak bytes the evidence bound withheld', async () => {
  await withDirectory(async (directory) => {
    /* The secret sits past the 120-character evidence bound, so `evidence`
       cannot show it and the quoted window in the parse message is the only
       route out. V8 answers this line with the windowed form. */
    const line = `["${'p'.repeat(200)}", }${CANARY}]`
    await writeFile(join(directory, 'ledger.jsonl'), `${line}${NEWLINE}`)

    const { stdout, stderr } = await cli(['verify', 'ledger.jsonl', '--json'], directory)
    const report = JSON.parse(stdout)
    assert.equal(report.findings[0].ruleId, 'event-not-json')
    assertNoLeak(CANARY, stdout, stderr)
  })
})

test('a ledger line whose parse failure carries a position keeps the position', async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, 'ledger.jsonl'), `{"id": "evt-0001" "subject": "a"}${NEWLINE}`)

    const { stdout } = await cli(['verify', 'ledger.jsonl', '--json'], directory)
    const [finding] = JSON.parse(stdout).findings
    assert.equal(finding.ruleId, 'event-not-json')
    assert.match(finding.message, /at position 18 \(line 1 column 19\)/)
  })
})

test('a parse failure still names the token: a detail that says nothing is its own defect', async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, 'ledger.jsonl'), `${CANARY}${NEWLINE}`)

    const { stdout } = await cli(['verify', 'ledger.jsonl', '--json'], directory)
    const [finding] = JSON.parse(stdout).findings
    assert.match(finding.message, /unexpected token 'A'/)
  })
})

test('parseFailureDetail keeps the position and drops the quoted window', () => {
  const detail = (text) => {
    try {
      JSON.parse(text)
      throw new Error('that text parsed')
    } catch (error) {
      return parseFailureDetail(error)
    }
  }

  // The positional form is all position and no input, and is kept whole.
  assert.equal(
    detail('{"id": "evt-0001" "subject": "a"}'),
    "Expected ',' or '}' after property value in JSON at position 18 (line 1 column 19)",
  )
  assert.equal(detail('{"a":1}x'), 'Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)')
  assert.equal(detail(''), 'Unexpected end of JSON input')
  assert.equal(detail('[1,2,'), 'Unexpected end of JSON input')

  // Every quoted shape: the whole input, a leading prefix, and a window.
  assert.equal(detail(CANARY), "unexpected token 'A' near the start")
  assert.equal(detail(LONG_SECRET), "unexpected token 'p' near the start")
  assert.equal(detail(`["${'p'.repeat(200)}", }${CANARY}]`), "unexpected token '}'")
})

test('parseFailureDetail refuses a document whose own bytes imitate a position', () => {
  // The quoted form is matched first for exactly this reason.
  let detail
  try {
    JSON.parse(`at position 12 ${CANARY}`)
  } catch (error) {
    detail = parseFailureDetail(error)
  }
  assertNoLeak(CANARY, detail)
  assert.equal(detail.includes('at position 12'), false)
})

test('parseFailureDetail escapes a control character that arrives as the token', () => {
  // V8 names the offending character, and that character comes from the input.
  let detail
  try {
    JSON.parse(String.fromCharCode(0x1f))
  } catch (error) {
    detail = parseFailureDetail(error)
  }
  assert.equal(detail.includes(String.fromCharCode(0x1f)), false)
  assert.match(detail, /\\u001f/)
})

test('parseFailureDetail says something for an error it does not recognise', () => {
  assert.equal(parseFailureDetail(undefined), 'it could not be parsed as JSON')
  assert.equal(parseFailureDetail(new Error('something else entirely')), 'it could not be parsed as JSON')
})
