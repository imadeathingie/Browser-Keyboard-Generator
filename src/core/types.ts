/** Shared data shapes for the keyboard generator core. */

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

/** A face is a CCW-wound polygon (3+ vertex indices), viewed from outside. */
export type Face = number[];

export interface Mesh {
  vertices: Vec3[];
  faces: Face[];
}

export interface KeyEntry {
  u_width?: number;
  u_height?: number;
  col: number;
  row: number;
  linked_keys?: Record<string, (number | string)[]>;
  pos: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  insert?: Record<string, number>;
  legend?: string;
  switch_profile?: string;
  switch_rotation?: number;
}

/** An already-expanded keylist (what buildShell consumes). */
export interface Keylist {
  name?: string;
  hole_size?: number;
  key_1u?: number;
  thickness?: number;
  switch_border?: number;
  flange_offset?: number;
  flange_z?: number;
  plate_lip?: number;
  plate_gap?: number;
  wall_base_z?: number;
  vertical_edges?: boolean;
  skirt?: boolean;
  wall_thickness?: number;
  skirt_flange?: number;
  skirt_mode?: string;
  skirt_angle?: number;
  skirt_flare?: number;
  skirt_profile?: { fraction?: number; angle?: number; out?: number }[];
  constant_thickness_walls?: boolean;
  tent_angle?: number;
  pitch_angle?: number;
  plate_min_wall?: number;
  baseplate_thickness?: number;
  insert_clearance_d?: number;
  insert_hole_segments?: number;
  keylist: KeyEntry[];
  [k: string]: unknown;
}

/** A keyboard definition (has *_algo fields) before expansion. */
export interface KeyboardDef {
  name?: string;
  width?: number;
  height?: number;
  x_algo?: string;
  y_algo?: string;
  z_algo?: string;
  x_rot_algo?: string;
  y_rot_algo?: string;
  z_rot_algo?: string;
  ignored_keys?: [number, number][];
  linked_keys?: Record<string, (number | string)[]>[];
  u_diff?: { keys: [number, number][]; u_width?: number; u_height?: number }[];
  inserts?: Record<string, number>[];
  legends?: { col: number; row: number; legend: string }[];
  switches?: { col: number; row: number; profile?: string; rot?: number }[];
  [k: string]: unknown;
}

export interface AssemblyItem {
  name?: string;
  pos?: Vec3;
  rot?: Vec3;
  mirror?: [number, number, number];
}

export interface AssemblyEntry {
  name?: string;
  items: AssemblyItem[];
  [k: string]: unknown;
}

export type Entry = Keylist | KeyboardDef | AssemblyEntry;
export type Catalog = Entry | Entry[];

export interface ResolvedInsert {
  x: number; y: number;
  id: number; od: number;
  height: number; rot: number;
  hole_x: number; hole_y: number;
  clearance_d: number;
  leg_0: number; leg_1: number; leg_2: number;
  col: number; row: number;
}
