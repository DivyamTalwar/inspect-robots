import { zodTextFormat } from 'openai/helpers/zod';
import type { WorkflowStep } from 'cloudflare:workers';
import policy from './policy.md';
import { ReviewSchema, validateReview, type Job } from './common';
import { collectContext, readFile } from './context';

const noRetry = { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes' } as const;
export type ReviewEnvironment = Pick<ReviewerEnv, 'LEDGER' | 'PUBLISHER' | 'RUNNER'>;
export async function runReview(env: ReviewEnvironment, job: Job, step: Pick<WorkflowStep, 'do' | 'sleep'>) {
  const ledger = env.LEDGER.getByName('budget');
  const read = async (p: string): Promise<any> => JSON.parse(await env.PUBLISHER.read(p));
  const context = JSON.parse(await step.do('gather review discussion', noRetry, async () => JSON.stringify(await collectContext(read, job))));
  const raw = await step.do('run fresh Codex reviewer', { ...noRetry, timeout: '25 minutes' }, async () => {
    console.log(JSON.stringify({ event: 'review_allowance', job: job.id, remainingMicros: await ledger.remaining(`${job.pr}-${job.head}`, job.pr) }));
    // Do not spend on another fresh session with only debugging leftovers.
    if (await ledger.remaining(`${job.pr}-${job.head}`, job.pr) < 2_000_000) throw new Error('insufficient_run_budget');
    if (!await ledger.reserve(`${job.id}-sandbox`, `${job.pr}-${job.head}`, job.pr, 100_000)) throw new Error('budget_exhausted');
    const token = await ledger.openSession(job.id);
    try {
      const output = JSON.parse(await env.RUNNER.review(job.head, context.merge_base, JSON.stringify(context), policy, JSON.stringify(zodTextFormat(ReviewSchema, 'review').schema), token));
      const failure = await ledger.sessionFailure(token);
      if (failure) { output.failure = failure; output.exitCode = 1; output.review = null; }
      return JSON.stringify(output);
    } finally { await ledger.closeSession(token); }
  });
  const output = JSON.parse(raw);
  if (output.exitCode !== 0 || !output.review) throw new Error(['model_timeout', 'budget_exhausted', 'billing_hold', 'context_too_large'].includes(output.failure) ? output.failure : 'codex_review_incomplete');
  const result = validateReview(output.review);
  for (const blocker of result.blockers) {
    try { await readFile(read, job, blocker.file, 'head', blocker.line, 1); }
    catch { await readFile(read, { ...job, base: context.merge_base }, blocker.file, 'base', blocker.line, 1); }
  }
  return { ...result, execution_records: output.executions ?? [], cost_summary: await ledger.costs(job.id) };
}
