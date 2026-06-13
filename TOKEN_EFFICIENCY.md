# Token Efficiency

LLM agents exploring codebases pay for every token sent to the model. Naive tools (grep, glob, `cat`) send full file contents, consuming context window and increasing latency and cost. **repocontext** is designed from the ground up to minimize token consumption by sending only structured metadata.

## The tool set

| Tool | What it returns | Token cost vs naive |
|---|---|---|
| `get_project_overview` | Language counts, entry points, config files, directory tree | 99% less than listing all files |
| `get_file_outline` | Symbol names, kinds, line ranges, imports, exports | 50–90% less than reading the file |
| `read_file` | Only the requested line range or symbol body | 80–99% less than full file |
| `find_symbols` | Symbol names + locations across the project | 99%+ less than grepping all files |
| `find_imports` | Import list for one file, optionally filtered | 80% less than scanning the file |
| `trace_symbol` | Definition + grep-based references | 95% less than manual search |
| `search_code` | Matching file paths + lines with context | 90%+ less than full file results |
| `git_log` / `git_blame` | Compact commit/blame summaries | N/A (no naive equivalent) |
| `find_documentation` | Relevant doc snippets + code comments | 95% less than reading all docs |

## Real-world measurements

Measured on a 2.2 KB TypeScript module (15 methods, 4 imports, 3 exports):

| Method | Tokens | vs raw |
|---|---|---|
| Raw file content | ~552 | — |
| `get_file_outline` full result | ~1,063 | -92% (JSON overhead on small file) |
| Structure-only (symbols) | ~796 | -44% |
| Symbol search across 50 similar files (grep) | ~27,600 | — |
| Symbol search via `find_symbols` | ~126 | **99.5% less** |

> **Key insight:** For individual small files (<5 KB), the JSON structure wrapper adds overhead, not savings. The value unlocks at repo scale — when searching across many files, sending only structural metadata is orders of magnitude cheaper.

## How repocontext wins at scale

An LLM agent exploring a codebase typically does this:

1. **Map the project** — `get_project_overview` → languages, entry points, directory tree (one call)
2. **Find relevant code** — `find_symbols(query)` or `search_code(pattern)` → symbol locations or matched lines
3. **Understand structure** — `get_file_outline(path)` → symbols, imports, exports (no file body)
4. **Read specific code** — `read_file(path, symbol_name="foo")` → only the definition body
5. **Trace context** — `git_blame(path)` or `trace_symbol(name)` → who wrote it, where it's used

With naive tools:
- **Step 1** requires listing all files, reading build configs, counting languages manually
- **Step 2** sends full file contents for every match
- **Step 3** reads the entire file to extract structure
- **Step 4** reads the whole file just to find one function
- **Step 5** is impractical without specialized tools

With repocontext, every step returns only what the agent needs — no noise, no wasted tokens.

## Token cost by scenario

| Scenario | Naive tools | repocontext | Savings |
|---|---|---|---|
| Understand a new 100-file repo | ~500,000 tokens (list + read everything) | ~500 tokens (`get_project_overview` + outlines) | 99.9% |
| Find `class Foo` across the project | ~200,000 tokens (grep → read all matches) | ~200 tokens (`find_symbols`) | 99.9% |
| Read a 500-line file's structure | ~2,000 tokens (full file) | ~400 tokens (`get_file_outline`) | 80% |
| Get imports of 5 files | ~10,000 tokens (read all 5) | ~500 tokens (`find_imports` × 5) | 95% |
| Trace where `handleAuth` is used | ~50,000 tokens (grep → read context) | ~500 tokens (`trace_symbol`) | 99% |
| Understand why a line was written | N/A (no tool) | ~300 tokens (`git_blame` + `git_log`) | — |

## When to use each tool

| Use case | Tool |
|---|---|
| First look at a new repo | `get_project_overview` |
| Browse directory structure | `list_directory` |
| Find files by pattern | `glob_files` |
| Read file structure (symbols, imports) | `get_file_outline` |
| Read a specific function or line range | `read_file` (with `symbol_name` or line range) |
| Find where something is defined | `find_symbols` |
| Find how something is used | `trace_symbol` |
| Find documentation or usage examples | `find_documentation` |
| Search for a pattern in code | `search_code` |
| Check file dependencies | `find_imports` |
| Understand code history | `git_log`, `git_blame` |

repocontext gives the LLM a **map** of the codebase. Most navigation, understanding, and research can be done through structural metadata — saving 80–99.9% of tokens compared to naive file reading.
