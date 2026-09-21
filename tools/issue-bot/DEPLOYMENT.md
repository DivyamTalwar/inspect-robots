# Issue bot rollout evidence

Rollout date: 2026-09-21. Repository base:
`4d35fe4b81a643c0e61e8d287810b3c26f9d386a`.

## Installation and authority

Separate GitHub App `robocurve-issue-bot`, App ID `5017788`, installation
`163417136`. Setup verified a selected-repository installation containing only
`robocurve/inspect-robots`, with Contents write, Issues write, Pull requests write,
Checks read and implicit Metadata read. Private credentials remain ignored.

GitHub ruleset `23732858` restricts default-branch updates with bypass only for
human team `19612023`, through pull requests. Neither bot App is a bypass actor.
Ruleset `18603265` separately requires the up-to-date `ci-ok` check. The publisher
has no merge or issue-closure operation. Preserve these rulesets: Contents write
alone is not a technical prohibition on merging.

## Disabled deployment

Cloudflare account: `7f405baff0972dc740a02ee0f700d2c1`.

| Service | Initial version | Exposure |
| --- | --- | --- |
| `robocurve-issue-publisher` | `32c43b9b-c4e3-4e8f-8970-39ba5702a450` | Private service binding |
| `robocurve-issue-runner` | `6b6ab2d9-4561-4290-9864-ae773b8eebd0` | Private service binding; one container maximum |
| `robocurve-issue-bot` | `a8c18df5-673d-49df-bd17-ea6dffe93fbc` | Signed webhook and public health check; processing disabled |

Endpoint: `https://robocurve-issue-bot.jay-7f4.workers.dev`.
Live health returned `{"ok":true,"enabled":false}`; an unsigned webhook returned
HTTP 401. The management-only `initial-state-check` workflow completed without
model calls or public writes.

The runner uses an authenticated fixed-purpose Python supervisor, with no generic
Sandbox management server. Initial deployed image digest:
`sha256:973e57469240c92a13fb7fde09fcb0aecfe803b501c2660ac70b7815fe23a935`.

The reviewed command-normalization correction was then deployed, still disabled:
coordinator `44f70a65-7dd3-4f4f-ba6a-c65819718bcc`, runner
`4752dab9-189d-49be-a809-33a09a339abe`, image digest
`sha256:ac63911a71227f681afd8ca1d1d0ed48328075d788a9f83389f97df0ac277819`.

## Verification and outstanding rollout

Core regression suite: 1,720 passed, six optional rerun-sdk skips, 100% coverage.
Core Ruff and mypy passed. Bot TypeScript and all 49 Worker tests passed. All 24
Python tests passed in the Linux container with external networking disabled,
including the real native Codex fixture using synthetic responses. The fixture
verified that native command records normalize to the original shell script.
Python Ruff checks passed. The final independent functional reviewer approved
after the command-evidence normalization correction.

Credential upload is pending explicit approval for the named Cloudflare secret
destinations following automatic approval review. Intake remains disabled.
No paid model trial or live ready-for-review handoff has run yet.

Selected trial issue: [#401](https://github.com/robocurve/inspect-robots/issues/401),
authored by `jeqcho`. Existing open fixes mean a duplicate assessment is a valid
outcome. Do not manufacture a competing PR to demonstrate the fix path. Record
the actual review, spend and limitations after the trial; offline workflow tests
do not establish that the separate live PR reviewer received a ready event.

Approved limits: $20 per issue lifetime and $200 per UTC month, including the
trial, all model stages and conservative container allowances.
