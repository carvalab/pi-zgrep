#!/usr/bin/env bash
# Reproducible search benchmark: zg (this extension's engine) vs ripgrep vs GNU grep.
#
# Usage:
#   ./doc/bench.sh                     # self-benchmark on this repo (latency + recall@3)
#   ./doc/bench.sh /path/to/corpus     # latency only on any directory
#   ./doc/bench.sh . 40                # custom iteration count (default 20)
#
# Method:
#   - copies the corpus to a scratch dir (hermetic; no repo pollution)
#   - cold-index time for zg (rg/grep index nothing, that is the trade)
#   - warm query latency per tool: 3 untimed warmups, N timed runs, median + p95
#   - recall@3 on the self-benchmark: does a top-3 result hit the known target
#     file? That is the honest differentiator for semantic search.
#   - no hyperfine or other deps: date +%s%N, sort, awk
#   - zg comes from $ZG, else `zg` on PATH, else the bundled platform binary
#     under node_modules (a plain `npm install` needs no PATH edit)
set -euo pipefail

CORPUS="${1:-}"
ITERS="${2:-20}"
# zg 0.3.0+ (rg-style flags, no subcommands). Resolution order: $ZG → `zg` on
# PATH → the per-platform binary the npm package ships under node_modules (a
# plain `npm install` leaves it there; it is never on PATH). Absolute paths
# only: the script cd's into the scratch copy below.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${ZG:-}" ]; then
  if command -v zg >/dev/null 2>&1; then
    ZG=zg
  else
    for candidate in "$REPO_ROOT"/node_modules/@zvec/zvec-grep-*/bin/zg; do
      if [ -x "$candidate" ]; then ZG="$candidate"; break; fi
    done
  fi
fi
ZG="${ZG:-zg}"
"$ZG" --version >/dev/null 2>&1 || { echo "bench: '$ZG' is not runnable; set ZG=/path/to/zg (0.3.0+)" >&2; exit 1; }
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/zg-bench.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

if [ -z "$CORPUS" ]; then
  cd "$(dirname "$0")/.."
  SELF=1
else
  cd "$CORPUS"
  SELF=0
fi
tar --exclude=.git --exclude=node_modules --exclude=.zvec-grep --exclude=.empryo \
    --exclude=doc -cf - . | tar -xf - -C "$SCRATCH"   # doc/ excluded: the
# bench script and benchmark.md contain the query strings verbatim, which
# would let the search tools match the test harness instead of the code.
cd "$SCRATCH"

timens() { # timens <cmd...> -> milliseconds
  local t0 t1
  t0=$(date +%s%N); "$@" >/dev/null 2>&1 || true; t1=$(date +%s%N)
  echo $(( (t1 - t0) / 1000000 ))
}

stats() { # stats <file-of-ms> -> "median p95"
  sort -n "$1" | awk -v n="$(wc -l < "$1")" '
    { v[NR] = $1 }
    END {
      m = (n % 2) ? v[(n + 1) / 2] : (v[n / 2] + v[n / 2 + 1]) / 2
      i = int((n * 95 + 99) / 100); if (i > n) i = n; if (i < 1) i = 1
      printf "%.0f %.0f\n", m, v[i]   # trailing newline: read would else report EOF
    }'
}

bench_case() { # bench_case <label> <query> <cmd...>  (@Q@ in cmd = query)
  local label="$1" q="$2"; shift 2
  local cmd=() a
  for a in "$@"; do cmd+=("${a//@Q@/$q}"); done
  local f="$SCRATCH/times.$label" ms
  : > "$f"
  for _ in 1 2 3; do "${cmd[@]}" >/dev/null 2>&1 || true; done
  for _ in $(seq "$ITERS"); do
    ms=$(timens "${cmd[@]}")
    echo "$ms" >> "$f"
  done
  read -r MED P95 < <(stats "$f")
  printf '%s\t%s\t%s\n' "$label" "$MED" "$P95"
}

echo "corpus: $(find . -type f -not -path './.zvec-grep/*' | wc -l) files, $(du -sh . | cut -f1)"
"$ZG" --index --embedding "${ZVEC_GREP_EMBEDDING:-local/potion-code-16m-v2}" >/dev/null 2>&1 && "$ZG" --index --drop >/dev/null 2>&1 || true
echo "cold index (zg): $(timens "$ZG" --index --embedding "${ZVEC_GREP_EMBEDDING:-local/potion-code-16m-v2}") ms"
"$ZG" --status --check-ready >/dev/null 2>&1 || { echo "bench: zg index build failed" >&2; exit 1; }
echo
echo -e "tool\tmedian_ms\tp95_ms"
bench_case zg-hybrid "parse stdout" "$ZG" --hybrid @Q@ --limit 3 --preview none --color never --mode auto
bench_case zg-fts    "parse stdout" "$ZG" --fts @Q@ --limit 3 --preview none --color never --mode auto
bench_case zg-vector "parse stdout" "$ZG" --vector @Q@ --limit 3 --preview none --color never --mode auto
bench_case zg-rg     "parse stdout" "$ZG" --rg @Q@ --limit 3 --color never
bench_case ripgrep   "parse stdout" rg --no-heading -n -g '!.zvec-grep/**' @Q@ .
bench_case grep      "parse stdout" grep -rn --exclude-dir=.zvec-grep @Q@ .

# --- Hit@3: natural-language questions; a query scores 1 when any top-3
# result (path) answers it. Answer keys are relevant SETS: the implementing
# source file or the doc section that answers the same question. Keys were
# fixed before running; see doc/benchmark.md for the judgments.
if [ "$SELF" = 1 ]; then
  echo
  echo "hit@3 (1 = some top-3 result answers the question)"
  printf 'query\tzg-hybrid\tzg-fts\tripgrep\tgrep\n'
  QUERIES=(
    "where does the tool output get parsed from stdout|parse\\.ts|src/index\\.ts|AGENTS\\.md"
    "how does the extension avoid hanging when the child process exits|src/index\\.ts|README\\.md|AGENTS\\.md"
    "installing the search binary globally with a fallback|zg\\.ts|README\\.md"
    "building command line arguments for the search engine|args\\.ts|NOTES\\.md|AGENTS\\.md"
    "caching index readiness per working directory|zg\\.ts|README\\.md|AGENTS\\.md"
  )
  for row in "${QUERIES[@]}"; do
    q="${row%%|*}"; keys="${row#*|}"
    line="$q"
    for tool in hybrid fts rg grep; do
      case "$tool" in
        hybrid) "$ZG" --hybrid "$q" --limit 3 --preview none --color never --mode auto ;;
        fts)    "$ZG" --fts "$q" --limit 3 --preview none --color never --mode auto ;;
        rg)     rg --no-heading -n -g '!.zvec-grep/**' "$q" . ;;
        grep)   grep -rn --exclude-dir=.zvec-grep "$q" . ;;
      esac > "$SCRATCH/out.$tool" 2>/dev/null || true
      paths=$(grep -oE '[^ :]+\.[A-Za-z]+:[0-9]+' "$SCRATCH/out.$tool" | cut -d: -f1 | head -3 | sort -u || true)
      if [ -n "$paths" ] && echo "$paths" | grep -qE "$keys"; then hit=1; else hit=0; fi
      line="$line\t$hit"
    done
    printf '%b\n' "$line"
  done
fi
