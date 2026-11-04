# Orchestrator v2 live verification — milestone FAIL / blocked

Starting implementation: ddd1c4ff9d894fe020f1e62425df5bc230b3cd3c.
Its GitHub Actions run 41758958293 completed successfully (21 tests).

## Live GitHub protocol primitives — PASS

Isolated retained evidence ref: `orch-journal/TEST-20261104-CLAIM-01`.
Synthetic metadata only; unchanged repository tree. No coding worker dispatched.

Two simultaneous connector create-ref requests used competing child commits:
- A: 82f5ba954d39ab3190e96fe214f09dcd90dd081b — succeeded.
- B: 7b6178ace3aaf96c027fe38377401f73fea8e371 — HTTP 422 Reference already exists.

Quarantine child 2372d33c13c9df54a7d181b7adbaf47ed23ba047 advanced the ref.
Stale dispatch sibling 1282bc6e0e11fda36a02598b50bd9bba1e5a0439 was rejected
by non-force update with HTTP 422 Update is not a fast forward.
These are direct connector tests of GitHub primitives, not execution of the
GitHubOwnershipStore class against REST. Full adapter integration remains unverified.

## Defect corrected

Ownership previously returned arbitrary post-CAS readback. A quarantine between CAS
and readback could return the replacement fence to the stale caller. Acquisition and
transition now validate their own fence, version and state on readback. Added regression
and lost-acquisition-acknowledgement tests. Interrupted acquisition remains retained,
blocks retries and requires explicit reconciliation; automatic recovery is incomplete.

## Exact execution limitation

No `codex` or `docker` executable is installed. `bwrap` is installed, but its isolation
probe fails: `open /proc/5/ns/ns failed: No such file or directory`.
Connected GitHub tools do not provide a persistent coding-agent launch operation.
Vercel exposes sandbox operations, but no configured coding-agent runtime/model
credential has been established. No secrets, paid settings or worker deployment were
changed to manufacture that capability. A shell process is not an isolated coding worker.

## Remaining mandatory gates — NOT PASSED

Actual adapter live execution, complete recovery and retry reconciliation, supported
isolated coding-worker dispatcher, canonical approved task contract, scope-enforced
publication, evidence outbox/writeback verification, bounded automatic continuation,
and canonical task-to-draft-PR end-to-end demonstration remain incomplete.
No task marked Done; no unattended execution authorized. PR #48 remains draft.
PAY-2 production remains HOLD.
