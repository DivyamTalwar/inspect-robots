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

Comments start with a one- or two-sentence TL;DR describing the change and the
reason for the verdict, followed immediately by the requested action. Detailed
findings, immutable head/base, contract review, tests and command records are
in an expandable section. Scope and value decisions requiring a human use
`NEED_REVIEWER`; escalation and merge requests still mention `@jeqcho`.
They disclose automation and record actual sandbox commands separately from CI. Contributor
intent and personal characteristics are never grounds for a finding.

The bot does not merge, close, label, submit formal approving reviews, edit code,
approve Actions, or modify branch rules. Its named check is initially advisory.
Making this check required needs a separate maintainer decision.

## Architecture and credentials

The public Worker authenticates GitHub HMAC signatures, restricts the repository
and installation, deduplicates jobs in a SQLite Durable Object and starts a Workflow.
The review engine is Codex CLI 0.155.1, running `gpt-6-astra` with high reasoning
in a new disposable Cloudflare Sandbox. It receives the versioned natural-language
review policy, immutable head and merge-base source snapshots, and PR/issue context.
Codex uses its own multi-turn file, search and shell tools to inspect local diffs
and run focused checks. We do not implement a separate model/tool loop or send
both complete versions of every changed file to the model. Large unchanged files
therefore do not trigger the former 100 KB per-file gate.

A private publisher Worker alone holds the GitHub App key. Its service binding
exposes bounded allowlisted reads and validated comments/check runs, with no merge,
close or arbitrary write method. Native `pull_requests:write` technically permits
closing, so protect the App key and publisher deployment. `contents:read` prevents
merges. The sandbox receives neither the App key nor a GitHub installation token.

A private model gateway outside the sandbox holds the OpenAI key and enforces
spending before each inference request. Codex receives only a short-lived capability
for its own review budget. Outbound networking is denied except for the internal
Responses proxy; arbitrary hosts, provider endpoints and paid provider tools are
not allowed. Exact duplicate submissions cannot double-charge an ambiguous request.
Streamed usage settles reservations, while missing usage retains them. The CLI's
own automatic request/stream retries are disabled.

The sandbox runs Codex and its commands as an unprivileged user. Scratch files
persist within that fresh session and are destroyed afterward. Python 3.11,
NumPy, pytest, hypothesis, pip, Hatch and rg are preinstalled. Offline local package
builds are allowed. Network dependency installs and hardware checks are unavailable.
Codex has a 20-minute deadline, with an independent container shutdown at 22 minutes.
Only one basic container can run at once. Provider credentials and GitHub publishing
remain outside this environment even though Codex can execute arbitrary review code.

Each sandbox session reserves $0.10 conservatively against the same spending caps.
That is a budget allowance, not a claim that Cloudflare charges ten cents. Its model
calls consume the remaining allowance. A partial/failed CLI result cannot approve;
complete output is validated against the review schema and cited file locations.
Comments include actual CLI command records separately from CI results. Model
judgments can still be wrong; Jay makes final decisions.

The job key includes both head and base. Every publication rechecks the live PR.
GitHub has no atomic compare-and-comment API: a push can race the final request,
so every comment names its exact revision and checks attach to that head only.

## Budget

| Limit | Amount |
| --- | --- |
| Model calls and sandbox allowances for one PR head, including reruns | $5 |
| All revisions/reruns of a PR, lifetime | $15 |
| All reviews per UTC calendar month | $200 |
| Monthly warning to Jay | $160 |

The maintainer authorized a $10 cap for trial PR #456 at head
`696fbaa9a00d7c345a81dd179fa10934f51ade89`. The deployment-only
`REVIEW_HEAD_LIMITS_JSON` setting records that exception in microdollars. It
applies only to that exact PR/head, preserves existing charges and cannot exceed
the $15 PR or $200 monthly ceilings. All other heads retain the $5 default.

Reservations are atomic across the deployment and recorded before submission.
Input is counted using OpenAI's token-count endpoint, limited to 200,000 tokens,
and reserved at $13/M plus a small token margin. This conservatively covers the
published $10/M ordinary input and $12.50/M cache-write pricing. Output, including
reasoning, is reserved at $50/M. Each call allows at most 16,000 output tokens;
Codex continues across turns within the total budget and session deadline.
Confirmed cache reads settle at the published $1/M rate; other input settles at
the conservative $13/M ceiling. Reservations never assume a future cache hit.
The gateway supplies the remaining budget each turn and requests a final answer
before further investigation becomes unaffordable. If material evidence is
missing, that answer must escalate. The ledger can still reach its limit before
the OpenAI bill does. See [Astra pricing](https://developers.openai.com/api/docs/models/gpt-6-astra).

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
npm run deploy:runner
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
redeploy. Cloudflare account ID is explicit in all three configs.

The configured CPU allowances require Workers Paid (currently a $5/month base
subscription); Free's 10 ms invocation limit is unsuitable for reliably parsing
large review contexts. See [Cloudflare pricing](https://developers.cloudflare.com/workers/platform/pricing/).

To pause new reviews, set `ENABLED=false` and redeploy. Terminate in-flight
Workflows too if immediate cessation is required. `/health` reports enabled state
and policy version without secrets. Logs contain opaque job IDs and safe error
categories; do not enable SDK request debugging. Cloudflare Workflow state retains review context; OpenAI requests use `store=false`
and `background=false`. No cross-PR conversation is used.

Tests use the real local Workers/SQLite runtime with all network calls mocked.
They cover concurrent spending, replay, head changes, untrusted inputs, decision
consistency, publication boundaries and ambiguous model failures. CI runs them
without production credentials.

Hosting estimate (before adding sandbox execution): a few hundred reviews per month should fit the included
Workers, Workflows and SQLite allowances, so the expected incremental hosting
charge is $0 beyond the $5 base subscription. Allow $1-$2 headroom pending real
usage; this is an estimate, not a hard hosting cap. Quotas are shared across the
account. Workflows include 500,000 steps and 1 GB-month of state; API waiting and
step sleeps do not incur Workflow CPU time. See [Workflow pricing](https://developers.cloudflare.com/workflows/reference/pricing/)
and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

Sandbox execution additionally uses Cloudflare Containers CPU, memory and disk. The runner scales to zero and permits one basic instance. Budget allowances bound requested executions conservatively, but the Cloudflare invoice is separate from OpenAI and its $5 base subscription. See [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/). Docker is needed to build/deploy the runner image.
