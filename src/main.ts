import './style.css';
import {
  buildBaseplateFromAny, buildInsertsFromAny, buildShellFromAny,
  buildWallsFromAny, findNamedEntry, isAssembly, mergeMeshes,
  resolveKeylist, transformMesh,
} from './core/core';
import type { AssemblyEntry, Catalog, Entry, Mesh, Vec3 } from './core/types';
import { downloadJSON, downloadSTL } from './stl';
import { RenderMode, Viewer } from './viewer';

type Category = 'plate' | 'inserts' | 'walls' | 'baseplate';

const PART_STYLE: Record<Category, { label: string; color: number }> = {
  plate: { label: 'Plate + case', color: 0xb9c2cb },
  inserts: { label: 'Insert bosses', color: 0xf0b542 },
  walls: { label: 'Wall frame', color: 0x8d99a7 },
  baseplate: { label: 'Baseplate', color: 0x5f6a78 },
};

interface BuiltPart {
  id: string;         // e.g. "plate" or "plate:1"
  category: Category;
  mesh: Mesh;
}

// ------------------------------------------------------------------- DOM

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const sampleSelect = $<HTMLSelectElement>('sample-select');
const entrySelect = $<HTMLSelectElement>('entry-select');
const entryRow = $<HTMLElement>('entry-row');
const fileInput = $<HTMLInputElement>('file-input');
const openFileBtn = $<HTMLButtonElement>('open-file');
const editor = $<HTMLTextAreaElement>('editor');
const buildBtn = $<HTMLButtonElement>('build');
const errorBox = $<HTMLElement>('error-box');
const partsBox = $<HTMLElement>('parts');
const modeSelect = $<HTMLSelectElement>('render-mode');
const frameBtn = $<HTMLButtonElement>('frame');
const exportStlBtn = $<HTMLButtonElement>('export-stl');
const exportJsonBtn = $<HTMLButtonElement>('export-json');
const statusBox = $<HTMLElement>('status');

const viewer = new Viewer($('viewport'));

// ----------------------------------------------------------------- form submit
const FORM_ID = "AttycIpoS_b8";
const BASE_URL = "https://forms.oniccah.com";

let currentToken: string | null = null;

// -------------------------------------------------------------- app state

let catalog: Catalog | null = null;
let entryIndex = 0;
let builtParts: BuiltPart[] = [];
let visibleCategories = new Set<Category>(
  ['plate', 'inserts', 'walls', 'baseplate']);
let firstBuild = true;

function entries(): Entry[] {
  if (catalog === null) return [];
  return Array.isArray(catalog) ? catalog : [catalog];
}

function currentEntry(): Entry | null {
  return entries()[entryIndex] ?? null;
}

// ------------------------------------------------------------------ build

/** Build every part for one (non-assembly) board entry. */
function buildBoardParts(entry: Entry, suffix = ''): BuiltPart[] {
  const kl = resolveKeylist(entry);
  const parts: BuiltPart[] = [];

  parts.push({ id: `plate${suffix}`, category: 'plate', mesh: buildShellFromAny(entry) });

  const inserts = buildInsertsFromAny(entry);
  if (inserts.vertices.length > 0) {
    parts.push({ id: `inserts${suffix}`, category: 'inserts', mesh: inserts });
  }

  if (kl.skirt) {
    // Fused-skirt case: the plate carries its own walls; the separate frame
    // doesn't apply, but a matching baseplate does.
    parts.push({
      id: `baseplate${suffix}`, category: 'baseplate',
      mesh: buildBaseplateFromAny(entry),
    });
  } else {
    parts.push({ id: `walls${suffix}`, category: 'walls', mesh: buildWallsFromAny(entry) });
  }
  return parts;
}

/** Build an assembly: each item is a named board, placed by pos/rot/mirror. */
function buildAssemblyParts(entry: AssemblyEntry): BuiltPart[] {
  const parts: BuiltPart[] = [];
  const items = entry.items ?? [];
  let resolvedAny = false;
  items.forEach((item, idx) => {
    const board = findNamedEntry(item.name ?? '', catalog!);
    if (board === null) return;
    resolvedAny = true;
    const pos = (item.pos ?? [0, 0, 0]) as Vec3;
    const rot = (item.rot ?? [0, 0, 0]) as Vec3;
    const mirror = (item.mirror ?? [0, 0, 0]) as [number, number, number];
    for (const p of buildBoardParts(board, `:${idx}`)) {
      parts.push({ ...p, mesh: transformMesh(p.mesh, pos, rot, mirror) });
    }
  });
  if (!resolvedAny) {
    throw new Error('assembly: none of the item names matched a board ' +
      'entry in this file');
  }
  return parts;
}

async function fetchToken(): Promise<string> {
    const response = await fetch(`${BASE_URL}/api/f/${FORM_ID}/token`, {
        headers: {
            "Accept": "application/json"
        }
    });

    if (!response.ok) {
        throw new Error("Failed to obtain form token.");
    }

    const data = await response.json();
    console.log(data);
    return data.token;
}

// Call this once when the page loads.
export async function initializeForm() {
    currentToken = await fetchToken();
}

export async function submitForm(formData: object) {
    if (!currentToken) {
        currentToken = await fetchToken();
    }

    // Save the current token because we'll replace it afterwards.
    const token = currentToken;
    console.log({token});
    const response = await fetch(`${BASE_URL}/f/${FORM_ID}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify({
            token,
            items: formData
        })
    });

    // Always fetch a fresh token after this attempt because
    // tokens are single-use.
    currentToken = await fetchToken();

    const result = await response.json();

    if (!response.ok) {
        throw new Error(result.error ?? "Form submission failed.");
    }

    return result;
}

function rebuild() {
  errorBox.textContent = '';
  errorBox.hidden = true;

  let parsed: Catalog;
  try {
    parsed = JSON.parse(editor.value);
  } catch (e) {
    showError(`JSON parse error: ${(e as Error).message}`);
    return;
  }
  catalog = parsed;
  refreshEntrySelect();

  const entry = currentEntry();
  if (entry === null) {
    showError('The file contains no entries.');
    return;
  }

  const t0 = performance.now();
  try {
    builtParts = isAssembly(entry)
      ? buildAssemblyParts(entry)
      : buildBoardParts(entry);
  } catch (e) {
    showError((e as Error).message);
    return;
  }
  const buildMs = performance.now() - t0;

  const keep = new Set(builtParts.map(p => p.id));
  viewer.removePartsExcept(keep);
  for (const p of builtParts) {
    viewer.setPart(p.id, p.mesh, { color: PART_STYLE[p.category].color });
  }
  applyVisibility();
  renderPartToggles();
  renderStatus(buildMs);

  if (firstBuild) {
    viewer.frameAll();
    firstBuild = false;
  }
  submitForm(parsed);
}

function showError(msg: string) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

// -------------------------------------------------------------- entry list

function refreshEntrySelect() {
  const list = entries();
  const prev = entrySelect.value;
  entrySelect.innerHTML = '';
  list.forEach((e, i) => {
    const opt = document.createElement('option');
    const name = (e as Record<string, unknown>)['name'] ?? `entry ${i}`;
    opt.value = String(i);
    opt.textContent = isAssembly(e) ? `${name} (assembly)` : String(name);
    entrySelect.appendChild(opt);
  });
  entryRow.hidden = list.length <= 1;
  if (Number(prev) < list.length) entrySelect.value = prev || '0';
  entryIndex = Number(entrySelect.value) || 0;
}

entrySelect.addEventListener('change', () => {
  entryIndex = Number(entrySelect.value) || 0;
  firstBuild = true; // reframe on a different board
  rebuild();
});

// ------------------------------------------------------------ part toggles

function categoriesPresent(): Category[] {
  const seen = new Set<Category>();
  for (const p of builtParts) seen.add(p.category);
  return (Object.keys(PART_STYLE) as Category[]).filter(c => seen.has(c));
}

function applyVisibility() {
  for (const p of builtParts) {
    viewer.setVisible(p.id, visibleCategories.has(p.category));
  }
}

function renderPartToggles() {
  partsBox.innerHTML = '';
  for (const cat of categoriesPresent()) {
    const label = document.createElement('label');
    label.className = 'part-toggle';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = visibleCategories.has(cat);
    input.addEventListener('change', () => {
      if (input.checked) visibleCategories.add(cat);
      else visibleCategories.delete(cat);
      applyVisibility();
      renderStatus();
    });

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background =
      `#${PART_STYLE[cat].color.toString(16).padStart(6, '0')}`;

    const text = document.createElement('span');
    text.textContent = PART_STYLE[cat].label;

    label.append(input, swatch, text);
    partsBox.appendChild(label);
  }
}

// ---------------------------------------------------------------- status

function visibleMeshes(): Mesh[] {
  return builtParts
    .filter(p => visibleCategories.has(p.category))
    .map(p => p.mesh);
}

function renderStatus(buildMs?: number) {
  const entry = currentEntry();
  if (entry === null) { statusBox.textContent = ''; return; }

  let keys = 0;
  try {
    if (isAssembly(entry)) {
      for (const item of entry.items ?? []) {
        const board = findNamedEntry(item.name ?? '', catalog!);
        if (board) keys += resolveKeylist(board).keylist.length;
      }
    } else {
      keys = resolveKeylist(entry).keylist.length;
    }
  } catch { /* status only */ }

  let verts = 0, tris = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let nonManifold = 0;

  for (const m of visibleMeshes()) {
    verts += m.vertices.length;
    for (const f of m.faces) tris += Math.max(0, f.length - 2);
    for (const [x, y, z] of m.vertices) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const edgeCount = new Map<string, number>();
    for (const f of m.faces) {
      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
      }
    }
    for (const c of edgeCount.values()) if (c !== 2) nonManifold++;
  }

  const dims = verts > 0
    ? `${(maxX - minX).toFixed(1)} × ${(maxY - minY).toFixed(1)} × ${(maxZ - minZ).toFixed(1)} mm`
    : '—';
  const water = verts === 0 ? '—'
    : nonManifold === 0 ? 'watertight ✓' : `${nonManifold} open edges ✗`;

  const cells = [
    `keys ${keys}`,
    `verts ${verts}`,
    `tris ${tris}`,
    dims,
    water,
  ];
  if (buildMs !== undefined) cells.push(`built in ${buildMs.toFixed(0)} ms`);
  statusBox.innerHTML = cells.map(c => `<span>${c}</span>`).join('');
  statusBox.classList.toggle('bad', verts > 0 && nonManifold > 0);
}

// --------------------------------------------------------------- samples

interface SampleInfo { id: string; name: string; file: string; }

async function loadSamples() {
  try {
    const res = await fetch('samples/manifest.json');
    if (!res.ok) throw new Error(String(res.status));
    const manifest: SampleInfo[] = await res.json();
    for (const s of manifest) {
      const opt = document.createElement('option');
      opt.value = s.file;
      opt.textContent = s.name;
      sampleSelect.appendChild(opt);
    }
    if (manifest.length > 0) {
      sampleSelect.value = manifest[0].file;
      await loadSample(manifest[0].file);
    }
  } catch {
    showError('Could not load the sample list (samples/manifest.json). ' +
      'Open a JSON file instead, or paste one into the editor.');
  }
}

async function loadSample(file: string) {
  try {
    const res = await fetch(`samples/${file}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    editor.value = JSON.stringify(JSON.parse(text), null, 2);
    entryIndex = 0;
    entrySelect.value = '0';
    firstBuild = true;
    rebuild();
  } catch (e) {
    showError(`Could not load sample '${file}': ${(e as Error).message}`);
  }
}

sampleSelect.addEventListener('change', () => {
  if (sampleSelect.value) void loadSample(sampleSelect.value);
});

// ------------------------------------------------------------- local file

openFileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  editor.value = await f.text();
  sampleSelect.value = '';
  entryIndex = 0;
  firstBuild = true;
  rebuild();
  fileInput.value = '';
});

// ---------------------------------------------------------------- actions

buildBtn.addEventListener('click', rebuild);
editor.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    rebuild();
  }
});

modeSelect.addEventListener('change', () => {
  const mode = {
    solid: RenderMode.Solid,
    edges: RenderMode.SolidWithEdges,
    wireframe: RenderMode.Wireframe,
  }[modeSelect.value] ?? RenderMode.SolidWithEdges;
  viewer.setRenderMode(mode);
});

frameBtn.addEventListener('click', () => viewer.frameAll());

exportStlBtn.addEventListener('click', () => {
  const meshes = visibleMeshes();
  if (meshes.length === 0) {
    showError('Nothing visible to export — turn on at least one part.');
    return;
  }
  const entry = currentEntry() as Record<string, unknown> | null;
  const name = String(entry?.['name'] ?? 'keyboard');
  downloadSTL(mergeMeshes(meshes), `${name}.stl`);
});

exportJsonBtn.addEventListener('click', () => {
  try {
    const parsed = JSON.parse(editor.value);
    const entry = currentEntry() as Record<string, unknown> | null;
    downloadJSON(parsed, String(entry?.['name'] ?? 'keyboard'));
  } catch (e) {
    showError(`JSON parse error: ${(e as Error).message}`);
  }
});

// ------------------------------------------------------------------- boot

void loadSamples();
await initializeForm();