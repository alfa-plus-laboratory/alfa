# Extension API v1

An extension exports `apiVersion = 1` and `activate(api)`. `api` is typed by `src/extension/api.ts`:

- `registerTool({id, description, parameters, execute})`: Zod parameters, `ToolContext`, `ToolResult`; IDs must start with `x_` and use only lowercase letters, digits and underscores. Calls pass the `extension` permission before execution. Core IDs cannot be overwritten.
- `onTool("before" | "after", listener)`: tool ID, input, context, result or error. Before events may reject execution. After observer errors cannot turn a successful side effect into a failed call and provoke a retry.
- `registerCommand("name", handler)`: invoked as `/x:name args`. Names use lowercase letters, digits and hyphens; a duplicate name fails loading.
- `ui.notify(text)`: plain text in the permanent transcript; no screen coordinates or terminal controls.

Tool definitions remain sorted for prompt caching. Event handlers are awaited; extensions must avoid slow/unbounded handlers. The API does not change the core agent loop.

Review the entire extension and dependencies, then compute the entry hash:

```sh
shasum -a 256 /absolute/path/extension.ts
```

Add to global `config.json`:

```json
{"extensions":[{"path":"/absolute/path/extension.ts","sha256":"<64 lowercase hex characters>"}]}
```

No project-local discovery or automatic installation occurs. A changed entry hash fails loading. This is **trust pinning, not sandboxing or a dependency lock**: imported files, packages, hooks and commands run with host privileges. Only install code you would run yourself. Removing the config entry and restarting revokes loading. The file-tool access helpers remain available through `ToolContext`, but malicious trusted host code can bypass them.

The runnable command/event example is `examples/extension.ts`. Custom tools can import the public TypeScript types and Zod from their own package; no SDK dependency is required. An extension needs its dependencies installed separately even when alfa is a compiled single-file binary.
