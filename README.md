# `repocontext`

**The only MCP server you need for context-efficient codebase learning.** 14 read-only tools, tree-sitter parsing, zero LSP overhead. Saves 90–100% of tokens vs naive file reading.

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
      "command": ["npx", "-y", "@idea404/repocontext", "start"],
      "enabled": true
    }
  }
}
```

## Token budget

Measured on the repocontext repo itself (10 source files, 636-line `server.ts`):

| Scenario | Naive | repocontext | Saved |
|---|---|---|---|
| Read file structure | 5,986 tok | 500 tok | **92%** |
| Find symbol across 10 files | 15,653 tok | 18 tok | **100%** |
| Project overview (34 files) | 53,704 tok | 36 tok | **100%** |

*Naive = `cat`/`grep` on matching files. Tokens estimated at 4 chars/token.*

## Tools (14 total)

| Tool | Returns |
|---|---|
| `get_project_overview` | Language counts, entry points, config files, directory tree |
| `list_directory` | Files/subdirs in a path (depth-controlled) |
| `glob_files` | Files matching a glob pattern |
| `get_file_outline` | Symbols, imports, exports — no file body |
| `read_file` | Line range or symbol body only |
| `find_symbols` | Symbol name + location across project |
| `find_imports` | Import list per file |
| `trace_symbol` | Definition + references |
| `search_code` | Matching lines with context |
| `find_documentation` | README + docstring matches |
| `git_log` | Recent commits for a file |
| `git_blame` | Per-line author/history |
| `detect_language` | Language by extension |
| `list_roots` | Allowed filesystem roots |

All read-only, bounded, and root-safe.

## Why tree-sitter

Every tool returns only **structural metadata** — symbol names, line ranges, import sources — never raw file contents. No LSP, no type checker, no semantic resolution.

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
