# Independent PR reviewer

Advisory review service for `robocurve/inspect-robots`, hosted in Robocurve's
Cloudflare account. It uses `gpt-6-astra` with high reasoning and a new context
for each run. Scope and usefulness are assessed before correctness. The deployed,
versioned [policy](src/policy.md) incorporates the maintainer's review guidance;
PR content cannot replace it.

## Decisions

| Verdict | Meaning | Next step |
| --- | --- | --- |
| APPROVE | Worthwhile, established scope, sufficient evidence, no blockers | Tag `@jeqcho` to merge after `ci-ok` is green on the reviewed head |
| REQUEST_CHANGES | Established scope with concrete implementation defects | Explain the trigger, expected/actual behavior, impact and fix |
| ESCALATE | Scope, necessity, competing proposals or missing evidence needs judgment | Tag `@jeqcho` with a precise decision; closure is only a recommendation |

Comments include the immutable head/base, verdict, worthwhile/scope decisions,
rationale, contract and test review, blockers, checks, limitations and next action.
They disclose automation and that the reviewer did not execute tests. Contributor
intent and personal characteristics are never grounds for a finding.

The bot does not merge, close, label, submit formal approving reviews, edit code,
approve Actions, or modify branch rules. Its named check is initially advisory.
Making this check required needs a separate maintainer decision.

## Architecture and credentials

The public Worker authenticates GitHub HMAC signatures, restricts repository and
installation IDs, deduplicates jobs in a SQLite Durable Object, then starts a
durable Workflow. The Workflow reads immutable source, tests, repo docs, linked
issues, maintainer decisions and open PRs, then runs bounded read-only model calls.

A separate publisher Worker has no public URL. It alone holds the GitHub App
private key. Its service binding exposes an allowlisted GET reader and a validated
comment/check publisher. Read calls use installation tokens reduced to read-only
permissions. No generic write endpoint, merge or close method exists. The model
only sees a `read_file` tool, never either credential or publisher methods.

GitHub cannot grant strictly comments-only PR permission. The App has
`pull_requests:write` and `checks:write`; the former technically permits closing
PRs. The publisher's code limits this broader permission to comments and checks.
`contents:read` prevents merges. Protect the private key and publisher deployment
access as privileged credentials.

No contributor code runs. Complete changed files at base/head are inspected;
binary files, missing patches, more than 60 files, incomplete pagination and
oversized contexts cause a hold. Supporting files are fetched only from those
two immutable commits. Findings are checked against inspected file locations.
Model judgments can still be wrong; Jay makes final decisions.

The job key includes both head and base. Every publication rechecks the live PR.
GitHub has no atomic compare-and-comment API: a push can race the final request,
so every comment names its exact revision and checks attach to that head only.

## Budget

| Limit | Amount |
| --- | --- |
| All model calls for one PR head, including reruns | $5 |
| All revisions/reruns of a PR, lifetime | $15 |
| All reviews per UTC calendar month | $200 |
| Monthly warning to Jay | $160 |

Reservations are atomic across the deployment and recorded before submission.
Input is counted using OpenAI's token-count endpoint, limited to 200,000 tokens,
and reserved at $13/M plus a small token margin. This conservatively covers the
published $10/M ordinary input and $12.50/M cache-write pricing. Output, including
reasoning, is reserved at $50/M. Each call allows at most 16,000 output tokens;
a review allows six calls. Actual usage settles at the conservative input rate,
so the ledger may reach its limit before the OpenAI bill does.

No inference submission retries automatically. Ambiguous failures retain the
full reservation, including across a process restart. Only retrieval/publication
retries. Unexpected usage exceeding a reservation freezes further inference.
Responses use the standard service tier; no paid provider tools are enabled.
Monthly assignment is the UTC month in which a call is reserved. Set a separate
$200 hard project limit in OpenAI as a second boundary, especially across month
boundaries or if another service uses that project. Pricing is pinned in code
and must be rechecked before changing the model. Cloudflare hosting is separate.

## Operations

New non-draft PRs and new revisions trigger review. Drafts and closed PRs are
ignored. There is no initial backlog scan. A ten-minute reconciliation schedule
recovers queued jobs and updates approved comments when CI turns green.

Only GitHub user ID `42904912` (`jeqcho`) can request these commands:

```text
/review
/review scope <full-current-head-sha> <scope decision and rationale>
```

A command creates a fresh run but shares the same head/PR/month budgets. A scope
decision is evidence of authorization, never proof of correctness. To increase
limits, release an uncertain reservation, or clear a billing hold, inspect usage
and logs first, then make an explicit operator change; the public endpoint cannot
change budgets. Repeated failed webhooks can be redelivered from GitHub App
settings. No model API key is needed in GitHub Actions.

```sh
npm ci
npm run types
npm run check
npm run deploy:publisher
npm run deploy:reviewer
node scripts/setup.mjs secrets
node scripts/setup.mjs webhook https://<reviewer>.workers.dev/webhook
```

The setup script reads the key file in `~/.config/robocurve-pr-reviewer/` and the
downloaded App key (override its path using `REVIEWER_PRIVATE_KEY_PATH`). It
generates a private webhook secret there and uploads credentials through Wrangler
stdin. It never prints values. Deploy initially with `ENABLED=false`, upload
secrets, enable App webhooks and subscribe to **Pull request** and **Issue comment**
in GitHub App settings, configure the URL/secret, then set `ENABLED=true` and
redeploy. Cloudflare account ID is explicit in both configs.

The configured CPU allowances require Workers Paid (currently a $5/month base
subscription); Free's 10 ms invocation limit is unsuitable for reliably parsing
large review contexts. See [Cloudflare pricing](https://developers.cloudflare.com/workers/platform/pricing/).

To pause new reviews, set `ENABLED=false` and redeploy. Terminate in-flight
Workflows too if immediate cessation is required. `/health` reports enabled state
and policy version without secrets. Logs contain opaque job IDs and safe error
categories; do not enable SDK request debugging. OpenAI background responses and
Cloudflare Workflow state retain review context; no cross-PR conversation is used.

Tests use the real local Workers/SQLite runtime with all network calls mocked.
They cover concurrent spending, replay, head changes, untrusted inputs, decision
consistency, publication boundaries and ambiguous model failures. CI runs them
without production credentials.

Hosting estimate: a few hundred reviews per month should fit the included
Workers, Workflows and SQLite allowances, so the expected incremental hosting
charge is $0 beyond the $5 base subscription. Allow $1-$2 headroom pending real
usage; this is an estimate, not a hard hosting cap. Quotas are shared across the
account. Workflows include 500,000 steps and 1 GB-month of state; API waiting and
step sleeps do not incur Workflow CPU time. See [Workflow pricing](https://developers.cloudflare.com/workflows/reference/pricing/)
and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
