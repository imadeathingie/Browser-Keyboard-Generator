/**
 * Port of keylist_gen.py: expands a keyboard-definition JSON (with
 * x_algo/y_algo/... position expressions) into the explicit keylist that
 * the mesh builders consume.
 */

import { parseAlgo } from './pyexpr';
import type { KeyboardDef, KeyEntry, Keylist } from './types';

const DEFAULTS = { hole_size: 14.5, key_1u: 19.05, thickness: 5 };

export function isKeyboardDef(data: unknown): data is KeyboardDef {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const d = data as Record<string, unknown>;
  if ('keylist' in d) return false;
  if ('items' in d) return false; // combined/assembly entry
  return ['x_algo', 'y_algo', 'width', 'height'].some(k => k in d);
}

export function generateKeylist(data: KeyboardDef): Keylist {
  const settings = DEFAULTS;

  const name = (data.name as string) ?? 'default';
  const ignored = new Set(
    (data.ignored_keys ?? []).map(k => `${k[0]},${k[1]}`),
  );
  const holeSize = (data.hole_size as number) ?? settings.hole_size;
  const key1u = (data.key_1u as number) ?? settings.key_1u;
  const thickness = (data.thickness as number) ?? settings.thickness;
  const flangeOffset = (data.flange_offset as number) ?? 0;
  const flangeZ = (data.flange_z as number) ?? 0;

  const width = data.width ?? 6;
  const height = data.height ?? 4;
  const xAlgo = data.x_algo ?? `x*${key1u}`;
  const yAlgo = data.y_algo ?? `-y*${key1u}`;
  const zAlgo = data.z_algo ?? '10';
  const xRotAlgo = data.x_rot_algo ?? '0';
  const yRotAlgo = data.y_rot_algo ?? '0';
  const zRotAlgo = data.z_rot_algo ?? '0';

  const pa = (expr: string, x: number, y: number) =>
    parseAlgo(expr, x, y, 0, width, height, key1u);

  // Same nesting order as the Python comprehension:
  // `for x in range(width) for y in range(height)`.
  const keys: KeyEntry[] = [];
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      keys.push({
        u_width: 1,
        u_height: 1,
        col: x,
        row: y,
        linked_keys: {},
        pos: { x: pa(xAlgo, x, y), y: pa(yAlgo, x, y), z: pa(zAlgo, x, y) },
        rotation: {
          x: pa(xRotAlgo, x, y),
          y: pa(yRotAlgo, x, y),
          z: pa(zRotAlgo, x, y),
        },
        insert: {},
        legend: '',
        switch_profile: 'asa',
        switch_rotation: 0,
      });
    }
  }

  const keylist = keys.filter(k => !ignored.has(`${k.col},${k.row}`));

  // u_diff: wider/taller keys, repositioned so the widened cell stays centred.
  for (const u of data.u_diff ?? []) {
    const uKeys = new Set((u.keys ?? []).map(k => `${k[0]},${k[1]}`));
    for (const k of keylist) {
      if (!uKeys.has(`${k.col},${k.row}`)) continue;
      k.u_width = u.u_width ?? 1;
      if (k.u_width !== 1) {
        if (k.u_width > 0) {
          k.pos.x = pa(xAlgo, k.col + (k.u_width - 1) / 2, k.row);
        } else {
          k.u_width = Math.abs(k.u_width);
          k.pos.x = pa(xAlgo, k.col - (k.u_width - 1) / 2, k.row);
        }
      }
      k.u_height = u.u_height ?? 1;
      if (k.u_height !== 1) {
        k.pos.y = pa(yAlgo, k.col, k.row + (k.u_height - 1) / 2);
      }
    }
  }

  // linked_keys: explicit joins between (possibly non-grid) keys.
  const split = (val: (number | string)[] | undefined):
      [[number, number] | null, string | null] => {
    if (val == null) return [null, null];
    if (val.length >= 3) {
      return [[Number(val[0]), Number(val[1])], String(val[2])];
    }
    return [[Number(val[0]), Number(val[1])], null];
  };
  const same = (p: [number, number], c: KeyEntry) =>
    c.col === p[0] && c.row === p[1];

  for (const group of (data.linked_keys ?? []) as Record<string, (number | string)[]>[]) {
    const [lCell, lCorner] = split(group['l']);
    const [rCell, rCorner] = split(group['r']);
    const [tCell, tCorner] = split(group['t']);
    const [bCell, bCorner] = split(group['b']);

    for (const k of keylist) {
      k.linked_keys = k.linked_keys ?? {};
      if (lCell && same(lCell, k) && rCell !== null) {
        k.linked_keys['r'] = lCorner
          ? [rCell![0], rCell![1], lCorner] : [rCell![0], rCell![1]];
      } else if (rCell && same(rCell, k) && lCell !== null) {
        k.linked_keys['l'] = rCorner
          ? [lCell![0], lCell![1], rCorner] : [lCell![0], lCell![1]];
      } else if (tCell && same(tCell, k) && bCell !== null) {
        k.linked_keys['b'] = tCorner
          ? [bCell![0], bCell![1], tCorner] : [bCell![0], bCell![1]];
      } else if (bCell && same(bCell, k) && tCell !== null) {
        k.linked_keys['t'] = bCorner
          ? [tCell![0], tCell![1], bCorner] : [tCell![0], tCell![1]];
      }
    }
  }

  const INSERT_FIELDS = ['x', 'y', 'rot', 'id', 'od', 'depth', 'height',
    'clearance_d', 'hole_x', 'hole_y', 'leg_0', 'leg_1', 'leg_2'] as const;
  for (const ins of data.inserts ?? []) {
    for (const k of keylist) {
      if (k.col === ins['col'] && k.row === ins['row']) {
        k.insert = k.insert ?? {};
        for (const f of INSERT_FIELDS) {
          if (f in ins) k.insert[f] = ins[f];
        }
      }
    }
  }

  for (const leg of data.legends ?? []) {
    for (const k of keylist) {
      if (k.col === leg.col && k.row === leg.row) k.legend = leg.legend;
    }
  }

  for (const sw of data.switches ?? []) {
    for (const k of keylist) {
      if (k.col === sw.col && k.row === sw.row) {
        k.switch_profile = sw.profile ?? 'asa';
        k.switch_rotation = sw.rot ?? 0;
      }
    }
  }

  const out: Keylist = {
    name,
    hole_size: holeSize,
    key_1u: key1u,
    thickness,
    flange_offset: flangeOffset,
    flange_z: flangeZ,
    keylist,
  };

  // Carry through optional build parameters the mesh/wall builders read.
  const OPTS = ['plate_lip', 'plate_gap', 'wall_base_z', 'vertical_edges',
    'skirt', 'wall_thickness', 'skirt_flange', 'skirt_mode',
    'skirt_angle', 'skirt_flare', 'skirt_profile',
    'skirt_steps', 'skirt_angle_end', 'skirt_step_out',
    'constant_thickness_walls', 'switch_border',
    'tent_angle', 'pitch_angle', 'plate_min_wall',
    'baseplate_thickness', 'insert_clearance_d', 'insert_hole_segments'];
  for (const opt of OPTS) {
    if (opt in data) (out as Record<string, unknown>)[opt] = data[opt];
  }
  return out;
}
