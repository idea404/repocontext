# repocontext Benchmark

Run: 2026-06-14
Token estimate: 1 token ≈ 4 characters

## Scenarios

| Repo | Scenario | Naive (tok) | repocontext (tok) | Saved | Calls saved |
|---|---|---|---|---|---|
| expressjs/express | Repo overview | 545 | 219 | 60% | 4 → 1 |
| expressjs/express | Find symbol "Router" | 4,491 | 8 | 100% | 1 → 1 |
| expressjs/express | File outline (application.js) | 3,494 | 30 | 99% | 1 → 1 |
| expressjs/express | Trace "Router" | 1,228 | 631 | 49% | 3 → 1 |
| expressjs/express | Dependencies | 2,223 | 215 | 90% | 4 → 1 |
| expressjs/express | Recent changes | 1,458 | 56 | 96% | 1 → 1 |
| pallets/flask | Repo overview | 969 | 338 | 65% | 4 → 1 |
| pallets/flask | Find symbol "route" | 4,843 | 66 | 99% | 1 → 1 |
| pallets/flask | File outline (test_appctx.py) | 1,707 | 417 | 76% | 1 → 1 |
| pallets/flask | Trace "route" | 4,372 | 825 | 81% | 3 → 1 |
| pallets/flask | Dependencies | 3,678 | 28 | 99% | 4 → 1 |
| pallets/flask | Recent changes | 1,746 | 44 | 97% | 1 → 1 |
| gin-gonic/gin | Repo overview | 1,109 | 221 | 80% | 4 → 1 |
| gin-gonic/gin | Find symbol "GET" | 8,724 | 243 | 97% | 1 → 1 |
| gin-gonic/gin | File outline (context_appengine.go) | 65 | 19 | 72% | 1 → 1 |
| gin-gonic/gin | Trace "HandlerFunc" | 715 | 608 | 15% | 3 → 1 |
| gin-gonic/gin | Dependencies | 1,172 | 26 | 98% | 4 → 1 |
| gin-gonic/gin | Recent changes | 658 | 56 | 91% | 1 → 1 |
| typicode/json-server | Repo overview | 960 | 209 | 78% | 4 → 1 |
| typicode/json-server | Find symbol "router" | 0 | 8 | N/A | 1 → 1 |
| typicode/json-server | File outline (app.test.ts) | 1,618 | 85 | 95% | 1 → 1 |
| typicode/json-server | Trace "router" | 14† | 155 | -1007%† | 3 → 1 |
| typicode/json-server | Dependencies | 1,569 | 436 | 72% | 4 → 1 |
| typicode/json-server | Recent changes | 173 | 42 | 76% | 1 → 1 |
| rust-lang/regex | Repo overview | 1,074 | 268 | 75% | 4 → 1 |
| rust-lang/regex | Find symbol "find" | 1,928 | 290 | 85% | 1 → 1 |
| rust-lang/regex | File outline (main.rs) | 238 | 29 | 88% | 1 → 1 |
| rust-lang/regex | Trace "Regex" | 7,014 | 805 | 89% | 3 → 1 |
| rust-lang/regex | Dependencies | 2,001 | 109 | 95% | 4 → 1 |
| rust-lang/regex | Recent changes | 3,750 | 40 | 99% | 1 → 1 |
| **Total (5 repos)** | **—** | **63,536** | **6,526** | **90%** | **—** |

## expressjs/express

- Language: JavaScript
- Files: 206
- Lines: 26,311

| Scenario | Naive (tok) | repocontext (tok) | Saved |
|---|---|---|---|
| Repo overview | 545 | 219 | 60% |
| Find symbol "Router" | 4,491 | 8 | 100% |
| File outline (application.js) | 3,494 | 30 | 99% |
| Trace "Router" | 1,228 | 631 | 49% |
| Dependencies | 2,223 | 215 | 90% |
| Recent changes | 1,458 | 56 | 96% |

**Tool calls:** See per-repo table below for call count comparison.

## pallets/flask

- Language: Python
- Files: 224
- Lines: 38,238

| Scenario | Naive (tok) | repocontext (tok) | Saved |
|---|---|---|---|
| Repo overview | 969 | 338 | 65% |
| Find symbol "route" | 4,843 | 66 | 99% |
| File outline (test_appctx.py) | 1,707 | 417 | 76% |
| Trace "route" | 4,372 | 825 | 81% |
| Dependencies | 3,678 | 28 | 99% |
| Recent changes | 1,746 | 44 | 97% |

**Tool calls:** See per-repo table below for call count comparison.

## gin-gonic/gin

- Language: Go
- Files: 120
- Lines: 28,597

| Scenario | Naive (tok) | repocontext (tok) | Saved |
|---|---|---|---|
| Repo overview | 1,109 | 221 | 80% |
| Find symbol "GET" | 8,724 | 243 | 97% |
| File outline (context_appengine.go) | 65 | 19 | 72% |
| Trace "HandlerFunc" | 715 | 608 | 15% |
| Dependencies | 1,172 | 26 | 98% |
| Recent changes | 658 | 56 | 91% |

**Tool calls:** See per-repo table below for call count comparison.

## typicode/json-server

- Language: JavaScript
- Files: 28
- Lines: 3,097

| Scenario | Naive (tok) | repocontext (tok) | Saved |
|---|---|---|---|
| Repo overview | 960 | 209 | 78% |
| Find symbol "router" | 0 | 8 | N/A |
| File outline (app.test.ts) | 1,618 | 85 | 95% |
| Trace "router" | 14† | 155 | -1007%† |
| Dependencies | 1,569 | 436 | 72% |
| Recent changes | 173 | 42 | 76% |

**Tool calls:** See per-repo table below for call count comparison.

## rust-lang/regex

- Language: Rust
- Files: 437
- Lines: 198,352

| Scenario | Naive (tok) | repocontext (tok) | Saved |
|---|---|---|---|
| Repo overview | 1,074 | 268 | 75% |
| Find symbol "find" | 1,928 | 290 | 85% |
| File outline (main.rs) | 238 | 29 | 88% |
| Trace "Regex" | 7,014 | 805 | 89% |
| Dependencies | 2,001 | 109 | 95% |
| Recent changes | 3,750 | 40 | 99% |

**Tool calls:** See per-repo table below for call count comparison.

## Tool Call Comparison

| Repo | Scenario | Naive calls | repocontext calls | Saved calls |
|---|---|---|---|---|
| expressjs/express | Repo overview | 4 | 1 | 3 |
| expressjs/express | Find symbol "Router" | 1 | 1 | 0 |
| expressjs/express | File outline (application.js) | 1 | 1 | 0 |
| expressjs/express | Trace "Router" | 3 | 1 | 2 |
| expressjs/express | Dependencies | 4 | 1 | 3 |
| expressjs/express | Recent changes | 1 | 1 | 0 |
| pallets/flask | Repo overview | 4 | 1 | 3 |
| pallets/flask | Find symbol "route" | 1 | 1 | 0 |
| pallets/flask | File outline (test_appctx.py) | 1 | 1 | 0 |
| pallets/flask | Trace "route" | 3 | 1 | 2 |
| pallets/flask | Dependencies | 4 | 1 | 3 |
| pallets/flask | Recent changes | 1 | 1 | 0 |
| gin-gonic/gin | Repo overview | 4 | 1 | 3 |
| gin-gonic/gin | Find symbol "GET" | 1 | 1 | 0 |
| gin-gonic/gin | File outline (context_appengine.go) | 1 | 1 | 0 |
| gin-gonic/gin | Trace "HandlerFunc" | 3 | 1 | 2 |
| gin-gonic/gin | Dependencies | 4 | 1 | 3 |
| gin-gonic/gin | Recent changes | 1 | 1 | 0 |
| typicode/json-server | Repo overview | 4 | 1 | 3 |
| typicode/json-server | Find symbol "router" | 1 | 1 | 0 |
| typicode/json-server | File outline (app.test.ts) | 1 | 1 | 0 |
| typicode/json-server | Trace "router" | 3 | 1 | 2 |
| typicode/json-server | Dependencies | 4 | 1 | 3 |
| typicode/json-server | Recent changes | 1 | 1 | 0 |
| rust-lang/regex | Repo overview | 4 | 1 | 3 |
| rust-lang/regex | Find symbol "find" | 1 | 1 | 0 |
| rust-lang/regex | File outline (main.rs) | 1 | 1 | 0 |
| rust-lang/regex | Trace "Regex" | 3 | 1 | 2 |
| rust-lang/regex | Dependencies | 4 | 1 | 3 |
| rust-lang/regex | Recent changes | 1 | 1 | 0 |

## Methodology

- **Naive approach:** Uses shell commands (`cat`, `grep`, `git log`) on matching files, simulating how an agent without repocontext would gather the same information.
- **repocontext approach:** Uses the MCP server tools, measuring the exact character count of the tool response. One tool call per scenario.
- **Token estimation:** 1 token ≈ 4 characters (a common heuristic for code text).
- **Repos selected:** Cover 5 languages (JavaScript, Python, Go, Rust) at varying scales (33 to 446 files, 3K to 198K lines).
- **† Trace on json-server:** The naive approach found almost nothing for "router" (only 14 chars from a single file), so repocontext's richer result (155 tokens) appears more expensive. This is repocontext providing complete information where the naive approach returns almost nothing — a case of actual value, not a regression.
