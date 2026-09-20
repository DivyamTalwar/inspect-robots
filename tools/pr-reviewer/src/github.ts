import { importPKCS8, SignJWT } from 'jose';
import { boundedText, REPO } from './common';

export function allowedRead(path: string): boolean {
  if (path.includes('..') || path.includes('\\') || /[\r\n#]/.test(path)) return false;
  const url = new URL(`https://api.github.com/repos/${REPO}${path}`);
  return url.origin === 'https://api.github.com' && url.pathname.startsWith(`/repos/${REPO}/`) &&
    /^\/(pulls(?:\/\d+(?:\/(?:files|commits))?)?|issues\/\d+(?:\/comments)?|contents\/[^?]+|git\/trees\/[a-f0-9]{40}|commits\/[a-f0-9]{40}\/(?:check-runs|status)|actions\/runs(?:\/\d+)?)($|\?)/.test(path);
}

export async function github(token: string, path: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await fetch(`https://api.github.com${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'inspect-robots-reviewer', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`github_http_${response.status}`);
  return JSON.parse(await boundedText(response));
}

export async function installationToken(env: PublisherEnv, write: boolean): Promise<string> {
  const key = await importPKCS8(env.GITHUB_PRIVATE_KEY, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(env.GITHUB_APP_ID).setIssuedAt(now - 60).setExpirationTime(now + 300).sign(key);
  const result = await github(jwt, `/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`, 'POST', {
    repositories: ['inspect-robots'],
    permissions: { contents: 'read', issues: 'read', actions: 'read', pull_requests: write ? 'write' : 'read', checks: write ? 'write' : 'read' },
  });
  return result.token;
}

export async function ciGreen(read: (path: string) => Promise<any>, sha: string): Promise<boolean> {
  // Accept only the aggregate check produced by GitHub Actions, not an arbitrary status.
  const checks = await read(`/commits/${sha}/check-runs?filter=latest&per_page=100`);
  const candidates = checks.check_runs?.filter((c: any) => c.name === 'ci-ok' && c.app?.slug === 'github-actions' && c.head_sha === sha) ?? [];
  return candidates.length > 0 && candidates.every((c: any) => c.status === 'completed' && c.conclusion === 'success');
}
