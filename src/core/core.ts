/**
 * Faithful TypeScript port of the plugin's core.py — pure geometry, no
 * rendering dependency. Takes a keylist (or keyboard definition) and returns
 * explicit meshes:
 *
 *   vertices : [x, y, z][]
 *   faces    : number[][]   (indices into vertices, CCW viewed from outside)
 *
 * Builders: buildShell (plate, optionally with fused skirt walls),
 * buildWalls (separate recess frame), buildBaseplate, buildInserts,
 * plus transformMesh / assembly helpers.
 */

import { generateKeylist, isKeyboardDef } from './keylistGen';
import type {
  AssemblyEntry, Catalog, Entry, Face, KeyEntry, Keylist, Mesh,
  ResolvedInsert, Vec2, Vec3,
} from './types';

// ------------------------------------------------------------------ helpers

const rad = (d: number) => (d * Math.PI) / 180;

/**
 * Rotate p by Euler angles (degrees), OpenSCAD rotate([rx,ry,rz]) order:
 * Z first, then Y, then X.
 */
export function rotXYZ(p: Vec3, rxDeg: number, ryDeg: number, rzDeg: number): Vec3 {
  let [x, y, z] = p;
  const rz = rad(rzDeg), ry = rad(ryDeg), rx = rad(rxDeg);
  // Z
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  // Y
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  // X
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  return [x, y, z];
}

/** Key local frame -> world: rotate by key rotation, translate by key pos. */
function place(pLocal: Vec3, key: KeyEntry): Vec3 {
  const r = key.rotation;
  const [px, py, pz] = rotXYZ(pLocal, r.x, r.y, r.z);
  return [px + key.pos.x, py + key.pos.y, pz + key.pos.z];
}

function norm(a: Vec3): Vec3 {
  const m = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  if (m < 1e-12) return [0, 0, 0];
  return [a[0] / m, a[1] / m, a[2] / m];
}

/** Newell's method polygon normal (magnitude = 2x area — area-weights sums). */
function faceNormal(pts: Vec3[]): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0, z0] = pts[i];
    const [x1, y1, z1] = pts[(i + 1) % n];
    nx += (y0 - y1) * (z0 + z1);
    ny += (z0 - z1) * (x0 + x1);
    nz += (x0 - x1) * (y0 + y1);
  }
  return [nx, ny, nz];
}

// -------------------------------------------------------------- TopSurface

/**
 * Accumulates the keyboard's TOP surface as one connected mesh with a shared,
 * welded vertex pool, accumulating area-weighted normals per vertex so the
 * bottom can be offset a uniform thickness perpendicular to the top.
 */
export class TopSurface {
  private inv: number;
  private remap = new Map<string, number>();
  points: Vec3[] = [];
  normals: [number, number, number][] = [];
  faces: Face[] = [];
  /** Per welded vertex: override normal for the constant-thickness offset. */
  offsetNormal = new Map<number, Vec3>();

  constructor(weldTol = 1e-4) {
    this.inv = 1 / weldTol;
  }

  private key(p: Vec3): string {
    return `${Math.round(p[0] * this.inv)},${Math.round(p[1] * this.inv)},${Math.round(p[2] * this.inv)}`;
  }

  vert(p: Vec3): number {
    const k = this.key(p);
    let idx = this.remap.get(k);
    if (idx === undefined) {
      idx = this.points.length;
      this.remap.set(k, idx);
      this.points.push(p);
      this.normals.push([0, 0, 0]);
    }
    return idx;
  }

  /** Add a top face given world points (CCW from above). */
  face(worldPts: Vec3[]): Face | null {
    const idxs = worldPts.map(p => this.vert(p));
    if (new Set(idxs).size < 3) return null; // degenerate after welding
    const nrm = faceNormal(worldPts);
    for (const i of idxs) {
      this.normals[i][0] += nrm[0];
      this.normals[i][1] += nrm[1];
      this.normals[i][2] += nrm[2];
    }
    this.faces.push(idxs);
    return idxs;
  }

  unitNormals(): Vec3[] {
    return this.normals.map(n => {
      const u = norm([n[0], n[1], n[2]]);
      return (u[0] === 0 && u[1] === 0 && u[2] === 0) ? [0, 0, 1] : u;
    });
  }
}

// ------------------------------------------------------------ key geometry

function cellHalfExtents(
  key: KeyEntry, key1u: number, holeSize = 14.5, switchBorder = 1.5,
): [number, number] {
  const u = key.u_width ?? 1;
  const h = key.u_height ?? 1;
  const hw = Math.max((u * key1u - 3) / 2, holeSize / 2 + switchBorder);
  const hh = Math.max((h * key1u - 3) / 2, holeSize / 2 + switchBorder);
  return [hw, hh];
}

/** Outer cell ring (4 pts) in local frame, at local z=0: tl, bl, br, tr. */
function cellRing(
  key: KeyEntry, key1u: number, holeSize = 14.5, switchBorder = 1.5,
): Vec3[] {
  const [hw, hh] = cellHalfExtents(key, key1u, holeSize, switchBorder);
  return [[-hw, hh, 0], [-hw, -hh, 0], [hw, -hh, 0], [hw, hh, 0]];
}

/** Inner switch-cutout ring (4 pts) in local frame, at local z=0. */
function holeRing(_key: KeyEntry, _key1u: number, holeSize: number): Vec3[] {
  const u = holeSize / 2;
  return [[-u, u, 0], [-u, -u, 0], [u, -u, 0], [u, u, 0]];
}

type CornerName = 'tl' | 'bl' | 'br' | 'tr';
type Corners = Record<CornerName, Vec3>;

/** The key's four top corners in world space, keyed by name. */
function keyEdgesWorld(
  key: KeyEntry, key1u: number, holeSize = 14.5, switchBorder = 1.5,
): Corners {
  const [tl, bl, br, tr] = cellRing(key, key1u, holeSize, switchBorder)
    .map(p => place(p, key));
  return { tl, bl, br, tr };
}

// -------------------------------------------------------- links/neighbours

type CR = string; // "col,row"
const crKey = (c: number, r: number): CR => `${c},${r}`;
const pairKey = (a: CR, b: CR): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

type Side = 'l' | 'r' | 't' | 'b';
const SIDES: Side[] = ['l', 'r', 't', 'b'];
const OPP: Record<Side, Side> = { l: 'r', r: 'l', t: 'b', b: 't' };

interface LinkTarget { cr: CR; corner: CornerName | null; }

/** This key's explicit links as {side: {cr, corner|null}}. */
function linkedTargets(key: KeyEntry): Partial<Record<Side, LinkTarget>> {
  const out: Partial<Record<Side, LinkTarget>> = {};
  const lk = key.linked_keys ?? {};
  for (const side of SIDES) {
    const v = lk[side];
    if (v == null) continue;
    if (v.length >= 3) {
      out[side] = {
        cr: crKey(Number(v[0]), Number(v[1])),
        corner: String(v[2]) as CornerName,
      };
    } else {
      out[side] = { cr: crKey(Number(v[0]), Number(v[1])), corner: null };
    }
  }
  return out;
}

/**
 * Explicit links as canonical unordered CR pairs. With fullEdgeOnly, links
 * that name a corner on either endpoint are excluded.
 */
function explicitLinkPairs(keys: KeyEntry[], fullEdgeOnly = false): Set<string> {
  const pairHasCorner = new Map<string, boolean>();
  for (const k of keys) {
    const a = crKey(k.col, k.row);
    for (const side of SIDES) {
      const t = linkedTargets(k)[side];
      if (!t) continue;
      const pr = pairKey(a, t.cr);
      pairHasCorner.set(pr, (pairHasCorner.get(pr) ?? false) || t.corner !== null);
    }
  }
  if (!fullEdgeOnly) return new Set(pairHasCorner.keys());
  const out = new Set<string>();
  for (const [pr, hasC] of pairHasCorner) if (!hasC) out.add(pr);
  return out;
}

/**
 * Determine this key's neighbours on each side (grid adjacency + explicit
 * links); full-edge links suppress the cardinal grid bridge on their side.
 */
function findNeighbours(
  key: KeyEntry, keysByCr: Map<CR, KeyEntry>,
): Partial<Record<Side, KeyEntry[]>> {
  const { col, row } = key;
  const neighs: Partial<Record<Side, KeyEntry[]>> = {};
  const grid: Record<Side, CR> = {
    l: crKey(col - 1, row),
    r: crKey(col + 1, row),
    t: crKey(col, row - 1),
    b: crKey(col, row + 1),
  };
  const myLinks = linkedTargets(key);

  for (const side of SIDES) {
    const cr = grid[side];
    if (!keysByCr.has(cr)) continue;
    // A FULL-EDGE link on this side claims the whole edge — the cardinal
    // grid neighbour yields. A CORNER link takes only one corner, so the
    // cardinal neighbour is kept.
    const ml = myLinks[side];
    if (ml && ml.corner === null) continue;
    // Reciprocal: if the grid neighbour full-edge-links back, yield too.
    const neigh = keysByCr.get(cr)!;
    const nl = linkedTargets(neigh)[OPP[side]];
    if (nl && nl.corner === null) continue;
    (neighs[side] ??= []).push(neigh);
  }

  // Explicit links add to (don't replace) neighbours on their side.
  for (const side of SIDES) {
    const t = myLinks[side];
    if (t && keysByCr.has(t.cr)) (neighs[side] ??= []).push(keysByCr.get(t.cr)!);
  }
  return neighs;
}

/** Which corner pairs face across each side (this-key edge, neighbour edge). */
const FACING: Record<Side, [[CornerName, CornerName], [CornerName, CornerName]]> = {
  r: [['tr', 'br'], ['tl', 'bl']],
  l: [['bl', 'tl'], ['br', 'tr']],
  b: [['br', 'bl'], ['tr', 'tl']],
  t: [['tl', 'tr'], ['bl', 'br']],
};

function degenerate(p: Vec3, q: Vec3, tol = 1e-6): boolean {
  return Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol &&
    Math.abs(p[2] - q[2]) < tol;
}

/** XY footprint scale of a small top polygon (area x avg |z|). */
function polygonScale(top: Vec3[]): number {
  const n = top.length;
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = top[i];
    const [x1, y1] = top[(i + 1) % n];
    area2 += x0 * y1 - x1 * y0;
  }
  const area = Math.abs(area2) * 0.5;
  const avgH = top.reduce((s, p) => s + p[2], 0) / n;
  return area * Math.abs(avgH);
}

/**
 * Corner patches sealing the gap at every grid junction where 3-4 key cells
 * meet. Blocks whose diagonal is an explicit link in `linkPairs` are skipped.
 */
function diagonalCornerPatches(
  keysByCr: Map<CR, KeyEntry>, key1u: number, linkPairs: Set<string>,
  holeSize = 14.5, switchBorder = 1.5,
): Vec3[][] {
  if (keysByCr.size === 0) return [];

  let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
  for (const k of keysByCr.values()) {
    minC = Math.min(minC, k.col); maxC = Math.max(maxC, k.col);
    minR = Math.min(minR, k.row); maxR = Math.max(maxR, k.row);
  }

  const patches: Vec3[][] = [];
  const order = ['A', 'C', 'D', 'B'] as const;
  const cornerName: Record<string, CornerName> = { A: 'br', B: 'bl', D: 'tl', C: 'tr' };

  for (let c = minC; c <= maxC; c++) {
    for (let r = minR; r <= maxR; r++) {
      const block: Record<string, CR> = {
        A: crKey(c, r), B: crKey(c + 1, r),
        C: crKey(c, r + 1), D: crKey(c + 1, r + 1),
      };
      // Yield to an explicit link on either diagonal of this block.
      if (linkPairs.has(pairKey(block['A'], block['D'])) ||
          linkPairs.has(pairKey(block['B'], block['C']))) continue;

      const present = new Map<string, KeyEntry>();
      for (const name of Object.keys(block)) {
        const k = keysByCr.get(block[name]);
        if (k) present.set(name, k);
      }
      if (present.size < 3) continue;

      const pts: Vec3[] = [];
      for (const name of order) {
        const key = present.get(name);
        if (key) {
          const corners = keyEdgesWorld(key, key1u, holeSize, switchBorder);
          pts.push(corners[cornerName[name]]);
        }
      }
      if (pts.length >= 3) patches.push(pts);
    }
  }
  return patches;
}

// --------------------------------------------------------------- resolvers

export function resolveKeylist(data: Entry): Keylist {
  if (isKeyboardDef(data)) return generateKeylist(data);
  return data as Keylist;
}

export function isAssembly(data: unknown): data is AssemblyEntry {
  return typeof data === 'object' && data !== null && !Array.isArray(data) &&
    'items' in (data as Record<string, unknown>);
}

/** Resolve a board referenced by name from the catalog (assemblies skipped). */
export function findNamedEntry(name: string, catalog: Catalog): Entry | null {
  const entries = Array.isArray(catalog) ? catalog : [catalog];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || isAssembly(entry)) continue;
    if ((entry as Record<string, unknown>)['name'] === name) return entry;
  }
  return null;
}

/** Place a mesh in an assembly: mirror -> rotate -> translate. */
export function transformMesh(
  mesh: Mesh,
  pos: Vec3 = [0, 0, 0],
  rot: Vec3 = [0, 0, 0],
  mirror: [number, number, number] = [0, 0, 0],
): Mesh {
  const sx = mirror[0] ? -1 : 1;
  const sy = mirror[1] ? -1 : 1;
  const sz = mirror[2] ? -1 : 1;
  const reflected = sx * sy * sz < 0;

  const vertices: Vec3[] = mesh.vertices.map(([x, y, z]) => {
    const p = rotXYZ([x * sx, y * sy, z * sz], rot[0], rot[1], rot[2]);
    return [p[0] + pos[0], p[1] + pos[1], p[2] + pos[2]];
  });
  const faces = reflected
    ? mesh.faces.map(f => [...f].reverse())
    : mesh.faces.map(f => [...f]);
  return { vertices, faces };
}

// ------------------------------------------------------------- top surface

interface TopBuild { top: TopSurface; holeVertIds: Set<number>; }

/**
 * Build the connected TOP surface of the plate (key annuli + bridges +
 * corner patches). Shared by buildShell and buildWalls so plate and walls
 * reference identical perimeter geometry.
 */
function buildTopSurface(keylistData: Keylist): TopBuild {
  const data = resolveKeylist(keylistData);
  const key1u = data.key_1u ?? 19.05;
  const holeSize = data.hole_size ?? 14.5;
  const switchBorder = data.switch_border ?? 1.5;
  const keys = data.keylist ?? [];
  const keysByCr = new Map<CR, KeyEntry>(keys.map(k => [crKey(k.col, k.row), k]));

  const top = new TopSurface();
  const holeVertIds = new Set<number>();

  const keyPlaneNormal = (key: KeyEntry): Vec3 => {
    const o = place([0, 0, 0], key);
    const z = place([0, 0, 1], key);
    return norm([z[0] - o[0], z[1] - o[1], z[2] - o[2]]);
  };

  const cellTopWorld = (key: KeyEntry) =>
    cellRing(key, key1u, holeSize, switchBorder).map(p => place(p, key));
  const holeTopWorld = (key: KeyEntry) =>
    holeRing(key, key1u, holeSize).map(p => place(p, key));

  // --- 1) Key tops: annulus (outer cell ring minus inner hole ring) ---
  for (const key of keys) {
    const outer = cellTopWorld(key);
    const inner = holeTopWorld(key);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      top.face([outer[i], outer[j], inner[j], inner[i]]);
    }
    const kn = keyPlaneNormal(key);
    for (const p of outer) top.offsetNormal.set(top.vert(p), kn);
    for (const p of inner) holeVertIds.add(top.vert(p));
  }

  // --- 2) Bridge tops between adjacent keys ---
  const linkPairs = explicitLinkPairs(keys);

  interface Rel {
    key: KeyEntry; neigh: KeyEntry; side: Side;
    corner: CornerName | null; isLink: boolean;
  }
  const rels = new Map<string, Rel>();
  for (const key of keys) {
    const thisCr = crKey(key.col, key.row);
    const myLinks = linkedTargets(key);
    const neighsBySide = findNeighbours(key, keysByCr);
    for (const side of SIDES) {
      for (const neigh of neighsBySide[side] ?? []) {
        const neighCr = crKey(neigh.col, neigh.row);
        const pair = pairKey(thisCr, neighCr);
        let corner: CornerName | null = null;
        let isLink = false;
        const ml = myLinks[side];
        if (ml && ml.cr === neighCr) {
          isLink = true;
          corner = ml.corner;
        }
        // Prefer a link record (carries corner) over a plain grid one.
        const existing = rels.get(pair);
        if (!existing || (isLink && existing.corner === null && !existing.isLink)) {
          rels.set(pair, { key, neigh, side, corner, isLink });
        }
      }
    }
  }
  void linkPairs; // parity with Python (collected there before rels)

  for (const { key, neigh, side, corner } of rels.values()) {
    const thisCorners = keyEdgesWorld(key, key1u, holeSize, switchBorder);
    const neighCorners = keyEdgesWorld(neigh, key1u, holeSize, switchBorder);
    const [[a0, a1], [n0, n1]] = FACING[side];

    if (corner === null) {
      // Full facing edge -> full facing edge.
      const pA0 = thisCorners[a0], pA1 = thisCorners[a1];
      const pN0 = neighCorners[n0], pN1 = neighCorners[n1];
      if (degenerate(pA0, pN0) && degenerate(pA1, pN1)) continue;
      const bridgeTop = [pA0, pA1, pN1, pN0];
      if (polygonScale(bridgeTop.map(p => [p[0], p[1], 1] as Vec3)) < 1) continue;
      top.face(bridgeTop);
    } else {
      // Single named corner of THIS key -> neighbour's full facing edge.
      const pc = thisCorners[corner];
      const pN0 = neighCorners[n0];
      const pN1 = neighCorners[n1];
      const tri = [pc, pN1, pN0];
      if (polygonScale(tri.map(p => [p[0], p[1], 1] as Vec3)) >= 0.1) {
        top.face(tri);
      }
    }
  }

  // --- 3) Corner patches where 3-4 keys meet ---
  const yieldPairs = explicitLinkPairs(keys, true);
  for (const patchTop of diagonalCornerPatches(
      keysByCr, key1u, yieldPairs, holeSize, switchBorder)) {
    if (polygonScale(patchTop.map(p => [p[0], p[1], 1] as Vec3)) < 0.1) continue;
    top.face(patchTop);
  }

  return { top, holeVertIds };
}

// ------------------------------------------------------------ skirt profile

interface SkirtSeg { frac: number; angle: number | null; out: number | null; }

/**
 * Normalise the skirt's outer cross-section into segments walked
 * top-to-bottom (see core.py _skirt_profile for the JSON format).
 */
function skirtProfile(keylistData: Keylist): SkirtSeg[] {
  let prof = keylistData.skirt_profile;
  if (!prof || prof.length === 0) {
    const mode = String(keylistData.skirt_mode ?? 'angle').toLowerCase();
    prof = mode === 'flare'
      ? [{ fraction: 1, out: keylistData.skirt_flare ?? 0 }]
      : [{ fraction: 1, angle: keylistData.skirt_angle ?? 0 }];
  }

  const segs: SkirtSeg[] = prof.map(s => ({
    frac: Number(s.fraction ?? 0),
    angle: 'angle' in s && s.angle !== undefined ? Number(s.angle) : null,
    out: 'out' in s && s.out !== undefined ? Number(s.out) : null,
  }));

  const total = segs.reduce((s, x) => s + x.frac, 0);
  if (total <= 1e-9) {
    throw new Error("skirt_profile: fractions sum to zero — at least one " +
      "segment must have a non-zero 'fraction'");
  }
  for (const s of segs) {
    s.frac /= total;
    if (s.out === null && s.angle === null) s.angle = 0;
    if (s.frac === 0 && s.out === null) {
      throw new Error("skirt_profile: a zero-fraction (horizontal) step " +
        "must specify 'out'");
    }
  }
  return segs;
}

// ------------------------------------------------------ 2D polygon helpers

function signedArea(pts: Vec2[]): number {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

function triArea2(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segsProperlyCross(p: Vec2, q: Vec2, r: Vec2, s: Vec2): boolean {
  const d1 = triArea2(r, s, p);
  const d2 = triArea2(r, s, q);
  const d3 = triArea2(p, q, r);
  const d4 = triArea2(p, q, s);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  const [x, y] = p;
  let inside = false;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % n];
    if ((y0 > y) !== (y1 > y)) {
      const xin = x0 + (y - y0) * (x1 - x0) / (y1 - y0);
      if (x < xin) inside = !inside;
    }
  }
  return inside;
}

const coincident = (a: Vec2, b: Vec2, eps = 1e-9) =>
  Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;

function pointInTri(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = triArea2(p, a, b);
  const d2 = triArea2(p, b, c);
  const d3 = triArea2(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** Ear-clip a simple polygon (concave OK, no holes). CCW index triples. */
function earClip(pts: Vec2[]): [number, number, number][] {
  const n = pts.length;
  if (n < 3) return [];

  let idx = Array.from({ length: n }, (_, i) => i);
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    area2 += pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1];
  }
  if (area2 < 0) idx.reverse();

  const tris: [number, number, number][] = [];
  let guard = 0;
  const limit = 10 * n * n + 100;
  while (idx.length > 2 && guard < limit) {
    guard++;
    let clipped = false;
    const m = idx.length;
    for (let k = 0; k < m; k++) {
      const i0 = idx[(k - 1 + m) % m], i1 = idx[k], i2 = idx[(k + 1) % m];
      const a = pts[i0], b = pts[i1], c = pts[i2];
      if (triArea2(a, b, c) <= 1e-12) continue; // reflex/degenerate corner
      let ok = true;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        const p = pts[j];
        if (coincident(p, a) || coincident(p, b) || coincident(p, c)) continue;
        if (pointInTri(p, a, b, c)) { ok = false; break; }
      }
      if (ok) {
        tris.push([i0, i1, i2]);
        idx.splice(k, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) break;
  }

  if (idx.length > 2) {
    throw new Error('baseplate: could not triangulate the outline ' +
      '(is it self-intersecting?)');
  }
  return tris;
}

/**
 * Merge HOLES into an OUTER polygon by cutting a zero-width bridge to each,
 * producing one simple polygon for ear clipping.
 */
function bridgeHoles(outer: Vec2[], holes: Vec2[][]): Vec2[] {
  let poly = [...outer];
  if (signedArea(poly) < 0) poly.reverse();

  const sortedHoles = [...holes].sort(
    (h1, h2) => Math.max(...h2.map(p => p[0])) - Math.max(...h1.map(p => p[0])),
  );
  for (const hole of sortedHoles) {
    const h = [...hole];
    if (signedArea(h) > 0) h.reverse(); // holes traverse CW

    // Bridge from the hole's right-most vertex.
    let mi = 0;
    for (let i = 1; i < h.length; i++) if (h[i][0] > h[mi][0]) mi = i;
    const M = h[mi];

    let best: number | null = null;
    let bestD: number | null = null;
    const n = poly.length;
    for (let pi = 0; pi < n; pi++) {
      const P = poly[pi];
      let ok = true;
      for (let j = 0; j < n; j++) {
        const a = poly[j], b = poly[(j + 1) % n];
        if (j === pi || (j + 1) % n === pi) continue;
        if (segsProperlyCross(M, P, a, b)) { ok = false; break; }
      }
      if (ok) {
        for (let j = 0; j < h.length; j++) {
          const a = h[j], b = h[(j + 1) % h.length];
          if (j === mi || (j + 1) % h.length === mi) continue;
          if (segsProperlyCross(M, P, a, b)) { ok = false; break; }
        }
      }
      if (ok) {
        const mid: Vec2 = [(M[0] + P[0]) / 2, (M[1] + P[1]) / 2];
        if (!pointInPoly(mid, poly)) ok = false;
        else if (pointInPoly(mid, h)) ok = false;
      }
      if (ok) {
        const d = (M[0] - P[0]) ** 2 + (M[1] - P[1]) ** 2;
        if (bestD === null || d < bestD) { best = pi; bestD = d; }
      }
    }

    if (best === null) {
      throw new Error('insert hole could not be bridged to the outline ' +
        '(is it outside the baseplate, or overlapping?)');
    }

    // Splice: ...P, hole[mi..end], hole[0..mi], P...
    poly = [
      ...poly.slice(0, best + 1),
      ...h.slice(mi), ...h.slice(0, mi + 1),
      ...poly.slice(best),
    ];
  }
  return poly;
}

function triangulateWithHoles(
  outer: Vec2[], holes: Vec2[][],
): { points: Vec2[]; tris: [number, number, number][] } {
  if (holes.length === 0) {
    const pts = [...outer];
    return { points: pts, tris: earClip(pts) };
  }
  const merged = bridgeHoles(outer, holes);
  return { points: merged, tris: earClip(merged) };
}

/** CCW circle as (x, y) points. */
function circlePts(cx: number, cy: number, r: number, segments = 32): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function cross2(o: Vec2, a: Vec2, b: Vec2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Andrew monotonic chain convex hull. CCW, first point not repeated. */
function convexHull(points: Vec2[]): Vec2[] {
  // De-dup exactly and sort lexicographically (matches sorted(set(points))).
  const seen = new Set<string>();
  const pts: Vec2[] = [];
  for (const p of points) {
    const k = `${p[0]},${p[1]}`;
    if (!seen.has(k)) { seen.add(k); pts.push(p); }
  }
  pts.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

  if (pts.length <= 1) return pts;

  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 &&
        cross2(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 &&
        cross2(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// -------------------------------------------------------- perimeter chains

const edgeKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

/**
 * Extract the OUTER perimeter of a built TopSurface as ordered vertex-index
 * loops (boundary edges not lying entirely on a switch-cutout rim).
 */
function perimeterLoops(top: TopSurface, holeVertIds: Set<number>): number[][] {
  const edgeCount = new Map<string, number>();
  for (const f of top.faces) {
    const m = f.length;
    for (let i = 0; i < m; i++) {
      const e = edgeKey(f[i], f[(i + 1) % m]);
      edgeCount.set(e, (edgeCount.get(e) ?? 0) + 1);
    }
  }

  const perimEdges: [number, number][] = [];
  for (const [e, cnt] of edgeCount) {
    if (cnt !== 1) continue;
    const [a, b] = e.split(',').map(Number);
    if (holeVertIds.has(a) && holeVertIds.has(b)) continue; // switch hole rim
    perimEdges.push([a, b]);
  }

  const adj = new Map<number, number[]>();
  for (const [a, b] of perimEdges) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }

  const unused = new Set(perimEdges.map(([a, b]) => edgeKey(a, b)));
  const edgeByKey = new Map(perimEdges.map(([a, b]) => [edgeKey(a, b), [a, b] as [number, number]]));
  const loops: number[][] = [];
  while (unused.size > 0) {
    const startKey = unused.values().next().value as string;
    const [a, b] = edgeByKey.get(startKey)!;
    const loop = [a, b];
    unused.delete(startKey);
    for (;;) {
      const cur = loop[loop.length - 1];
      let nxt: number | null = null;
      for (const cand of adj.get(cur) ?? []) {
        const e = edgeKey(cur, cand);
        if (unused.has(e)) { nxt = cand; unused.delete(e); break; }
      }
      if (nxt === null) break;
      if (nxt === loop[0]) break; // closed
      loop.push(nxt);
    }
    loops.push(loop);
  }
  return loops;
}

/**
 * For an ordered perimeter loop, return [loop forced CCW, unit outward XY
 * normal per loop vertex].
 */
function outwardNormalsXY(
  points: Vec3[], loopIn: number[],
): [number[], Vec2[]] {
  let loop = loopIn;
  const n = loop.length;
  let pts = loop.map(i => points[i]);

  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    area2 += x0 * y1 - x1 * y0;
  }
  if (area2 < 0) {
    loop = [...loop].reverse();
    pts = loop.map(i => points[i]);
  }

  const edgeOut = (p: Vec3, q: Vec3): Vec2 => {
    const dx = q[0] - p[0], dy = q[1] - p[1];
    // Right of travel for CCW loop = outward: (dy, -dx)
    const ox = dy, oy = -dx;
    const m = Math.sqrt(ox * ox + oy * oy);
    return m > 1e-12 ? [ox / m, oy / m] : [0, 0];
  };

  const normals: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prevP = pts[(i - 1 + n) % n];
    const curP = pts[i];
    const nextP = pts[(i + 1) % n];
    const e0 = edgeOut(prevP, curP);
    const e1 = edgeOut(curP, nextP);
    const ox = e0[0] + e1[0], oy = e0[1] + e1[1];
    const m = Math.sqrt(ox * ox + oy * oy);
    normals.push(m > 1e-12 ? [ox / m, oy / m] : e1);
  }
  return [loop, normals];
}

// ------------------------------------------------------------- buildShell

/**
 * Stitch two vertical vertex columns (bottom -> top ordered indices) into a
 * watertight triangle strip; the columns may have different point counts.
 */
function stitchColumns(
  faces: Face[], vertices: Vec3[], colA: number[], colB: number[],
): void {
  let ia = 0, ib = 0;
  const za = colA.map(i => vertices[i][2]);
  const zb = colB.map(i => vertices[i][2]);
  const na = colA.length, nb = colB.length;
  while (ia < na - 1 || ib < nb - 1) {
    const canA = ia < na - 1;
    const canB = ib < nb - 1;
    if (canA && (!canB || za[ia + 1] <= zb[ib + 1])) {
      faces.push([colB[ib], colA[ia], colA[ia + 1]]);
      ia++;
    } else {
      faces.push([colB[ib], colA[ia], colB[ib + 1]]);
      ib++;
    }
  }
}

/**
 * Build a constant-thickness SHELL of the key plate: top follows the tilted
 * switch planes, bottom is a uniform-thickness perpendicular offset, switch
 * cutouts pass through perpendicular to the top. With `skirt: true` the
 * plate grows fused walls sweeping down to `wall_base_z`. Returns one
 * closed manifold.
 */
export function buildShell(keylistData: Keylist): Mesh {
  const data = resolveKeylist(keylistData);
  const thickness = data.thickness ?? 5;
  let verticalEdges = data.vertical_edges ?? true;
  // A fused skirt REQUIRES an aligned (vertical) perimeter.
  if (data.skirt ?? false) verticalEdges = true;

  const { top, holeVertIds } = buildTopSurface(data);

  // --- Tent / pitch of the whole plate as a rigid body -------------------
  const tentAngle = Number(data.tent_angle ?? 0) || 0;
  const pitchAngle = Number(data.pitch_angle ?? 0) || 0;
  const tilted = Boolean(tentAngle || pitchAngle);
  if (tilted) {
    const pts = top.points;
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const tilt = (p: Vec3): Vec3 => {
      const q = rotXYZ([p[0] - cx, p[1] - cy, p[2]], pitchAngle, tentAngle, 0);
      return [q[0] + cx, q[1] + cy, q[2]];
    };
    top.points = pts.map(tilt);
    top.normals = top.normals.map(nz =>
      rotXYZ([nz[0], nz[1], nz[2]], pitchAngle, tentAngle, 0) as [number, number, number]);
    const rotated = new Map<number, Vec3>();
    for (const [vi, nrm] of top.offsetNormal) {
      rotated.set(vi, rotXYZ(nrm, pitchAngle, tentAngle, 0));
    }
    top.offsetNormal = rotated;
  }

  // --- Offset bottom ------------------------------------------------------
  const unit = top.unitNormals();
  const override = top.offsetNormal;
  let topPts = [...top.points];
  const botPts: Vec3[] = [];
  for (let vi = 0; vi < topPts.length; vi++) {
    const p = topPts[vi];
    const u = override.get(vi) ?? unit[vi];
    botPts.push([
      p[0] - u[0] * thickness,
      p[1] - u[1] * thickness,
      p[2] - u[2] * thickness,
    ]);
  }

  // Lift the tilted plate so its lowest point clears the base.
  if (tilted) {
    const baseZ0 = Number(data.wall_base_z ?? 0);
    const minClear = Number(data.plate_min_wall ?? 1);
    const minZ = Math.min(
      Math.min(...top.points.map(p => p[2])),
      Math.min(...botPts.map(p => p[2])),
    );
    if (minZ < baseZ0 + minClear) {
      const dz = baseZ0 + minClear - minZ;
      top.points = top.points.map(p => [p[0], p[1], p[2] + dz]);
      topPts = topPts.map(p => [p[0], p[1], p[2] + dz]);
      for (let i = 0; i < botPts.length; i++) {
        botPts[i] = [botPts[i][0], botPts[i][1], botPts[i][2] + dz];
      }
    }
  }

  // --- Vertical outer perimeter (move each outer BOTTOM vertex below its
  //     TOP vertex) so the plate drops straight into a wall recess. -----
  if (verticalEdges) {
    for (const lp of perimeterLoops(top, holeVertIds)) {
      for (const vi of lp) {
        const [tx, ty] = topPts[vi];
        const bz = botPts[vi][2];
        botPts[vi] = [tx, ty, bz];
      }
    }
  }

  // Assemble the final shell mesh.
  const vertices: Vec3[] = [...topPts, ...botPts];
  const n = topPts.length;
  const faces: Face[] = [];

  // --- Optional fused SKIRT walls ----------------------------------------
  const skirt = data.skirt ?? false;
  const wallThickness = data.wall_thickness ?? 2;
  const skirtFlange = data.skirt_flange ?? 0;
  const baseZ = data.wall_base_z ?? 0;
  const constantThickness = data.constant_thickness_walls ?? false;

  // Outward XY normals for the OUTER perimeter loop(s) only.
  const skirtNormals = new Map<number, Vec2>();
  if (skirt) {
    const loops = perimeterLoops(top, holeVertIds);
    if (loops.length > 0) {
      const bboxArea = (lp: number[]) => {
        const xs = lp.map(v => topPts[v][0]);
        const ys = lp.map(v => topPts[v][1]);
        return (Math.max(...xs) - Math.min(...xs)) *
          (Math.max(...ys) - Math.min(...ys));
      };
      const areas = loops.map(bboxArea);
      const amax = Math.max(...areas);
      for (let li = 0; li < loops.length; li++) {
        if (areas[li] < 0.5 * amax) continue; // interior hole: no skirt
        const [olp, nrms] = outwardNormalsXY(topPts, loops[li]);
        for (let i = 0; i < olp.length; i++) skirtNormals.set(olp[i], nrms[i]);
      }
    }
  }

  // Intermediate rings per perimeter vertex (see core.py for the diagram).
  const segs = skirt ? skirtProfile(data) : [];
  const rings: Map<number, number>[] =
    Array.from({ length: segs.length + 1 }, () => new Map());
  const rimRing = new Map<number, number>();
  const innerCols = new Map<number, number[]>();

  for (const [vi, [nx, ny]] of skirtNormals) {
    const p = topPts[vi];
    const ztop = p[2];
    const drop = ztop - baseZ;

    const ringDz: Vec2[] = [];
    let d = skirtFlange;
    let z = ztop;
    rings[0].set(vi, vertices.length);
    vertices.push([p[0] + nx * d, p[1] + ny * d, z]);
    ringDz.push([d, z]);

    for (let si = 0; si < segs.length; si++) {
      const s = segs[si];
      const dz = s.frac * drop;
      const out = s.out !== null ? s.out : dz * Math.tan(rad(s.angle!));
      d += out;
      z -= dz;
      if (si === segs.length - 1) z = baseZ; // land exactly on base_z
      rings[si + 1].set(vi, vertices.length);
      vertices.push([p[0] + nx * d, p[1] + ny * d, z]);
      ringDz.push([d, z]);
    }

    rimRing.set(vi, vertices.length);
    const dBottom = ringDz[ringDz.length - 1][0];
    const di = dBottom - wallThickness;
    vertices.push([p[0] + nx * di, p[1] + ny * di, baseZ]);

    // Inner-face column (bottom -> top).
    const col = [rimRing.get(vi)!];
    if (constantThickness) {
      const zbot = vertices[vi + n][2]; // plate underside z at this vertex

      // Smooth constant-thickness inner wall via Minkowski EROSION: the
      // inner face is the lower envelope of radius-wt disks centred on a
      // dense sampling of the outer polyline.
      const wt = wallThickness;
      const opts: Vec2[] = [];
      for (let i = 0; i < ringDz.length - 1; i++) {
        const [d0, z0] = ringDz[i];
        const [d1, z1] = ringDz[i + 1];
        const segLen = Math.hypot(d1 - d0, z1 - z0);
        const steps = Math.max(1, Math.floor(segLen / 0.15));
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          opts.push([d0 + (d1 - d0) * t, z0 + (z1 - z0) * t]);
        }
      }

      const span = zbot - baseZ;
      if (span > 1e-6) {
        const nz = Math.max(2, Math.floor(span / 0.4));
        for (let zi = 1; zi < nz; zi++) {
          const zc = baseZ + (span * zi) / nz;
          let best: number | null = null;
          for (const [pd, pz] of opts) {
            const dz = zc - pz;
            if (-wt < dz && dz < wt) {
              const left = pd - Math.sqrt(wt * wt - dz * dz);
              if (best === null || left < best) best = left;
            }
          }
          if (best === null) continue;
          const dIn = Math.max(best, 0);
          const idx = vertices.length;
          vertices.push([p[0] + nx * dIn, p[1] + ny * dIn, zc]);
          col.push(idx);
        }
      }
    }
    col.push(vi + n); // P4, plate bottom perimeter
    innerCols.set(vi, col);
  }

  // Top faces keep CCW-from-above winding; bottoms are shifted + reversed.
  for (const f of top.faces) {
    faces.push([...f]);
    faces.push(f.map(i => i + n).reverse());
  }

  // Boundary walls: stitch each boundary edge (used by exactly one top face)
  // down, keeping the edge's directed orientation for outward winding.
  const edgeCount = new Map<string, number>();
  const directed = new Map<string, [number, number]>();
  for (const f of top.faces) {
    const m = f.length;
    for (let i = 0; i < m; i++) {
      const a = f[i], b = f[(i + 1) % m];
      const e = edgeKey(a, b);
      edgeCount.set(e, (edgeCount.get(e) ?? 0) + 1);
      directed.set(e, [a, b]);
    }
  }

  for (const [e, cnt] of edgeCount) {
    if (cnt !== 1) continue; // interior edge -> no wall
    const [a, b] = directed.get(e)!;
    if (skirt && rimRing.has(a) && rimRing.has(b)) {
      // Skirt strip: P0 -> flange -> profile segments -> flat rim -> back up
      // the inner face to the plate's bottom perimeter (P4).
      faces.push([b, a, rings[0].get(a)!, rings[0].get(b)!]);
      for (let i = 0; i < rings.length - 1; i++) {
        faces.push([
          rings[i].get(b)!, rings[i].get(a)!,
          rings[i + 1].get(a)!, rings[i + 1].get(b)!,
        ]);
      }
      const last = rings[rings.length - 1];
      faces.push([last.get(b)!, last.get(a)!, rimRing.get(a)!, rimRing.get(b)!]);
      stitchColumns(faces, vertices, innerCols.get(a)!, innerCols.get(b)!);
    } else {
      // Ordinary vertical band (switch-cutout rims, interior holes, and the
      // whole perimeter when the skirt is off).
      faces.push([b, a, a + n, b + n]);
    }
  }

  return { vertices, faces };
}

export function buildShellFromAny(data: Entry): Mesh {
  return buildShell(resolveKeylist(data));
}

// ------------------------------------------------------------- buildWalls

/**
 * Build the perimeter WALLS as a separate object: a recess frame the plate
 * drops into. One closed manifold per outer perimeter loop.
 */
export function buildWalls(keylistData: Keylist): Mesh {
  const data = resolveKeylist(keylistData);
  const thickness = data.thickness ?? 5;
  const flangeOffset = (data.flange_offset ?? 0) || 0;
  const flangeZ = (data.flange_z ?? 0) || 0;
  const plateLip = data.plate_lip ?? 1.5;
  const baseZ = data.wall_base_z ?? 0;
  const plateGap = data.plate_gap ?? 0.25;

  const { top, holeVertIds } = buildTopSurface(data);
  let loops = perimeterLoops(top, holeVertIds);

  // Keep only OUTER perimeter loop(s); skip interior holes.
  const loopBboxArea = (lp: number[]) => {
    const xs = lp.map(v => top.points[v][0]);
    const ys = lp.map(v => top.points[v][1]);
    return (Math.max(...xs) - Math.min(...xs)) *
      (Math.max(...ys) - Math.min(...ys));
  };
  if (loops.length > 0) {
    const areas = loops.map(loopBboxArea);
    const amax = Math.max(...areas);
    loops = loops.filter((_, i) => areas[i] >= 0.5 * amax);
  }

  const vertices: Vec3[] = [];
  const faces: Face[] = [];
  const addVert = (p: Vec3) => { vertices.push(p); return vertices.length - 1; };

  const override = top.offsetNormal;
  const unit = top.unitNormals();

  for (const rawLoop of loops) {
    const [loop, normals] = outwardNormalsXY(top.points, rawLoop);
    const nLoop = loop.length;
    if (nLoop < 3) continue;

    // 6-point cross-section ring per perimeter vertex (see core.py diagram).
    const rings: number[][] = [];
    for (let i = 0; i < nLoop; i++) {
      const vi = loop[i];
      const p = top.points[vi];
      const [nx, ny] = normals[i];
      const u = override.get(vi) ?? unit[vi];
      const rim = p[2] + flangeZ;

      // The plate's true underside point at this perimeter vertex.
      const bx = p[0] - u[0] * thickness;
      const by = p[1] - u[1] * thickness;
      const bz = p[2] - u[2] * thickness;

      const uz = Math.abs(u[2]) > 1e-6 ? u[2] : 1e-6;
      const undersideZ = (x: number, y: number) =>
        bz - (u[0] * (x - bx) + u[1] * (y - by)) / uz;

      const at = (offset: number, z: number): Vec3 =>
        [bx + nx * offset, by + ny * offset, z];
      const atLedge = (offset: number): Vec3 => {
        const x = bx + nx * offset;
        const y = by + ny * offset;
        return [x, y, undersideZ(x, y)];
      };

      const inner = plateGap;             // recess wall, gap beyond plate edge
      const ledgeIn = plateGap - plateLip; // ledge inner edge

      const ring: Vec3[] = [
        at(flangeOffset, baseZ), // 0 outer_bottom
        at(flangeOffset, rim),   // 1 outer_top
        at(inner, rim),          // 2 inner_top
        atLedge(inner),          // 3 ledge_top (outer) on underside
        atLedge(ledgeIn),        // 4 ledge_inner       on underside
        at(ledgeIn, baseZ),      // 5 inner_bottom
      ];
      rings.push(ring.map(addVert));
    }

    const m = rings[0].length; // 6
    for (let i = 0; i < nLoop; i++) {
      const a = rings[i];
      const b = rings[(i + 1) % nLoop];
      for (let k = 0; k < m; k++) {
        const k2 = (k + 1) % m;
        faces.push([a[k], b[k], b[k2], a[k2]]);
      }
    }
    // No end caps — the closed loop sweep forms a complete solid frame.
  }

  return { vertices, faces };
}

export function buildWallsFromAny(data: Entry): Mesh {
  return buildWalls(resolveKeylist(data));
}

// --------------------------------------------------------------- inserts

/** Resolve every threaded-insert holder to world coords and parameters. */
export function insertPositions(keylistData: Keylist): ResolvedInsert[] {
  const data = resolveKeylist(keylistData);
  const defaultClear = data.insert_clearance_d ?? 3;
  const out: ResolvedInsert[] = [];
  for (const key of data.keylist ?? []) {
    const ins = key.insert ?? {};
    if (ins['x'] == null || ins['y'] == null) continue;
    const u = key.u_width ?? 1;
    const h = key.u_height ?? 1;
    out.push({
      x: key.pos.x + Number(ins['x']) * u,
      y: key.pos.y + Number(ins['y']) * h,
      id: Number(ins['id'] ?? 4),
      od: Number(ins['od'] ?? 8),
      height: Number(ins['height'] ?? 4.2),
      rot: Number(ins['rot'] ?? 0) || 0,
      hole_x: Number(ins['hole_x'] ?? 0) || 0,
      hole_y: Number(ins['hole_y'] ?? 0) || 0,
      clearance_d: Number(ins['clearance_d'] ?? defaultClear),
      leg_0: Number(ins['leg_0'] ?? 5),
      leg_1: Number(ins['leg_1'] ?? 7),
      leg_2: Number(ins['leg_2'] ?? 5),
      col: key.col, row: key.row,
    });
  }
  return out;
}

/** Circle polygon centred on origin, CCW. */
function circlePoints(r: number, segments = 64): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

/** Cross-section of a threaded-insert holder: the three-leg "wishbone". */
function insertBossOutline(ins: ResolvedInsert, segments = 64): Vec2[] {
  const r = ins.od / 2;
  const left: Vec2 = [-r, ins.leg_0];
  const topPt: Vec2 = [0, ins.leg_1];
  const right: Vec2 = [r, ins.leg_2];

  const circle = circlePoints(r, segments);
  const leftHull = convexHull([...circle, left, topPt]);
  const rightHull = convexHull([...circle, right, topPt]);
  const result = convexHull([...leftHull, ...rightHull]);
  if (signedArea(result) < 0) result.reverse();
  return result;
}

/**
 * Build the threaded-insert holders: for each insert, a wishbone prism with
 * a Ø`id` press-fit hole, standing on the base plane and rising `height` mm.
 */
export function buildInserts(keylistData: Keylist): Mesh {
  const data = resolveKeylist(keylistData);
  const baseZ = data.wall_base_z ?? 0;
  const segments = Math.floor(data.insert_hole_segments ?? 32);

  const vertices: Vec3[] = [];
  const faces: Face[] = [];

  for (const ins of insertPositions(data)) {
    const outline = insertBossOutline(ins, segments);
    if (outline.length < 3) continue;

    // Hole centre offset, clamped inside the disc.
    const rid = ins.id / 2;
    const rDisc = ins.od / 2;
    let hx = ins.hole_x, hy = ins.hole_y;
    const hd = Math.hypot(hx, hy);
    const maxHd = Math.max(0, rDisc - rid - 0.01);
    if (hd > maxHd && hd > 1e-9) {
      hx = (hx / hd) * maxHd;
      hy = (hy / hd) * maxHd;
    }
    const hole = circlePts(hx, hy, rid, segments);

    const a = rad(ins.rot);
    const ca = Math.cos(a), sa = Math.sin(a);
    const placeXY = (p: Vec2): Vec2 =>
      [ins.x + p[0] * ca - p[1] * sa, ins.y + p[0] * sa + p[1] * ca];

    const outlineW = outline.map(placeXY);
    let holeW: Vec2[] | null = hole.map(placeXY);
    if (signedArea(outlineW) < 0) outlineW.reverse();

    let merged: Vec2[];
    let tris: [number, number, number][];
    // If the hole isn't strictly inside the holder outline, drop it.
    if (!holeW.every(p => pointInPoly(p, outlineW))) {
      ({ points: merged, tris } = triangulateWithHoles(outlineW, []));
      holeW = null;
    } else {
      ({ points: merged, tris } = triangulateWithHoles(outlineW, [holeW]));
    }
    const z0 = baseZ, z1 = baseZ + ins.height;

    const topI = new Map<string, number>();
    const botI = new Map<string, number>();
    const key6 = (p: Vec2) =>
      `${Math.round(p[0] * 1e6) / 1e6},${Math.round(p[1] * 1e6) / 1e6}`;
    const vt = (p: Vec2) => {
      const k = key6(p);
      let i = topI.get(k);
      if (i === undefined) { i = vertices.length; topI.set(k, i); vertices.push([p[0], p[1], z1]); }
      return i;
    };
    const vb = (p: Vec2) => {
      const k = key6(p);
      let i = botI.get(k);
      if (i === undefined) { i = vertices.length; botI.set(k, i); vertices.push([p[0], p[1], z0]); }
      return i;
    };

    for (const [i, j, k] of tris) { // top cap, +Z
      faces.push([vt(merged[i]), vt(merged[j]), vt(merged[k])]);
    }
    for (const [i, j, k] of tris) { // bottom cap, -Z
      faces.push([vb(merged[k]), vb(merged[j]), vb(merged[i])]);
    }

    const mOut = outlineW.length; // outer wall
    for (let i = 0; i < mOut; i++) {
      const j = (i + 1) % mOut;
      faces.push([vt(outlineW[i]), vb(outlineW[i]), vb(outlineW[j]), vt(outlineW[j])]);
    }

    if (holeW !== null) {
      const hw = [...holeW]; // hole wall, facing the hole
      if (signedArea(hw) > 0) hw.reverse();
      const mH = hw.length;
      for (let i = 0; i < mH; i++) {
        const j = (i + 1) % mH;
        faces.push([vt(hw[i]), vb(hw[i]), vb(hw[j]), vt(hw[j])]);
      }
    }
  }

  return { vertices, faces };
}

export function buildInsertsFromAny(data: Entry): Mesh {
  return buildInserts(resolveKeylist(data));
}

// ------------------------------------------------------------- baseplate

/**
 * The skirt's OUTER footprint polygon(s) at wall_base_z, CCW (x, y) lists —
 * one per outer perimeter loop. Shares the sweep maths with buildShell.
 */
function skirtOuterRings(keylistData: Keylist): Vec2[][] {
  const data = resolveKeylist(keylistData);
  if (!(data.skirt ?? false)) {
    throw new Error('baseplate requires the fused-skirt wall method ' +
      '(set "skirt": true)');
  }

  const thickness = data.thickness ?? 5;
  const baseZ = data.wall_base_z ?? 0;
  const flange = data.skirt_flange ?? 0;
  const segs = skirtProfile(data);

  const { top, holeVertIds } = buildTopSurface(data);
  const unit = top.unitNormals();
  const override = top.offsetNormal;

  // The skirt forces an aligned perimeter: each perimeter vertex's XY is its
  // bottom-offset XY (as buildShell uses).
  const pts = [...top.points];
  for (const lp of perimeterLoops(top, holeVertIds)) {
    for (const vi of lp) {
      const u = override.get(vi) ?? unit[vi];
      const p = top.points[vi];
      pts[vi] = [p[0] - u[0] * thickness, p[1] - u[1] * thickness, p[2]];
    }
  }

  const loops = perimeterLoops(top, holeVertIds);
  if (loops.length === 0) return [];

  const bboxArea = (lp: number[]) => {
    const xs = lp.map(v => pts[v][0]);
    const ys = lp.map(v => pts[v][1]);
    return (Math.max(...xs) - Math.min(...xs)) *
      (Math.max(...ys) - Math.min(...ys));
  };
  const areas = loops.map(bboxArea);
  const amax = Math.max(...areas);

  const rings: Vec2[][] = [];
  for (let li = 0; li < loops.length; li++) {
    if (areas[li] < 0.5 * amax) continue; // interior hole
    const [olp, nrms] = outwardNormalsXY(pts, loops[li]);
    const ring: Vec2[] = [];
    for (let i = 0; i < olp.length; i++) {
      const p = pts[olp[i]];
      const [nx, ny] = nrms[i];
      const drop = p[2] - baseZ;
      let d = flange;
      for (const s of segs) {
        const dz = s.frac * drop;
        d += s.out !== null ? s.out : dz * Math.tan(rad(s.angle!));
      }
      ring.push([p[0] + nx * d, p[1] + ny * d]);
    }
    rings.push(ring);
  }
  return rings;
}

/**
 * Build the BASEPLATE: a flat bottom cover matching the fused skirt's outer
 * footprint at wall_base_z, extruded DOWNWARD by baseplate_thickness, with
 * screw clearance holes coaxial with each insert.
 */
export function buildBaseplate(keylistData: Keylist): Mesh {
  const data = resolveKeylist(keylistData);
  const t = data.baseplate_thickness ?? 2;
  const baseZ = data.wall_base_z ?? 0;
  if (t <= 0) throw new Error('baseplate_thickness must be > 0');

  const inserts = insertPositions(data);
  const segments = Math.floor(data.insert_hole_segments ?? 32);

  const vertices: Vec3[] = [];
  const faces: Face[] = [];

  for (const ring of skirtOuterRings(data)) {
    const nRing = ring.length;
    if (nRing < 3) continue;

    // Screw clearance holes for inserts that fall inside this ring.
    const holes: Vec2[][] = [];
    for (const ins of inserts) {
      if (ins.clearance_d <= 0) continue;
      const a = rad(ins.rot);
      const ca = Math.cos(a), sa = Math.sin(a);
      const wx = ins.x + ins.hole_x * ca - ins.hole_y * sa;
      const wy = ins.y + ins.hole_x * sa + ins.hole_y * ca;
      if (pointInPoly([wx, wy], ring)) {
        holes.push(circlePts(wx, wy, ins.clearance_d / 2, segments));
      }
    }

    const { points: merged, tris } = triangulateWithHoles(ring, holes);

    const topI = new Map<string, number>();
    const botI = new Map<string, number>();
    const key6 = (p: Vec2) =>
      `${Math.round(p[0] * 1e6) / 1e6},${Math.round(p[1] * 1e6) / 1e6}`;
    const vt = (p: Vec2) => {
      const k = key6(p);
      let i = topI.get(k);
      if (i === undefined) { i = vertices.length; topI.set(k, i); vertices.push([p[0], p[1], baseZ]); }
      return i;
    };
    const vb = (p: Vec2) => {
      const k = key6(p);
      let i = botI.get(k);
      if (i === undefined) { i = vertices.length; botI.set(k, i); vertices.push([p[0], p[1], baseZ - t]); }
      return i;
    };

    // Top cap: CCW -> +Z (the case rests on this face). Bottom cap: -Z.
    for (const [i, j, k] of tris) {
      faces.push([vt(merged[i]), vt(merged[j]), vt(merged[k])]);
    }
    for (const [i, j, k] of tris) {
      faces.push([vb(merged[k]), vb(merged[j]), vb(merged[i])]);
    }

    // Outer side wall, outward-facing for the CCW ring.
    for (let i = 0; i < nRing; i++) {
      const j = (i + 1) % nRing;
      faces.push([vt(ring[i]), vb(ring[i]), vb(ring[j]), vt(ring[j])]);
    }

    // Hole walls: traverse CW so normals point into the hole.
    for (const hole of holes) {
      const hw = [...hole];
      if (signedArea(hw) > 0) hw.reverse();
      const mH = hw.length;
      for (let i = 0; i < mH; i++) {
        const j = (i + 1) % mH;
        faces.push([vt(hw[i]), vb(hw[i]), vb(hw[j]), vt(hw[j])]);
      }
    }
  }

  return { vertices, faces };
}

export function buildBaseplateFromAny(data: Entry): Mesh {
  return buildBaseplate(resolveKeylist(data));
}

// ------------------------------------------------------------ mesh utility

/** Merge meshes into one (concatenating with re-indexed faces). */
export function mergeMeshes(meshes: Mesh[]): Mesh {
  const vertices: Vec3[] = [];
  const faces: Face[] = [];
  for (const m of meshes) {
    const off = vertices.length;
    vertices.push(...m.vertices);
    for (const f of m.faces) faces.push(f.map(i => i + off));
  }
  return { vertices, faces };
}
