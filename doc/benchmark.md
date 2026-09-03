# Benchmark: zg search vs ripgrep vs GNU grep

Numbers from a real run on 2026-09-03, with the exact script used
(`doc/bench.sh` in this repo). Rerun it yourself; expect roughly ±10%
run-to-run spread on latencies.

## What is compared

| Tool | Role |
|---|---|
| `zg` hybrid / fts / vector | this extension's engine, index-backed semantic + keyword search |
| `zg --rg` | zg running its ripgrep route (no index) |
| ripgrep 15.2.0 | the keyword-search baseline, no index |
| GNU grep 3.12 | the classic baseline, no index |

Two properties are measured:

1. **Query latency** — median and p95 over 20 timed runs per tool, after
   3 untimed warmups, on a warm page cache. Time covers the whole process
   (spawn to final output), which is what an agent actually waits for.
2. **Hit@3 on natural-language questions** — five questions about this
   repo, each with a fixed set of answers judged relevant beforehand (the
   implementing source file, or the doc section answering the same
   question). A tool scores 1 when any of its top 3 results comes from a
   relevant file. The keys were written before running and are listed in
   `doc/bench.sh`.

## Environment

- AMD Ryzen 5 5600H (12 threads), 13 GiB RAM, Arch Linux (kernel 7.1.9)
- zg 0.2.1, ripgrep 15.2.0, GNU grep 3.12, node 24.20.0
- embedding model already cached locally (no network during runs)

## Corpus A: this repo (code only, 72 files, 672 KB)

`doc/` is excluded from the corpus: the benchmark script and this file
contain the query strings verbatim, so search tools would match the test
harness instead of the code.

Cold index (zg only): **1135 ms**. rg and grep index nothing; that
asymmetry is the trade the index exists to pay for.

Query latency, median / p95 in ms:

| tool | median | p95 |
|---|---:|---:|
| zg hybrid | 410 | 431 |
| zg fts | 408 | 432 |
| zg vector | 409 | 435 |
| zg --rg | 236 | 240 |
| ripgrep | 5 | 5 |
| grep | 3 | 3 |

Hit@3 on the five natural-language questions:

| query | zg hybrid | zg fts | ripgrep | grep |
|---|---|---|---|---|
| where does the tool output get parsed from stdout | 1 | 1 | 0 | 0 |
| how does the extension avoid hanging when the child process exits | 1 | 1 | 0 | 0 |
| installing the search binary globally with a fallback | 1 | 1 | 0 | 0 |
| building command line arguments for the search engine | 1 | 1 | 0 | 0 |
| caching index readiness per working directory | 1 | 1 | 0 | 0 |

## Corpus B: expressjs/express (213 files, 1.3 MB, latency only)

Cloned at default branch, shallow. No answer keys were written for this
corpus, so only latency is reported.

Cold index (zg only): **2020 ms**.

| tool | median | p95 |
|---|---:|---:|
| zg hybrid | 411 | 422 |
| zg fts | 412 | 422 |
| zg vector | 410 | 433 |
| zg --rg | 230 | 237 |
| ripgrep | 6 | 7 |
| grep | 4 | 4 |

## Reading the numbers

- rg and grep win raw speed by two orders of magnitude, and will keep
  winning it: their 3–6 ms is a substring scan, while every zg query pays
  ~400 ms of model inference for embeddings. That ~400 ms is nearly flat
  between a 72-file and a 213-file corpus at this scale; the index pays
  off in retrieval quality, not in scan time.
- Keyword tools score 0/5 on the question set by construction: the
  questions are phrased in words that do not appear verbatim in the code,
  which is exactly the situation an agent is in before it knows the
  codebase's vocabulary. For exact-symbol lookups (`buildQueryArgs`,
  `ZG_TEST_E2E`) all tools find the target and rg is the fastest way.
- zg's ripgrep route (236 ms) is slower than raw rg because it spawns the
  same scan through an extra process plus JSON output; its value is one
  entry point with a uniform result shape, not speed.

## Replicating

```bash
git clone https://github.com/carvalab/pi-zgrep && cd pi-zgrep
npm install -g @zvec/zvec-grep        # or let the extension install it
./doc/bench.sh                        # latency + hit@3 on this repo
./doc/bench.sh /path/to/any/repo      # latency only, any corpus
./doc/bench.sh . 50                   # more iterations for tighter p95
```

The script copies the corpus to a scratch directory, so your working
tree is never indexed or modified. Everything is `date +%s%N`, `sort`,
and `awk` — read the 130-line script to see exactly what is timed.
