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
set -euo pipefail

CORPUS="${1:-}"
ITERS="${2:-20}"
SCRATCH="$(mktemp -d /tmp/zg-bench.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

if [ -z "$CORPUS" ]; then
  cd "$(dirname "$0")/.."
  SELF=1
else
  cd "$CORPUS"
  SELF=0
fi
tar --exclude=.git --exclude=node_modules --exclude=.zvec-grep \
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
echo "cold index (zg): $(timens zg index) ms"
echo
echo -e "tool\tmedian_ms\tp95_ms"
bench_case zg-hybrid "parse stdout" zg query @Q@ --limit 3 --preview none --mode auto
bench_case zg-fts    "parse stdout" zg query --fts @Q@ --limit 3 --preview none --mode auto
bench_case zg-vector "parse stdout" zg query --vector @Q@ --limit 3 --preview none --mode auto
bench_case zg-rg     "parse stdout" zg query --rg @Q@ --limit 3
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
        hybrid) zg query "$q" --limit 3 --preview none --mode auto ;;
        fts)    zg query --fts "$q" --limit 3 --preview none --mode auto ;;
        rg)     rg --no-heading -n -g '!.zvec-grep/**' "$q" . ;;
        grep)   grep -rn --exclude-dir=.zvec-grep "$q" . ;;
      esac > "$SCRATCH/out.$tool" 2>/dev/null || true
      paths=$(grep -oE '[^ :]+\.[A-Za-z]+:[0-9]+' "$SCRATCH/out.$tool" | cut -d: -f1 | head -3 | sort -u)
      if [ -n "$paths" ] && echo "$paths" | grep -qE "$keys"; then hit=1; else hit=0; fi
      line="$line\t$hit"
    done
    printf '%b\n' "$line"
  done
fi
