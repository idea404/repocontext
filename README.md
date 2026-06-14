# `repocontext`

**The only MCP server you need for context-efficient codebase learning.** 11 read-only tools, tree-sitter parsing, zero LSP overhead. Saves 90%+ tokens vs naive file reading and minimizes the number of tool calls needed to learn a repo.

## Quick start

```bash
npx -y @idea404/repocontext start
```

Add to opencode config:

```json
{
  "mcpServers": {
    "repocontext": {
      "type": "local",
      "command": ["sh", "-c", "cd /tmp \u0026\u0026 exec npx -y @idea404/repocontext start"],
      "enabled": true
    }
  }
}
```

> The `cd /tmp` wrapper avoids npm/npx resolving a local `package.json` when your agent's working directory happens to be the repocontext source repo itself. This ensures npx always uses the published package from the registry.

## Token budget

**Benchmarked across 5 open-source repos** (express, flask, gin, json-server, regex — 28–437 files each, covering JS/Python/Go/Rust):

| Scenario | Naive (tok) | repocontext (tok) | Saved | Calls saved |
|---|---|---|---|---|
| Repo overview (README + config + ls) | 545–1,109 | **209–338** | **60–80%** | 4 → 1 |
| Find symbol across codebase | 1,928–8,724 | **8–290** | **85–100%** | — |
| File outline (whole file vs symbols) | 65–3,494 | **19–417** | **72–99%** | — |
| Trace symbol (def + refs + git) | 715–7,014 | **608–825** | **15–89%** | 3 → 1 |
| Dependencies (config + imports) | 1,172–3,678 | **26–436** | **90–99%** | 4 → 1 |
| Recent changes (git log + names) | 173–3,750 | **40–56** | **76–99%** | — |
| **Overall (30 scenarios)** | **63,536** | **6,526** | **90%** | **3–4 → 1** |

Token estimate: 1 token ≈ 4 characters. Full methodology in [`BENCHMARK.md`](./BENCHMARK.md).

## Tools (11 total)

| Tool | Use it when you want to... |
|---|---|
| `repo_overview` | Learn a repo in one call: purpose, stack, languages, entry points, config, structure |
| `find` | Search files, symbols, or code content in one tool |
| `read` | Read line ranges, symbol bodies, or structural outlines |
| `query` | Ask a natural-language question and get relevant files + symbols |
| `trace` | Trace a symbol: definition, references, recent commits, blame |
| `deps` | See external dependencies and internal import graph |
| `tests` | Find tests for a file or overall test coverage |
| `changes` | See recent commits, authors, and hot files |
| `docs` | Search README/markdown and code comments for a topic |
| `analyze` | Deep-dive a file: symbols, imports, exports, refs, optional blame |
| `roots` | Show allowed filesystem roots |

All read-only, bounded, and root-safe.

## Learning workflow

1. Start with `repo_overview` to get the big picture.
2. Ask `query` for specific mechanisms ("how does auth work?").
3. Use `find` + `read` to drill into files.
4. Use `trace` to follow a symbol across the codebase.
5. Use `deps`, `tests`, and `changes` for cross-cutting context.

## Why tree-sitter

Every tool returns only **structural metadata** — symbol names, line ranges, import sources — and avoids sending whole files unless requested. No LSP, no type checker, no semantic resolution.

## Supported languages

WASM-based tree-sitter grammars: TypeScript/TSX, JavaScript, Python, Go, Rust, Java, C/C++, C#, Bash, Ruby, Swift, Kotlin, Elixir, Scala, PHP, OCaml, CSS, HTML, JSON, Lua, Dart, Zig, YAML, TOML, Vue, Elm, Objective-C.

Runs on any OS that supports Node.js, including NixOS, without native C++ compilation.

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
