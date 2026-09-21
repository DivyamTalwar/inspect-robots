import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { boundedText, current, digest, INSTALLATION_ID, JAY_ID, POLICY_VERSION, REPO, snapshot, validateReview, verifySignature, type Job } from './common';
import { ciGreen } from './github';
import { runReview } from './review';
import { holdReason } from './holds';
export { ReviewLedger } from './ledger';
export { ModelGateway } from './model-gateway';

export type WebhookEnvironment = Pick<ReviewerEnv, 'ENABLED' | 'GITHUB_WEBHOOK_SECRET'> & {
  LEDGER: Pick<ReviewerEnv['LEDGER'], 'getByName'>;
  PUBLISHER: Pick<ReviewerEnv['PUBLISHER'], 'read'>;
  REVIEW: Pick<ReviewerEnv['REVIEW'], 'create'>;
};
async function read(env: Pick<WebhookEnvironment, 'PUBLISHER'>, path: string): Promise<any> { return JSON.parse(await env.PUBLISHER.read(path)); }

async function enqueue(env: WebhookEnvironment, pr: number, scope = '', requestId = '') {
  const info = snapshot(await read(env, `/pulls/${pr}`));
  if (info.state !== 'open' || info.draft) return;
  const id = (await digest(`${pr}:${info.head}:${info.base}:${POLICY_VERSION}:${scope}:${requestId}`)).slice(0, 48);
  const ledger = env.LEDGER.getByName('budget');
  const registered = await ledger.register({ id, pr, head: info.head, base: info.base, scope });
  if (registered) await env.REVIEW.create({ id, params: { id } });
}

export async function handleWebhook(request: Request, env: WebhookEnvironment): Promise<Response> {
  const body = await boundedText(request, 1_000_000);
  if (!await verifySignature(body, request.headers.get('x-hub-signature-256'), env.GITHUB_WEBHOOK_SECRET)) return new Response('Unauthorized', { status: 401 });
  const event = request.headers.get('x-github-event');
  if (event === 'ping') return new Response('pong');
  if (env.ENABLED !== 'true') return new Response('Reviewer disabled', { status: 503 });
  const data = JSON.parse(body);
  if (data.repository?.full_name !== REPO || data.installation?.id !== INSTALLATION_ID) return new Response('Ignored', { status: 202 });
  if (event === 'pull_request' && ['opened', 'synchronize', 'reopened', 'ready_for_review', 'edited'].includes(data.action)) {
    if (!Number.isSafeInteger(data.number) || data.number < 1) return new Response('Invalid PR', { status: 400 });
    await enqueue(env, data.number);
  } else if (event === 'issue_comment' && data.action === 'created' && data.issue?.pull_request && data.comment?.user?.id === JAY_ID) {
    const command = /^\/review(?:\s+scope\s+([a-f0-9]{40})\s+([^\n]{1,2000}))?\s*$/.exec(data.comment.body);
    if (command) {
      const pr = snapshot(await read(env, `/pulls/${data.issue.number}`));
      if (!command[1] || command[1] === pr.head) await enqueue(env, pr.number, command[2] ? `jeqcho explicitly decided scope for ${pr.head}: ${command[2]}` : '', String(data.comment.id));
    }
  }
  return new Response('Accepted', { status: 202 });
}

export class ReviewWorkflow extends WorkflowEntrypoint<ReviewerEnv, { id: string; inspectOnly?: boolean }> {
  async run(event: WorkflowEvent<{ id: string; inspectOnly?: boolean }>, step: WorkflowStep) {
    const ledger = this.env.LEDGER.getByName('budget');
    const job: Job | null = JSON.parse(await step.do('load job', async () => JSON.stringify(await ledger.job(event.payload.id))));
    if (!job) throw new Error('unknown_job');
    // Cloudflare management API only; never accepted from a webhook or PR text.
    if (event.payload.inspectOnly === true) return ledger.costs(job.id);
    try {
      if (this.env.ENABLED !== 'true') throw new Error('reviewer_disabled');
      await step.do('start', async () => {
        await ledger.finish(job.id, 'running');
        if (!await this.env.PUBLISHER.publish(job, null, 'started')) throw new Error('stale_revision');
      });
      const result = await runReview(this.env, job, step);
      await step.do('save verdict', () => ledger.finish(job.id, result.verdict === 'APPROVE' ? 'approved' : 'publishing', JSON.stringify(result)));
      const published = await step.do('publish verdict', () => this.env.PUBLISHER.publish(job, result));
      if (!published) await step.do('mark stale', () => ledger.finish(job.id, 'stale'));
      else if (result.verdict !== 'APPROVE') await step.do('mark delivered', () => ledger.notified(job.id));
      if (await ledger.warningNeeded()) {
        if (await step.do('publish budget warning', () => this.env.PUBLISHER.publish(job, null, 'budget-warning'))) await step.do('record budget warning', () => ledger.warningSent());
      }
    } catch (error) {
      // Never log external response bodies, prompts, code, headers or credentials.
      console.error(JSON.stringify({ job: job.id, status: 'held', error: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'review_failed' }));
      const details = { ...holdReason(error), cost_summary: await ledger.costs(job.id) };
      await step.do('record held', () => ledger.finish(job.id, 'held', JSON.stringify(details)));
      await step.do('publish hold', () => this.env.PUBLISHER.publish(job, details, 'held'));
    }
  }
}

async function scheduled(env: ReviewerEnv) {
  if (env.ENABLED !== 'true') return;
  const ledger = env.LEDGER.getByName('budget');
  for (const job of await ledger.pending()) {
    try {
      const info = snapshot(await read(env, `/pulls/${job.pr}`));
      if (info.state !== 'open' || info.draft) { await ledger.finish(job.id, 'stale'); continue; }
      if (!current(job, info)) {
        await ledger.finish(job.id, 'stale');
        await enqueue(env, job.pr);
        continue;
      }
      if (job.status === 'approved' && job.result && await ciGreen(p => read(env, p), job.head)) {
        if (await env.PUBLISHER.publish(job, JSON.parse(job.result))) await ledger.notified(job.id);
      } else if (job.status === 'queued' || job.status === 'running') {
        let instance;
        try { instance = await env.REVIEW.get(job.id); await instance.status(); }
        catch { await env.REVIEW.create({ id: job.id, params: { id: job.id } }); continue; }
        const status = await instance.status();
        if (['errored', 'terminated', 'complete'].includes(status.status)) {
          const details = { code: 'codex_review_incomplete', cost_summary: await ledger.costs(job.id) };
          await ledger.finish(job.id, 'held', JSON.stringify(details));
          await env.PUBLISHER.publish(job, details, 'held');
        }
      }
    } catch { console.error(JSON.stringify({ job: job.id, status: 'reconcile_failed' })); }
  }
}

export default {
  async fetch(request: Request, env: ReviewerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ service: 'inspect-robots-reviewer', mode: env.MODE, enabled: env.ENABLED === 'true', policy: POLICY_VERSION });
    if (url.pathname !== '/webhook' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    try { return await handleWebhook(request, env); }
    catch { return new Response('Webhook processing failed; delivery may be retried', { status: 500 }); }
  },
  async scheduled(_controller: ScheduledController, env: ReviewerEnv): Promise<void> { await scheduled(env); },
} satisfies ExportedHandler<ReviewerEnv>;
