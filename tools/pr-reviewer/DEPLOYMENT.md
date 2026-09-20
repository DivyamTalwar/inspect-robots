# Deployment record

Date: 2026-09-20. Repository: `robocurve/inspect-robots`.
Cloudflare account: `7f405baff0972dc740a02ee0f700d2c1` (Robocurve).
GitHub App: `robocurve-pr-reviewer`, ID `5012304`, installation `163290338`.

Current status: live in advisory mode for new non-draft PRs and revisions.

- OpenAI key verified for `gpt-6-astra`.
- Live standard-tier background structured-output request with high reasoning
  completed successfully. Input count matched actual usage: 37 input tokens,
  13 output tokens, approximately $0.00102 at standard rates.
- Worker bundles passed Wrangler dry-run compilation.
- TypeScript and 34 offline policy, ledger, gateway and orchestration tests passed. Obsolete custom-loop tests were replaced by Codex gateway/lifecycle tests.
- Core checks passed: Ruff, formatting, mypy, 1,720 pytest tests with 100% core
  coverage. Six optional rerun-sdk tests skipped because that extra is absent.
- Clean npm install succeeded; dependency audit reported zero vulnerabilities.
- Workers Paid enabled by the maintainer. The reviewer and publisher deployed successfully.
- Publisher version: `6f74706a-0882-4668-af68-09910d3b1afa`.
- Reviewer version: `c82ab9bc-7d0e-4b21-b20a-4b1b97615883`.
- Receiver: https://inspect-robots-reviewer.jay-7f4.workers.dev/webhook
- Health endpoint reports advisory mode and `enabled: true`.
- GitHub private key, OpenAI key and generated HMAC secret uploaded securely.
- Production signed ping accepted (200); invalid signature rejected (401).
- CodeQL sanitizer alerts addressed by escaping each HTML delimiter; regression
  tests pass and the updated CodeQL check no longer reports a failure.
- GitHub App subscribed to `pull_request` and `issue_comment`; URL and secret
  configured. GitHub-generated ping redelivery accepted (200).
- Live draft-PR probe accepted (202) through the private publisher and GitHub API;
  no Workflow created, confirming draft deferral without model charges.
- Fixed an outbound request compatibility failure found by the live probe.
  Explicit Worker Requests use manual redirect handling and reject all 3xx
  responses, preventing credential forwarding. Regression test included.
- No merge rules were changed. No existing PR backlog was imported.
- Restored Sravanthi's merged-and-reverted PR #453 as trial PR #456 by
  reverting #454. Its tree matches the original merged implementation exactly.
- The first trial stopped before inference because GitHub omits patches for
  empty files. Fixed by verifying complete immutable file contents are empty;
  zero diff counts alone cannot bypass the missing-patch guard. Regression
  tests cover additions, removals, binary data and BOM-only files.
- A `/review` rerun reached the existing 100,000-byte per-file cap: the
  restored `uv.lock` is 524,568 bytes. Workflow
  `679ba5b31f920ab2086ff632283630c0520279906ccaa88b` published a held result
  and tagged Jay. Neither trial reached model submission or budget reservation;
  no model-review verdict was produced. PR #456 remains open with green CI.
- Hold notices now include an allowlisted reason, safe file-size details when
  available, a next step and a run reference. Budget, context-size and model
  failures have distinct explanations. Raw exceptions and provider responses
  never become public comment text.

No further setup is required for advisory processing.
Turning the independent review check into a merge requirement is a separate
rollout decision. Implementation is tracked in PR #455; deployment is already live.

## Codex engine rollout

- Replaced the hand-built model/tool loop with Codex CLI 0.155.1 and a natural-language review policy, using Astra/high.
- Public source snapshots at the head and merge base are staged in an isolated Cloudflare Sandbox. Codex uses its own diff/search/file/shell tools and fresh session.
- Added a private model gateway: session-scoped expiring access, pinned model/reasoning, atomic per-request reservations, duplicate-submission prevention, streaming usage settlement. Provider keys remain outside the sandbox.
- Sandbox has no GitHub credentials and no outbound access except its budgeted Responses proxy. One basic instance; 20-minute CLI limit and independent 22-minute shutdown.
- Native CLI mock integration passed: initial request, shell execution, continued request containing its tool output, and structured final JSON. No provider credentials or live inference used for that test.
- Offline Docker test on the trial PR passed 14 focused plugin tests with local package setup and networking disabled.
- First production CLI attempt stopped at the launcher before model review. Corrected the executable path for Cloudflare's shell.
- Live native CLI sessions performed multiple model turns, diff inspection and source/context reads. The shared per-head budget then prevented further inference; no completed review verdict was issued.
- Diagnostic run `230721d16d351acd424c9633cb672b40619b430a06f4d553` confirmed $0.244662 remaining in the conservative head ledger. This is not an invoice total: earlier settlement charged every input token at the non-cached ceiling.
- Corrected future settlement to credit confirmed cache reads at $1/M, added final-turn budget steering, and preserved budget-stop reasons independently of CLI stderr. Existing charges remain unchanged because historical cache usage was not retained.
- No further paid trial was started after these fixes. A complete end-to-end verdict on PR #456 remains pending additional authorized trial allowance. The $5/head, $15/PR and $200/month limits remain unchanged.
- Runner version: `61ee5a32-0f1f-4e23-b46c-f95e42bb31b1`.

## Authorized trial budget exception

- The maintainer authorized raising PR #456 head `696fbaa9a00d7c345a81dd179fa10934f51ade89` from $5 to $10 after earlier attempts consumed its shared allowance.
- The deployment-only exception preserves charges and leaves all other heads at $5, with the $15 PR and $200 monthly ceilings unchanged.
- All 34 offline reviewer tests passed, including concurrent reservations against the exact-head exception and the unchanged PR ceiling.
- Live workflow `90dfed5db293fd070613dafecef32a618ee95003f12e97a9` completed and published ESCALATE: scope needs Jay's decision and technical inspection remained incomplete. Codex reported 131 plugin tests passing.
- The session completed 12 model calls, booked $2.132670 in model usage plus the $0.10 sandbox allowance, and issued no approval. These ledger amounts are conservative allowances, not invoice totals.
- Published review: https://github.com/robocurve/inspect-robots/pull/456#issuecomment-5752014167
