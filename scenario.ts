// Small identity derivation from the kit's program/env/src/wire.ts (published scenario).
export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const MASK = 0xffffffffffffffffn;

export function fnv1a64(label: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < label.length; i += 1) {
    hash = ((hash ^ BigInt(label.charCodeAt(i))) * 0x100000001b3n) & MASK;
  }
  return hash;
}

export function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}

export class Rng {
  #state: bigint;
  constructor(seed: bigint) { this.#state = (seed & MASK) || SCENARIO_SEED; }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & MASK;
    x = (x ^ (x << 25n)) & MASK;
    x = (x ^ (x >> 27n)) & MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK;
  }
  nextInt(max: number): number {
    if (!Number.isSafeInteger(max) || max < 1) throw new Error('Expected a positive safe integer');
    if (max === 1) return 0;
    const limit = 0x100000000 - (0x100000000 % max);
    for (;;) {
      const value = Number(this.nextU64() >> 32n);
      if (value < limit) return value % max;
    }
  }
  pick<T>(items: readonly T[]): T { return items[this.nextInt(items.length)]!; }
}

export function scenarioRng(label: string): Rng {
  return new Rng(mix64(SCENARIO_SEED ^ fnv1a64(label)));
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
const ADJECTIVES = [
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
];
const NOUNS = [
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
];

export interface User { readonly id: number; readonly login: string; readonly name: string; readonly email: string; }
export function generateUsers(rng: Rng, count: number): User[] {
  const used = new Set<string>();
  return Array.from({ length: Math.max(0, Math.trunc(count)) }, (_, index) => {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) login = `${base}-${suffix++}`;
    used.add(login);
    return Object.freeze({ id: 1000 + index, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  });
}

export const users = generateUsers(scenarioRng('users'), 12);
export const viewer = users[0]!;
const orgRng = scenarioRng('org');
export const org = `${orgRng.pick(ADJECTIVES)}-${orgRng.pick(NOUNS)}-org`;

export function checkScenario(): void {
  const expected = ['adaiversen', 'quinnkeller', 'olgabauer'];
  const ok = expected.every((login, index) => users[index]?.login === login && users[index]?.id === 1000 + index)
    && org === 'faint-meadow-org';
  process.stderr.write(`[scenario] identity self-check ${ok ? 'OK' : 'MISMATCH'}: ${users.slice(0, 3).map((u) => `${u.login} (${u.id})`).join(', ')}; ${org}\n`);
}
