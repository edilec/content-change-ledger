# Ledger format, rules and limits

This document is the reference for what a `content-change-ledger` file holds,
what the tool checks, what it refuses to guess, and what it guarantees about its
own output.

## The file

A ledger is a UTF-8 **JSON Lines** file: one JSON object per line, appended in
the order the changes happened. Blank lines are skipped. Nothing else is a
ledger, and nothing in this package ever rewrites a line that is already there.

Each event is a flat object with exactly these twelve keys, in this order:

| Field | Type | Meaning |
| :------------ | :----------- | :------------------------------------------------ |
| `id` | string | Identifies this event forever; never reused |
| `subject` | string | The content item that changed, as your own key |
| `action` | string | `create`, `update`, `delete` or `correct` |
| `beforeHash` | string, null | Content hash before the change, null when none |
| `afterHash` | string, null | Content hash after the change, null after a delete |
| `reason` | string | Why the change was made |
| `owner` | string | Who is accountable for it |
| `releaseId` | string | The release this change belongs to |
| `recordedAt` | string | UTC instant, `YYYY-MM-DDTHH:MM:SS.sssZ` |
| `corrects` | string, null | The event id this correction refers to |
| `previousHash` | string, null | The `hash` of the event before it; null at the head |
| `hash` | string | This event's own hash, covering the eleven above |

Every value is a string or `null`. There is no nesting, so there is no recursion
to bound: a nested object or an array in any field is rejected, not flattened.
Content hashes are written `sha256:` followed by 64 lowercase hex digits. A
control character -- C0 (U+0000-U+001F), DEL (U+007F) or C1 (U+0080-U+009F,
which includes U+0085 NEL and the 8-bit CSI U+009B) -- and the line and
paragraph separators U+2028 and U+2029 are rejected in any field, because each
of them ends or forges a line somewhere.

The bidirectional formatting characters are not rejected: they are real content
in right-to-left text. They are stored exactly as given and escaped wherever
this tool prints them, which is described under [What reaches the
report](#what-reaches-the-report).

### The hash

`hash` is the SHA-256 of the canonical JSON of the eleven hashed fields, in the
order of the table above. The order is fixed in code, not derived from the
object, so the same event hashes identically on any machine. `JSON.stringify`
escapes quotes, backslashes and control characters, so no field value can
imitate the framing of another one.

Because `previousHash` is one of the hashed fields, each event's hash covers the
whole history before it. Changing any event changes its own hash, and every
event after it still records the old one.

### The actions

| Action | `beforeHash` | `afterHash` | `corrects` |
| :-------- | :----------- | :---------- | :--------- |
| `create` | null | required | null |
| `update` | required | required | null |
| `delete` | required | null | null |
| `correct` | free | free | required |

A subject must be created before it is updated or deleted, and cannot be created
twice without a delete in between. Every event's `beforeHash` must equal the
`afterHash` this ledger last recorded for that subject.

A **correction never edits anything**. It is a new event that names the event it
corrects, and the corrected event stays in the file byte for byte. `history`
annotates the corrected event with `supersededBy` when it prints it; that
annotation is computed for the reader and never written to the file.

## Rule catalog

Rule ids are stable. Renaming one is a breaking change and is recorded in the
changelog. Severity comes from one frozen table in `src/index.mjs`, and this
catalog is asserted against that table in both directions by the test suite.

The **Incomplete** column says whether the finding means evidence was missing.
A report carrying any rule marked `yes` can only have status `incomplete`; the
report builder throws rather than emit it any other way, so a forgotten flag
cannot turn an unread input green.

| ruleId | Severity | Incomplete | What it means |
| :------------------------------ | :------ | :--------- | :-------------------- |
| `ledger-unreadable` | error | yes | A named ledger could not be opened or read |
| `ledger-outside-root` | error | yes | A named ledger resolves outside the declared root |
| `ledger-not-utf8` | error | yes | A ledger's bytes are not valid UTF-8 |
| `ledger-not-text` | error | yes | A ledger contains NUL bytes |
| `limit-exceeded` | error | yes | A declared bound was reached; the run stopped there |
| `event-not-json` | error | yes | A line is not JSON |
| `event-not-object` | error | yes | A line is JSON but not an object |
| `event-field-missing` | error | yes | An event is missing one of the twelve fields |
| `event-field-invalid` | error | yes | A field has the wrong type, shape or length |
| `event-field-unknown` | error | yes | An event carries a field the format does not define |
| `event-id-duplicate` | error | no | Two events share an id |
| `event-hash-mismatch` | error | no | An event does not match its own recorded hash |
| `chain-genesis-invalid` | error | no | The first event records a previousHash, so the front is missing |
| `chain-previous-hash-mismatch` | error | no | An event does not chain to the line above it |
| `subject-hash-discontinuity` | error | no | A beforeHash is not the last afterHash recorded for that subject |
| `subject-state-invalid` | error | no | A subject was created twice, or changed before it existed |
| `correction-target-unknown` | error | no | A correction names an id no earlier event records |
| `correction-target-invalid` | error | no | A correction names itself |
| `event-owner-not-allowed` | error | no | An owner outside the configured `owners` list |
| `event-release-id-not-allowed` | error | no | A release id that does not match `releaseIdPattern` |
| `checkpoint-mismatch` | error | no | The last event is not the configured head checkpoint |
| `ledger-empty` | warning | yes | A ledger holds no verifiable event, so nothing was verified |
| `event-recorded-at-out-of-order` | warning | no | An event is recorded earlier than the line above it |
| `history-truncated` | warning | yes | A query matched more events than its limit returned |
| `history-identity-ambiguous` | warning | yes | Duplicate event IDs make history correction relationships non-unique |
| `tail-not-anchored` | info | no | No head checkpoint is configured, so tail truncation is undetectable |

## What "unknown" means here

A line that could not be parsed or validated is **unknown**, not a verdict. The
run is `incomplete` and exits 2, and from that line onward in that ledger the
tool stops reporting:

- `subject-state-invalid` and `subject-hash-discontinuity`, because the state
  they compare against is no longer known;
- `correction-target-unknown`, because the id it looked for may be in the line
  that could not be read;
- `chain-previous-hash-mismatch` across the gap, because the hash on the other
  side of it was never obtained.

Duplicate ids, self-corrections, hash mismatches and chain links between two
readable events are still reported: those are observations, not inferences from
what is missing.

These rules also hold:

- `pass` with `checked: 0` is impossible. An empty ledger is `ledger-empty` and
  `incomplete`, and the report builder refuses to emit a pass that verified
  nothing.
- An input that was not read is a finding naming the file, never a skipped
  input.

## What reaches the report

Every untrusted string is bounded and escaped on its way into output -- ids,
keys, paths, messages, evidence, the entries of a history, and the diagnostics
on stderr, not only the excerpt of a bad line. Escaped means written as `\uXXXX`
escape text, and it covers:

| Class | Range | Why |
| :---------------- | :---------------------------------- | :--------------- |
| C0 | U+0000-U+001F | ends a line in any consumer |
| DEL | U+007F | control character |
| C1 | U+0080-U+009F | U+0085 is a line break, U+009B starts a terminal escape |
| line, paragraph | U+2028, U+2029 | ends a line for a JavaScript consumer |
| bidi | U+200E, U+200F, U+202A-U+202E, U+2066-U+2069 | reverses or hides displayed text |

The bound is 200 characters for a path, 120 for an excerpt, and shorter for a
quoted field; a bounded string ends in ` [...]`. A ledger file name is as
untrusted as a ledger's contents, so it is escaped in the human report, in the
`location.file` of every finding, and in the `file` of every history entry.

A parse failure is reported by position, never by quotation. `JSON.parse` has
two error messages and one of them embeds the input --
`Unexpected token 'A', "AKIA..." is not valid JSON` for a short document, and a
ten-character window around the offending character for a long one. A ledger
line or a configuration file that is only a credential would otherwise be
reproduced by its own error message, and a window drawn deep inside a long line
would show bytes the 120-character excerpt bound deliberately stops short of.
Escaping and bounding do not remove it: the quoted span is at the front of the
message and the bound cuts from the back. So `parseFailureDetail` keeps the
position, line and column and drops the quotation.

## Configuration

`--config FILE` takes a JSON object. Unknown keys are refused, so a typo can
never quietly drop a policy.

| Key | Meaning |
| :----------------- | :------------------------------------------------------ |
| `schemaVersion` | Must be `"1"` |
| `limits` | Overrides for the bounds below |
| `head` | `{ "id", "hash" }` of the event the ledger must end with |
| `owners` | Non-empty list of owners events may record |
| `releaseIdPattern` | Regular expression every `releaseId` must match |

`head` anchors exactly one ledger: verifying several files with a `head`
configured is a usage error rather than a check that silently applies to one of
them.

## Limits

Every bound on evidence is enforced, and exceeding one is a `limit-exceeded`
finding with status `incomplete` -- never a silent truncation, and never a pass.

`maxFiles` is the exception, because it bounds the invocation rather than the
evidence: naming more ledgers than it allows is refused before anything is read,
so there is no run to report on. That is a usage error -- exit 2, empty stdout,
and the limit named on stderr -- exactly like an unknown option.

| Limit | Default | What it bounds |
| :---------------- | ------: | :------------------------------------------ |
| `maxFiles` | 64 | Ledger paths accepted in one run |
| `maxBytes` | 8000000 | Bytes in one ledger file |
| `maxEvents` | 50000 | Events read from one ledger |
| `maxEventBytes` | 16384 | Bytes in one event line |
| `maxFieldLength` | 512 | Characters in a free-text field |
| `maxReasonLength` | 1024 | Characters in `reason` |
| `maxQueryResults` | 1000 | Events one `history` answer may return |
| `timeLimitMs` | 10000 | Wall clock for parsing one ledger |

`maxFieldLength` and `maxReasonLength` count characters, not UTF-16 units, and
do not apply to the hash and timestamp fields: those are bounded by their own
exact formats, so lowering a limit can never make a well-formed event
unrepresentable.

`maxQueryResults` and `--limit` bound the whole answer, not each ledger of it:
querying several ledgers at once returns at most that many events in total, and
an answer the bound cut short is `incomplete` with a `history-truncated`
finding.

`--since` and `--until` are refused unless they are written in the one timestamp
spelling `recordedAt` uses, `YYYY-MM-DDTHH:MM:SS.sssZ`. A window that is a typo
would otherwise match nothing and report it as a complete, green "no events
changed".

`timeLimitMs` is measured against an injected clock. The library never reads a
clock of its own; the command line injects the process monotonic clock, and a
test injects a fixed one.

## Determinism

- Findings sort by `(location.file, line, ruleId, location.pointer, message)`.
- Every comparison is by UTF-16 code unit. `localeCompare` is never used: it
  depends on ICU data that varies between Node builds.
- No directory is ever walked. Every input is named explicitly, so nothing in
  the report depends on filesystem enumeration order.
- `recordedAt` is supplied by the caller, never taken from the clock inside the
  library.
- Two runs over the same bytes produce byte-identical stdout.

## Paths

A ledger path is resolved to its real path and must be inside the real path of
`--root` (default: the working directory). Both sides are resolved, so a symlink
planted inside the root cannot read from outside it, and a root that is itself
reached through a symlink does not turn a file genuinely inside it into a
refusal. A ledger being created for the first time is confined by its real
parent directory.

## Exit codes

| Code | Meaning |
| ---: | :------------------------------------------------------------ |
| `0` | The ledger verified, or the query was answered in full |
| `1` | The ledger failed verification |
| `2` | Invalid usage or configuration, or evidence not read in full |

On exit 2 stdout is **empty** for a usage or configuration error -- the run
never had a subject -- and carries a report with status `incomplete` when a
named input could not be read, because a consumer needs to know which one.
