# Deployment record

Date: 2026-09-20. Repository: `robocurve/inspect-robots`.
Cloudflare account: `7f405baff0972dc740a02ee0f700d2c1` (Robocurve).
GitHub App: `robocurve-pr-reviewer`, ID `5012304`, installation `163290338`.

Current status: implementation tested; production activation pending.

- OpenAI key verified for `gpt-6-astra`.
- Live standard-tier background structured-output request with high reasoning
  completed successfully. Input count matched actual usage: 37 input tokens,
  13 output tokens, approximately $0.00102 at standard rates.
- Both Worker bundles passed Wrangler dry-run compilation.
- TypeScript and 23 offline review safety tests passed.
- Core checks passed: Ruff, formatting, mypy, 1,720 pytest tests with 100% core
  coverage. Six optional rerun-sdk tests skipped because that extra is absent.
- Clean npm install succeeded; dependency audit reported zero vulnerabilities.
- Cloudflare rejected deployment with API code `100328`: configured CPU limits
  require Workers Paid. Awaiting the account plan decision.
- GitHub App has the intended permission set, but webhook subscriptions are
  currently empty and its hook configuration endpoint returns 404 while inactive.
- No merge rules were changed. No existing PR backlog was reviewed.

After resolving hosting: deploy both Workers disabled, upload secrets using the
setup script, enable GitHub App webhooks, subscribe to Pull request and Issue
comment, configure the signed endpoint, test it, then enable advisory processing.
Record the resulting URLs and deployment versions here. Turning the review check
into a merge requirement is a separate rollout decision.
