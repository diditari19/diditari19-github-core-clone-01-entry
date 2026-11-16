import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import { viewer } from './scenario.ts';
import { repositoryJson, resourceJson } from './app.ts';

const versions = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const serverInfo = { name: 'makefun-forge', version: '1.0.0' };
const string = { type: 'string' };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
  ({ name, description, inputSchema: { type: 'object', properties, required } });
const tools = [
  tool('create_repo', 'Create a repository owned by the token viewer.', { name: string, description: string, private: { type: 'boolean' } }, ['name']),
  tool('get_repo', 'Read a repository.', { owner: string, repo: string }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', { owner: string, repo: string, title: string, body: string }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List repository issues by state.', { owner: string, repo: string, state: string }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request between branches.', { owner: string, repo: string, title: string, head: string, base: string, body: string }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge an open pull request.', { owner: string, repo: string, pull_number: { type: 'integer' } }, ['owner', 'repo', 'pull_number']),
];
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const error = (code: number, message: string) => ({ error: { code, message } });
const success = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
const failure = (message: string) => ({ content: [{ type: 'text', text: message }], isError: true });

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

// Authentication is enforced by createApp before this reads any request bytes.
export async function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL, store: Store): Promise<void> {
  if (req.method !== 'POST') { send(res, 405, { message: 'Method Not Allowed' }); return; }
  let document: unknown;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { send(res, 400, { jsonrpc: '2.0', id: null, ...error(-32700, 'Parse error') }); return; }
  if (!record(document)) { send(res, 200, { jsonrpc: '2.0', id: null, ...error(-32600, 'Invalid Request') }); return; }
  if (!Object.hasOwn(document, 'id') && typeof document.method === 'string') { res.writeHead(202); res.end(); return; }
  const id = Object.hasOwn(document, 'id') ? document.id : null;
  if (document.jsonrpc !== '2.0' || typeof document.method !== 'string' || !Object.hasOwn(document, 'id')) {
    send(res, 200, { jsonrpc: '2.0', id, ...error(-32600, 'Invalid Request') }); return;
  }
  try {
    const response = document.params !== undefined && !record(document.params)
      ? error(-32602, 'Params must be an object')
      : execute(store, url, document.method, (document.params ?? {}) as Record<string, unknown>);
    send(res, 200, { jsonrpc: '2.0', id, ...response });
  } catch { send(res, 200, { jsonrpc: '2.0', id, ...error(-32603, 'Internal error') }); }
}

function execute(store: Store, url: URL, method: string, params: Record<string, unknown>): object {
  if (method === 'server/discover') return { result: { supportedVersions: versions, capabilities: { tools: {} }, serverInfo,
    instructions: 'GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP over one in-memory store.',
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo } } };
  if (method === 'initialize') return versions.includes(params.protocolVersion as string)
    ? { result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo } }
    : error(-32602, 'Unsupported protocol version');
  if (method === 'tools/list') return { result: { tools } };
  if (method !== 'tools/call') return error(-32601, `Method not found: ${method}`);
  const definition = tools.find((entry) => entry.name === params.name);
  if (!definition) return error(-32602, `Unknown tool: ${String(params.name)}`);
  if (params.arguments !== undefined && !record(params.arguments)) return error(-32602, 'Arguments must be an object');
  const args = record(params.arguments) ? params.arguments : {};
  const pick = (...keys: string[]) => keys.map((key) => args[key]).find((value) => value !== undefined);
  const values: Record<string, unknown> = {
    name: pick('name', 'repository', 'repo', 'repository_name', 'repo_name'),
    owner: pick('owner', 'owner_login', 'org', 'organization', 'user', 'login', 'namespace'),
    repo: pick('repo', 'repository', 'repository_name', 'repo_name'),
    title: pick('title', 'issue_title', 'pr_title', 'subject'),
    body: pick('body', 'description', 'issue_body', 'content', 'text'),
    head: pick('head', 'head_ref', 'head_branch', 'source', 'source_branch', 'branch'),
    base: pick('base', 'base_ref', 'base_branch', 'target', 'target_branch'),
    pull_number: pick('pull_number', 'number', 'pull_request_number', 'pr_number'),
  };
  const missing = definition.inputSchema.required.filter((key) => values[key] === undefined);
  if (missing.length) return { result: failure(`Missing required arguments: ${missing.join(', ')}`) };
  for (const key of definition.inputSchema.required) {
    if (key === 'pull_number' ? !Number.isSafeInteger(values[key]) || Number(values[key]) < 1
      : typeof values[key] !== 'string' || !(values[key] as string).trim()) return { result: failure(`Invalid argument: ${key}`) };
  }
  if (definition.name === 'create_repo') {
    const name = values.name as string;
    const description = pick('description', 'about', 'summary', 'body');
    const isPrivate = pick('private', 'is_private');
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(name) || name === '.' || name === '..'
      || (description !== undefined && description !== null && typeof description !== 'string')
      || (isPrivate !== undefined && typeof isPrivate !== 'boolean')) return { result: failure('Invalid repository fields') };
    if (store.getRepository(viewer.login, name)) return { result: failure('Repository already exists') };
    return { result: success(repositoryJson(store.createRepository({ name, description: description as string | null | undefined,
      private: isPrivate as boolean | undefined }), url.origin)) };
  }
  const repo = store.getRepository(values.owner as string, values.repo as string);
  if (!repo) return { result: failure('Not Found') };
  if (definition.name === 'get_repo') return { result: success(repositoryJson(repo, url.origin)) };
  if (definition.name === 'list_issues') {
    const state = pick('state', 'status') ?? 'open';
    if (!['open', 'closed', 'all'].includes(state as string)) return { result: failure('Invalid issue state') };
    return { result: success({ issues: store.listResources(repo, false, state as string, false).map((item) => resourceJson({ store, url }, repo, item)) }) };
  }
  const result = definition.name === 'create_issue' ? store.createIssue(repo, values)
    : definition.name === 'create_pull_request' ? store.createPull(repo, values)
    : store.mergePull(repo, values.pull_number as number);
  if (result.status >= 400) return { result: failure(result.body.message) };
  return { result: success(definition.name === 'merge_pull_request'
    ? { ...result.body, number: values.pull_number, state: 'closed' }
    : resourceJson({ store, url }, repo, result.body)) };
}
