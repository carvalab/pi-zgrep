# Benchmark: zg search vs ripgrep vs GNU grep

Numbers from a real run on 2026-11-03 with zg 0.3.0, using the exact script in this repo (`doc/bench.sh`). Rerun it yourself; expect roughly ±10% run-to-run spread on latencies.

## What is compared

| Tool | Role |
| --- | --- |
| `zg` hybrid / fts / vector | this extension's engine, index-backed semantic + keyword search |
| `zg --rg` | zg running its ripgrep route (no index) |
| ripgrep 14.1.1 | the keyword-search baseline, no index |
| GNU grep 3.12 | the classic baseline, no index |

Two properties are measured:

1. **Query latency** — median and p95 over 20 timed runs per tool, after 3 untimed warmups, on a warm page cache. Time covers the whole process (spawn to final output), which is what an agent actually waits for.
2. **Hit@3 on natural-language questions** — five questions about this repo, each with a fixed set of answers judged relevant beforehand (the implementing source file, or the doc section answering the same question). A tool scores 1 when any of its top 3 results comes from a relevant file. The keys were written before running and are listed in `doc/bench.sh`.

## Environment

- AMD Ryzen 5 5600H (12 threads), 13 GiB RAM, Linux 7.2.8
- zg 0.3.0 (bundled `@zvec/zvec-grep-linux-x64-gnu`), ripgrep 14.1.1, GNU grep 3.12, node 24.20.0
- zg in direct mode, no daemon; model `local/potion-code-16m-v2`, cached locally (no network during runs)

## Corpus A: this repo (code only, 81 files, 780 KB)

`doc/` is excluded from the corpus: the benchmark script and this file contain the query strings verbatim, so search tools would match the test harness instead of the code.

Cold index (zg only): **1404 ms**. rg and grep index nothing; that asymmetry is the trade the index exists to pay for.

Query latency, median / p95 in ms:

| tool      | median | p95 |
| --------- | -----: | --: |
| zg hybrid |    802 | 852 |
| zg fts    |    682 | 689 |
| zg vector |    800 | 824 |
| zg --rg   |     12 |  15 |
| ripgrep   |      5 |   6 |
| grep      |      3 |   3 |

Hit@3 on the five natural-language questions:

| query | zg hybrid | zg fts | ripgrep | grep |
| --- | --- | --- | --- | --- |
| where does the tool output get parsed from stdout | 1 | 1 | 0 | 0 |
| how does the extension avoid hanging when the child process exits | 1 | 1 | 0 | 0 |
| installing the search binary globally with a fallback | 1 | 1 | 0 | 0 |
| building command line arguments for the search engine | 0 | 0 | 0 | 0 |
| caching index readiness per working directory | 1 | 1 | 0 | 0 |

## Corpus B: expressjs/express (216 files, 1.3 MB, latency only)

Cloned at default branch, shallow. No answer keys were written for this corpus, so only latency is reported.

Cold index (zg only): **2077 ms**.

| tool      | median | p95 |
| --------- | -----: | --: |
| zg hybrid |    812 | 877 |
| zg fts    |    692 | 730 |
| zg vector |    846 | 893 |
| zg --rg   |     13 |  14 |
| ripgrep   |      7 |   8 |
| grep      |      4 |   5 |

## 0.2.1 vs 0.3.0

| measurement                      | 0.2.1 (2026-09-03) | 0.3.0 (2026-11-03) |
| -------------------------------- | -----------------: | -----------------: |
| zg hybrid / fts / vector, median |            ~410 ms |         682–802 ms |
| zg --rg, median                  |             236 ms |              12 ms |
| cold index, repo / express       |     1135 / 2020 ms |     1404 / 2077 ms |
| hit@3, zg hybrid and fts         |                5/5 |                4/5 |

The two runs are not the same configuration: 0.3.0 here is the bundled binary in direct mode with the default model `local/potion-code-16m-v2`. Query latency rose on both corpora; **not measured: daemon mode**, so the regression is reported, not explained. `zg --rg` moved the other way and is now within ~10 ms of raw rg.

## Reading the numbers

- rg and grep still win raw speed by two orders of magnitude: their 3–7 ms is a substring scan, while a zg query pays a process plus embedding pass costing 680–850 ms. That cost is nearly flat between an 81-file and a 216-file corpus at this scale; the index pays off in retrieval quality, not in scan time.
- Keyword tools score 0/5 on the question set by construction: the questions are phrased in words that do not appear verbatim in the code, which is exactly the situation an agent is in before it knows the codebase's vocabulary. On this run zg scored 4/5: hybrid and fts both miss the command-line-arguments question. For exact-symbol lookups (`buildQueryArgs`, `ZG_TEST_E2E`) all tools find the target and rg is the fastest way.
- zg's ripgrep route (12 ms) is now close to raw rg (5–7 ms); the remaining gap is one extra process spawn plus JSON output. Its value is one entry point with a uniform result shape, not a faster scan.

## Replicating

```bash
git clone https://github.com/carvalab/pi-zgrep && cd pi-zgrep
npm install                           # bundled binary, no install scripts
./doc/bench.sh                        # latency + hit@3 on this repo
./doc/bench.sh /path/to/any/repo      # latency only, any corpus
./doc/bench.sh . 50                   # more iterations for tighter p95
```

No PATH edit and no install scripts: `npm install` leaves the platform binary at `node_modules/@zvec/zvec-grep-<os>-<arch>/bin/zg`, which the script picks up when neither `$ZG` nor a `zg` on `PATH` resolves.

`zg` comes from `$ZG`, else `zg` on `PATH`, else the bundled platform binary under `node_modules`; if none of those is runnable the script says so and exits 1. `TMPDIR` moves the scratch directory and `ZVEC_GREP_EMBEDDING` overrides the model (default `local/potion-code-16m-v2`). The script copies the corpus to that scratch directory, so your working tree is never indexed or modified. Everything is `date +%s%N`, `sort`, and `awk` — read the 129-line script to see exactly what is timed.
