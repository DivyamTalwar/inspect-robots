// Credential-free deployment probe; never emits a PR review or calls a model.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { getSandbox, Sandbox } from '@cloudflare/sandbox';
import runner from '../sandbox/codex_runner.py';
import boundaryCheck from '../sandbox/check_isolation.py';
import regression from '../sandbox/test_evidence.py';
export class IsolationSandbox extends Sandbox {
  enableInternet = false;
  async armDeadline() { await this.schedule(180, 'expireProbe'); }
  async expireProbe() { await this.destroy(); }
}
interface ProbeEnv { SANDBOX: DurableObjectNamespace<IsolationSandbox> }
export class IsolationProbe extends WorkflowEntrypoint<ProbeEnv> {
  async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
    return step.do('kernel boundary probe', { timeout: '3 minutes', retries: { limit: 0, delay: '1 second' } }, async () => {
      const box = getSandbox(this.env.SANDBOX, 'isolation-regression', { keepAlive: false, sleepAfter: '30s' });
      try {
        await box.armDeadline();
        for (const [path, expected] of [['/opt/codex-review.py', runner], ['/opt/check-isolation.py', boundaryCheck]]) {
          const actual = await box.readFile(path, { encoding: 'utf-8' });
          if (actual.content !== expected) {
            const hashes = await box.exec('sha256sum /opt/codex-review.py /opt/check-isolation.py');
            throw new Error('deployed_image_does_not_match_tested_sources: ' + hashes.stdout);
          }
        }
        await box.writeFile('/tmp/test_evidence.py', regression);
        const result = await box.exec('/opt/review-env/bin/python -I /tmp/test_evidence.py', { timeout: 120000 });
        if (!result.success) throw new Error(JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }));
        return { passed: true, stdout: result.stdout, stderr: result.stderr };

      } finally { await box.destroy(); }
    });
  }
}
export default { fetch() { return new Response('Not found', { status: 404 }); } };
