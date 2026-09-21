import { DurableObject } from 'cloudflare:workers';
import { LIMITS, RunOutput, SHA, type Execution, type Job } from './common';

export class ReviewLedger extends DurableObject<ReviewerEnv> {
  private reviewLimit(job: string, pr: number): number {
    // Deployment-controlled exceptions only; webhooks and model tools cannot
    // alter budgets. Every exception still shares the PR and monthly limits.
    const overrides = JSON.parse(this.env.REVIEW_HEAD_LIMITS_JSON ?? '{}');
    if (!overrides || Array.isArray(overrides) || typeof overrides !== 'object') throw new Error('invalid_budget_config');
    for (const [key, value] of Object.entries(overrides)) {
      if (!/^[1-9][0-9]*-[a-f0-9]{40}$/.test(key) || !Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > LIMITS.pr) throw new Error('invalid_budget_config');
    }
    return job.startsWith(`${pr}-`) ? overrides[job] ?? LIMITS.review : LIMITS.review;
  }
  constructor(ctx: DurableObjectState, env: ReviewerEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, pr INTEGER NOT NULL, head TEXT NOT NULL, base TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', result TEXT, notified INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS charges (id TEXT PRIMARY KEY, job TEXT NOT NULL, pr INTEGER NOT NULL, month TEXT NOT NULL, amount INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS executions (job TEXT PRIMARY KEY, token TEXT NOT NULL, sandbox TEXT NOT NULL, started INTEGER NOT NULL, mergeBase TEXT NOT NULL, checkpointToken TEXT, output TEXT)`);
    if (!ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(executions)').toArray().some(c => c.name === 'checkpointToken')) ctx.storage.sql.exec('ALTER TABLE executions ADD COLUMN checkpointToken TEXT');
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }
  async register(job: Omit<Job, 'status' | 'result' | 'notified' | 'created'>): Promise<boolean> {
    const old = this.ctx.storage.sql.exec('SELECT id FROM jobs WHERE id=?', job.id).toArray();
    if (old.length) return false;
    this.ctx.storage.sql.exec('INSERT INTO jobs(id,pr,head,base,scope,created) VALUES(?,?,?,?,?,?)', job.id, job.pr, job.head, job.base, job.scope, Date.now());
    return true;
  }
  async job(id: string): Promise<Job | null> {
    return this.ctx.storage.sql.exec<Job>('SELECT * FROM jobs WHERE id=?', id).toArray()[0] ?? null;
  }
  async pending(): Promise<Job[]> {
    return this.ctx.storage.sql.exec<Job>("SELECT * FROM jobs WHERE status IN ('queued','running','approved','recovering','publishing') ORDER BY created LIMIT 100").toArray();
  }
  async finish(id: string, status: string, result: string | null = null): Promise<void> {
    this.ctx.storage.sql.exec('UPDATE jobs SET status=?,result=? WHERE id=?', status, result, id);
  }
  async workflowInstance(id: string, instance?: string): Promise<string> {
    if (instance !== undefined) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(instance)) throw new Error('invalid_workflow_instance');
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)', `workflow-${id}`, instance);
    }
    return this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM settings WHERE key=?', `workflow-${id}`).toArray()[0]?.value ?? id;
  }
  async notified(id: string): Promise<void> {
    this.ctx.storage.sql.exec('UPDATE jobs SET notified=1,status=? WHERE id=?', 'done', id);
  }
  async remaining(job: string, pr: number): Promise<number> {
    const month = new Date().toISOString().slice(0, 7);
    const sums = this.ctx.storage.sql.exec<{ review: number; pr: number; month: number }>(`SELECT COALESCE(SUM(CASE WHEN job=? THEN amount ELSE 0 END),0) AS review, COALESCE(SUM(CASE WHEN pr=? THEN amount ELSE 0 END),0) AS pr, COALESCE(SUM(CASE WHEN month=? THEN amount ELSE 0 END),0) AS month FROM charges`, job, pr, month).one();
    return Math.max(0, Math.min(this.reviewLimit(job, pr) - sums.review, LIMITS.pr - sums.pr, LIMITS.month - sums.month));
  }
  async costs(id: string) {
    const job = await this.job(id);
    if (!job) throw new Error('unknown_job');
    // Existing charge IDs already contain the run ID; no reset or lossy migration.
    const rows = this.ctx.storage.sql.exec<{ id: string; amount: number; settled: number }>(
      'SELECT id,amount,settled FROM charges WHERE substr(id,1,?)=?', id.length + 1, `${id}-`).toArray();
    const sandbox = rows.filter(r => r.id === `${id}-sandbox`);
    const model = rows.filter(r => r.id.startsWith(`${id}-codex-`));
    const sum = (entries: typeof rows) => entries.reduce((n, r) => n + r.amount, 0);
    const headSpent = this.ctx.storage.sql.exec<{ amount: number }>('SELECT COALESCE(SUM(amount),0) AS amount FROM charges WHERE job=?', `${job.pr}-${job.head}`).one().amount;
    return { modelMicros: sum(model.filter(r => r.settled)), reservedMicros: sum(model.filter(r => !r.settled)),
      sandboxMicros: sum(sandbox), modelCalls: model.length, headSpentMicros: headSpent,
      headLimitMicros: this.reviewLimit(`${job.pr}-${job.head}`, job.pr), remainingMicros: await this.remaining(`${job.pr}-${job.head}`, job.pr) };
  }
  async reserve(id: string, job: string, pr: number, amount: number): Promise<boolean> {
    return this.reserveNow(id, job, pr, amount);
  }
  private reserveNow(id: string, job: string, pr: number, amount: number): boolean {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('invalid_amount');
    // All SQL is synchronous; the transaction cannot interleave with another reservation.
    return this.ctx.storage.transactionSync(() => {
      if (this.ctx.storage.sql.exec("SELECT value FROM settings WHERE key='billing_hold'").toArray().length) return false;
      if (this.ctx.storage.sql.exec('SELECT id FROM charges WHERE id=?', id).toArray().length) return false;
      const month = new Date().toISOString().slice(0, 7);
      const sums = this.ctx.storage.sql.exec<{ review: number; pr: number; month: number }>(`SELECT COALESCE(SUM(CASE WHEN job=? THEN amount ELSE 0 END),0) AS review, COALESCE(SUM(CASE WHEN pr=? THEN amount ELSE 0 END),0) AS pr, COALESCE(SUM(CASE WHEN month=? THEN amount ELSE 0 END),0) AS month FROM charges`, job, pr, month).one();
      if (sums.review + amount > this.reviewLimit(job, pr) || sums.pr + amount > LIMITS.pr || sums.month + amount > LIMITS.month) return false;
      this.ctx.storage.sql.exec('INSERT INTO charges(id,job,pr,month,amount) VALUES(?,?,?,?,?)', id, job, pr, month, amount);
      return true;
    });
  }
  async execution(id: string): Promise<Execution | null> {
    return this.ctx.storage.sql.exec<Execution>('SELECT token,checkpointToken,sandbox,started,mergeBase FROM executions WHERE job=?', id).toArray()[0] ?? null;
  }
  async prepareExecution(id: string, mergeBase: string): Promise<Execution> {
    const existing = await this.execution(id);
    if (existing) return existing;
    const job = await this.job(id);
    if (!job || !SHA.test(mergeBase)) throw new Error('invalid_review_request');
    if (await this.remaining(`${job.pr}-${job.head}`, job.pr) < 2_000_000) throw new Error('insufficient_run_budget');
    // Recheck after awaits; commit the charge, session and durable handle together.
    return this.ctx.storage.transactionSync(() => {
      const prior = this.ctx.storage.sql.exec<Execution>('SELECT token,checkpointToken,sandbox,started,mergeBase FROM executions WHERE job=?', id).toArray()[0];
      if (prior) return prior;
      if (!this.reserveNow(`${id}-sandbox`, `${job.pr}-${job.head}`, job.pr, 100_000)) throw new Error('budget_exhausted');
      const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
      const checkpointToken = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
      const execution = { token, checkpointToken, sandbox: crypto.randomUUID(), started: Date.now(), mergeBase };
      this.ctx.storage.sql.exec('INSERT INTO executions(job,token,sandbox,started,mergeBase,checkpointToken) VALUES(?,?,?,?,?,?)', id, token, execution.sandbox, execution.started, mergeBase, checkpointToken);
      this.ctx.storage.sql.exec('INSERT INTO settings(key,value) VALUES(?,?)', `session-${token}`, JSON.stringify({ jobId: id, expires: execution.started + 25 * 60_000 }));
      return execution;
    });
  }
  async runOutput(id: string): Promise<string | null> {
    return this.ctx.storage.sql.exec<{ output: string | null }>('SELECT output FROM executions WHERE job=?', id).toArray()[0]?.output ?? null;
  }
  async deliverCheckpoint(receipt: string, raw: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(receipt)) throw new Error('invalid_checkpoint_receipt');
    const row = this.ctx.storage.sql.exec<{ token: string }>('SELECT token FROM executions WHERE checkpointToken=?', receipt).toArray()[0];
    if (!row) throw new Error('invalid_checkpoint_receipt');
    await this.checkpoint(row.token, raw);
  }
  async checkpoint(token: string, raw: string): Promise<void> {
    const job = await this.session(token);
    if (!job) throw new Error('invalid_review_session');
    if (new TextEncoder().encode(raw).byteLength > 1_500_000) throw new Error('review_output_too_large');
    const output = RunOutput.parse(JSON.parse(raw));
    const failure = await this.sessionFailure(token);
    if (failure) { output.failure = failure; output.exitCode = 1; output.review = null; }
    const body = JSON.stringify(output);
    this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ token: string; output: string | null }>('SELECT token,output FROM executions WHERE job=?', job.id).toArray()[0];
      if (!row || row.token !== token) throw new Error('invalid_review_session');
      if (row.output !== null && row.output !== body) throw new Error('conflicting_review_output');
      this.ctx.storage.sql.exec('UPDATE executions SET output=? WHERE job=?', body, job.id);
    });
  }
  async settle(id: string, amount: number): Promise<boolean> {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('invalid_amount');
    const row = this.ctx.storage.sql.exec<{ amount: number; settled: number }>('SELECT amount,settled FROM charges WHERE id=?', id).one();
    if (row.settled) return true;
    // Unexpected pricing/usage never frees a reservation; disable further inference.
    if (amount > row.amount) {
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO settings VALUES('billing_hold','true')");
      return false;
    }
    this.ctx.storage.sql.exec('UPDATE charges SET amount=?,settled=1 WHERE id=?', amount, id);
    return true;
  }
  async billingHold(): Promise<boolean> {
    return this.ctx.storage.sql.exec("SELECT value FROM settings WHERE key='billing_hold'").toArray().length > 0;
  }
  async openSession(jobId: string): Promise<string> {
    if (!await this.job(jobId)) throw new Error('unknown_job');
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    this.ctx.storage.sql.exec('INSERT INTO settings(key,value) VALUES(?,?)', `session-${token}`, JSON.stringify({ jobId, expires: Date.now() + 25 * 60_000 }));
    return token;
  }
  async session(token: string): Promise<Job | null> {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM settings WHERE key=?', `session-${token}`).toArray()[0];
    if (!row) return null;
    const value = JSON.parse(row.value);
    if (value.expires < Date.now()) return null;
    return this.job(value.jobId);
  }
  async closeSession(token: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM settings WHERE key=?', `session-${token}`);
  }
  async sessionFailure(token: string, reason?: string): Promise<string | null> {
    if (!await this.session(token)) return null;
    const key = `session-${token}`;
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM settings WHERE key=?', key).one();
    const session = JSON.parse(row.value);
    if (reason && ['budget_exhausted', 'billing_hold', 'context_too_large'].includes(reason)) {
      session.failure = reason;
      this.ctx.storage.sql.exec('UPDATE settings SET value=? WHERE key=?', JSON.stringify(session), key);
    }
    return session.failure ?? null;
  }
  async warningNeeded(): Promise<boolean> {
    const month = new Date().toISOString().slice(0,7);
    const total = this.ctx.storage.sql.exec<{ amount: number }>('SELECT COALESCE(SUM(amount),0) AS amount FROM charges WHERE month=?', month).one().amount;
    return total >= LIMITS.warn && !this.ctx.storage.sql.exec('SELECT value FROM settings WHERE key=?', `warning-${month}`).toArray().length;
  }
  async warningSent(): Promise<void> {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO settings VALUES(?,?)', `warning-${new Date().toISOString().slice(0,7)}`, 'true');
  }
}
