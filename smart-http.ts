import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, Repository } from './store.ts';
import { objectSha, readTree, type GitObject, type ObjectType } from './git.ts';

export const ZERO = '0'.repeat(40);
const flush = Buffer.from('0000'), delim = Buffer.from('0001');
export function pkt(value: string | Buffer): Buffer {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (data.length > 65516) throw new Error('Packet too large');
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}
export function packets(data: Buffer): { lines: string[]; offset: number } {
  const lines: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    const header = data.toString('ascii', offset, offset + 4);
    if (!/^[a-fA-F0-9]{4}$/.test(header)) throw new Error('Invalid packet header');
    const size = parseInt(header, 16);
    offset += 4;
    if (size === 0) return { lines, offset };
    if (size === 1 || size === 2) continue;
    if (size < 4 || size > 65520 || offset + size - 4 > data.length) throw new Error('Invalid packet size');
    lines.push(data.toString('utf8', offset, offset + size - 4).replace(/\n$/, ''));
    offset += size - 4;
  }
  throw new Error('Missing flush');
}
const types: ObjectType[] = ['commit', 'tree', 'blob', 'tag'];
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects], header = Buffer.alloc(12);
  header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(list.length, 8);
  const parts = [header];
  for (const object of list) {
    let size = object.data.length;
    const bytes = [(types.indexOf(object.type) + 1) * 16 + size % 16];
    size = Math.floor(size / 16);
    while (size) { bytes[bytes.length - 1] |= 128; bytes.push(size % 128); size = Math.floor(size / 128); }
    parts.push(Buffer.from(bytes), deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const byte = () => { if (at >= delta.length) throw new Error('Truncated delta'); return delta[at++]; };
  const integer = () => { let value = 0, scale = 1, n: number; do { n = byte(); value += (n & 127) * scale; scale *= 128; if (!Number.isSafeInteger(value)) throw new Error('Delta size overflow'); } while (n & 128); return value; };
  if (integer() !== base.length) throw new Error('Delta base size');
  const target = integer(), chunks: Buffer[] = [];
  while (at < delta.length) {
    const op = byte();
    if (op & 128) {
      let start = 0, length = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) start += byte() * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (16 << i)) length += byte() * 2 ** (8 * i);
      length ||= 65536;
      if (start + length > base.length) throw new Error('Delta copy range');
      chunks.push(base.subarray(start, start + length));
    } else {
      if (!op || at + op > delta.length) throw new Error('Delta insert range');
      chunks.push(delta.subarray(at, at + op)); at += op;
    }
  }
  const result = Buffer.concat(chunks);
  if (result.length !== target) throw new Error('Delta result size');
  return result;
}

export function readPack(data: Buffer, existing = new Map<string, GitObject>()): Map<string, GitObject> {
  const end = data.length - 20;
  if (data.length < 32 || data.toString('ascii', 0, 4) !== 'PACK' || ![2, 3].includes(data.readUInt32BE(4))) throw new Error('Invalid pack header');
  if (!createHash('sha1').update(data.subarray(0, end)).digest().equals(data.subarray(end))) throw new Error('Pack checksum mismatch');
  let at = 12;
  const byte = () => { if (at >= end) throw new Error('Truncated pack'); return data[at++]; };
  const entries: { offset: number; code: number; data: Buffer; base?: number | string; object?: GitObject }[] = [];
  for (let i = 0; i < data.readUInt32BE(8); i++) {
    const offset = at;
    let n = byte(), size = n & 15, scale = 16;
    const code = (n >> 4) & 7;
    while (n & 128) { n = byte(); size += (n & 127) * scale; scale *= 128; if (!Number.isSafeInteger(size)) throw new Error('Pack size overflow'); }
    let base: number | string | undefined;
    if (code === 6) {
      n = byte(); let distance = n & 127;
      while (n & 128) { n = byte(); distance = (distance + 1) * 128 + (n & 127); }
      base = offset - distance;
    } else if (code === 7) {
      if (at + 20 > end) throw new Error('Truncated delta base');
      base = data.subarray(at, at + 20).toString('hex'); at += 20;
    } else if (code < 1 || code > 4) throw new Error('Unknown pack type');
    const inflated = inflateSync(data.subarray(at, end), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    at += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) throw new Error('Pack size mismatch');
    entries.push({ offset, code, data: inflated.buffer, base });
  }
  if (at !== end) throw new Error('Trailing pack bytes');
  const objects = new Map<string, GitObject>();
  let remaining = entries.length;
  while (remaining) {
    let progress = false;
    for (const entry of entries) {
      if (entry.object) continue;
      let object: GitObject;
      if (entry.code <= 4) object = { type: types[entry.code - 1], data: entry.data };
      else {
        const base = typeof entry.base === 'number' ? entries.find((item) => item.offset === entry.base)?.object : objects.get(entry.base!) ?? existing.get(entry.base!);
        if (!base) continue;
        object = { type: base.type, data: applyDelta(base.data, entry.data) };
      }
      entry.object = object; objects.set(objectSha(object.type, object.data), object); remaining--; progress = true;
    }
    if (!progress) throw new Error('Unresolved delta base');
  }
  return objects;
}

export function commitView(data: Buffer) {
  const text = data.toString('utf8'), split = text.indexOf('\n\n');
  const headers = (split < 0 ? text : text.slice(0, split)).split('\n');
  const tree = headers.find((line) => line.startsWith('tree '))?.slice(5) ?? '';
  const parents = headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7));
  if (!/^[a-f0-9]{40}$/.test(tree) || parents.some((oid) => !/^[a-f0-9]{40}$/.test(oid))) throw new Error('Invalid commit');
  return { tree, parents, message: split < 0 ? '' : text.slice(split + 2) };
}
function tagTarget(object: GitObject): string { return /^object ([a-f0-9]{40})$/m.exec(object.data.toString())?.[1] ?? ''; }
export function reachable(repo: Repository, roots: string[], depth = Infinity, shallow = new Set<string>()): Set<string> {
  const found = new Set<string>(), distances = new Map<string, number>();
  const queue: [string, number][] = roots.map((oid) => [oid, 0]);
  for (let i = 0; i < queue.length; i++) {
    const [oid, distance] = queue[i], object = repo.objects.get(oid);
    if (!object || distance >= depth || (distances.get(oid) ?? Infinity) <= distance) continue;
    found.add(oid); distances.set(oid, distance);
    if (object.type === 'commit') {
      const commit = commitView(object.data);
      queue.push([commit.tree, distance]);
      if (!shallow.has(oid)) for (const parent of commit.parents) queue.push([parent, distance + 1]);
    } else if (object.type === 'tag') queue.push([tagTarget(object), distance]);
    else if (object.type === 'tree') for (const entry of readTree(object.data)) if (entry.mode !== '160000') queue.push([entry.sha, distance]);
  }
  return found;
}
export function descendant(repo: Repository, tip: string, ancestor: string): boolean {
  const seen = new Set<string>(), queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object?.type === 'commit') queue.push(...commitView(object.data).parents);
  }
  return false;
}
function registerCommits(repo: Repository): void {
  const filesAt = (tree: string, prefix: string, files: Map<string, Buffer>, active = new Set<string>()) => {
    if (active.has(tree)) throw new Error('Tree cycle');
    active.add(tree);
    const object = repo.objects.get(tree);
    if (object?.type !== 'tree') throw new Error('Missing tree');
    for (const entry of readTree(object.data)) {
      if (entry.mode === '40000') filesAt(entry.sha, `${prefix}${entry.name}/`, files, active);
      else if (entry.mode !== '160000') {
        const blob = repo.objects.get(entry.sha);
        if (!blob) throw new Error('Missing blob');
        files.set(prefix + entry.name, blob.data);
      }
    }
    active.delete(tree);
  };
  for (const [sha, object] of repo.objects) if (object.type === 'commit' && !repo.commits.has(sha)) {
    const commit = commitView(object.data), files = new Map<string, Buffer>();
    filesAt(commit.tree, '', files);
    repo.commits.set(sha, { sha, ...commit, files });
  }
}
function refs(repo: Repository): [string, string][] {
  const result: [string, string][] = [];
  for (const [name, oid] of repo.branches) result.push([`refs/heads/${name}`, oid]);
  for (const [name, oid] of repo.tags) result.push([`refs/tags/${name}`, oid]);
  result.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const main = repo.branches.get('main');
  if (main) result.unshift(['HEAD', main]);
  return result;
}
function peeled(repo: Repository, oid: string): string | undefined {
  const seen = new Set<string>(); let changed = false;
  while (repo.objects.get(oid)?.type === 'tag' && !seen.has(oid)) { seen.add(oid); oid = tagTarget(repo.objects.get(oid)!); changed = true; }
  return changed ? oid : undefined;
}
function sideband(bytes: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += 65515) parts.push(pkt(Buffer.concat([Buffer.from([1]), bytes.subarray(i, i + 65515)])));
  return parts;
}
function upload(repo: Repository, body: Buffer): Buffer {
  const { lines, offset } = packets(body);
  if (offset !== body.length || !lines[0]?.startsWith('command=')) throw new Error('Expected v2 command');
  const args = new Set(lines.slice(1));
  const values = (key: string) => lines.filter((line) => line.startsWith(key + ' ')).map((line) => line.slice(key.length + 1));
  if (lines[0] === 'command=ls-refs') {
    const prefixes = values('ref-prefix'), parts: Buffer[] = [];
    for (const [name, oid] of refs(repo)) {
      if (prefixes.length && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
      const peel = args.has('peel') ? peeled(repo, oid) : undefined;
      parts.push(pkt(`${oid} ${name}${name === 'HEAD' && args.has('symrefs') ? ' symref-target:refs/heads/main' : ''}${peel ? ` peeled:${peel}` : ''}\n`));
    }
    if (!refs(repo).length && args.has('unborn') && (!prefixes.length || prefixes.some((p) => 'HEAD'.startsWith(p)))) parts.push(pkt('unborn HEAD symref-target:refs/heads/main\n'));
    return Buffer.concat([...parts, flush]);
  }
  if (lines[0] !== 'command=fetch') throw new Error('Unknown command');
  const depthText = values('deepen')[0], depth = depthText === undefined ? Infinity : Number(depthText);
  if (!(depth > 0)) throw new Error('Invalid depth');
  const oldShallow = new Set(values('shallow'));
  const held = reachable(repo, values('have'), Infinity, oldShallow);
  const included = reachable(repo, values('want'), depth);
  const present = new Set([...held, ...included]);
  const parts = [pkt('acknowledgments\n'), pkt('NAK\n'), delim];
  if (depthText !== undefined) {
    parts.push(pkt('shallow-info\n'));
    const complete = (oid: string) => {
      const object = repo.objects.get(oid);
      return object?.type === 'commit' && commitView(object.data).parents.every((parent) => present.has(parent));
    };
    for (const oid of [...included].sort()) if (repo.objects.get(oid)?.type === 'commit' && !complete(oid)) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of [...oldShallow].sort()) if (complete(oid)) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(delim);
  }
  const send = [...included].filter((oid) => !held.has(oid)).sort().map((oid) => repo.objects.get(oid)!);
  parts.push(pkt('packfile\n'), ...sideband(writePack(send)), flush);
  return Buffer.concat(parts);
}
function receive(repo: Repository, body: Buffer): Buffer {
  const { lines, offset } = packets(body);
  const commands = lines.map((line) => {
    const match = /^([a-f0-9]{40}) ([a-f0-9]{40}) (refs\/(?:heads|tags)\/[^\s\0]+)$/.exec(line.split('\0')[0].trim());
    if (!match) throw new Error('Invalid ref command');
    return { old: match[1], next: match[2], ref: match[3] };
  });
  const report: Buffer[] = [];
  try {
    const objects = offset < body.length ? readPack(body.subarray(offset), repo.objects) : new Map<string, GitObject>();
    for (const [oid, object] of objects) repo.objects.set(oid, object);
    registerCommits(repo);
    report.push(pkt('unpack ok\n'));
  } catch {
    return Buffer.concat([...sideband(Buffer.concat([pkt('unpack error invalid pack\n'), flush])), flush]);
  }
  for (const command of commands) {
    const heads = command.ref.startsWith('refs/heads/'), map = heads ? repo.branches : repo.tags;
    const name = command.ref.slice(heads ? 11 : 10), current = map.get(name) ?? ZERO;
    let reason = '';
    if (current !== command.old) reason = 'old value does not match';
    else if (command.next !== ZERO && !repo.objects.has(command.next)) reason = 'object not found';
    else if (current !== ZERO && command.next !== ZERO && !descendant(repo, command.next, current)) reason = 'non-fast-forward';
    if (reason) report.push(pkt(`ng ${command.ref} ${reason}\n`));
    else {
      if (command.next === ZERO) { map.delete(name); if (heads) repo.branchFiles.delete(name); }
      else { map.set(name, command.next); if (heads) repo.branchFiles.set(name, new Map(repo.commits.get(command.next)?.files ?? [])); }
      report.push(pkt(`ok ${command.ref}\n`));
    }
  }
  return Buffer.concat([...sideband(Buffer.concat([...report, flush])), flush]);
}
export async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, store: Store): Promise<boolean> {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!match) return false;
  const json = (status: number, message: string) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message })); };
  const repo = store.getRepository(match[1], match[2]);
  if (!repo) { json(404, 'Not Found'); return true; }
  try {
    let result: Buffer, service: string, suffix: string;
    if (req.method === 'GET' && match[3] === 'info/refs') {
      service = url.searchParams.get('service') ?? '';
      if (!['git-upload-pack', 'git-receive-pack'].includes(service)) throw new Error('Unknown service');
      suffix = 'advertisement';
      const parts = [pkt(`# service=${service}\n`), flush];
      if (service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2') {
        parts.push(...['version 2', 'agent=makefun-forge/1.0', 'ls-refs', 'fetch=shallow', 'object-format=sha1'].map((line) => pkt(line + '\n')));
      } else {
        const caps = service === 'git-receive-pack' ? 'report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0' : 'side-band-64k multi_ack_detailed thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=makefun-forge/1.0';
        const list = refs(repo);
        if (!list.length) parts.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
        for (let i = 0; i < list.length; i++) {
          const [name, oid] = list[i]; parts.push(pkt(`${oid} ${name}${i === 0 ? '\0' + caps : ''}\n`));
          const peel = name.startsWith('refs/tags/') ? peeled(repo, oid) : undefined;
          if (peel) parts.push(pkt(`${peel} ${name}^{}\n`));
        }
      }
      result = Buffer.concat([...parts, flush]);
    } else if (req.method === 'POST' && match[3] !== 'info/refs') {
      service = match[3]; suffix = 'result';
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      result = service === 'git-upload-pack' ? upload(repo, body) : receive(repo, body);
    } else { json(400, 'Invalid git request'); return true; }
    res.writeHead(200, { 'content-type': `application/x-${service}-${suffix}`, 'content-length': result.length }); res.end(result);
  } catch { json(400, 'Malformed git request'); }
  return true;
}
