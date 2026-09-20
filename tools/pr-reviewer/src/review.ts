import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { ResponseInput, ResponseCreateParamsNonStreaming, Response as ModelResponse, Tool } from 'openai/resources/responses/responses';
import type { WorkflowStep } from 'cloudflare:workers';
import policy from './policy.md';
import { MODEL, ReviewSchema, validateReview, type Job } from './common';
import { collectContext, readFile } from './context';

const noRetry = { retries: { limit: 0, delay: '1 second' }, timeout: '2 minutes' } as const;
const tool: Tool = {
  type: 'function', name: 'read_file', description: 'Read a complete source or test file at the immutable base or head revision. No code execution.', strict: true,
  parameters: { type: 'object', properties: { path: { type: 'string' }, revision: { type: 'string', enum: ['base', 'head'] } }, required: ['path', 'revision'], additionalProperties: false }
};

export type ReviewEnvironment = Pick<ReviewerEnv, 'OPENAI_API_KEY'> & {
  LEDGER: Pick<ReviewerEnv['LEDGER'], 'getByName'>;
  PUBLISHER: Pick<ReviewerEnv['PUBLISHER'], 'read'>;
};
export async function runReview(env: ReviewEnvironment, job: Job, step: Pick<WorkflowStep, 'do' | 'sleep'>) {
  const ledger = env.LEDGER.getByName('budget');
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 0, timeout: 60_000 });
  const read = async (p: string): Promise<any> => JSON.parse(await env.PUBLISHER.read(p));
  const context: Awaited<ReturnType<typeof collectContext>> = JSON.parse(await step.do('gather immutable review context', { ...noRetry, timeout: '5 minutes' }, async () => JSON.stringify(await collectContext(read, job))));
  const input: ResponseInput = [{ role: 'user', content: JSON.stringify(context) }];
  const evidence = [...context.evidence];
  const revisionBudget = `${job.pr}-${job.head}`;
  for (let round = 0; round < 6; round++) {
    const responseId = await step.do(`reserve and submit ${round}`, noRetry, async () => {
      if (await ledger.billingHold()) throw new Error('billing_hold');
      const params = { model: MODEL, instructions: policy, input, reasoning: { effort: 'high' as const }, text: { format: zodTextFormat(ReviewSchema, 'review') }, tools: [tool], parallel_tool_calls: false };
      const count = await client.responses.inputTokens.count(params);
      if (count.input_tokens > 200_000) throw new Error('context_too_large');
      const allowance = await ledger.remaining(revisionBudget, job.pr);
      // 13 microdollars/input token includes the published $12.50/M cache-write rate.
      // Output/reasoning tokens cost $50/M. No provider tools or automatic retries.
      const inputReservation = (count.input_tokens + 128) * 13;
      const maxOutput = Math.min(16_000, Math.floor((allowance - inputReservation) / 50));
      if (maxOutput < 2_000) throw new Error('budget_exhausted');
      const charge = `${job.id}-${round}`;
      if (!await ledger.reserve(charge, revisionBudget, job.pr, inputReservation + maxOutput * 50)) throw new Error('budget_or_duplicate_reservation');
      // A failed/ambiguous submission keeps its entire reservation. This step never retries.
      const request: ResponseCreateParamsNonStreaming = { ...params, service_tier: 'default', background: true, store: true, max_output_tokens: maxOutput, parallel_tool_calls: false };
      const response = await client.responses.create(request);
      return response.id;
    });
    let response: ModelResponse | undefined;
    for (let poll = 0; poll < 90; poll++) {
      response = JSON.parse(await step.do(`retrieve ${round}-${poll}`, { retries: { limit: 2, delay: '5 seconds' }, timeout: '90 seconds' }, async () => { const r = await client.responses.retrieve(responseId); return JSON.stringify({ ...r, output_text: r.output_text }); }));
      if (!['queued', 'in_progress'].includes(response?.status ?? '')) break;
      await step.sleep(`wait ${round}-${poll}`, '20 seconds');
    }
    if (!response || ['queued', 'in_progress'].includes(response?.status ?? '')) {
      await step.do(`cancel timed out response ${round}`, noRetry, async () => { await client.responses.cancel(responseId); });
      throw new Error('model_timeout');
    }
    if (response.usage && !await step.do(`settle usage ${round}`, () => ledger.settle(`${job.id}-${round}`, response.usage!.input_tokens * 13 + response.usage!.output_tokens * 50))) throw new Error('usage_exceeds_reservation');
    if (response.status !== 'completed' || !response.usage) throw new Error('incomplete_model_response');
    const calls = response.output.filter(item => item.type === 'function_call');
    if (!calls.length) {
      const text = response.output.filter(item => item.type === 'message').flatMap(item => item.content).filter(item => item.type === 'output_text').map(item => item.text).join('');
      const result = validateReview(JSON.parse(text));
      for (const blocker of result.blockers) {
        if (!evidence.some(e => e.path === blocker.file && blocker.line <= e.lines)) throw new Error('unverified_finding_location');
      }
      return result;
    }
    if (calls.length > 8) throw new Error('too_many_tool_calls');
    for (const item of response.output) {
      if (item.type !== 'function_call' && item.type !== 'reasoning' && item.type !== 'message') throw new Error('unexpected_model_output');
      input.push(item);
    }
    for (const [index, call] of calls.entries()) {
      if (call.name !== 'read_file') throw new Error('unknown_tool');
      const args = JSON.parse(call.arguments);
      if (typeof args.path !== 'string' || !['base', 'head'].includes(args.revision)) throw new Error('invalid_tool_arguments');
      const file = await step.do(`read supporting file ${round}-${index}`, noRetry, () => readFile(read, job, args.path, args.revision));
      evidence.push(file);
      input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(file) });
    }
  }
  throw new Error('review_round_limit');
}
