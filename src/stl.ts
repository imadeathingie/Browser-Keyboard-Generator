/**
 * Binary STL export from explicit (vertices, faces) meshes.
 * Polygon faces are fan-triangulated; units pass through verbatim (the
 * generator works in millimetres, which is what slicers assume).
 */

import type { Mesh, Vec3 } from './core/types';

function triNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const m = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (m < 1e-12) return [0, 0, 0];
  return [nx / m, ny / m, nz / m];
}

export function meshToBinarySTL(mesh: Mesh, header = 'kbgen-web'): ArrayBuffer {
  let triCount = 0;
  for (const f of mesh.faces) triCount += Math.max(0, f.length - 2);

  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);

  // 80-byte header
  for (let i = 0; i < Math.min(header.length, 79); i++) {
    view.setUint8(i, header.charCodeAt(i));
  }
  view.setUint32(80, triCount, true);

  let off = 84;
  const v = mesh.vertices;
  for (const f of mesh.faces) {
    for (let i = 1; i < f.length - 1; i++) {
      const a = v[f[0]], b = v[f[i]], c = v[f[i + 1]];
      const n = triNormal(a, b, c);
      view.setFloat32(off + 0, n[0], true);
      view.setFloat32(off + 4, n[1], true);
      view.setFloat32(off + 8, n[2], true);
      let o = off + 12;
      for (const p of [a, b, c]) {
        view.setFloat32(o + 0, p[0], true);
        view.setFloat32(o + 4, p[1], true);
        view.setFloat32(o + 8, p[2], true);
        o += 12;
      }
      view.setUint16(off + 48, 0, true); // attribute byte count
      off += 50;
    }
  }
  return buffer;
}

export function downloadSTL(mesh: Mesh, filename: string) {
  const buffer = meshToBinarySTL(mesh, filename);
  const blob = new Blob([buffer], { type: 'model/stl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.stl') ? filename : `${filename}.stl`;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadJSON(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.json') ? filename : `${filename}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
