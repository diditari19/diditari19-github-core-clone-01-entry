import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, type Repository } from './store.ts';
import { viewer, checkScenario } from './scenario.ts';
import { handleGit } from './smart-http.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

type Headers = Record<string, string>;
interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  store: Store;
  match: RegExpMatchArray;
  body: Record<string, unknown>;
}
interface Route { method: string; path: RegExp; handle: (ctx: Context) => void; }
let requestId = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Headers = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw === '') return {};
  const body: unknown = JSON.parse(raw);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a JSON object');
  return body as Record<string, unknown>;
}

function origin(ctx: Context): string { return ctx.url.origin; }
export function repositoryJson(repo: Repository, base: string) {
  const full = `${repo.owner.login}/${repo.name}`;
  const path = `${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`;
  return {
    id: repo.id, node_id: repo.node_id, name: repo.name, full_name: full,
    owner: { login: repo.owner.login, id: repo.owner.id },
    private: repo.private, description: repo.description, default_branch: repo.default_branch,
    created_at: repo.created_at, updated_at: repo.updated_at,
    html_url: `${base}/${path}`, url: `${base}/api/v3/repos/${path}`,
    git_url: `git://${new URL(base).host}/${path}.git`,
    clone_url: `${base}/${path}.git`, ssh_url: `git@${new URL(base).hostname}:${full}.git`,
  };
}

function pageNumber(value: string | null, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function listRepositories(ctx: Context): void {
  const perPage = pageNumber(ctx.url.searchParams.get('per_page'), 30, 100);
  const page = pageNumber(ctx.url.searchParams.get('page'), 1);
  const repos = ctx.store.listRepositories();
  const offset = (page - 1) * perPage;
  const headers: Headers = {};
  if (offset + perPage < repos.length) {
    const next = new URL(ctx.url);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    headers.link = `<${next.href}>; rel="next"`;
  }
  sendJson(ctx.res, 200, repos.slice(offset, offset + perPage).map((repo) => repositoryJson(repo, origin(ctx))), headers);
}

function createRepository(ctx: Context): void {
  const { name, description, private: isPrivate, default_branch: branch } = ctx.body;
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(name) || name === '.' || name === '..'
    || (description !== undefined && description !== null && typeof description !== 'string')
    || (isPrivate !== undefined && typeof isPrivate !== 'boolean')
    || (branch !== undefined && (typeof branch !== 'string' || branch.length === 0))) {
    sendJson(ctx.res, 422, { message: 'Invalid repository fields' });
    return;
  }
  if (ctx.store.getRepository(viewer.login, name)) {
    sendJson(ctx.res, 422, { message: 'Repository already exists' });
    return;
  }
  const repo = ctx.store.createRepository({
    name, description: description as string | null | undefined,
    private: isPrivate as boolean | undefined, default_branch: branch as string | undefined,
  });
  sendJson(ctx.res, 201, repositoryJson(repo, origin(ctx)));
}

function getRepository(ctx: Context): void {
  const owner = decodeURIComponent(ctx.match[1]!);
  const name = decodeURIComponent(ctx.match[2]!);
  const repo = ctx.store.getRepository(owner, name);
  sendJson(ctx.res, repo ? 200 : 404, repo ? repositoryJson(repo, origin(ctx)) : { message: 'Not Found' });
}

function withRepository(handle: (ctx: Context, repo: Repository) => void): Route['handle'] {
  return (ctx) => {
    const repo = ctx.store.getRepository(decodeURIComponent(ctx.match[1]!), decodeURIComponent(ctx.match[2]!));
    if (!repo) { sendJson(ctx.res, 404, { message: 'Not Found' }); return; }
    handle(ctx, repo);
  };
}

function contentPath(ctx: Context): string {
  return decodeURIComponent(ctx.match[3] ?? '').replace(/^\/+|\/+$/g, '');
}

function getContents(ctx: Context, repo: Repository): void {
  const path = contentPath(ctx);
  const ref = ctx.url.searchParams.get('ref') ?? repo.default_branch;
  const file = ctx.store.getFileAt(repo, ref, path);
  if (file) {
    sendJson(ctx.res, 200, { type: 'file', encoding: 'base64', content: file.bytes.toString('base64'), sha: file.blobSha,
      size: file.bytes.length, name: path.split('/').at(-1), path });
    return;
  }
  const entries = ctx.store.listDirAt(repo, ref, path);
  sendJson(ctx.res, entries ? 200 : 404, entries ?? { message: 'Not Found' });
}

function changeContents(ctx: Context, repo: Repository): void {
  const result = ctx.store.changeContent(repo, contentPath(ctx), ctx.body, ctx.req.method === 'DELETE');
  sendJson(ctx.res, result.status, result.body);
}

function validBranch(name: string): boolean {
  return name.length > 0 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(name)
    && !name.includes('..') && !name.includes('@{') && name !== '@'
    && name.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
}

function listCommits(ctx: Context, repo: Repository): void {
  const tip = ctx.store.resolveRef(repo, ctx.url.searchParams.get('sha') ?? repo.default_branch);
  if (!tip) { sendJson(ctx.res, 404, { message: 'Not Found' }); return; }
  const seen = new Set<string>();
  const pending = [tip];
  const commits = [];
  const identity = { name: repo.owner.login, email: `${repo.owner.login}@example.invalid`, date: ctx.store.now };
  while (pending.length) {
    const sha = pending.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const commit = repo.commits.get(sha)!;
    commits.push({ sha, commit: { message: commit.message, author: identity, committer: identity },
      parents: commit.parents.map((parent) => ({ sha: parent })) });
    pending.unshift(...commit.parents);
  }
  sendJson(ctx.res, 200, commits);
}

export function resourceJson(ctx: Pick<Context, 'url' | 'store'>, repo: Repository, item: import('./store.ts').Issue | import('./store.ts').PullRequest) {
  const base = repositoryJson(repo, ctx.url.origin);
  const pull = 'head' in item;
  return { ...item,
    ...(pull ? { head: { ...item.head, sha: repo.branches.get(item.head.ref) ?? item.head.sha },
      mergeable: item.state === 'open' && !ctx.store.pullDiff(repo, item).conflicted }
      : { labels: item.labels.map((name) => ({ name })), comments: item.comments.length }),
    html_url: `${base.html_url}/${pull ? 'pull' : 'issues'}/${item.number}`,
    url: `${base.url}/${pull ? 'pulls' : 'issues'}/${item.number}`,
  };
}

function listResources(ctx: Context, repo: Repository, pulls: boolean): void {
  const items = ctx.store.listResources(repo, pulls, ctx.url.searchParams.get('state') ?? 'open',
    ctx.url.searchParams.get('direction') === 'asc' && !pulls);
  const size = pageNumber(ctx.url.searchParams.get('per_page'), 30, 100);
  const page = pageNumber(ctx.url.searchParams.get('page'), 1);
  const offset = (page - 1) * size;
  const headers: Headers = {};
  if (offset + size < items.length) {
    const next = new URL(ctx.url);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(size));
    headers.link = `<${next.href}>; rel="next"`;
  }
  sendJson(ctx.res, 200, items.slice(offset, offset + size).map((item) => resourceJson(ctx, repo, item)), headers);
}

const routes: readonly Route[] = [
  { method: 'POST', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/, handle: withRepository((ctx, repo) => {
    const result = ctx.store.createLabel(repo, ctx.body);
    sendJson(ctx.res, result.status, result.body);
  }) },
  { method: 'GET', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/, handle: withRepository((ctx, repo) => {
    sendJson(ctx.res, 200, [...repo.labels.values()]);
  }) },
  { method: 'POST', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)$/, handle: withRepository((ctx, repo) => {
    const result = ctx.match[3] === 'issues' ? ctx.store.createIssue(repo, ctx.body) : ctx.store.createPull(repo, ctx.body);
    sendJson(ctx.res, result.status, result.status === 201 ? resourceJson(ctx, repo, result.body) : result.body);
  }) },
  { method: 'GET', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)$/, handle: withRepository((ctx, repo) => {
    listResources(ctx, repo, ctx.match[3] === 'pulls');
  }) },
  { method: 'GET', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)$/, handle: withRepository((ctx, repo) => {
    const item = (ctx.match[3] === 'issues' ? repo.issues : repo.pulls).get(Number(ctx.match[4]));
    sendJson(ctx.res, item ? 200 : 404, item ? resourceJson(ctx, repo, item) : { message: 'Not Found' });
  }) },
  { method: 'PATCH', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/, handle: withRepository((ctx, repo) => {
    const result = ctx.store.patchIssue(repo, Number(ctx.match[3]), ctx.body);
    sendJson(ctx.res, result.status, result.status === 200 ? resourceJson(ctx, repo, result.body) : result.body);
  }) },
  { method: 'POST', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, handle: withRepository((ctx, repo) => {
    const result = ctx.store.createComment(repo, Number(ctx.match[3]), ctx.body);
    sendJson(ctx.res, result.status, result.status === 201 ? { ...result.body,
      issue_url: `${repositoryJson(repo, origin(ctx)).url}/issues/${Number(ctx.match[3])}` } : result.body);
  }) },
  { method: 'GET', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, handle: withRepository((ctx, repo) => {
    const issue = repo.issues.get(Number(ctx.match[3]));
    sendJson(ctx.res, issue ? 200 : 404, issue ? issue.comments : { message: 'Not Found' });
  }) },
  { method: 'GET', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/, handle: withRepository((ctx, repo) => {
    const pull = repo.pulls.get(Number(ctx.match[3]));
    sendJson(ctx.res, pull ? 200 : 404, pull ? ctx.store.pullFiles(repo, pull) : { message: 'Not Found' });
  }) },
  { method: 'PUT', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/, handle: withRepository((ctx, repo) => {
    const result = ctx.store.mergePull(repo, Number(ctx.match[3]));
    sendJson(ctx.res, result.status, result.body);
  }) },
  { method: 'GET', path: /^\/healthz$/, handle: ({ res }) => sendJson(res, 200, { ok: true }) },
  { method: 'GET', path: /^\/api\/v3\/?$/, handle: ({ res }) => sendJson(res, 200,
    { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' }) },
  { method: 'GET', path: /^\/api\/v3\/meta$/, handle: ({ res }) => sendJson(res, 200, { installed_version: '1.0.0' }) },
  { method: 'GET', path: /^\/api\/v3\/user$/, handle: ({ res }) => sendJson(res, 200, { login: viewer.login, id: viewer.id }) },
  { method: 'GET', path: /^\/api\/v3\/user\/repos$/, handle: listRepositories },
  { method: 'POST', path: /^\/api\/v3\/user\/repos$/, handle: createRepository },
  { method: 'GET', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, handle: getRepository },
  { method: 'PATCH', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, handle: withRepository((ctx, repo) => {
    if (ctx.body.description !== undefined) {
      if (ctx.body.description !== null && typeof ctx.body.description !== 'string') { sendJson(ctx.res, 422, { message: 'Invalid description' }); return; }
      repo.description = ctx.body.description as string | null;
    }
    repo.updated_at = ctx.store.now;
    sendJson(ctx.res, 200, repositoryJson(repo, origin(ctx)));
  }) },
  { method: 'DELETE', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, handle: withRepository((ctx, repo) => {
    ctx.store.repositories.delete(ctx.store.key(repo.owner.login, repo.name));
    ctx.res.writeHead(204, { 'content-type': 'application/json; charset=utf-8' });
    ctx.res.end();
  }) },
  { method: 'GET', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents(?:\/(.*))?$/, handle: withRepository(getContents) },
  { method: 'PUT', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/, handle: withRepository(changeContents) },
  { method: 'DELETE', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/, handle: withRepository(changeContents) },
  { method: 'POST', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs$/, handle: withRepository((ctx, repo) => {
    const { ref, sha } = ctx.body;
    if (typeof ref !== 'string' || !ref.startsWith('refs/heads/') || !validBranch(ref.slice(11)) || typeof sha !== 'string'
      || !ctx.store.createBranch(repo, ref.slice(11), sha)) { sendJson(ctx.res, 422, { message: 'Invalid reference' }); return; }
    sendJson(ctx.res, 201, { ref, object: { sha } });
  }) },
  { method: 'GET', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches$/, handle: withRepository((ctx, repo) => {
    const base = repositoryJson(repo, origin(ctx)).url;
    sendJson(ctx.res, 200, [...repo.branches].map(([name, sha]) => ({ name, commit: { sha, url: `${base}/commits/${sha}` }, protected: false })));
  }) },
  { method: 'GET', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/, handle: withRepository((ctx, repo) => {
    const name = decodeURIComponent(ctx.match[3]!);
    const sha = repo.branches.get(name);
    sendJson(ctx.res, sha ? 200 : 404, sha ? { name, commit: { sha }, protected: false } : { message: 'Not Found' });
  }) },
  { method: 'GET', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/, handle: withRepository((ctx, repo) => {
    const branch = decodeURIComponent(ctx.match[3]!);
    const sha = repo.branches.get(branch);
    sendJson(ctx.res, sha ? 200 : 404, sha ? { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } } : { message: 'Not Found' });
  }) },
  { method: 'GET', path: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/commits$/, handle: withRepository(listCommits) },
];

export function createApp(store = new Store()): Server {
  checkScenario();
  return createServer(async (req, res) => {
    // Node otherwise supplies a wall-clock Date header automatically.
    res.sendDate = false;
    res.setHeader('x-github-request-id', `req-${++requestId}`);
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'entry'}`);
      if (await handleGit(req, res, url, store)) return;
      const graphql = url.pathname === '/api/graphql';
      const mcp = url.pathname === '/mcp';
      const api = mcp || graphql || url.pathname === '/api/v3' || url.pathname.startsWith('/api/v3/');
      const token = process.env.MAKEFUN_SHOP_TOKEN;
      if (api && (!token || req.headers.authorization !== `Bearer ${token}`)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
      if (mcp) { await handleMcp(req, res, url, store); return; }
      if (graphql && req.method === 'POST') {
        let document: unknown;
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch { sendJson(res, 400, { message: 'Malformed JSON body' }); return; }
        sendJson(res, 200, Array.isArray(document)
          ? document.map((operation) => executeGraphQL(store, operation))
          : executeGraphQL(store, document));
        return;
      }
      let body: Record<string, unknown>;
      try { body = await readBody(req); }
      catch { sendJson(res, 400, { message: 'Malformed JSON body' }); return; }
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = url.pathname.match(route.path);
        if (match) { route.handle({ req, res, url, store, match, body }); return; }
      }
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      sendJson(res, err instanceof URIError || err instanceof TypeError ? 400 : 500,
        { message: err instanceof URIError || err instanceof TypeError ? 'Invalid request URL' : 'Internal Server Error' });
    }
  });
}
