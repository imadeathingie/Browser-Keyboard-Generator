# Keyboard Case Generator (web)

A TypeScript port of the geometry core from
[BlenderKeyboardGenerator](https://github.com/imadeathingie/BlenderKeyboardGenerator),
rendering directly in the browser with three.js. Load a keyboard JSON
(definition or keylist), preview the plate/case, insert bosses and baseplate,
and export a millimetre-scale binary STL for printing. Fully static — no
backend.

## Layout

```
index.html              app shell
src/
  core/pyexpr.ts        sandboxed evaluator for Python-syntax *_algo fields
  core/keylistGen.ts    port of keylist_gen.py (definition -> keylist)
  core/core.ts          port of core.py (shell, skirt, walls, baseplate,
                        insert bosses, assembly transform)
  core/types.ts         shared data shapes
  viewer.ts             three.js viewport (parts registry, hover, fit view)
  stl.ts                binary STL + JSON download
  main.ts               UI wiring
public/samples/         predefined boards + manifest.json
scripts/verify.ts|py    parity harness (see Verification)
```

## Develop / build

```
npm install
npm run dev       # local dev server
npm run build     # static site into dist/
npm run verify    # rebuild the bundled sample and print mesh stats
```

## Verification against the Python original

`scripts/verify.py` (run against the Blender repo's `src/`) and
`scripts/verify.ts` print identical reports — vertex/face/triangle counts,
bounding box, coordinate checksum and a watertightness check — so a plain
`diff` proves parity:

```
python3 scripts/verify.py board.json /path/to/BlenderKeyboardGenerator/src > py.out
npx tsx scripts/verify.ts board.json > ts.out
diff py.out ts.out
```

The port currently matches the Python core exactly (to the printed
precision) on: the fused-skirt staggered sample, skirt-off walls, tent/pitch
lift, constant-thickness skirt erosion, `u_diff` wide keys, corner-named
`linked_keys`, inserts and baseplates. Assembly entries (`items`) are
composed at the app layer, mirroring the Blender add-on's
mirror → rotate → translate order.

## Adding sample boards

Drop a JSON file into `public/samples/` and list it in
`public/samples/manifest.json`:

```json
{ "id": "my-board", "name": "My board", "file": "my-board.json" }
```

Samples are fetched at runtime, so adding one needs no rebuild — on the
deployed site you can add files straight into the deployed `samples/`
directory.

## Hosting inside a Jekyll site (GitHub Pages)

The build uses `base: './'`, so `dist/` works from **any** subpath. Two
options:

**Option A — commit the build.** Copy `dist/` into your Jekyll repo as e.g.
`keyboard-generator/`, and add to the front of each copied HTML file nothing —
instead, tell Jekyll not to process the directory in `_config.yml`:

```yaml
include: []
exclude: []
keep_files: [keyboard-generator]
```

or simply place the folder and let Jekyll copy it through (static files pass
through by default; ensure no leading underscore in the folder name). The app
is then live at `https://you.github.io/site/keyboard-generator/`.

**Option B — build in CI.** Keep this project in its own directory (or repo)
and let Actions build both. Example job step sequence for a Jekyll +
generator monorepo:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- run: npm ci && npm run build
  working-directory: keyboard-generator-src
- run: cp -r keyboard-generator-src/dist site/keyboard-generator
- uses: actions/jekyll-build-pages@v1
  with: { source: site, destination: _site }
- uses: actions/upload-pages-artifact@v3
  with: { path: _site }
```

A ready-to-use workflow is in `.github/workflows/deploy-example.yml`.

## JSON quick reference

Everything the Python core reads is honoured; the important fields:

| field | meaning |
| --- | --- |
| `width`, `height` | key grid size |
| `x_algo` … `z_rot_algo` | per-key position/rotation expressions in `x`, `y`, `key_1u` (Python syntax, incl. `a if cond else b`) |
| `ignored_keys` | `[col, row]` cells to skip |
| `linked_keys` | explicit joins, optionally corner-anchored (`[c, r, "br"]`) |
| `u_diff` | wider/taller keys |
| `skirt`, `skirt_profile`, `skirt_angle`, `skirt_flange`, `wall_thickness` | fused case walls |
| `constant_thickness_walls` | erode a parallel inner wall instead of one sloped panel |
| `tent_angle`, `pitch_angle` | tilt the finished plate before walls |
| `inserts`, `insert_clearance_d`, `baseplate_thickness` | heat-set bosses + screw-hole baseplate |
| `vertical_edges`, `flange_offset`, `flange_z`, `plate_lip`, `plate_gap` | separate wall-frame mode (skirt off) |

License: the original project is GPL-3.0; this port should carry the same
license.
