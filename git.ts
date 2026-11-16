import { createHash } from 'node:crypto';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';
// Raw bytes are shared by REST-created objects and smart HTTP packs.
export interface GitObject { type: ObjectType; data: Buffer; }
export interface TreeEntry { mode: string; name: string; sha: string; }

export function objectSha(type: ObjectType, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

export function saveObject(objects: Map<string, GitObject>, type: ObjectType, data: Buffer): string {
  const sha = objectSha(type, data);
  objects.set(sha, { type, data: Buffer.from(data) });
  return sha;
}

// Gregorian calendar arithmetic, without consulting the host clock.
export function isoEpoch(iso: string): number {
  const fields = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(iso);
  if (!fields) throw new TypeError('Expected a UTC ISO timestamp');
  const [year, month, day, hour, minute, second] = fields.slice(1).map(Number) as [number, number, number, number, number, number];
  const leap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const beforeYear = (y: number) => 365 * (y - 1) + Math.floor((y - 1) / 4) - Math.floor((y - 1) / 100) + Math.floor((y - 1) / 400);
  const months = [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > months[month - 1]! || hour > 23 || minute > 59 || second > 59) throw new TypeError('Invalid UTC timestamp');
  const days = beforeYear(year) - beforeYear(1970) + months.slice(0, month - 1).reduce((a, b) => a + b, 0) + day - 1;
  return days * 86400 + hour * 3600 + minute * 60 + second;
}

export function buildTree(objects: Map<string, GitObject>, files: Map<string, Buffer>): string {
  const build = (prefix: string): string => {
    const children = new Map<string, TreeEntry>();
    for (const [path, bytes] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      if (children.has(name)) continue;
      children.set(name, slash < 0
        ? { name, mode: '100644', sha: saveObject(objects, 'blob', bytes) }
        : { name, mode: '40000', sha: build(`${prefix}${name}/`) });
    }
    const entries = [...children.values()].sort((a, b) => Buffer.compare(
      Buffer.from(a.name + (a.mode === '40000' ? '/' : '')),
      Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))));
    return saveObject(objects, 'tree', Buffer.concat(entries.map((entry) => Buffer.concat([
      Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.sha, 'hex'),
    ]))));
  };
  return build('');
}

export function readTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    const nul = data.indexOf(0, space + 1);
    if (space < offset || nul < space || nul + 21 > data.length) throw new Error('Invalid tree object');
    entries.push({ mode: data.toString('ascii', offset, space), name: data.toString('utf8', space + 1, nul), sha: data.subarray(nul + 1, nul + 21).toString('hex') });
    offset = nul + 21;
  }
  return entries;
}
