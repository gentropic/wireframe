"""python -m gcu.wireframe info <file.wfr> — what a .wfr holds."""
import sys

from . import open as wfr_open


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 2 or argv[0] != "info":
        print("usage: python -m gcu.wireframe info <file.wfr>", file=sys.stderr)
        return 2
    with wfr_open(argv[1]) as f:
        m = f.manifest
        print(f"{argv[1]}: wireframe {m['version']} · frame {m.get('frame')}")
        for e in f:
            c = e.counts
            print(f"  {e.name} [{e.kind}] {c.get('cells', 0)} cells · {c['vertices']} vertices · {e.n_bricks} bricks · {e.coords}")
            if e.topology:
                print(f"    topology {e.topology}")
            for t, pf in e.tables.items():
                print(f"    {t}: {' '.join(f'{fl.name}:{fl.type}' for fl in pf.schema_arrow)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
