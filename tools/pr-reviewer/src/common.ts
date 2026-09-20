import { z } from 'zod';

export const REPO = 'robocurve/inspect-robots';
export const APP_ID = 5012304;
export const INSTALLATION_ID = 163290338;
export const JAY_ID = 42904912;
export const CHECK_NAME = 'Independent PR review';
export const MODEL = 'gpt-6-astra';
export const SHA = /^[a-f0-9]{40}$/;
export const LIMITS = { review: 5_000_000, pr: 15_000_000, month: 200_000_000, warn: 160_000_000 };
export const POLICY_VERSION = '1';

export const ReviewSchema = z.object({
  worthwhile: z.enum(['YES', 'NO', 'NEEDS_JAY']),
  scope: z.enum(['ESTABLISHED', 'NEEDS_JAY']),
  verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'ESCALATE']),
  recommended_action: z.enum(['MERGE', 'REVISE', 'CLOSE', 'NEEDS_DECISION']),
  rationale: z.string(),
  blockers: z.array(z.object({ file: z.string(), line: z.number().int(), trigger: z.string(), expected: z.string(), actual: z.string(), impact: z.string(), fix: z.string() })),
  contract_and_test_review: z.string(),
  checks: z.array(z.string()),
  limitations: z.array(z.string()),
  sufficient_review: z.boolean(),
  decision_needed: z.string(),
  body: z.string(),
});
export type Review = z.infer<typeof ReviewSchema>;
export const ExecutionRecords = z.array(z.object({ revision: z.string().regex(/^[a-f0-9]{40}$/), command: z.string().max(12000), exitCode: z.number().int().nullable(), limit: z.string().nullable() })).max(100);
export type Snapshot = { number: number; head: string; base: string; title: string; body: string; draft: boolean; state: string; author: string };
export type Job = { id: string; pr: number; head: string; base: string; scope: string; status: string; result: string | null; notified: number; created: number };

export function validateReview(value: unknown): Review {
  const r = ReviewSchema.parse(value);
  if (JSON.stringify(r).length > 24000 || !r.body.trim() || !r.rationale.trim()) throw new Error('invalid_review');
  if (r.verdict === 'APPROVE' && (r.worthwhile !== 'YES' || r.scope !== 'ESTABLISHED' || !r.sufficient_review || r.blockers.length || r.recommended_action !== 'MERGE' || r.decision_needed.trim())) throw new Error('inconsistent_approval');
  if (r.verdict === 'REQUEST_CHANGES' && (!r.blockers.length || r.recommended_action !== 'REVISE' || r.scope !== 'ESTABLISHED' || r.worthwhile !== 'YES' || !r.sufficient_review)) throw new Error('inconsistent_changes');
  if (r.verdict === 'ESCALATE' && (!r.decision_needed.trim() || !['CLOSE', 'NEEDS_DECISION'].includes(r.recommended_action))) throw new Error('inconsistent_escalation');
  for (const b of r.blockers) if (b.line < 1 || !b.file || !b.trigger || !b.expected || !b.actual || !b.fix) throw new Error('unsupported_blocker');
  return r;
}

export function snapshot(pr: Record<string, any>): Snapshot {
  const result = { number: pr.number, head: pr.head?.sha, base: pr.base?.sha, title: pr.title ?? '', body: pr.body ?? '', draft: !!pr.draft, state: pr.state, author: pr.user?.login ?? '' };
  if (!Number.isSafeInteger(result.number) || result.number < 1 || !SHA.test(result.head) || !SHA.test(result.base)) throw new Error('invalid_snapshot');
  return result;
}

export function current(a: Pick<Snapshot, 'head' | 'base'>, b: Snapshot): boolean {
  return b.state === 'open' && !b.draft && a.head === b.head && a.base === b.base;
}

export async function digest(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), x => x.toString(16).padStart(2, '0')).join('');
}

export async function verifySignature(body: string, signature: string | null, secret: string): Promise<boolean> {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, x => parseInt(x, 16));
  return crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(body));
}

export async function boundedText(response: Response | Request, limit = 2_000_000): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error('payload_too_large'); }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(all);
}

// Untrusted prose cannot inject mentions, hidden markup or remote media into a bot comment.
export function publicText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '[link omitted]')
    .replace(/@/g, '@\u200b').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202a-\u202e\u2066-\u2069]/g, '').replace(/—/g, ',');
}

export function renderReview(job: Job, review: Review, ciGreen: boolean, executions: z.infer<typeof ExecutionRecords> = []): string {
  let body = `Automated independent review of commit \`${job.head}\` (base \`${job.base}\`).\n\nVerdict: ${review.verdict}\nWorthwhile: ${review.worthwhile}\nScope: ${review.scope}\nRecommendation: ${review.recommended_action}\n\n${publicText(review.rationale)}\n\n${publicText(review.body)}\n\nContracts and tests: ${publicText(review.contract_and_test_review)}`;
  for (const b of review.blockers) body += `\n\n${publicText(b.file)}:${b.line}: ${publicText(b.trigger)}\nExpected: ${publicText(b.expected)}\nObserved from code: ${publicText(b.actual)}\nImpact: ${publicText(b.impact)}\nSuggested fix: ${publicText(b.fix)}`;
  body += `\n\nChecks: ${publicText(review.checks.join('; '))}\n${executions.length ? 'Sandbox execution records (CI is checked separately):' : 'No sandbox commands were executed; CI is checked separately.'}`;
  for (const execution of executions.slice(0, 10)) body += `\n- Revision ${execution.revision.slice(0, 12)}, exit ${execution.exitCode ?? 'unknown'}${execution.limit ? `, ${publicText(execution.limit)}` : ''}: ${publicText(execution.command.slice(0, 500)).replace(/\n/g, ' ')}`;
  if (review.limitations.length) body += `\nLimitations: ${publicText(review.limitations.join('; '))}`;
  if (review.verdict === 'APPROVE') body += ciGreen ? '\n\n@jeqcho, review approved and ci-ok is green for this revision. Please review and merge if you agree.' : '\n\nReview approved. Waiting for ci-ok before requesting a merge.';
  else if (review.verdict === 'ESCALATE') body += `\n\n@jeqcho, ${review.recommended_action === 'CLOSE' ? 'please decide whether to close this PR. ' : 'your decision is needed. '}${publicText(review.decision_needed)}`;
  return body;
}
