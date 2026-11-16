import { Store, type Repository } from './store.ts';
import { viewer } from './scenario.ts';

type Value = { kind: string; value: any };
type Selection = { name: string; alias: string; args: Record<string, Value>; selections: Selection[]; fragment?: string };
type Operation = { kind: string; name?: string; variables: Record<string, { type: string; fallback?: Value }>; selections: Selection[] };

// Tokenize without silently skipping unsupported input.
function parse(source: string): Operation[] {
  const tokens: string[] = [];
  const pattern = /\s+|#[^\n]*|,|\.\.\.|"(?:[^"\\\r\n]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"|-?(?:0|[1-9][0-9]*)|[_A-Za-z][_0-9A-Za-z]*|[!$():={}\[\]]/y;
  let offset = 0;
  while (offset < source.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    if (!match) throw new Error(`Invalid GraphQL token at ${offset}`);
    offset = pattern.lastIndex;
    if (!/^(?:\s|#|,)/.test(match[0])) tokens.push(match[0]);
  }
  let index = 0;
  const peek = () => tokens[index];
  const take = () => { if (index >= tokens.length) throw new Error('Unexpected end of document'); return tokens[index++]; };
  const expect = (token: string) => { if (take() !== token) throw new Error(`Expected ${token}`); };
  const name = () => { const token = take(); if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(token)) throw new Error('Expected name'); return token; };
  function value(): Value {
    const token = take();
    if (token === '$') return { kind: 'variable', value: name() };
    if (token === '[') { const items = []; while (peek() !== ']') items.push(value()); take(); return { kind: 'list', value: items }; }
    if (token === '{') { const fields: Record<string, Value> = {}; while (peek() !== '}') { const key = name(); expect(':'); fields[key] = value(); } take(); return { kind: 'object', value: fields }; }
    if (token.startsWith('"')) return { kind: 'scalar', value: JSON.parse(token) };
    if (/^-?\d+$/.test(token)) return { kind: 'scalar', value: Number(token) };
    if (['true', 'false', 'null'].includes(token)) return { kind: 'scalar', value: JSON.parse(token) };
    if (!/^[_A-Za-z]/.test(token)) throw new Error('Expected value');
    return { kind: 'enum', value: token };
  }
  function selections(): Selection[] {
    expect('{'); const fields: Selection[] = [];
    while (peek() !== '}') {
      if (peek() === '...') { take(); expect('on'); const fragment = name(); fields.push({ name: '', alias: '', args: {}, fragment, selections: selections() }); continue; }
      const first = name(); let field = first;
      if (peek() === ':') { take(); field = name(); }
      const args: Record<string, Value> = {};
      if (peek() === '(') { take(); while (peek() !== ')') { const key = name(); expect(':'); args[key] = value(); } take(); }
      fields.push({ name: field, alias: first, args, selections: peek() === '{' ? selections() : [] });
    }
    take(); return fields;
  }
  function type(): string { let result: string; if (peek() === '[') { take(); result = `[${type()}`; expect(']'); result += ']'; } else result = name(); if (peek() === '!') result += take(); return result; }
  const operations: Operation[] = [];
  while (peek()) {
    const operation: Operation = { kind: 'query', variables: {}, selections: [] };
    if (peek() !== '{') {
      operation.kind = take();
      if (!['query', 'mutation'].includes(operation.kind)) throw new Error('Expected query or mutation');
      if (peek() !== '(' && peek() !== '{') operation.name = name();
      if (peek() === '(') {
        take(); while (peek() !== ')') { expect('$'); const key = name(); expect(':'); const variable = { type: type(), fallback: undefined as Value | undefined }; if (peek() === '=') { take(); variable.fallback = value(); } operation.variables[key] = variable; } take();
      }
    }
    operation.selections = selections(); operations.push(operation);
  }
  return operations;
}

type Field = { type: string; args?: Record<string, string> };
const field = (type: string, args?: Record<string, string>): Field => ({ type, args });
const schema: Record<string, Record<string, Field>> = {
  Query: { viewer: field('User'), repository: field('Repository', { owner: 'String!', name: 'String!' }), node: field('Node', { id: 'ID!' }), __type: field('__Type', { name: 'String!' }) },
  Mutation: { createIssue: field('CreateIssuePayload', { input: 'CreateIssueInput!' }), closeIssue: field('CloseIssuePayload', { input: 'CloseIssueInput!' }), createPullRequest: field('CreatePullRequestPayload', { input: 'CreatePullRequestInput!' }), mergePullRequest: field('MergePullRequestPayload', { input: 'MergePullRequestInput!' }), addComment: field('AddCommentPayload', { input: 'AddCommentInput!' }) },
  User: { login: field('String') },
  Repository: { id: field('ID'), databaseId: field('Int'), name: field('String'), nameWithOwner: field('String'), owner: field('User'), defaultBranchRef: field('Ref'), viewerPermission: field('RepositoryPermission'), hasIssuesEnabled: field('Boolean'), issue: field('Issue', { number: 'Int!' }), issues: field('IssueConnection', { first: 'Int', states: '[IssueState!]', orderBy: 'IssueOrder', after: 'String' }), pullRequests: field('PullRequestConnection', { first: 'Int' }), pullRequest: field('PullRequest', { number: 'Int!' }) },
  Issue: { id: field('ID'), number: field('Int'), title: field('String'), body: field('String'), state: field('IssueState'), createdAt: field('String'), updatedAt: field('String') },
  PullRequest: { id: field('ID'), number: field('Int'), title: field('String'), body: field('String'), state: field('PullRequestState'), merged: field('Boolean'), headRefName: field('String'), baseRefName: field('String'), mergeable: field('MergeableState'), files: field('PullRequestChangedFileConnection', { first: 'Int' }) },
  IssueConnection: { nodes: field('[Issue]'), pageInfo: field('PageInfo') },
  PullRequestConnection: { nodes: field('[PullRequest]'), pageInfo: field('PageInfo') },
  PullRequestChangedFileConnection: { nodes: field('[PullRequestChangedFile]') },
  PullRequestChangedFile: { path: field('String'), additions: field('Int'), deletions: field('Int'), changes: field('Int'), status: field('String') },
  PageInfo: { hasNextPage: field('Boolean'), endCursor: field('String'), hasPreviousPage: field('Boolean'), startCursor: field('String') },
  Ref: { name: field('String') }, Node: { id: field('ID') },
  __Type: { fields: field('[__Field]', { includeDeprecated: 'Boolean' }), enumValues: field('[__EnumValue]', { includeDeprecated: 'Boolean' }) },
  __Field: { name: field('String') }, __EnumValue: { name: field('String') },
  CreateIssuePayload: { issue: field('Issue') }, CloseIssuePayload: { issue: field('Issue') },
  CreatePullRequestPayload: { pullRequest: field('PullRequest') }, MergePullRequestPayload: { pullRequest: field('PullRequest') },
  AddCommentPayload: { commentEdge: field('IssueCommentEdge') }, IssueCommentEdge: { node: field('IssueComment') }, IssueComment: { id: field('ID'), body: field('String') },
};
const enums: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'], IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'], OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], PullRequestState: ['OPEN', 'CLOSED', 'MERGED'], PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'], SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
};
const inputs: Record<string, Record<string, string>> = {
  IssueOrder: { field: 'IssueOrderField!', direction: 'OrderDirection!' },
  CreateIssueInput: { repositoryId: 'ID!', title: 'String!', body: 'String' }, CloseIssueInput: { issueId: 'ID!' },
  CreatePullRequestInput: { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!' },
  MergePullRequestInput: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod' }, AddCommentInput: { subjectId: 'ID!', body: 'String!' },
};
const baseType = (type: string) => type.replace(/[\[\]!]/g, '');

function checkValue(value: any, type: string): void {
  if (value == null) { if (type.endsWith('!')) throw new Error(`Expected non-null ${type}`); return; }
  const nullable = type.replace(/!$/, '');
  if (nullable.startsWith('[')) {
    if (!Array.isArray(value)) throw new Error(`Expected ${type}`);
    for (const item of value) checkValue(item, nullable.slice(1, -1));
  } else if (inputs[nullable]) {
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected ${type}`);
    for (const key of Object.keys(value)) if (!inputs[nullable][key]) throw new Error(`Unknown input field ${key}`);
    for (const [key, childType] of Object.entries(inputs[nullable])) checkValue(value[key], childType);
  } else if (enums[nullable]) {
    if (!enums[nullable].includes(value)) throw new Error(`Unknown ${nullable} value ${String(value)}`);
  } else if (nullable === 'Int' ? !Number.isInteger(value) || value < -2147483648 || value > 2147483647
    : nullable === 'Boolean' ? typeof value !== 'boolean'
    : nullable === 'ID' ? typeof value !== 'string' && !Number.isInteger(value)
    : nullable === 'String' ? typeof value !== 'string' : true) throw new Error(`Expected ${type}`);
}

type ObjectValue = { type: string; value: any; repo?: Repository };
const object = (type: string, value: any, repo?: Repository): ObjectValue | null => value == null ? null : { type, value, repo };
const encode = (value: string) => Buffer.from(value).toString('base64');
function lookup(store: Store, id: unknown): ObjectValue | null {
  if (typeof id !== 'string' || Buffer.from(id, 'base64').toString('base64') !== id) return null;
  const parts = Buffer.from(id, 'base64').toString('utf8').split(':');
  if (!['Repository', 'Issue', 'PullRequest'].includes(parts[0]) || !/^[1-9]\d*$/.test(parts[1] ?? '')) return null;
  const repo = [...store.repositories.values()].find((item) => item.id === Number(parts[1]));
  if (!repo) return null;
  if (parts[0] === 'Repository') return parts.length === 2 ? object('Repository', repo, repo) : null;
  if (parts.length !== 3 || !/^[1-9]\d*$/.test(parts[2])) return null;
  return object(parts[0], (parts[0] === 'Issue' ? repo.issues : repo.pulls).get(Number(parts[2])), repo);
}

function connection(type: string, items: any[], args: any, repo: Repository): ObjectValue {
  let offset = 0;
  if (args.after != null) {
    const decoded = Buffer.from(args.after, 'base64').toString('utf8');
    if (!/^cursor:[1-9]\d*$/.test(decoded)) throw new Error('Invalid cursor');
    const index = items.findIndex((item) => item.number === Number(decoded.slice(7)));
    if (index < 0) throw new Error('Cursor not found');
    offset = index + 1;
  }
  if (args.first != null && args.first < 0) throw new Error('first must be nonnegative');
  const page = items.slice(offset, args.first == null ? undefined : offset + args.first);
  const cursor = (item: any) => item ? encode(`cursor:${item.number}`) : null;
  return object(`${type}Connection`, { nodes: page.map((item) => object(type, item, repo)),
    pageInfo: object('PageInfo', { hasNextPage: offset + page.length < items.length, hasPreviousPage: args.after != null,
      startCursor: cursor(page[0]), endCursor: cursor(page.at(-1)) }) })!;
}

function resolve(store: Store, parent: ObjectValue, name: string, args: any): any {
  const { type, value, repo } = parent;
  if (name === '__typename') return type;
  if (type === 'Query') {
    if (name === 'viewer') return object('User', viewer);
    if (name === 'repository') { const found = store.getRepository(args.owner, args.name); return object('Repository', found, found); }
    if (name === 'node') return lookup(store, args.id);
    if (name === '__type') return schema[args.name] || enums[args.name] ? object('__Type', args.name) : null;
  }
  if (type === '__Type') {
    const names = name === 'fields' ? Object.keys(schema[value] ?? {}) : enums[value] ?? [];
    return names.map((entry) => object(name === 'fields' ? '__Field' : '__EnumValue', { name: entry }));
  }
  if (type === 'Repository') {
    if (name === 'id') return value.node_id;
    if (name === 'databaseId') return value.id;
    if (name === 'nameWithOwner') return `${value.owner.login}/${value.name}`;
    if (name === 'owner') return object('User', value.owner);
    if (name === 'defaultBranchRef') return value.branches.has(value.default_branch) ? object('Ref', { name: value.default_branch }) : null;
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'issue' || name === 'pullRequest') return object(name === 'issue' ? 'Issue' : 'PullRequest', (name === 'issue' ? value.issues : value.pulls).get(args.number), value);
    if (name === 'pullRequests') return connection('PullRequest', [...value.pulls.values()].sort((a: any, b: any) => b.number - a.number), args, value);
    if (name === 'issues') {
      const order = args.orderBy ?? { field: 'CREATED_AT', direction: 'DESC' };
      const direction = order.direction === 'ASC' ? 1 : -1;
      const key = (issue: any) => order.field === 'COMMENTS' ? issue.comments.length : issue[order.field === 'UPDATED_AT' ? 'updated_at' : 'created_at'];
      const items = [...value.issues.values()].filter((issue: any) => args.states == null || args.states.includes(issue.state.toUpperCase()));
      items.sort((a: any, b: any) => direction * ((key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) || a.number - b.number));
      return connection('Issue', items, args, value);
    }
  }
  if (type === 'Issue' || type === 'PullRequest') {
    if (name === 'id') return value.node_id;
    if (name === 'state') return value.merged ? 'MERGED' : value.state.toUpperCase();
    if (name === 'createdAt') return value.created_at;
    if (name === 'updatedAt') return value.updated_at;
    if (name === 'headRefName') return value.head.ref;
    if (name === 'baseRefName') return value.base.ref;
    if (name === 'mergeable') return value.state !== 'open' ? 'UNKNOWN' : store.pullDiff(repo!, value).conflicted ? 'CONFLICTING' : 'MERGEABLE';
    if (name === 'files') {
      if (args.first != null && args.first < 0) throw new Error('first must be nonnegative');
      const files = store.pullFiles(repo!, value).slice(0, args.first ?? undefined);
      return object('PullRequestChangedFileConnection', { nodes: files.map((file) => object('PullRequestChangedFile', { ...file, path: file.filename })) });
    }
  }
  if (type === 'Mutation') {
    const input = args.input;
    const expected = name === 'closeIssue' || name === 'addComment' ? 'Issue' : name === 'mergePullRequest' ? 'PullRequest' : 'Repository';
    const target = lookup(store, input.repositoryId ?? input.issueId ?? input.pullRequestId ?? input.subjectId);
    if (!target || target.type !== expected) throw new Error(`Invalid ${expected} id`);
    const repository = target.repo!;
    let result;
    if (name === 'createIssue') result = store.createIssue(repository, { title: input.title, ...(input.body == null ? {} : { body: input.body }) });
    if (name === 'closeIssue') result = store.patchIssue(repository, target.value.number, { state: 'closed' });
    if (name === 'createPullRequest') result = store.createPull(repository, { title: input.title, head: input.headRefName, base: input.baseRefName });
    if (name === 'mergePullRequest') result = store.mergePull(repository, target.value.number);
    if (name === 'addComment') result = store.createComment(repository, target.value.number, { body: input.body });
    if (!result || result.status >= 400) throw new Error(result?.body.message ?? 'Mutation failed');
    if (name === 'addComment') return object('AddCommentPayload', { commentEdge: object('IssueCommentEdge', { node: object('IssueComment', { id: encode(`IssueComment:${repository.id}:${target.value.number}:${result.body.id}`), body: result.body.body }) }) });
    const pull = name === 'createPullRequest' || name === 'mergePullRequest';
    return object(schema.Mutation[name].type, { [pull ? 'pullRequest' : 'issue']: object(pull ? 'PullRequest' : 'Issue', name === 'mergePullRequest' ? target.value : result.body, repository) });
  }
  return value[name] ?? null;
}

export function executeGraphQL(store: Store, request: any): any {
  try {
    if (!request || typeof request.query !== 'string') throw new Error('Expected a query string');
    const operations = parse(request.query);
    const operationNames = operations.map((entry) => entry.name).filter(Boolean);
    if (new Set(operationNames).size !== operationNames.length) throw new Error('Duplicate operation name');
    const operation = operations.length === 1 ? operations[0] : operations.find((entry) => entry.name === request.operationName);
    if (!operation) throw new Error('An operationName must select an operation');
    if (request.variables != null && (typeof request.variables !== 'object' || Array.isArray(request.variables))) throw new Error('Expected variables object');
    const variables = { ...(request.variables ?? {}) };
    function evaluate(value: Value): any {
      if (value.kind === 'variable') {
        if (!operation!.variables[value.value] || !(value.value in variables)) throw new Error(`Variable $${value.value} was not provided`);
        return variables[value.value];
      }
      if (value.kind === 'list') return value.value.map(evaluate);
      if (value.kind === 'object') return Object.fromEntries(Object.entries(value.value).map(([key, child]) => [key, evaluate(child as Value)]));
      return value.value;
    }
    for (const [key, definition] of Object.entries(operation.variables)) {
      if (!(key in variables) && definition.fallback) variables[key] = evaluate(definition.fallback);
      checkValue(variables[key], definition.type);
    }
    function validateValue(value: Value, type: string): void {
      if (value.kind === 'variable') {
        const declared = operation!.variables[value.value]?.type;
        if (!declared || declared.replace(/!/g, '') !== type.replace(/!/g, '') || (type.endsWith('!') && !declared.endsWith('!'))) throw new Error(`Variable $${value.value} has incompatible type`);
      } else if (value.kind === 'list') {
        if (!type.startsWith('[')) throw new Error(`Expected ${type}`);
        for (const child of value.value) validateValue(child, type.replace(/!$/, '').slice(1, -1));
      } else if (value.kind === 'object') {
        const fields = inputs[baseType(type)];
        if (!fields) throw new Error(`Expected ${type}`);
        for (const [key, child] of Object.entries(value.value)) { if (!fields[key]) throw new Error(`Unknown input field ${key}`); validateValue(child as Value, fields[key]); }
      } else if (enums[baseType(type)] && value.value != null && value.kind !== 'enum') throw new Error(`Expected enum ${type}`);
      else if (value.kind === 'enum' && !enums[baseType(type)]) throw new Error(`Expected ${type}`);
      checkValue(evaluate(value), type);
    }
    function validate(type: string, selections: Selection[]): void {
      for (const selection of selections) {
        if (selection.fragment) { if (!schema[selection.fragment]) throw new Error(`Unknown type ${selection.fragment}`); validate(selection.fragment, selection.selections); continue; }
        const definition = selection.name === '__typename' ? field('String') : schema[type]?.[selection.name];
        if (!definition) throw new Error(`Cannot query field "${selection.name}" on type "${type}".`);
        for (const [key, value] of Object.entries(selection.args)) { const argType = definition.args?.[key]; if (!argType) throw new Error(`Unknown argument "${key}" on field "${selection.name}".`); validateValue(value, argType); }
        for (const [key, argType] of Object.entries(definition.args ?? {})) if (!(key in selection.args)) checkValue(undefined, argType);
        const child = baseType(definition.type);
        if (schema[child]) { if (!selection.selections.length) throw new Error(`Field ${selection.name} requires selections`); validate(child, selection.selections); }
        else if (selection.selections.length) throw new Error(`Field ${selection.name} cannot have selections`);
      }
    }
    const root = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    validate(root, operation.selections);
    function project(parent: ObjectValue | null, selections: Selection[]): any {
      if (parent == null) return null;
      const result: Record<string, any> = {};
      for (const selection of selections) {
        if (selection.fragment) { if (parent.type === selection.fragment || selection.fragment === 'Node') Object.assign(result, project(parent, selection.selections)); continue; }
        const args = Object.fromEntries(Object.entries(selection.args).map(([key, value]) => [key, evaluate(value)]));
        const value = resolve(store, parent, selection.name, args);
        result[selection.alias] = selection.selections.length ? Array.isArray(value) ? value.map((entry) => project(entry, selection.selections)) : project(value, selection.selections) : value;
      }
      return result;
    }
    return { data: project(object(root, {})!, operation.selections) };
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}
