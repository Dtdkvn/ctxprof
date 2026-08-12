# Storage benchmark

Ctxprof deliberately uses append-only JSONL for a small, local, single-process workload. The benchmark makes that tradeoff measurable instead of assuming that JSONL or SQLite is universally better.

Run the release-sized scenario after a storage, schema, serialization, or Node.js runtime change:

```bash
npm run benchmark:store
```

The command builds the current source, creates 3,000 deterministic `ProfileRun` records in a temporary store, performs one bounded batch append and a validated full read, prints machine-readable JSON, and removes the temporary data. Pass another count to explore scaling, up to the script's 50,000-run safety ceiling:

```bash
npm run benchmark:store -- 10000
```

Record the Node version, platform, byte size, append time, and full-read time with any performance report. Compare like-for-like runs on an otherwise idle machine; one timing is not a cross-machine service-level objective.

Reference release-audit run on 2026-08-12 (`linux/x64`, Docker Desktop, 3,000 runs / 16.46 MiB):

| Node | Batch append | Full validated read | Read throughput |
|---|---:|---:|---:|
| 22.23.2 | 266.96 ms | 196.18 ms | 15,292 runs/s |
| 24.19.0 | 271.19 ms | 198.35 ms | 15,125 runs/s |

These numbers are a reproducibility reference, not a promised latency across hardware.

## Decision boundary

The v0.1 storage target is one writer and up to 3,000 captures or approximately 25 MiB, whichever comes first. This bracket is large enough for the intended local profiling sessions and remains easy to inspect, archive, and delete with filesystem tools. The store is not presented as a trace database.

If representative user stores regularly cross that boundary, benchmark the current JSONL implementation against a SQLite adapter using the same records and operations before changing the default. A replacement must preserve `ProfileRun`, interrupted-write recovery, owner-only storage intent, deterministic ordering, zero runtime-package installs in the container, and the no-network workflow. Multi-writer access, indexed retention, or consistently poor reads above the documented boundary are evidence for an adapter; popularity alone is not.
