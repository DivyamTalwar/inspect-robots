# Deployment record

Date: 2026-09-20. Repository: `robocurve/inspect-robots`.
Cloudflare account: `7f405baff0972dc740a02ee0f700d2c1` (Robocurve).
GitHub App: `robocurve-pr-reviewer`, ID `5012304`, installation `163290338`.

Current status: live in advisory mode for new non-draft PRs and revisions.

- OpenAI key verified for `gpt-6-astra`.
- Live standard-tier background structured-output request with high reasoning
  completed successfully. Input count matched actual usage: 37 input tokens,
  13 output tokens, approximately $0.00102 at standard rates.
- Both Worker bundles passed Wrangler dry-run compilation.
- TypeScript and 28 offline review safety tests passed.
- Core checks passed: Ruff, formatting, mypy, 1,720 pytest tests with 100% core
  coverage. Six optional rerun-sdk tests skipped because that extra is absent.
- Clean npm install succeeded; dependency audit reported zero vulnerabilities.
- Workers Paid enabled by the maintainer. Both Workers deployed successfully.
- Publisher version: `59b0c1ce-584e-4ba1-944b-56bdaf4eead9`.
- Reviewer version: `c44d5b76-caad-4c3f-bdae-14b95d1ec895`.
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

No further setup is required for advisory processing.
Turning the independent review check into a merge requirement is a separate
rollout decision. Implementation is tracked in PR #455; deployment is already live.
