# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- an append-only JSON Lines ledger of content change events: each event records
  the before and after content hashes, the reason, the owner, the release id,
  the UTC instant it was recorded, and the hash of the event before it;
- a hash chain whose canonical form has a key order fixed in code, so the same
  event hashes identically on any machine, and an event edited or lifted out of
  the middle of a file is detectable at the exact line;
- corrections as append-only events: `appendEvent` never rewrites a line, the
  event a correction names keeps its bytes, and `history` annotates the
  corrected event with `supersededBy` for the reader without storing it;
- verification of duplicate event ids, self-recorded hashes, chain continuity,
  the genesis event, per-subject before/after continuity, the subject state
  machine, correction targets, and an optional head checkpoint;
- `history` queries by subject, owner, release, action and time window, where
  every filter is validated -- a malformed window is refused, not answered --
  and an answer cut short by the limit on the whole answer is `incomplete`
  rather than quietly short;
- explicit bounds on files, bytes, events, event size, field length, query
  results and wall-clock time, each reported as `incomplete` with a finding
  naming the limit;
- a CLI with `verify`, `history`, `append`, `--root`, `--json` and exit codes
  0 / 1 / 2;
- a clean example ledger with a policy file, and a deliberately tampered one;
- the format, rule catalog, limits and determinism guarantee in
  `docs/ledger-rules.md`.

### Defended

Each of these is a guarantee with a test that fails when the guarantee is
removed from the source:

- evidence that was not obtained is never a verdict. After a line that could not
  be parsed, the subject state machine, the before/after continuity check, the
  correction-target check and the chain link across the gap all stop reporting,
  and the run is `incomplete`;
- `pass` with `checked: 0` cannot be emitted: an empty ledger is `ledger-empty`
  and `incomplete`, and the report builder refuses a pass that verified nothing.
  Every rule that was observed to make a real run `incomplete` is also refused on
  a report that is not, so a rule quietly dropped from that list fails a test;
- severity comes from one frozen `ruleId -> severity` table, and what each rule
  does to a run is pinned by a real run: every rule in the catalog has a fixture
  driven through the command line, asserting the exit code, the status and the
  error, warning and info counts it produces. A severity changed in the table,
  the documented catalog and a test map together still fails, because the
  observed outcome changes. An unknown rule id throws, and the lookup that
  throws is exported so that guard can be called;
- ledgers and the configuration file are both decoded with
  `TextDecoder('utf-8', { fatal: true })`; encoding validity is never inferred
  from decoded text;
- path confinement resolves the real path of both the target and the root, so a
  symlink planted inside the root cannot escape it and a legitimate file reached
  through a symlinked root is not falsely refused;
- every untrusted string that reaches output -- ids, keys, paths, messages,
  history entries, raw lines and the diagnostics on stderr -- is bounded and
  escaped, not only the evidence field. The escaped set is C0, DEL, C1
  (U+0085 and U+009B among them), U+2028, U+2029 and the bidi controls
  U+200E, U+200F, U+202A-U+202E and U+2066-U+2069, each tested through a real
  run and through an identifier as well as an excerpt;
- ordering is by UTF-16 code unit, pinned by the exact list each entry point
  emits for inputs that collation orders differently -- `Z` before `a`, `README`
  before `assets`, `MAXB` before `MAX_A`, `a-b` before `a_b`. Substituting a
  collator for `byCodeUnit` fails those tests rather than passing a source scan;
- unknown configuration keys, unknown limits and unknown query filters are
  refused rather than ignored, and so is a `--since` or `--until` that is not a
  UTC instant in the one spelling `recordedAt` uses;
- an input that could not be read still produces a report naming it, for
  `history` as well as `verify`: exit 2 carries the report, and only a usage or
  configuration error leaves stdout empty.

No release has been published.
