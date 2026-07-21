# SPRINGCODEGEN — MoProCo Extension Changes

Summary of all changes to the MoProCo (`mdellm`) VS Code extension for Spring Boot code generation.

---

## 1. Bug Fixes

### 1.1 Command ID Mismatch
- `myExtension.addToDiagram` → `mdellm.addToDiagram` (registration + CodeLens)
- The `package.json` declared `mdellm.addToDiagram` but the code registered `myExtension.addToDiagram`

### 1.2 Unused Import
- Removed `import { start } from 'repl'` from `llmprocessor.ts`

### 1.3 Windows-Safe Paths
- `filePath.split('/').pop()` → `path.basename()` in `llmprocessor.ts` and `extension.ts`

### 1.4 Llama.cpp API Fix
- Removed bogus `context` field (was sending the codebase string as a token array)
- Now uses `getSystemPrompt()` / `getUserPrompt()` for consistency with Ollama
- Raised `max_tokens` from 256 to 1024

### 1.5 Logging Guard
- `logResponse.context = []` now guarded against undefined

### 1.6 Class Name Derivation
- `regenerateMethod` now derives `className` from the class symbol (via `findParentClass`) instead of the filename

### 1.7 WorkspaceEdit Preservation
- Full-document `WorkspaceEdit.replace` now uses the actual last line end to preserve trailing newlines

### 1.8 System Prompt Fallback
- `systemprompt.txt` wired as fallback when `aiServer.systemPrompt` setting is empty
- `systemprompt-springboot.txt` added for Spring Boot mode

---

## 2. Robustness

### 2.1 Configurable Generation Parameters
New settings:
- `aiServer.temperature` (default 0.7)
- `aiServer.maxTokens` (default 1024)
- `aiServer.topP` (default 0.9)
- `aiServer.retryAttempts` (default 2)

Wired into all LLM backends (Llama.cpp, Ollama generate, Ollama chat, OpenAI).

### 2.2 Recursive File Scanning
- `getAllJavaFilesContent` and `processJavaFolder` now recursively walk subdirectories
- Previously only the immediate directory was scanned, so subpackages were missed

### 2.3 Context Size Budget
- `aiServer.contextMaxChars` (default 50000) limits total context characters
- `aiServer.contextMaxCharsBatch` (default 0) — separate limit for batch mode; falls back to `contextMaxChars` when 0
- Files are sorted by relevance before truncation

### 2.4 Retry on Transient Failures
- Exponential backoff retry on network/5xx errors
- 4xx errors are not retried
- Garbage/prose responses trigger retry

### 2.5 Error Reporting in Batch Mode
- Failures are collected and shown in a summary (`x/y methods succeeded`)
- Previously errors were silently swallowed

---

## 3. OpenAI-Compatible API

### 3.1 New Backend
- `aiServer.type: "openai"` option added
- `aiServer.openaiEndpoint` (default `http://localhost:11434/v1/chat/completions`)
- `aiServer.openaiApiKey` (Bearer token)
- Uses standard `/v1/chat/completions` format with system + user messages

---

## 4. Spring Boot Support

### 4.1 Separate System Prompt
- `systemprompt-springboot.txt` with Spring Boot service layer pattern rules:
  - Controllers, services, repositories, DTOs, domain entities
  - `@Transactional` boundaries
  - `Optional` return types from repositories
  - `java.util.stream.Collectors` for collections
  - **No `jakarta.ws.rs` / `javax.ws.rs`** classes
  - Use `ResponseStatusException(HttpStatus.NOT_FOUND, ...)` instead of `NotFoundException`
  - No `jakarta.annotation` / `javax.annotation`

### 4.2 Two Commands
- **"Process Java Folder"** — uses `systemprompt.txt` (plain Java)
- **"Process Spring Boot Folder"** — uses `systemprompt-springboot.txt`
- Both appear in the explorer context menu

### 4.3 Auto-Detection for Regenerate
- `regenerateMethod` auto-detects Spring Boot mode by checking for `@RestController`, `@Service`, `@Repository`, or `@SpringBootApplication` annotations

---

## 5. Context Relevance

### 5.1 Import-Based Prioritization
`sortFilesByRelevance` in `llmprocessor.ts`:
1. The target file itself
2. Direct interface (`DeliveryAddressService` for `DeliveryAddressServiceImpl`)
3. Files explicitly imported by the target file (via `parseImportedFiles`)
4. Repositories matching the concept
5. Domain entities matching the concept
6. DTOs
7. Other repositories
8. Same package
9. Everything else

`parseImportedFiles` reads the target file's `import` statements and maps class names to file paths.

### 5.2 Per-Method Context
- In batch mode, context is built per method (not per file) with the target file as relevance anchor
- Separate `contextMaxCharsBatch` setting for batch mode

---

## 6. Response Parsing

### 6.1 `extractJavaCode` Rewritten
- Handles fenced code blocks (```` ```java ````) — returns the last block
- Handles indented code blocks (4+ spaces) interspersed with prose
- Paragraph-based detection: splits response into paragraphs, finds those that look like code
- Returns the last code paragraph (usually the corrected version)

### 6.2 `isResponseValidJava` Hardened
- Prose detection at 30% threshold
- Checks for Java syntax indicators
- Balanced braces/parens (ignoring string literals)
- Fragmented code detection (starts with `.`, `)`, `,`, `&&`, `||`, `:`)
- More prose indicators (`However`, `Based on`, `notice that`, `incorrect`, `missing`, `assumption`)

### 6.3 Garbage Detection with Retry
- If `isResponseValidJava` fails, the response is rejected and retried
- After all retries fail, the last invalid response is returned as best-effort with a warning

---

## 7. Postprocessing: Missing Imports

### 7.1 `addMissingImports` (in `src/imports.ts`)
- Builds a class name → package map from all Java files in the folder
- Extracts class references from generated code (capitalized identifiers not preceded by a dot)
- Checks against existing imports and `java.lang` auto-imports
- Looks up missing classes in the project's class-to-package map
- Falls back to a hardcoded `KNOWN_JAVA_PACKAGES` map (~100 common `java.util`, `java.io`, `java.time`, etc.)
- Inserts new imports after the last existing import (or after the package declaration)
- Wired into both `processJavaFile` (batch) and `regenerateMethod` (interactive)

---

## 8. Diff/Preview

### 8.1 Interactive Regeneration
- `regenerateMethod` shows a diff view (current ↔ proposed) using virtual documents
- QuickPick: **Apply / Regenerate / Discard**
- "Regenerate" loops back to ask the LLM again
- After applying, missing imports are added automatically

---

## 9. Infrastructure

### 9.1 `tsconfig.json`
- `module: "Node16"`, `moduleResolution: "node16"`
- `typeRoots` and `types` explicitly set to `["node", "mocha"]`
- `include: ["src"]`

### 9.2 `launch.json`
- "Run Extension" (extensionHost) is now the first (default) configuration
- "Debug using Hotswap Agent" (Java) moved to second position

### 9.3 `.vscode/settings.json`
- `typescript.tsdk` set to workspace TS version

### 9.4 `@types/node`
- Upgraded to 26.1.1 for TS 6.0 compatibility

---

## 10. Settings Summary

| Setting | Default | Description |
|---------|---------|-------------|
| `aiServer.type` | `llama` | `llama`, `ollama`, or `openai` |
| `aiServer.model` | `devstral-small-2:24b` | Model name |
| `aiServer.systemPrompt` | (empty) | Custom system prompt; falls back to `systemprompt.txt` |
| `aiServer.llamaEndpoint` | `http://localhost:8080/completion` | Llama.cpp endpoint |
| `aiServer.ollamaEndpoint` | `http://localhost:11434/api/generate` | Ollama endpoint |
| `aiServer.ollamaApiApproach` | `generate` | `generate` or `chat` |
| `aiServer.ollamaApiKey` | (empty) | Ollama API key |
| `aiServer.openaiEndpoint` | `http://localhost:11434/v1/chat/completions` | OpenAI-compatible endpoint |
| `aiServer.openaiApiKey` | (empty) | OpenAI API key (Bearer token) |
| `aiServer.temperature` | `0.7` | LLM temperature |
| `aiServer.maxTokens` | `1024` | Max tokens to generate |
| `aiServer.topP` | `0.9` | Top-p (nucleus) sampling |
| `aiServer.contextMaxChars` | `50000` | Max context chars (interactive) |
| `aiServer.contextMaxCharsBatch` | `0` | Max context chars (batch); 0 = use `contextMaxChars` |
| `aiServer.retryAttempts` | `2` | Retry attempts on transient/garbage responses |

---

## 11. Commands

| Command | Title | Description |
|---------|-------|-------------|
| `mdellm.processJavaFolder` | Process Java Folder | Batch process with plain Java system prompt |
| `mdellm.processJavaFolderSpringBoot` | Process Spring Boot Folder | Batch process with Spring Boot system prompt |
| `mdellm.regenerateMethod` | 🔄 Regenerate | CodeLens on `@prompt` methods; auto-detects Spring Boot |
| `mdellm.addToDiagram` | ✨ Add to Model | CodeLens on `// generated start` markers |

---

## 12. Files Changed

| File | Changes |
|------|---------|
| `src/extension.ts` | Command registration, CodeLens, diff/preview, Spring Boot auto-detection |
| `src/llmprocessor.ts` | LLM backends, context building, response parsing, validation, retry |
| `src/imports.ts` | New file: `addMissingImports`, `buildClassToPackageMap` |
| `systemprompt.txt` | Plain Java system prompt |
| `systemprompt-springboot.txt` | Spring Boot system prompt |
| `package.json` | New settings, new command, `openai` enum |
| `tsconfig.json` | Fixed for TS 6.0 compatibility |
| `.vscode/launch.json` | Reordered launch configs |
| `.vscode/settings.json` | `typescript.tsdk` |
