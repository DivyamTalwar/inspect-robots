import { env } from 'cloudflare:workers';
import type { WorkflowStep } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { handleWebhook } from '../src/worker';
import { runReview } from '../src/review';
import type { Job } from '../src/common';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const job: Job = { id: 'run-1', pr: 9, head, base, scope: '', status: 'running', result: null, notified: 0, created: 1 };
const pr = { number: 9, head: { sha: head }, base: { sha: base }, state: 'open', draft: false, changed_files: 1, title: 'Fix boundary', body: '', user: { login: 'author' } };
function setup() {
  const ledger = env.LEDGER.getByName(crypto.randomUUID());
  const read = vi.fn(async (p: string) => {
    if (p === '/pulls/9') return JSON.stringify(pr);
    if (p.startsWith('/compare/')) return JSON.stringify({ merge_base_commit: { sha: base } });
    if (p.includes('/files?')) return JSON.stringify([{ filename: 'x.py', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }]);
    if (p.startsWith('/contents/')) return JSON.stringify({ type: 'file', encoding: 'base64', size: 4, content: btoa('new\n') });
    if (p.startsWith('/git/trees/')) return JSON.stringify({ truncated: false, tree: [] });
    return '[]';
  });
  const create = vi.fn<ReviewerEnv['REVIEW']['create']>();
  const config = { ENABLED: 'true', GITHUB_WEBHOOK_SECRET: 'test-hook', OPENAI_API_KEY: 'sk-test', LEDGER: { getByName: () => ledger }, PUBLISHER: { read }, RUNNER: { review: vi.fn(async () => JSON.stringify({ exitCode: 1 })) }, REVIEW: { create } };
  const steps: { name: string; options: any }[] = [];
  const step = { do: async (name: string, optionsOrFn: any, callback?: () => Promise<any>) => { steps.push({ name, options: callback ? optionsOrFn : {} }); return (callback ?? optionsOrFn)(); }, sleep: async () => {} } as Pick<WorkflowStep, 'do' | 'sleep'>;
  return { ledger, read, create, config, step, steps };
}
async function webhook(body: any, event: string) {
  const text = JSON.stringify(body);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-hook'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2, '0')).join('');
  return new Request('https://reviewer.test/webhook', { method: 'POST', body: text, headers: { 'x-github-event': event, 'x-hub-signature-256': 'sha256=' + signature } });
}
const repo = { repository: { full_name: 'robocurve/inspect-robots' }, installation: { id: 163290338 } };

describe('webhook dispatch', () => {
  it('rejects unsigned input before any GitHub read', async () => {
    const s = setup();
    const response = await handleWebhook(new Request('https://x/', { method: 'POST', body: '{}' }), s.config);
    expect(response.status).toBe(401); expect(s.read).not.toHaveBeenCalled();
  });
  it('ignores other repositories and installations and deduplicates delivery', async () => {
    const s = setup();
    const payload = { ...repo, action: 'opened', number: 9 };
    await handleWebhook(await webhook({ ...payload, installation: { id: 2 } }, 'pull_request'), s.config);
    expect(s.read).not.toHaveBeenCalled();
    await handleWebhook(await webhook(payload, 'pull_request'), s.config);
    await handleWebhook(await webhook(payload, 'pull_request'), s.config);
    expect(s.create).toHaveBeenCalledTimes(1);
  });
  it('allows only Jay to request reruns and rejects a scope decision for another head', async () => {
    const s = setup();
    const payload = { ...repo, action: 'created', issue: { number: 9, pull_request: {} }, comment: { id: 3, user: { id: 1 }, body: '/review' } };
    await handleWebhook(await webhook(payload, 'issue_comment'), s.config);
    expect(s.read).not.toHaveBeenCalled();
    payload.comment.user.id = 42904912;
    payload.comment.body = `/review scope ${base} Approved feature`;
    await handleWebhook(await webhook(payload, 'issue_comment'), s.config);
    expect(s.create).not.toHaveBeenCalled();
    payload.comment.body = `/review scope ${head} Approved feature`;
    await handleWebhook(await webhook(payload, 'issue_comment'), s.config);
    expect(s.create).toHaveBeenCalledTimes(1);
  });
});

describe('Codex review lifecycle', () => {
  it('runs a fresh CLI session with the policy and closes its scoped gateway access', async () => {
    const s = setup(); await s.ledger.register(job);
    let capability = '';
    const result = { worthwhile: 'YES', scope: 'ESTABLISHED', verdict: 'APPROVE', recommended_action: 'MERGE', rationale: 'Concrete boundary fix.', blockers: [], contract_and_test_review: 'Preserved.', checks: [], limitations: [], sufficient_review: true, decision_needed: '', body: 'Verified.' };
    s.config.RUNNER.review.mockImplementation(async (...args: any[]) => {
      capability = args[5];
      expect(await s.ledger.session(capability)).toMatchObject({ id: job.id });
      expect(args[0]).toBe(head); expect(args[1]).toBe(base);
      expect(args[3]).toContain('Authority and scope');
      return JSON.stringify({ exitCode: 0, review: result, executions: [] });
    });
    expect((await runReview(s.config as any, job, s.step)).verdict).toBe('APPROVE');
    expect(await s.ledger.session(capability)).toBeNull();
    expect(await s.ledger.remaining(`9-${head}`, 9)).toBe(4_900_000);
  });
  it('never accepts a partial verdict or retries a failed Codex session', async () => {
    const s = setup(); await s.ledger.register(job);
    await expect(runReview(s.config as any, job, s.step)).rejects.toThrow('codex_review_incomplete');
    expect(s.config.RUNNER.review).toHaveBeenCalledTimes(1);
    expect(s.steps.find(s => s.name === 'run fresh Codex reviewer')?.options.retries.limit).toBe(0);
  });
  it('preserves the trusted gateway stop even if CLI diagnostics omit its reason', async () => {
    const s = setup(); await s.ledger.register(job);
    s.config.RUNNER.review.mockImplementation(async (...args: any[]) => {
      await s.ledger.sessionFailure(args[5], 'budget_exhausted');
      return JSON.stringify({ exitCode: 1, failure: 'codex_review_incomplete' });
    });
    await expect(runReview(s.config as any, job, s.step)).rejects.toThrow('budget_exhausted');
  });
});
