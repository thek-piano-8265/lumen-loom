/**
 * Lumen Loom — pure puzzle logic (no three.js, no DOM).
 *
 * The loom is a 9 x 9 grid of cells. Light travels in one of eight
 * directions (k * 45 degrees). Mirrors sit on sockets and have one of eight
 * line angles (m * 22.5 degrees). A beam moving in direction k that meets a
 * mirror with angle m leaves in direction (m - k) mod 8. When the beam runs
 * parallel to the mirror, that formula returns k again, so it simply passes.
 */

export const GRID = 9;

export type Cell = readonly [number, number];

export const DIRS: ReadonlyArray<Cell> = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

export type PieceKind = 'mirror' | 'splitter';

export interface PieceDef {
  kind: PieceKind;
  cell: Cell;
  m: number;
  movable?: boolean;
}

export interface SeedDef {
  cell: Cell;
  twin?: boolean;
}

export interface LevelDef {
  id: string;
  title: string;
  hint: string;
  source: { cell: Cell; dir: number };
  pieces: PieceDef[];
  seeds: SeedDef[];
  stones: Cell[];
  /** Empty sockets a movable piece can be carried to. */
  sockets: Cell[];
}

export interface Piece {
  kind: PieceKind;
  c: number;
  r: number;
  m: number;
  movable: boolean;
}

export interface Segment {
  from: [number, number];
  to: [number, number];
  /** true when the segment leaves the loom (drawn fading). */
  exits: boolean;
}

export interface TraceResult {
  segments: Segment[];
  litSeeds: boolean[];
  solved: boolean;
}

const mod8 = (v: number) => ((v % 8) + 8) % 8;

export const inside = (c: number, r: number) =>
  c >= 0 && r >= 0 && c < GRID && r < GRID;

export function key(c: number, r: number) {
  return c * GRID + r;
}

export function reflect(dir: number, m: number) {
  return mod8(m - dir);
}

export function trace(level: LevelDef, pieces: Piece[]): TraceResult {
  const pieceAt = new Map<number, Piece>();
  for (const p of pieces) pieceAt.set(key(p.c, p.r), p);
  const stoneAt = new Set(level.stones.map(([c, r]) => key(c, r)));
  const seedIndex = new Map<number, number>();
  level.seeds.forEach((s, i) => seedIndex.set(key(s.cell[0], s.cell[1]), i));
  const seedDirs: Array<Set<number>> = level.seeds.map(() => new Set());

  const segments: Segment[] = [];
  const visited = new Set<number>();
  const queue: Array<[number, number, number]> = [];
  const [sc, sr] = level.source.cell;
  queue.push([sc, sr, level.source.dir]);

  let guard = 0;
  while (queue.length > 0 && guard++ < 400) {
    const [c0, r0, d] = queue.shift()!;
    let c = c0;
    let r = r0;
    // walk until something changes the beam
    for (;;) {
      const nc = c + DIRS[d][0];
      const nr = r + DIRS[d][1];
      if (!inside(nc, nr)) {
        segments.push({
          from: [c0, r0],
          to: [nc - DIRS[d][0] * 0.5, nr - DIRS[d][1] * 0.5],
          exits: true,
        });
        break;
      }
      const k = key(nc, nr);
      if (stoneAt.has(k)) {
        segments.push({
          from: [c0, r0],
          to: [nc - DIRS[d][0] * 0.42, nr - DIRS[d][1] * 0.42],
          exits: false,
        });
        break;
      }
      const si = seedIndex.get(k);
      if (si !== undefined) seedDirs[si].add(d);
      const p = pieceAt.get(k);
      if (p) {
        segments.push({ from: [c0, r0], to: [nc, nr], exits: false });
        const out = reflect(d, p.m);
        const stateKeys: number[] = [];
        if (p.kind === 'mirror') {
          stateKeys.push(out);
        } else {
          stateKeys.push(d);
          if (out !== d) stateKeys.push(out);
        }
        for (const nd of stateKeys) {
          const sk = k * 8 + nd;
          if (!visited.has(sk)) {
            visited.add(sk);
            queue.push([nc, nr, nd]);
          }
        }
        break;
      }
      c = nc;
      r = nr;
    }
  }

  const litSeeds = level.seeds.map((s, i) =>
    s.twin ? seedDirs[i].size >= 2 : seedDirs[i].size >= 1,
  );
  return { segments, litSeeds, solved: litSeeds.every(Boolean) };
}

export function piecesFromLevel(level: LevelDef): Piece[] {
  return level.pieces.map((p) => ({
    kind: p.kind,
    c: p.cell[0],
    r: p.cell[1],
    m: p.m,
    movable: !!p.movable,
  }));
}

/** Brute-force check used by the level tests and the daily generator. */
export function isSolvable(level: LevelDef): boolean {
  const base = piecesFromLevel(level);
  const sockets: Cell[] = [
    ...level.sockets,
    ...base.filter((p) => p.movable).map((p) => [p.c, p.r] as Cell),
  ];
  const movable = base.filter((p) => p.movable);
  const placements: Array<Cell[]> = [];
  const pick = (i: number, used: Set<number>, acc: Cell[]) => {
    if (i === movable.length) {
      placements.push([...acc]);
      return;
    }
    for (const s of sockets) {
      const k = key(s[0], s[1]);
      if (used.has(k)) continue;
      used.add(k);
      acc.push(s);
      pick(i + 1, used, acc);
      acc.pop();
      used.delete(k);
    }
  };
  pick(0, new Set(), []);
  for (const place of placements) {
    const pcs = base.map((p) => ({ ...p }));
    let mi = 0;
    for (const p of pcs) {
      if (p.movable) {
        p.c = place[mi][0];
        p.r = place[mi][1];
        mi++;
      }
    }
    const n = pcs.length;
    const total = 8 ** n;
    for (let code = 0; code < total; code++) {
      let x = code;
      for (const p of pcs) {
        p.m = x % 8;
        x = Math.floor(x / 8);
      }
      if (trace(level, pcs).solved) return true;
    }
  }
  return false;
}

export const LEVELS: LevelDef[] = [
  {
    id: 'first-light',
    title: 'I · First Light',
    hint: 'Pinch the mirror and turn your wrist',
    source: { cell: [0, 4], dir: 0 },
    pieces: [{ kind: 'mirror', cell: [4, 4], m: 0 }],
    seeds: [{ cell: [4, 8] }],
    stones: [],
    sockets: [],
  },
  {
    id: 'around-the-stone',
    title: 'II · Around the Stone',
    hint: 'Two turns. Or tap a mirror to step it',
    source: { cell: [0, 1], dir: 0 },
    pieces: [
      { kind: 'mirror', cell: [3, 1], m: 0 },
      { kind: 'mirror', cell: [3, 7], m: 5 },
    ],
    seeds: [{ cell: [8, 7] }],
    stones: [[6, 1], [6, 4]],
    sockets: [],
  },
  {
    id: 'carry',
    title: 'III · Carry the Light',
    hint: 'Pinch, lift and set the mirror in a socket',
    source: { cell: [4, 0], dir: 2 },
    pieces: [{ kind: 'mirror', cell: [7, 2], m: 6, movable: true }],
    seeds: [{ cell: [0, 6] }],
    stones: [[4, 8]],
    sockets: [[4, 6], [2, 3]],
  },
  {
    id: 'split',
    title: 'IV · One Becomes Two',
    hint: 'A prism lets light pass and turn at once',
    source: { cell: [0, 4], dir: 0 },
    pieces: [{ kind: 'splitter', cell: [4, 4], m: 0 }],
    seeds: [{ cell: [8, 4] }, { cell: [4, 8] }],
    stones: [[4, 0]],
    sockets: [],
  },
  {
    id: 'twin',
    title: 'V · Twin Seed',
    hint: 'A twin seed blooms only when light meets it twice',
    source: { cell: [0, 2], dir: 0 },
    pieces: [
      { kind: 'splitter', cell: [2, 2], m: 0 },
      { kind: 'mirror', cell: [6, 2], m: 7 },
      { kind: 'mirror', cell: [2, 6], m: 4 },
    ],
    seeds: [{ cell: [6, 6], twin: true }],
    stones: [[8, 2]],
    sockets: [],
  },
  {
    id: 'the-loom',
    title: 'VI · The Loom',
    hint: 'Three seeds, one beam',
    source: { cell: [8, 1], dir: 4 },
    pieces: [
      { kind: 'splitter', cell: [5, 1], m: 0 },
      { kind: 'mirror', cell: [1, 1], m: 3 },
      { kind: 'mirror', cell: [4, 4], m: 0, movable: true },
    ],
    seeds: [{ cell: [1, 5] }, { cell: [7, 7] }, { cell: [7, 3] }],
    stones: [[3, 3], [6, 5]],
    sockets: [[1, 7], [6, 7]],
  },
];

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function dateSeed(d: Date) {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/**
 * Daily Weave: a fresh puzzle for every calendar day, identical for every
 * player on that day. Built backwards from a random light path so it is
 * always solvable, then scrambled.
 */
export function dailyLevel(seed: number): LevelDef {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rand = rng(seed * 7919 + attempt);
    const ri = (n: number) => Math.floor(rand() * n);
    const edge = ri(4);
    const p = 1 + ri(GRID - 2);
    const start: Cell =
      edge === 0 ? [0, p] : edge === 1 ? [GRID - 1, p] : edge === 2 ? [p, 0] : [p, GRID - 1];
    const startDir = edge === 0 ? 0 : edge === 1 ? 4 : edge === 2 ? 2 : 6;
    const used = new Set<number>([key(start[0], start[1])]);
    const turns: PieceDef[] = [];
    const seeds: SeedDef[] = [];
    let c = start[0];
    let r = start[1];
    let d = startDir;
    const nTurns = 2 + ri(2);
    let ok = true;
    for (let t = 0; t <= nTurns; t++) {
      const len = 2 + ri(3);
      for (let s = 0; s < len; s++) {
        c += DIRS[d][0];
        r += DIRS[d][1];
        if (!inside(c, r) || used.has(key(c, r))) {
          ok = false;
          break;
        }
        used.add(key(c, r));
      }
      if (!ok) break;
      if (t === nTurns) {
        seeds.push({ cell: [c, r] });
        break;
      }
      // choose a new direction (orthogonal or diagonal turn)
      const choices = [1, 2, 3, 5, 6, 7].map((x) => mod8(d + x));
      const nd = choices[ri(choices.length)];
      // mirror angle m such that reflect(d, m) === nd  ->  m = nd + d
      const m = mod8(nd + d);
      turns.push({ kind: 'mirror', cell: [c, r], m });
      d = nd;
    }
    if (!ok || seeds.length === 0 || turns.length < 2) continue;
    // a seed half way along the path too
    const mid = turns[Math.floor(turns.length / 2)].cell;
    const level: LevelDef = {
      id: `daily-${seed}`,
      title: 'Daily Weave',
      hint: 'A new loom every day. Same puzzle for everyone',
      source: { cell: start, dir: startDir },
      pieces: turns.map((tp) => ({ ...tp, m: mod8(tp.m + 2 + ri(5)) })),
      seeds,
      stones: [],
      sockets: [],
    };
    // decoy stones away from the path
    for (let s = 0; s < 3; s++) {
      const sc = 1 + ri(GRID - 2);
      const sr = 1 + ri(GRID - 2);
      if (!used.has(key(sc, sr)) && !(sc === mid[0] && sr === mid[1])) {
        level.stones.push([sc, sr]);
      }
    }
    // must be solvable with the true angles and unsolved as scrambled
    const solvedPieces = piecesFromLevel(level).map((pc, i) => ({ ...pc, m: turns[i].m }));
    if (!trace(level, solvedPieces).solved) continue;
    if (trace(level, piecesFromLevel(level)).solved) continue;
    return level;
  }
  return LEVELS[0];
}
