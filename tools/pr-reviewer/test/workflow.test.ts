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
    if (p.includes('/files?')) return JSON.stringify([{ filename: 'x.py', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }]);
    if (p.startsWith('/contents/')) return JSON.stringify({ type: 'file', encoding: 'base64', size: 4, content: btoa('new\n') });
    if (p.startsWith('/git/trees/')) return JSON.stringify({ truncated: false, tree: [] });
    return '[]';
  });
  const create = vi.fn<ReviewerEnv['REVIEW']['create']>();
  const config = { ENABLED: 'true', GITHUB_WEBHOOK_SECRET: 'test-hook', OPENAI_API_KEY: 'sk-test', LEDGER: { getByName: () => ledger }, PUBLISHER: { read }, REVIEW: { create } };
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

describe('bounded model workflow', () => {
  it('completes a structured review using high reasoning and bounded output', async () => {
    const s = setup(); const requests: any[] = [];
    const result = { worthwhile: 'YES', scope: 'ESTABLISHED', verdict: 'APPROVE', recommended_action: 'MERGE', rationale: 'A concrete boundary fix.', blockers: [], contract_and_test_review: 'Invariants preserved.', checks: ['Full source inspected'], limitations: [], sufficient_review: true, decision_needed: '', body: 'The boundary is handled correctly.' };
    vi.stubGlobal('fetch', vi.fn(async (url: string | Request, init?: RequestInit) => {
      const request = new Request(url, init);
      if (request.url.endsWith('/input_tokens')) return Response.json({ input_tokens: 100 });
      if (request.method === 'POST') { requests.push(await request.json()); return Response.json({ id: 'resp_test' }); }
      return Response.json({ id: 'resp_test', status: 'completed', usage: { input_tokens: 100, output_tokens: 300 }, output: [{ id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(result), annotations: [] }] }] });
    }));
    expect((await runReview(s.config, job, s.step)).verdict).toBe('APPROVE');
    expect(requests[0]).toMatchObject({ model: 'gpt-6-astra', reasoning: { effort: 'high' }, service_tier: 'default', background: true, max_output_tokens: 16000 });
    expect(requests[0].tools.map((t: any) => t.name)).toEqual(['read_file']);
    expect(await s.ledger.remaining(`9-${head}`, 9)).toBe(5_000_000 - 16_300);
  });
  it('retains the reservation and never retries an ambiguous create call', async () => {
    const s = setup(); let creates = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | Request, init?: RequestInit) => {
      const request = new Request(url, init);
      if (request.url.endsWith('/input_tokens')) return Response.json({ input_tokens: 100 });
      creates++; throw new Error('Connection lost after request submission');
    }));
    await expect(runReview(s.config, job, s.step)).rejects.toThrow();
    expect(creates).toBe(1);
    expect(await s.ledger.remaining(`9-${head}`, 9)).toBeLessThan(5_000_000);
    expect(s.steps.find(s => s.name === 'reserve and submit 0')?.options.retries.limit).toBe(0);
  });
  it('does not call the model when the revision budget is exhausted', async () => {
    const s = setup();
    await s.ledger.reserve('prior-run', `9-${head}`, 9, 5_000_000);
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | Request, init?: RequestInit) => {
      const request = new Request(url, init); calls.push(request.url); return Response.json({ input_tokens: 100 }); }));
    await expect(runReview(s.config, job, s.step)).rejects.toThrow('budget_exhausted');
    expect(calls).toHaveLength(1); expect(calls[0]).toContain('/input_tokens');
  });
  it('settles known usage but never approves an incomplete response', async () => {
    const s = setup();
    vi.stubGlobal('fetch', vi.fn(async (url: string | Request, init?: RequestInit) => {
      const request = new Request(url, init);
      if (request.url.endsWith('/input_tokens')) return Response.json({ input_tokens: 100 });
      if (request.method === 'POST') return Response.json({ id: 'resp_test' });
      return Response.json({ id: 'resp_test', status: 'incomplete', usage: { input_tokens: 100, output_tokens: 10 }, output: [] });
    }));
    await expect(runReview(s.config, job, s.step)).rejects.toThrow('incomplete_model_response');
    expect(await s.ledger.remaining(`9-${head}`, 9)).toBe(5_000_000 - 1800);
  });
});
