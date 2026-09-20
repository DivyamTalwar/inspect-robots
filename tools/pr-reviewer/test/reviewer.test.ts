import { env, createExecutionContext, evictDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { exportPKCS8, generateKeyPair } from 'jose';
import { current, publicText, renderReview, validateReview, verifySignature, type Job, type Review } from '../src/common';
import { allowedRead, ciGreen } from '../src/github';
import { collectContext, readFile, safePath } from '../src/context';
import { GithubPublisher } from '../src/publisher';
import { handleWebhook } from '../src/worker';
import type { ReviewLedger } from '../src/ledger';

declare module 'cloudflare:test' { interface ProvidedEnv { LEDGER: DurableObjectNamespace<ReviewLedger> } }
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const job: Job = { id: 'revision-1', pr: 9, head, base, scope: '', status: 'running', result: null, notified: 0, created: 1 };
const approval: Review = { worthwhile: 'YES', scope: 'ESTABLISHED', verdict: 'APPROVE', recommended_action: 'MERGE', rationale: 'Confirmed bug fix.', blockers: [], contract_and_test_review: 'Tests preserve contracts.', checks: ['Source and tests inspected'], limitations: [], sufficient_review: true, decision_needed: '', body: 'The fix preserves the documented behavior.' };
const pr = { number: 9, head: { sha: head }, base: { sha: base }, state: 'open', draft: false, changed_files: 1, user: { login: 'contributor' }, title: 'Fix error', body: '' };

describe('review gates', () => {
  it('rejects approvals with unapproved scope, missing evidence, or blockers', () => {
    expect(validateReview(approval).verdict).toBe('APPROVE');
    for (const change of [{ scope: 'NEEDS_JAY' }, { worthwhile: 'NO' }, { sufficient_review: false }, { recommended_action: 'CLOSE' }, { decision_needed: 'Choose API' }]) expect(() => validateReview({ ...approval, ...change })).toThrow();
  });
  it('requires a concrete decision for escalation and a blocker for changes', () => {
    expect(() => validateReview({ ...approval, verdict: 'ESCALATE', recommended_action: 'CLOSE' })).toThrow();
    expect(() => validateReview({ ...approval, verdict: 'REQUEST_CHANGES', recommended_action: 'REVISE' })).toThrow();
  });
  it('only asks Jay to merge when this revision has green CI', () => {
    expect(renderReview(job, approval, false)).not.toContain('@jeqcho');
    expect(renderReview(job, approval, true)).toContain('@jeqcho');
    expect(renderReview(job, { ...approval, verdict: 'ESCALATE', recommended_action: 'CLOSE', decision_needed: 'The existing plan excludes this dependency.' }, false)).toContain('@jeqcho, please decide whether to close');
  });
  it('neutralizes untrusted mentions, links and hidden markup', () => {
    const output = publicText('<!-- hidden --><img src=x> @jeqcho ![secret](https://bad.test/key) https://bad.test');
    expect(output).not.toMatch(/@jeqcho|https:|<img|<!--/);
    expect(output).toContain('&lt;!-- hidden --&gt;');
    // Removing a nested tag can reconstruct another tag. Escape every delimiter instead.
    expect(publicText('<scr<script>ipt>alert(1)</script><!<!-- -->-->&#60;img src=x>')).not.toMatch(/[<>]/);
  });
  it('rejects old heads, changed bases, drafts and closed PRs', () => {
    const s = { number: 9, head, base, title: '', body: '', draft: false, state: 'open', author: '' };
    expect(current(job, s)).toBe(true);
    for (const change of [{ head: base }, { base: head }, { draft: true }, { state: 'closed' }]) expect(current(job, { ...s, ...change })).toBe(false);
  });
  it('does not accept a spoofed ci-ok or a green status on another head', async () => {
    const check = { name: 'ci-ok', head_sha: head, app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success' };
    expect(await ciGreen(async () => ({ check_runs: [check] }), head)).toBe(true);
    expect(await ciGreen(async () => ({ check_runs: [{ ...check, app: { slug: 'other' } }] }), head)).toBe(false);
    expect(await ciGreen(async () => ({ check_runs: [{ ...check, head_sha: base }] }), head)).toBe(false);
  });
});

describe('budget ledger in the Workers runtime', () => {
  it('atomically limits concurrent reservations and disallows duplicate charges', async () => {
    const ledger = env.LEDGER.getByName(crypto.randomUUID());
    const accepted = await Promise.all(Array.from({ length: 10 }, (_, i) => ledger.reserve(`charge-${i}`, 'revision', 1, 1_000_000)));
    expect(accepted.filter(Boolean)).toHaveLength(5);
    expect(await ledger.remaining('revision', 1)).toBe(0);
    expect(await ledger.reserve('charge-0', 'revision', 1, 1)).toBe(false);
    await ledger.settle('charge-0', 100_000);
    await ledger.settle('charge-0', 0); // settlement is idempotent
    expect(await ledger.remaining('revision', 1)).toBe(900_000);
  });
  it('enforces the PR cap across revisions and the monthly cap across PRs', async () => {
    const ledger = env.LEDGER.getByName(crypto.randomUUID());
    for (let i = 0; i < 3; i++) expect(await ledger.reserve(`a-${i}`, `r-${i}`, 1, 5_000_000)).toBe(true);
    expect(await ledger.reserve('a-4', 'r-4', 1, 1)).toBe(false);
    for (let i = 0; i < 37; i++) expect(await ledger.reserve(`b-${i}`, `b-${i}`, i + 2, 5_000_000)).toBe(true);
    expect(await ledger.reserve('last', 'last', 100, 1)).toBe(false);
    expect(await ledger.warningNeeded()).toBe(true);
    await ledger.warningSent(); expect(await ledger.warningNeeded()).toBe(false);
  });
  it('keeps uncertain reservations and freezes inference on unexpected usage', async () => {
    const ledger = env.LEDGER.getByName(crypto.randomUUID());
    await ledger.reserve('ambiguous', 'r', 1, 5_000_000);
    expect(await ledger.remaining('r', 1)).toBe(0);
    expect(await ledger.settle('ambiguous', 5_000_001)).toBe(false);
    expect(await ledger.billingHold()).toBe(true);
  });
  it('deduplicates webhook jobs', async () => {
    const ledger = env.LEDGER.getByName(crypto.randomUUID());
    expect(await ledger.register(job)).toBe(true);
    expect(await ledger.register(job)).toBe(false);
    expect((await ledger.pending()).length).toBe(1);
  });
  it('preserves reservations after eviction and resets only the monthly allowance', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T23:00:00Z'));
    const ledger = env.LEDGER.getByName(crypto.randomUUID());
    for (let i = 0; i < 40; i++) expect(await ledger.reserve(`c-${i}`, `r-${i}`, i + 1, 5_000_000)).toBe(true);
    await evictDurableObject(ledger);
    expect(await ledger.remaining('new', 100)).toBe(0);
    vi.setSystemTime(new Date('2026-10-01T01:00:00Z'));
    expect(await ledger.remaining('new', 100)).toBe(5_000_000);
    expect(await ledger.remaining('r-0', 1)).toBe(0);
  });
});

describe('untrusted input and complete context', () => {
  it('authenticates the original webhook body and rejects mutations', async () => {
    const body = '{"action":"opened"}', secret = 'test-secret';
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = 'sha256=' + [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(x => x.toString(16).padStart(2, '0')).join('');
    expect(await verifySignature(body, sig, secret)).toBe(true);
    expect(await verifySignature(body + ' ', sig, secret)).toBe(false);
    expect(await verifySignature(body, null, secret)).toBe(false);
  });
  it('has no general GitHub URL or mutation tool', () => {
    for (const p of ['/pulls/9', '/contents/src/main.py?ref=' + head, '/issues/9/comments']) expect(allowedRead(p)).toBe(true);
    for (const p of ['/pulls/9/merge', '/issues/comments/1', '/../../other', 'https://bad.test/', '/actions/runs/1/approve', '/contents/../secrets']) expect(allowedRead(p)).toBe(false);
    expect(safePath('../.env')).toBe(false);
  });
  it('holds missing patches, excess files, and incomplete file lists', async () => {
    await expect(collectContext(async () => ({ ...pr, changed_files: 61 }), job)).rejects.toThrow('review_too_large');
    await expect(collectContext(async p => p.includes('/files?') ? [] : pr, job)).rejects.toThrow('incomplete_diff');
    await expect(collectContext(async p => p.includes('/files?') ? [{ filename: 'image.png' }] : pr, job)).rejects.toThrow('uninspectable_diff');
  });
  it('rejects binary data and unsupported file paths before inference', async () => {
    await expect(readFile(async () => ({ type: 'file', encoding: 'base64', size: 1, content: btoa('\0') }), job, 'x', 'head')).rejects.toThrow('binary_file');
    await expect(readFile(async () => ({}), job, '../x', 'head')).rejects.toThrow('invalid_file_path');
  });
});

describe('publisher authority', () => {
  it('only writes check runs and a courteous comment, and stops for a stale head', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const publisher = new GithubPublisher(createExecutionContext(), { GITHUB_PRIVATE_KEY: await exportPKCS8(privateKey), GITHUB_APP_ID: '5012304', GITHUB_INSTALLATION_ID: '163290338' });
    const writes: { path: string; method: string; body: any }[] = [];
    let live = pr;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/access_tokens')) return Response.json({ token: 'test-installation-token' });
      if (init.method !== 'GET') { writes.push({ path, method: init.method!, body: JSON.parse(init.body as string) }); return Response.json({ id: 123 }); }
      if (path.endsWith('/pulls/9')) return Response.json(live);
      if (path.endsWith('/check-runs')) return Response.json({ check_runs: [{ name: 'ci-ok', app: { slug: 'github-actions' }, head_sha: head, status: 'completed', conclusion: 'success' }] });
      if (path.endsWith('/comments')) return Response.json([]);
      throw new Error('unexpected endpoint');
    }));
    expect(await publisher.publish(job, approval)).toBe(true);
    expect(writes.map(w => w.path)).toEqual(['/repos/robocurve/inspect-robots/check-runs', '/repos/robocurve/inspect-robots/issues/9/comments']);
    expect(writes[1].body.body).toContain('@jeqcho');
    live = { ...pr, head: { sha: base } };
    expect(await publisher.publish(job, approval)).toBe(false);
    expect(writes).toHaveLength(2);
  });
});
