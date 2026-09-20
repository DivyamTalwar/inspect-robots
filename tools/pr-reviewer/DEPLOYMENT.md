# Deployment record

Date: 2026-09-20. Repository: `robocurve/inspect-robots`.
Cloudflare account: `7f405baff0972dc740a02ee0f700d2c1` (Robocurve).
GitHub App: `robocurve-pr-reviewer`, ID `5012304`, installation `163290338`.

Current status: deployed with reviews disabled; GitHub webhook activation pending.

- OpenAI key verified for `gpt-6-astra`.
- Live standard-tier background structured-output request with high reasoning
  completed successfully. Input count matched actual usage: 37 input tokens,
  13 output tokens, approximately $0.00102 at standard rates.
- Both Worker bundles passed Wrangler dry-run compilation.
- TypeScript and 23 offline review safety tests passed.
- Core checks passed: Ruff, formatting, mypy, 1,720 pytest tests with 100% core
  coverage. Six optional rerun-sdk tests skipped because that extra is absent.
- Clean npm install succeeded; dependency audit reported zero vulnerabilities.
- Workers Paid enabled by the maintainer. Both Workers deployed successfully.
- Publisher version: `9e4077c4-3e27-4fd9-831f-912b15b2a3c1`.
- Reviewer version: `7fdd1b61-7ba0-4246-94e5-01f22af16832`.
- Receiver: https://inspect-robots-reviewer.jay-7f4.workers.dev/webhook
- Health endpoint reports advisory mode and `enabled: false`.
- GitHub private key, OpenAI key and generated HMAC secret uploaded securely.
- Production signed ping accepted (200); invalid signature rejected (401).
- CodeQL sanitizer alerts addressed by escaping each HTML delimiter; regression
  tests pass and the updated CodeQL check no longer reports a failure.
- GitHub App has the intended permission set, but webhook subscriptions are
  currently empty and its hook configuration endpoint returns 404 while inactive.
- No merge rules were changed. No existing PR backlog was reviewed.

Remaining setup: enable GitHub App webhooks and subscribe to Pull request and
Issue comment in its settings UI. Then run the setup script to configure the URL
and secret, verify GitHub delivery, and enable advisory processing. Turning the review check
into a merge requirement is a separate rollout decision.
