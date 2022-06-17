# content-change-ledger

Record why a content field changed and connect it to a release or owner.

- **Repository:** [edilec/content-change-ledger](https://github.com/edilec/content-change-ledger)
- **Area:** Content & Publishing
- **License:** MIT

## The problem

"Who changed the pricing page, why, and which release shipped it?" is usually
answered by asking three people. The commit says what the bytes became, the
ticket says what someone intended a fortnight earlier, and the release notes say
neither.

A ledger answers it in one file. Each change appends one event: the content hash
before, the content hash after, the reason, the owner, the release id, and the
hash of the event before it. Because every event's hash covers the event before
it, an event that is quietly edited or lifted out of the middle of the file
stops matching, and `verify` says exactly which line broke.

Nothing is ever edited. A mistake in a recorded event is fixed by appending a
**correction** that names it -- the original stays in the file, byte for byte.

## Install

Node 22 or newer. No runtime dependencies and no build step.

```sh
npm install content-change-ledger
```

Or run it from a checkout:

```sh
node bin/content-change-ledger.mjs --help
```

## Commands

```sh
# record a change
content-change-ledger append ledger.jsonl \
  --subject content/pricing.md --action update \
  --after-file content/pricing.md \
  --reason "Team plan moved to 49 USD" --owner content-team --release 2026.09.1

# fix a mistake in an earlier event without touching it
content-change-ledger append ledger.jsonl \
  --subject content/pricing.md --action correct --corrects evt-0002 \
  --after sha256:d67ce779... \
  --reason "evt-0002 recorded the wrong release" --owner content-team --release 2026.09.2

# check the whole chain against a policy and a head checkpoint
content-change-ledger verify examples/ledger.jsonl --config examples/ledger-policy.json

# read the history back
content-change-ledger history examples/ledger.jsonl --subject content/pricing.md
content-change-ledger history examples/ledger.jsonl --release 2026.09.1 --json
```

| Option | Verb | Meaning |
| :--------------- | :------ | :--------------------------------------------- |
| `--config FILE` | verify | Policy and head checkpoint (JSON) |
| `--root DIR` | all | Confine ledger paths to this directory (default: cwd) |
| `--json` | all | Emit the machine-readable report on stdout |
| `--subject S` | history | Only events about this subject |
| `--owner O` | history | Only events recorded by this owner |
| `--release ID` | history | Only events in this release |
| `--action A` | history | Only `create`, `update`, `delete` or `correct` |
| `--since` / `--until` | history | Bound the answer by `recordedAt`, written `2026-09-13T09:30:00.000Z` |
| `--limit N` | history | Bound the whole answer; a cut answer is `incomplete` |
| `--subject`, `--action`, `--reason`, `--owner`, `--release` | append | Required |
| `--after HASH` / `--after-file FILE` | append | The content hash after the change |
| `--before HASH` | append | Override the inherited before hash |
| `--id ID` | append | Event id (default: `evt-NNNN` by position) |
| `--corrects ID` | append | The earlier event this correction refers to |
| `--recorded-at TS` | append | UTC timestamp (default: now) |

Repository scripts: `npm run lint`, `npm test`, `npm run test:coverage`,
`npm run example`, `npm run pack:check`, and `npm run check` for all of them.
The deliberately tampered ledger is checked with:

```sh
node bin/content-change-ledger.mjs verify examples/broken-ledger.jsonl
```

It reports the chain break, the subject discontinuity and the reused event id,
and exits 1.

## The event

One JSON object per line, twelve fields, all strings or null:

```json
{"id":"evt-0002","subject":"content/pricing.md","action":"update",
 "beforeHash":"sha256:197c095e...","afterHash":"sha256:d67ce779...",
 "reason":"Team plan moved to 49 USD and seat counts were added",
 "owner":"content-team","releaseId":"2026.09.1","recordedAt":"2026-09-04T11:15:00.000Z",
 "corrects":null,"previousHash":"sha256:3baa98d2...","hash":"sha256:d1b29e5a..."}
```

`hash` is the SHA-256 of the canonical JSON of the other eleven fields, in a key
order fixed in code. `previousHash` is one of them, which is what chains the
file together. The full format, the action rules and the rule catalog are in
[docs/ledger-rules.md](./docs/ledger-rules.md).

## Outputs

`--json` writes the report to stdout, and only the report, so it can be piped
straight into a parser. Diagnostics always go to stderr.

```json
{
  "schemaVersion": "1",
  "tool": "content-change-ledger",
  "status": "fail",
  "summary": { "checked": 4, "errors": 3, "warnings": 0, "info": 1, "events": 4,
               "corrections": 1, "files": 1, "filesRead": 1, "subjects": 2 },
  "findings": [
    {
      "ruleId": "chain-previous-hash-mismatch",
      "severity": "error",
      "message": "This event follows line 1 in the file but records a different previousHash, so an event between them was removed or replaced.",
      "location": { "file": "examples/broken-ledger.jsonl", "pointer": "/events/1" },
      "line": 2,
      "evidence": "recorded sha256:d1b29e5a..., expected sha256:3baa98d2...",
      "suggestion": "Restore the missing event; the chain is only continuous when each event names the hash before it."
    }
  ]
}
```

`history --json` returns the same envelope with an `entries` array. Each entry
is a copy of the stored event plus `supersededBy`, the ids of later corrections
that name it, and the ledger `file` it came from. That annotation is computed
for the reader and is never written into the file.

Every untrusted string in either output -- an id, a path, a message, an excerpt
-- is bounded and escaped. Control characters (C0, DEL and C1, which is where
U+0085 hides), line separators, and bidirectional overrides become visible
escape text. File labels additionally double literal backslashes, so an actual
control character and text that merely spells its escape cannot produce the
same label. A long file label carries a short prefix, its UTF-16 length, and a
SHA-256 digest of its full UTF-16 path. A crafted id or file name cannot forge
a line in the human report or reverse what it says.

Duplicate-ID findings identify the two source lines without echoing the ID.

A line or a configuration file that does not parse is reported by position,
line and column -- never by quoting it back. `JSON.parse` embeds the input in
one of its two error messages, so a file short enough to be only a credential
would otherwise be reproduced in full by its own failure, and escaping would
not stop it: the quotation sits at the front of the message while the bound
cuts from the back.

## Exit codes

| Code | Meaning |
| ---: | :------------------------------------------------------------- |
| `0` | The ledger verified, or the query was answered in full |
| `1` | The ledger failed verification |
| `2` | Invalid usage or configuration, or evidence not read in full |

On exit 2, stdout is **empty** for a usage or configuration error -- the run
never had a subject to report on -- and carries a report with status
`incomplete` when a named input could not be read, so a consumer knows which
one. A consumer that pipes stdout must handle both.

## Limits and non-goals

**This is not tamper-proofing, and the README will not pretend otherwise.**

- **A truncated tail is undetectable on its own.** Deleting the last events
  leaves a perfectly consistent chain. Only a head checkpoint held somewhere the
  ledger's writer cannot reach (`head` in the configuration) detects it. Without
  one, every report carries the `tail-not-anchored` note rather than implying the
  end of the file was checked. A checkpoint mismatch reports the ledger event
  position and which checkpoint field differs, but withholds both ID and hash
  values from the finding.
- **Anyone who can rewrite the whole file can forge a consistent one.** The chain
  detects an event altered or removed *without* recomputing everything after it.
  It proves nothing against a writer who rebuilds the ledger from the first line.
  There are no signatures and no external anchor.
- **The timestamps are claims, not evidence.** `recordedAt` is whatever the
  caller supplied, and nothing corroborates it. The library never reads a clock:
  the command line is the only part of the tool that does, and only to default
  `--recorded-at` to this process's wall clock, which is a claim by the machine
  that ran the append and nothing more.
- **The content hashes are claims too.** `verify` checks the ledger against
  itself; it does not open your content files and re-hash them, so it cannot
  tell you whether `content/pricing.md` still matches the last `afterHash`
  recorded for it. `--after-file` hashes real bytes, but only at the moment of
  the append.
- **It cannot judge a reason or an owner.** `reason`, `owner` and `releaseId`
  are free text. A configured `owners` list and `releaseIdPattern` check spelling,
  not accountability.
- **One writer at a time.** There is no lock. Two processes appending
  simultaneously can both chain to the same event; the fork is detectable at the
  next `verify` as `chain-previous-hash-mismatch`, but it is not prevented.
- **A correction does not change what the earlier event says.** Any consumer that
  reads one event in isolation will still read the original. Read the history.
- **No network, ever.** No remote timestamping, no attestation service, no
  telemetry. Evidence the tool did not obtain locally is reported as unverified,
  and unverified is never a pass.
- **It is a file, not a database.** Every verb reads the whole ledger; the bounds
  in [docs/ledger-rules.md](./docs/ledger-rules.md) say how far that goes before
  the run reports `incomplete` instead of truncating. The one bound that is not
  a finding is `maxFiles`: naming more ledgers than it allows is refused before
  any of them is read, so it is a usage error with empty stdout rather than a
  report.

## License

MIT. See [LICENSE](./LICENSE).
