import { describe, expect, it, vi } from 'vitest';
import { collectContext, readFile } from '../src/context';
import type { Job } from '../src/common';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const job: Job = { id: 'diff-test', pr: 9, head, base, scope: '', status: 'running', result: null, notified: 0, created: 1 };
const patch = '@@ -1 +1 @@\n-old\n+new';
function fixture(files: any[]) {
  return vi.fn(async (path: string): Promise<any> => {
    if (path === '/pulls/9') return { number: 9, head: { sha: head }, base: { sha: base }, state: 'open', draft: false, changed_files: files.length, title: '', body: '' };
    if (path.includes('/files?')) return files;
    if (path.startsWith('/git/trees/')) return { tree: [], truncated: false };
    if (path.startsWith('/contents/')) throw new Error('Unexpected whole-file read');
    return [];
  });
}
describe('Codex source context', () => {
  it('gathers discussion and immutable merge-base without reading full changed files', async () => {
    const basic = fixture([]);
    const read = vi.fn(async (path: string) => path.startsWith('/compare/') ? { merge_base_commit: { sha: base } } : basic(path));
    expect((await collectContext(read, job)).merge_base).toBe(base);
    expect(read.mock.calls.some(([p]) => p.startsWith('/contents/') || p.includes('/files?'))).toBe(false);
  });
  it('returns bounded ranges for verifying locations in large files', async () => {
    const content = Array.from({ length: 20000 }, (_, i) => `source line ${i + 1}`).join('\n');
    const evidence = await readFile(async () => ({ type: 'file', encoding: 'base64', size: content.length, content: btoa(content) }), job, 'large.py', 'head', 901, 3);
    expect(evidence).toMatchObject({ start_line: 901, end_line: 903, more: true, lines: 20000 });
  });
});
