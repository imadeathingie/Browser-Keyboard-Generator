/**
 * Sanity harness: build every part from a JSON file and print vertex/face
 * counts, bounding box and a coordinate checksum, in the same format as the
 * companion verify.py — so `diff` tells us whether the TS port matches the
 * Python original.
 */
import { readFileSync } from 'node:fs';
import {
  buildBaseplateFromAny, buildInsertsFromAny, buildShellFromAny,
  buildWallsFromAny, isAssembly, resolveKeylist,
} from '../src/core/core';
import type { Entry, Mesh } from '../src/core/types';

function report(label: string, mesh: Mesh) {
  const { vertices, faces } = mesh;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let sum = 0;
  for (const [x, y, z] of vertices) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    sum += x + 2 * y + 3 * z;
  }
  const nTris = faces.reduce((s, f) => s + Math.max(0, f.length - 2), 0);
  // Manifold check on polygon edges: every edge shared by exactly 2 faces.
  const edgeCount = new Map<string, number>();
  for (const f of faces) {
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const c of edgeCount.values()) if (c !== 2) bad++;
  const fmt = (v: number) => v.toFixed(4);
  console.log(
    `${label}: verts=${vertices.length} faces=${faces.length} tris=${nTris} ` +
    `bbox=[${fmt(minX)},${fmt(minY)},${fmt(minZ)}]..[${fmt(maxX)},${fmt(maxY)},${fmt(maxZ)}] ` +
    `checksum=${sum.toFixed(3)} nonmanifold_edges=${bad}`,
  );
}

const path = process.argv[2];
const raw = JSON.parse(readFileSync(path, 'utf8'));
const entries: Entry[] = Array.isArray(raw) ? raw : [raw];

for (const entry of entries) {
  const name = (entry as Record<string, unknown>)['name'] ?? '?';
  if (isAssembly(entry)) {
    console.log(`== ${name} (assembly, skipped by harness)`);
    continue;
  }
  const kl = resolveKeylist(entry);
  console.log(`== ${name} keys=${kl.keylist.length}`);
  report('shell', buildShellFromAny(entry));
  report('inserts', buildInsertsFromAny(entry));
  if (kl.skirt) report('baseplate', buildBaseplateFromAny(entry));
  else report('walls', buildWallsFromAny(entry));
}
