import { users, viewer } from './scenario.ts';
import type { User } from './scenario.ts';
import { objectSha, saveObject, buildTree, readTree, isoEpoch, type GitObject } from './git.ts';

export interface StoredCommit { sha: string; tree: string; message: string; parents: string[]; files: Map<string, Buffer>; }
export interface Comment { id: number; body: string; user: { login: string; id: number }; created_at: string; updated_at: string; }
export interface Issue {
  id: number; node_id: string; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; user: { login: string; id: number }; created_at: string; updated_at: string; comments: Comment[];
}
export interface PullRequest extends Omit<Issue, 'labels' | 'comments'> {
  head: { ref: string; sha: string }; base: { ref: string; sha: string };
  merged: boolean; merged_at: string | null; merge_commit_sha: string | null;
}
export interface Result { status: number; body: any; }
const failure = (status: number, message: string): Result => ({ status, body: { message } });
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
export interface Repository {
  id: number;
  node_id: string;
  owner: User;
  name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  branches: Map<string, string>;
  tags: Map<string, string>;
  commits: Map<string, StoredCommit>;
  branchFiles: Map<string, Map<string, Buffer>>;
  objects: Map<string, GitObject>;
  nextNumber: number;
  nextCommentId: number;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
}

export interface CreateRepository {
  name: string;
  description?: string | null;
  private?: boolean;
  default_branch?: string;
}

export class Store {
  readonly users = new Map(users.map((user) => [user.login, user]));
  readonly repositories = new Map<string, Repository>();
  readonly now = process.env.MAKEFUN_TRIAL_NOW || '2026-11-14T06:30:00.000Z';
  readonly counters = { repository: 1 };

  key(owner: string, name: string): string { return `${owner}/${name}`.toLowerCase(); }
  getRepository(owner: string, name: string): Repository | undefined {
    return this.repositories.get(this.key(owner, name));
  }
  listRepositories(owner = viewer.login): Repository[] {
    return [...this.repositories.values()].filter((repo) => repo.owner.login === owner);
  }

  getBlobSha(content: Buffer): string { return objectSha('blob', content); }
  createLabel(repo: Repository, body: Record<string, unknown>): Result {
    if (!nonempty(body.name) || (body.color !== undefined && typeof body.color !== 'string')) return failure(422, 'Invalid label');
    const label = repo.labels.get(body.name) ?? { name: body.name, color: (body.color as string | undefined) ?? 'ededed' };
    repo.labels.set(label.name, label);
    return { status: 201, body: label };
  }
  resourceFields(repo: Repository, title: string, body: unknown, kind: string) {
    const number = repo.nextNumber++;
    return { id: number, node_id: Buffer.from(`${kind}:${repo.id}:${number}`).toString('base64'), number,
      title, body: typeof body === 'string' ? body : '', state: 'open' as const,
      user: { login: viewer.login, id: viewer.id }, created_at: this.now, updated_at: this.now };
  }
  createIssue(repo: Repository, body: Record<string, unknown>): Result {
    if (!nonempty(body.title) || (body.body !== undefined && typeof body.body !== 'string')) return failure(422, 'Invalid issue fields');
    const labels = body.labels ?? [];
    if (!Array.isArray(labels) || labels.some((name) => typeof name !== 'string' || !repo.labels.has(name))) return failure(422, 'Unknown label');
    const issue: Issue = { ...this.resourceFields(repo, body.title, body.body, 'Issue'), labels: [...labels], comments: [] };
    repo.issues.set(issue.number, issue);
    return { status: 201, body: issue };
  }
  listResources(repo: Repository, pulls: boolean, state = 'open', ascending = false): (Issue | PullRequest)[] {
    const items: (Issue | PullRequest)[] = pulls ? [...repo.pulls.values()] : [...repo.issues.values()];
    return items.filter((item) => state === 'all' || item.state === state)
      .sort((a, b) => ascending ? a.number - b.number : b.number - a.number);
  }
  patchIssue(repo: Repository, number: number, body: Record<string, unknown>): Result {
    const issue = repo.issues.get(number);
    if (!issue) return failure(404, 'Not Found');
    if ((body.state !== undefined && body.state !== 'open' && body.state !== 'closed')
      || (body.title !== undefined && !nonempty(body.title))
      || (body.body !== undefined && typeof body.body !== 'string')) return failure(422, 'Invalid issue fields');
    if (body.state !== undefined) issue.state = body.state as Issue['state'];
    if (body.title !== undefined) issue.title = body.title as string;
    if (body.body !== undefined) issue.body = body.body as string;
    issue.updated_at = this.now;
    return { status: 200, body: issue };
  }
  createComment(repo: Repository, number: number, body: Record<string, unknown>): Result {
    const issue = repo.issues.get(number);
    if (!issue) return failure(404, 'Not Found');
    if (!nonempty(body.body)) return failure(422, 'Invalid comment body');
    const comment: Comment = { id: repo.nextCommentId++, body: body.body, user: { login: viewer.login, id: viewer.id },
      created_at: this.now, updated_at: this.now };
    issue.comments.push(comment);
    issue.updated_at = this.now;
    return { status: 201, body: comment };
  }
  createPull(repo: Repository, body: Record<string, unknown>): Result {
    if (!nonempty(body.title) || typeof body.head !== 'string' || typeof body.base !== 'string'
      || body.head === body.base || !repo.branches.has(body.head) || !repo.branches.has(body.base)
      || (body.body !== undefined && typeof body.body !== 'string')) return failure(422, 'Invalid pull request fields');
    const pull: PullRequest = { ...this.resourceFields(repo, body.title, body.body, 'PullRequest'),
      head: { ref: body.head, sha: repo.branches.get(body.head)! }, base: { ref: body.base, sha: repo.branches.get(body.base)! },
      merged: false, merged_at: null, merge_commit_sha: null };
    repo.pulls.set(pull.number, pull);
    return { status: 201, body: pull };
  }
  mergeBase(repo: Repository, head: string, base: string): string | undefined {
    const distances = (tip: string) => {
      const found = new Map<string, number>();
      const queue: [string, number][] = [[tip, 0]];
      for (let i = 0; i < queue.length; i++) {
        const [sha, distance] = queue[i]!;
        if (found.has(sha)) continue;
        found.set(sha, distance);
        for (const parent of repo.commits.get(sha)?.parents ?? []) queue.push([parent, distance + 1]);
      }
      return found;
    };
    const a = distances(head), b = distances(base);
    return [...a.keys()].filter((sha) => b.has(sha)).sort((x, y) =>
      (a.get(x)! + b.get(x)!) - (a.get(y)! + b.get(y)!) || x.localeCompare(y))[0];
  }
  pullDiff(repo: Repository, pull: PullRequest) {
    const headSha = repo.branches.get(pull.head.ref) ?? pull.head.sha;
    const baseSha = repo.branches.get(pull.base.ref) ?? pull.base.sha;
    const ancestor = this.mergeBase(repo, headSha, baseSha);
    const before = repo.commits.get(ancestor ?? '')?.files ?? new Map<string, Buffer>();
    const head = repo.commits.get(headSha)!.files;
    const base = repo.commits.get(baseSha)!.files;
    const equal = (a: Buffer | undefined, b: Buffer | undefined) => a === undefined ? b === undefined : b !== undefined && a.equals(b);
    const paths = [...new Set([...before.keys(), ...head.keys()])].filter((path) => !equal(before.get(path), head.get(path))).sort();
    const conflicted = paths.some((path) => !equal(base.get(path), before.get(path)) && !equal(base.get(path), head.get(path)));
    return { paths, before, head, base, baseSha, conflicted };
  }
  pullFiles(repo: Repository, pull: PullRequest) {
    const diff = this.pullDiff(repo, pull);
    return diff.paths.map((filename) => {
      const old = diff.before.get(filename), next = diff.head.get(filename);
      const a = old === undefined ? [] : old.toString('utf8').split('\n');
      const b = next === undefined ? [] : next.toString('utf8').split('\n');
      // Match line occurrences, retaining counts when a line appears more than once.
      const remaining = new Map<string, number>();
      for (const line of a) remaining.set(line, (remaining.get(line) ?? 0) + 1);
      let additions = 0;
      for (const line of b) {
        const count = remaining.get(line) ?? 0;
        if (count) remaining.set(line, count - 1); else additions++;
      }
      const deletions = [...remaining.values()].reduce((sum, count) => sum + count, 0);
      return { filename, status: old === undefined ? 'added' : next === undefined ? 'removed' : 'modified',
        additions, deletions, changes: additions + deletions, sha: this.getBlobSha(next ?? old!) };
    });
  }
  mergePull(repo: Repository, number: number): Result {
    const pull = repo.pulls.get(number);
    if (!pull) return failure(404, 'Not Found');
    if (pull.state !== 'open' || pull.merged) return failure(405, 'Pull request is closed');
    const diff = this.pullDiff(repo, pull);
    if (diff.conflicted) return failure(405, 'Pull request has conflicts');
    const files = this.copyFiles(diff.base);
    for (const path of diff.paths) {
      const bytes = diff.head.get(path);
      if (bytes === undefined) files.delete(path); else files.set(path, Buffer.from(bytes));
    }
    const message = `${pull.title} (#${pull.number})`;
    const sha = this.createCommit(repo, { message, parents: [diff.baseSha], files, branch: pull.base.ref });
    pull.state = 'closed'; pull.merged = true; pull.merged_at = this.now;
    pull.updated_at = this.now; pull.merge_commit_sha = sha;
    return { status: 200, body: { merged: true, sha, message } };
  }
  changeContent(repo: Repository, path: string, body: Record<string, unknown>, remove = false): { status: number; body: Record<string, unknown> } {
    const error = (status: number, message: string) => ({ status, body: { message } });
    if (!path || path.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\0'))
      || typeof body.message !== 'string' || (body.branch !== undefined && typeof body.branch !== 'string')) return error(400, 'Invalid content fields');
    const branch = (body.branch as string | undefined) ?? repo.default_branch;
    const tip = repo.branches.get(branch);
    if (!tip && (repo.commits.size !== 0 || branch !== repo.default_branch)) return error(404, 'Not Found');
    let bytes: Buffer | undefined;
    if (!remove) {
      if (typeof body.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.content)) return error(400, 'Invalid base64 content');
      bytes = Buffer.from(body.content, 'base64');
      if (bytes.toString('base64') !== body.content) return error(400, 'Invalid base64 content');
    }
    const current = this.getFileAt(repo, branch, path);
    if (remove && !current) return error(404, 'Not Found');
    if ((body.sha !== undefined && body.sha !== current?.blobSha) || (current && body.sha === undefined)) return error(409, 'Content SHA does not match');
    const files = this.copyFiles(tip ? repo.commits.get(tip)!.files : new Map());
    if (!remove && [...files.keys()].some((name) => name.startsWith(`${path}/`) || path.startsWith(`${name}/`))) return error(409, 'File and directory conflict');
    if (remove) files.delete(path); else files.set(path, bytes!);
    const sha = this.createCommit(repo, { message: body.message, parents: tip ? [tip] : [], files, branch });
    return { status: remove || current ? 200 : 201, body: {
      ...(remove ? {} : { content: { type: 'file', name: path.split('/').at(-1), path, sha: this.getBlobSha(bytes!), encoding: 'base64', size: bytes!.length } }),
      commit: { sha },
    } };
  }
  getCommit(sha: string, repo?: Repository): StoredCommit | undefined {
    if (repo) return repo.commits.get(sha);
    for (const candidate of this.repositories.values()) {
      const commit = candidate.commits.get(sha);
      if (commit) return commit;
    }
  }
  getTree(sha: string, repo?: Repository) {
    const object = repo ? repo.objects.get(sha) : [...this.repositories.values()].map((r) => r.objects.get(sha)).find(Boolean);
    return object?.type === 'tree' ? readTree(object.data) : undefined;
  }
  resolveRef(repo: Repository, ref: string): string | undefined {
    return repo.branches.get(ref) ?? (/^[a-fA-F0-9]{40}$/.test(ref) && repo.commits.has(ref.toLowerCase()) ? ref.toLowerCase() : undefined);
  }
  createBranch(repo: Repository, branch: string, sha: string): boolean {
    const commit = repo.commits.get(sha);
    if (!commit || repo.branches.has(branch)) return false;
    repo.branches.set(branch, sha);
    repo.branchFiles.set(branch, this.copyFiles(commit.files));
    return true;
  }
  copyFiles(files: Map<string, Buffer>): Map<string, Buffer> {
    return new Map([...files].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  }
  createCommit(repo: Repository, input: { message: string; parents: string[]; files: Map<string, Buffer>; branch: string }): string {
    const files = this.copyFiles(input.files);
    const tree = buildTree(repo.objects, files);
    const identity = `${repo.owner.login} <${repo.owner.login}@example.invalid> ${isoEpoch(this.now)} +0000`;
    const data = Buffer.from(`tree ${tree}\n${input.parents.map((sha) => `parent ${sha}\n`).join('')}author ${identity}\ncommitter ${identity}\n\n${input.message}\n`);
    const sha = saveObject(repo.objects, 'commit', data);
    repo.commits.set(sha, { sha, tree, message: input.message, parents: [...input.parents], files });
    repo.branches.set(input.branch, sha);
    repo.branchFiles.set(input.branch, this.copyFiles(files));
    repo.updated_at = this.now;
    return sha;
  }
  getFileAt(repo: Repository, ref: string, path: string) {
    const sha = this.resolveRef(repo, ref);
    const bytes = sha ? repo.commits.get(sha)?.files.get(path) : undefined;
    return bytes ? { bytes: Buffer.from(bytes), blobSha: this.getBlobSha(bytes) } : undefined;
  }
  listDirAt(repo: Repository, ref: string, dirPath: string) {
    const commit = repo.commits.get(this.resolveRef(repo, ref) ?? '');
    if (!commit) return undefined;
    let treeSha = commit.tree;
    for (const name of dirPath.split('/').filter(Boolean)) {
      const entry = this.getTree(treeSha, repo)?.find((item) => item.name === name && item.mode === '40000');
      if (!entry) return undefined;
      treeSha = entry.sha;
    }
    return this.getTree(treeSha, repo)?.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file', name: entry.name,
      path: dirPath ? `${dirPath}/${entry.name}` : entry.name, sha: entry.sha,
      ...(entry.mode === '40000' ? {} : { size: repo.objects.get(entry.sha)!.data.length }),
    }));
  }

  createRepository(input: CreateRepository, owner: User = viewer): Repository {
    const key = this.key(owner.login, input.name);
    if (this.repositories.has(key)) throw new Error('Repository already exists');
    const id = this.counters.repository++;
    const repo: Repository = {
      id, node_id: Buffer.from(`Repository:${id}`).toString('base64'), owner,
      name: input.name, description: input.description ?? null, private: input.private ?? false,
      default_branch: input.default_branch ?? 'main', created_at: this.now, updated_at: this.now,
      branches: new Map(), tags: new Map(), commits: new Map(), branchFiles: new Map(), objects: new Map(),
      nextNumber: 1, nextCommentId: 1, labels: new Map(), issues: new Map(), pulls: new Map(),
    };
    this.repositories.set(key, repo);
    return repo;
  }
}
