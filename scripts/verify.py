"""Python-side twin of verify.ts: identical output format for diffing."""
import json
import sys
from collections import defaultdict

sys.path.insert(0, sys.argv[2])  # path to BlenderKeyboardGenerator/src
import core  # noqa: E402


def report(label, verts, faces):
    if not verts:
        print(f"{label}: verts=0 faces=0 tris=0 "
              f"bbox=[Infinity,Infinity,Infinity]..[-Infinity,-Infinity,-Infinity] "
              f"checksum=0.000 nonmanifold_edges=0")
        return
    minx = min(v[0] for v in verts); maxx = max(v[0] for v in verts)
    miny = min(v[1] for v in verts); maxy = max(v[1] for v in verts)
    minz = min(v[2] for v in verts); maxz = max(v[2] for v in verts)
    s = sum(x + 2 * y + 3 * z for x, y, z in verts)
    ntris = sum(max(0, len(f) - 2) for f in faces)
    edge_count = defaultdict(int)
    for f in faces:
        for i in range(len(f)):
            a, b = f[i], f[(i + 1) % len(f)]
            edge_count[frozenset((a, b))] += 1
    bad = sum(1 for c in edge_count.values() if c != 2)
    print(f"{label}: verts={len(verts)} faces={len(faces)} tris={ntris} "
          f"bbox=[{minx:.4f},{miny:.4f},{minz:.4f}]..[{maxx:.4f},{maxy:.4f},{maxz:.4f}] "
          f"checksum={s:.3f} nonmanifold_edges={bad}")


with open(sys.argv[1]) as f:
    raw = json.load(f)
entries = raw if isinstance(raw, list) else [raw]

for entry in entries:
    if core.is_assembly(entry):
        print(f"== {entry.get('name', '?')} (assembly, skipped by harness)")
        continue
    kl = core.resolve_keylist(entry)
    print(f"== {entry.get('name', '?')} keys={len(kl['keylist'])}")
    report('shell', *core.build_shell_from_any(entry))
    report('inserts', *core.build_inserts_from_any(entry))
    if kl.get('skirt'):
        report('baseplate', *core.build_baseplate_from_any(entry))
    else:
        report('walls', *core.build_walls_from_any(entry))
