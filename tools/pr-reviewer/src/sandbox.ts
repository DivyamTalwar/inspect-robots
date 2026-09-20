import { WorkerEntrypoint } from 'cloudflare:workers';
import { getSandbox, Sandbox, ContainerProxy } from '@cloudflare/sandbox';
import { Buffer } from 'node:buffer';
import { boundedText, SHA } from './common';
export { ContainerProxy };

export class ReviewSandbox extends Sandbox<RunnerEnv> {
  enableInternet = false;
  allowedHosts = ['review-model.local'];
  async armDeadline(): Promise<void> {
    await this.schedule(22 * 60, 'expireReview');
  }
  async expireReview(): Promise<void> { await this.destroy(); }
}
ReviewSandbox.outboundByHost = {
  'review-model.local': async (request, env) => {
    const match = /^\/([a-f0-9]{64})\/responses$/.exec(new URL(request.url).pathname);
    if (request.method !== 'POST' || !match) return new Response('Not allowed', { status: 403 });
    return env.MODEL.respond(match[1], await boundedText(request, 3_000_000));
  }
};

async function archive(sha: string): Promise<string> {
  const response = await fetch(new Request(`https://codeload.github.com/robocurve/inspect-robots/tar.gz/${sha}`, { redirect: 'manual', signal: AbortSignal.timeout(30000) }));
  if (!response.ok || !response.body) throw new Error('archive_unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > 10_000_000) { await reader.cancel(); throw new Error('archive_too_large'); }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks).toString('base64');
}
export class CodeRunner extends WorkerEntrypoint<RunnerEnv> {
  async review(head: string, base: string, context: string, policy: string, schema: string, token: string): Promise<string> {
    if (!SHA.test(head) || !SHA.test(base) || !/^[a-f0-9]{64}$/.test(token) || context.length > 2_000_000 || policy.length > 30000 || schema.length > 30000) throw new Error('invalid_review_request');
    const box = getSandbox(this.env.SANDBOX, crypto.randomUUID(), { sleepAfter: '30s', keepAlive: true, enableDefaultSession: false });
    try {
      await box.armDeadline();
      await box.writeFile('/tmp/head.tar.gz', await archive(head), { encoding: 'base64' });
      await box.writeFile('/tmp/base.tar.gz', await archive(base), { encoding: 'base64' });
      await box.writeFile('/tmp/request.json', JSON.stringify({ head, base, context, policy, schema, token }));
      const result = await box.exec('/opt/review-env/bin/python /opt/codex-review.py', { timeout: 21 * 60_000 });
      if (!result.success) {
        const markers = ['PermissionError', 'FileNotFoundError', 'ModuleNotFoundError', 'JSONDecodeError', 'not found', 'Operation not permitted', 'unsupported_archive_entry', 'archive_too_large'].filter(marker => result.stderr.includes(marker));
        console.error(JSON.stringify({ event: 'sandbox_launcher_failed', exitCode: result.exitCode, markers }));
        throw new Error('sandbox_execution_failed');
      }
      return result.stdout;
    } finally { await box.destroy(); }
  }
}
export default { fetch() { return new Response('Not found', { status: 404 }); } };
