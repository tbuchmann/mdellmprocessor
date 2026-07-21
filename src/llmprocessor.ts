import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { Ollama } from 'ollama';
import { addMissingImports } from './imports';
import { getLogger, resetLogger, extractOllamaUsage, extractOpenAIUsage, type TokenUsage } from './logger';

let extensionRootPath: string | undefined;

/**
 * Sets the extension root path so default resources (e.g. systemprompt.txt) can be located.
 */
export function setExtensionRootPath(rootPath: string): void {
    extensionRootPath = rootPath;
}

//const LLAMA_SERVER_URL = "http://127.0.0.1:8080/completion";

/**
 * Extracts Java code from LLM response, handling:
 * - Markdown fenced code blocks (```java ... ```)
 * - Indented code blocks (4+ spaces or tab)
 * - Non-indented code mixed with prose (paragraph-based detection)
 * - Multiple code blocks (returns the last/most complete one)
 * - Pure code responses with no prose
 */
export function extractJavaCode(response: string): string {
    const trimmed = response.trim();

    // 1. Try fenced code blocks (```java or ```)
    const fencedMatches = [...trimmed.matchAll(/```(?:java)?\n([\s\S]*?)```/gm)];
    if (fencedMatches.length > 0) {
        // Return the last fenced block (usually the corrected/final version)
        return fencedMatches[fencedMatches.length - 1][1].trim();
    }

    // 2. Split into paragraphs (separated by blank lines) and find code blocks
    const paragraphs = trimmed.split(/\n\s*\n/);

    // Check if a paragraph looks like Java code
    const isCodeParagraph = (text: string): boolean => {
        const lines = text.split('\n').filter(l => l.trim().length > 0);
        if (lines.length === 0) {
            return false;
        }

        // Prose indicators — if any line matches, it's not code
        const proseIndicators: RegExp[] = [
            /^(I|The|This|Here|Note|First|Then|After|In order|To |For |If |You |Your|However|Let|Sorry|Unfortunately|Based on|Now|So|But|And|Or)\b/i,
            /^(I[rm]|I[dl]|Let[st]|Let us|Please|Sorry|Unfortunately)\b/i,
            /\b(should|would|could|might|basically|essentially|in other words|notice that|I notice|incorrect|missing|assumption)\b/i,
        ];
        for (const line of lines) {
            if (proseIndicators.some(regex => regex.test(line.trim()))) {
                return false;
            }
        }

        // Code indicators — at least one line must look like Java
        const codeIndicators = [
            /\b(return|if|for|while|var|new|this|super|throw|try|catch|final|switch|case|break|continue)\b/,
            /\b(public|private|protected|static)\b/,
            /\w+\.\w+\(/, // method call
            /\b(int|long|double|float|boolean|String|List|Map|Set|Optional)\b/,
            /^[^A-Za-z]*\./, // starts with . (method chain)
        ];
        const hasCode = codeIndicators.some(regex => regex.test(text));
        if (!hasCode) {
            return false;
        }

        // Check for balanced braces (allow off-by-one for incomplete blocks)
        const openBraces = (text.match(/{/g) || []).length;
        const closeBraces = (text.match(/}/g) || []).length;
        if (Math.abs(openBraces - closeBraces) > 1) {
            return false;
        }

        return true;
    };

    // Find all paragraphs that look like code
    const codeParagraphs = paragraphs.filter(isCodeParagraph);

    if (codeParagraphs.length > 0) {
        // Return the last code paragraph (usually the final/corrected version)
        return codeParagraphs[codeParagraphs.length - 1].trim();
    }

    // 3. No code paragraphs found — return as-is (might be pure code without indentation)
    return trimmed;
}

/**
 * Normalizes whitespace in generated code
 */
export function normalizeCodeWhitespace(code: string): string {
    return code
        .split('\n')
        .map(line => line.trimEnd())
        .join('\n')
        .trim();
}

export async function processJavaFile(filePath: string, folderPath: string, mode: SystemPromptMode = 'default') {
    let content = fs.readFileSync(filePath, 'utf8');
    let className: string = path.basename(filePath, '.java');

    const javadocRegex = /\/\*\*[\s\S]*?@prompt\s+([\s\S]*?)\*\//g;
    let match;
    
    // Collect all matches first
    const matches: Array<{
        promptContent: string;
        javadocEndIndex: number;
        startGenIndex: number;
        endGenIndex: number;
        methodName: string;
    }> = [];

    while ((match = javadocRegex.exec(content)) !== null) {
        let promptContent = match[1].trim();
        
        // Handle multi-line @prompt (stopping at '*/')
        promptContent = promptContent.split("\n").map(line => line.trim().replace(/^\*/, "").trim()).join(" ");

        // Find the next '//generated start' after the JavaDoc
        const javadocEndIndex = match.index + match[0].length;
        const startGenIndex = content.indexOf('// generated start', javadocEndIndex);

        // Extract the complete method signature (including generics, annotations, etc.)
        // Search for the next method declaration after the javadoc
        const remainingContent = content.substring(javadocEndIndex);
        const methodRegex = /(?:public|private|protected)?\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:<[^>]+>\s+)?([a-zA-Z0-9_<>\[\].,?]+)\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)\s*(?:throws[^{]+)?\s*\{/;
        const methodMatch = remainingContent.match(methodRegex);
        let methodName = "UnknownMethod";

        if (methodMatch) {
            methodName = methodMatch[2];
            console.log(`[LLMProcessor] Found method: ${methodName}`);
        } else {
            console.warn(`[LLMProcessor] Could not extract method name from javadoc at index ${javadocEndIndex}`);
        }

        // Check if markers exist
        if (startGenIndex === -1) {
            console.warn(`[LLMProcessor] // generated start marker not found after javadoc for method ${methodName}`);
        } else {
            const endGenIndex = content.indexOf('// generated end', startGenIndex);
            if (endGenIndex === -1) {
                console.warn(`[LLMProcessor] // generated end marker not found for method ${methodName}`);
            } else {
                console.log(`[LLMProcessor] Found markers for method ${methodName}`);
                matches.push({
                    promptContent,
                    javadocEndIndex,
                    startGenIndex,
                    endGenIndex,
                    methodName
                });
            }
        }
    }

    // Process matches sequentially with progress tracking
    const totalMethods = matches.length;
    
    if (totalMethods === 0) {
        vscode.window.showInformationMessage("No methods with @prompt found in file.");
        return;
    }

    // Read all Java files in the folder as context (do this once per method, not per file)
    // The context is built per-method to keep the context window focused and avoid
    // exhausting the LLM's attention with irrelevant files.

    // Show progress while processing
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Processing Java methods (0/${totalMethods})`,
            cancellable: true,
        },
        async (progress, token) => {
            const failures: Array<{ methodName: string; error: string }> = [];

            for (let i = 0; i < matches.length; i++) {
                // Check if cancellation was requested
                if (token.isCancellationRequested) {
                    vscode.window.showWarningMessage("Method processing cancelled by user.");
                    break;
                }

                const matchItem = matches[i];

                // Update progress
                const message = `Processing method: ${matchItem.methodName} (${i + 1}/${totalMethods})`;
                progress.report({ message, increment: (100 / totalMethods) * i });

                try {
                    // Build per-method context with the method's class as target
                    const batchMaxChars = vscode.workspace.getConfiguration("aiServer").get<number>("contextMaxCharsBatch", 0);
                    const contextResult = getAllJavaFilesContent(folderPath, filePath, batchMaxChars > 0 ? batchMaxChars : undefined);

                    // Wait for the AI response
                    const llmResponse = await sendToAI(matchItem.promptContent, contextResult.content, contextResult.files, className, matchItem.methodName, mode);

                    if (!llmResponse || !llmResponse.trim()) {
                        throw new Error(`Empty response from LLM`);
                    }

                    // Extract Java code from response (handles markdown blocks)
                    const extractedCode = extractJavaCode(llmResponse);
                    
                    // Normalize whitespace
                    const normalizedCode = normalizeCodeWhitespace(extractedCode);
                    
                    if (!normalizedCode) {
                        throw new Error(`Empty code generated for method ${matchItem.methodName}`);
                    }
                    
                    // Re-read content to account for previous insertions
                    content = fs.readFileSync(filePath, 'utf8');
                    
                    // Re-find the method's javadoc in the current content by searching for
                    // the @prompt specification text. This is robust against index shifts
                    // caused by earlier method insertions.
                    const promptSnippet = matchItem.promptContent.substring(0, 60);
                    const javadocPos = content.indexOf(promptSnippet);
                    if (javadocPos === -1) {
                        throw new Error(`Could not find @prompt specification for method ${matchItem.methodName} in current content`);
                    }
                    const updatedStartGenIndex = content.indexOf('// generated start', javadocPos);
                    if (updatedStartGenIndex === -1) {
                        throw new Error(`Generated start marker not found for method ${matchItem.methodName}`);
                    }
                    const updatedEndGenIndex = content.indexOf('// generated end', updatedStartGenIndex);
                    if (updatedEndGenIndex === -1) {
                        throw new Error(`Generated end marker not found for method ${matchItem.methodName}`);
                    }

                    content = content.slice(0, updatedStartGenIndex + '// generated start'.length) +
                            "\n" + normalizedCode + "\n" +
                            content.slice(updatedEndGenIndex);
                    fs.writeFileSync(filePath, content, 'utf8');
                    console.log(`[LLMProcessor] Successfully inserted code for method: ${matchItem.methodName}`);

                    // Postprocessing: add missing imports
                    try {
                        const added = addMissingImports(filePath, normalizedCode, folderPath);
                        if (added.length > 0) {
                            // Re-read content since the file was modified
                            content = fs.readFileSync(filePath, 'utf8');
                        }
                    } catch (e) {
                        console.warn(`[LLMProcessor] Failed to add missing imports: ${e}`);
                    }
                } catch (error: any) {
                    const errorMsg = `${error.message}`;
                    console.error(`[LLMProcessor] Error for method ${matchItem.methodName}: ${errorMsg}`);
                    failures.push({ methodName: matchItem.methodName, error: errorMsg });
                }

                // Update final progress
                if (i === matches.length - 1) {
                    progress.report({ message: `Completed: ${matchItem.methodName}`, increment: 100 });
                }
            }

            // Summary
            const successCount = totalMethods - failures.length;
            if (failures.length === 0) {
                vscode.window.showInformationMessage(`Successfully processed ${successCount}/${totalMethods} method(s)`);
            } else {
                const failedList = failures.map(f => `  • ${f.methodName}: ${f.error}`).join('\n');
                vscode.window.showWarningMessage(
                    `Processed ${successCount}/${totalMethods} methods. ${failures.length} failed:\n${failedList}`
                );
            }
        }
    );

    console.log(`[LLMProcessor] Processed ${totalMethods} method(s) in ${path.basename(filePath)}`);
}
/*
function sendPrompt(prompt: string, method: string): string {
    let promptResult = '';

    const testMsg = async(prompt: string) => {
        try {
            let response = await fetch("http://127.0.0.1:8080/completion", {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                prompt,
                n_predict: 30,
                stream: true,
              }),
            });
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
              }

              if (!response.body) {
                throw new Error('Response body is null');
              }

              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let result = '';

              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  break;
                }
                result += decoder.decode(value, { stream: true });

                const lines = result.split('\n');
                for (const line of lines) {
                  if (line.startsWith('data:')) {
                    try {
                      const json = JSON.parse(line.substring(5).trim());
                      console.log(json.content);
                      let token = json.content;                      
                    } catch (e) {
                        console.error('Error parsing JSON:', e);
                    }
                }
                result = lines[lines.length - 1];
              }
            }
            promptResult = result;
        } catch (error) {
            console.error('Error:', error);
        }
    };

    return promptResult;
}
*/
export interface ContextResult {
    content: string;
    files: string[];
}

function getAllJavaFilesContent(folderPath: string, targetFilePath?: string, maxCharsOverride?: number): ContextResult {
    const config = vscode.workspace.getConfiguration("aiServer");
    const maxChars = maxCharsOverride ?? config.get<number>("contextMaxChars", 50000);

    const javaFiles: string[] = [];
    const collectJavaFiles = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                collectJavaFiles(fullPath);
            } else if (entry.name.endsWith(".java")) {
                javaFiles.push(fullPath);
            }
        }
    };
    collectJavaFiles(folderPath);

    // Select only relevant files: target + interface + imports
    const relevantFiles = targetFilePath
        ? getRelevantFiles(javaFiles, targetFilePath)
        : javaFiles;

    const parts: string[] = [];
    const includedFiles: string[] = [];
    let totalChars = 0;
    let truncated = false;

    for (const filePath of relevantFiles) {
        const relativeName = path.relative(folderPath, filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        const part = "### `" + relativeName + "`\n```java\n" + content + "```";

        if (maxChars > 0 && totalChars + part.length > maxChars) {
            truncated = true;
            break;
        }

        parts.push(part);
        includedFiles.push(relativeName);
        totalChars += part.length;
    }

    if (truncated) {
        console.warn(`[LLMProcessor] Context truncated at ${totalChars} chars (${parts.length}/${relevantFiles.length} relevant files) due to contextMaxChars=${maxChars}`);
        vscode.window.showWarningMessage(`Context truncated: ${parts.length}/${relevantFiles.length} relevant files included (${totalChars} chars). Increase 'aiServer.contextMaxChars' to include more.`);
    } else {
        console.log(`[LLMProcessor] Context: ${parts.length}/${javaFiles.length} files (${relevantFiles.length} relevant), ${totalChars} chars`);
    }

    return { content: parts.join("\n\n"), files: includedFiles };
}

/**
 * Returns only the files relevant to the target file:
 *   1. The target file itself
 *   2. The direct interface (e.g. DeliveryAddressService for DeliveryAddressServiceImpl)
 *   3. Files explicitly imported by the target file
 *
 * Files not referenced by the target file are excluded to keep the context
 * focused and avoid wasting the LLM's attention on irrelevant code.
 */
function getRelevantFiles(files: string[], targetFilePath: string): string[] {
    const targetName = path.basename(targetFilePath, '.java');
    // Strip "Impl" if present to get the base name (e.g. DeliveryAddressServiceImpl -> DeliveryAddressService)
    const baseName = targetName.endsWith('Impl') ? targetName.slice(0, -4) : targetName;

    // Parse imports from the target file
    const importedFiles = parseImportedFiles(targetFilePath, files);

    const result: string[] = [];
    const seen = new Set<string>();

    const addIfPresent = (filePath: string) => {
        if (!seen.has(filePath)) {
            seen.add(filePath);
            result.push(filePath);
        }
    };

    // 1. The target file itself
    addIfPresent(targetFilePath);

    // 2. Direct interface (e.g. DeliveryAddressService for DeliveryAddressServiceImpl)
    for (const filePath of files) {
        const fileName = path.basename(filePath, '.java');
        if (fileName === baseName && filePath !== targetFilePath) {
            addIfPresent(filePath);
            break;
        }
    }

    // 3. Files explicitly imported by the target file
    for (const filePath of importedFiles) {
        addIfPresent(filePath);
    }

    return result;
}

/**
 * Parses the import statements from a Java file and maps them to actual file paths
 * in the provided list of files.
 *
 * E.g. `import dev.moproco.icedlatte.dto.DeliveryAddressSnapshot;`
 * maps to `.../dto/DeliveryAddressSnapshot.java`
 */
function parseImportedFiles(targetFilePath: string, allFiles: string[]): Set<string> {
    const result = new Set<string>();

    let content: string;
    try {
        content = fs.readFileSync(targetFilePath, 'utf8');
    } catch {
        return result;
    }

    // Match: import <package>.<ClassName>;
    const importRegex = /import\s+(?:static\s+)?[\w.]+\.(\w+);/g;
    const importedClassNames = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
        importedClassNames.add(match[1]);
    }

    if (importedClassNames.size === 0) {
        return result;
    }

    // Map class names to file paths
    for (const filePath of allFiles) {
        const fileName = path.basename(filePath, '.java');
        if (importedClassNames.has(fileName)) {
            result.add(filePath);
        }
    }

    return result;
}

export function getAllJavaFilesContentExported(folderPath: string, targetFilePath?: string, maxCharsOverride?: number): ContextResult {
    return getAllJavaFilesContent(folderPath, targetFilePath, maxCharsOverride);
}

function getUserPrompt(className: string, methodName: string, specification: string, context: string): string {
    return `##Method to implement:\n\`${methodName}\` of class \`${className}\`\n\n##Specification:\n"${specification}"\n\n##Context\n\n${context}`;
}

function getGenerationOptions(): { temperature: number; maxTokens: number; topP: number } {
  const config = vscode.workspace.getConfiguration("aiServer");
  return {
      temperature: config.get<number>("temperature", 0.7),
      maxTokens: config.get<number>("maxTokens", 1024),
      topP: config.get<number>("topP", 0.9),
  };
}

export type SystemPromptMode = 'default' | 'springboot';

interface LLMResponse {
    text: string;
    usage?: TokenUsage;
}

function getSystemPrompt(mode: SystemPromptMode = 'default'): string {
  // For springboot mode, prefer the bundled Spring Boot prompt
  if (mode === 'springboot') {
      if (extensionRootPath) {
          try {
              const filePath = path.join(extensionRootPath, 'systemprompt-springboot.txt');
              return fs.readFileSync(filePath, 'utf8');
          } catch (e) {
              console.warn(`[LLMProcessor] Could not read systemprompt-springboot.txt: ${e}`);
          }
      }
  }

  const config = vscode.workspace.getConfiguration("aiServer");
  const configured = config.get<string>("systemPrompt", "");
  if (configured && configured.trim().length > 0) {
      return configured;
  }
  // Fall back to the bundled systemprompt.txt
  if (extensionRootPath) {
      try {
          const filePath = path.join(extensionRootPath, 'systemprompt.txt');
          return fs.readFileSync(filePath, 'utf8');
      } catch (e) {
          console.warn(`[LLMProcessor] Could not read systemprompt.txt: ${e}`);
      }
  }
  return "You are an experienced Java programmer. I will ask you questions on how to implement the body of certain Java methods. In your answer, only give the statements for the method body. And output the raw data.";
}

/*
async function sendToLlama(prompt: string, method: string, context: string) {
    let request = `Please give me a Java implementation for the method ${method}. The following prompt describes the desired behavior:\n\n${prompt}\n\nContext:\n\n${context}\n\nSource code only, without any explanations and only the body of the method. Don't repeat the Java source code. Please give me only the generated lines.`;
    try {
        const response = await axios.post(LLAMA_SERVER_URL, {
            prompt: request,
            context: context,
            temperature: 0.7,
            max_tokens: 256
        });

        vscode.window.showInformationMessage("Llama Response: " + response.data.content);
    } catch (error) {
        vscode.window.showErrorMessage("Error communicating with Llama server: " + error);
    }
}
*/

/**
 * Checks if the LLM response looks like valid Java code (not explanations/garbage).
 * Returns true if the response appears to be code.
 */
function isResponseValidJava(response: string): boolean {
    const trimmed = response.trim();
    if (trimmed.length === 0) {
        return false;
    }

    // Extract code block if present
    const code = extractJavaCode(trimmed);

    // If the extracted code is empty, it's garbage
    if (code.trim().length === 0) {
        return false;
    }

    const lines = code.split('\n');
    const nonEmptyLines = lines.filter(l => l.trim().length > 0);

    if (nonEmptyLines.length === 0) {
        return false;
    }

    // Check for common prose patterns that would indicate the extraction failed
    // to separate code from prose
    const proseIndicators: RegExp[] = [
        /^(I|The|This|Here|Note|First|Then|After|In order|To |For |If |You |Your|However|Let|Sorry|Unfortunately|Based on|Now|So|But|And|Or)\b/i,
        /^(I[rm]|I[dl]|Let[st]|Let us|Please|Sorry|Unfortunately)\b/i,
        /\b(should|would|could|might|basically|essentially|in other words|notice that|see that|I notice)\b/i,
        /\b(incorrect|wrong|issue|problem|error|missing|assumption)\b/i,
    ];

    let proseLineCount = 0;
    for (const line of nonEmptyLines) {
        if (proseIndicators.some(regex => regex.test(line.trim()))) {
            proseLineCount++;
        }
    }

    // If more than 30% of lines look like prose, it's garbage
    if (nonEmptyLines.length > 0 && proseLineCount / nonEmptyLines.length > 0.3) {
        return false;
    }

    // Check for at least some Java-like syntax
    const codeIndicators = [
        /\b(return|if|for|while|var|new|this|super|throw|try|catch|final|switch|case|break|continue)\b/,
        /[;{}()]/,
        /\b(public|private|protected|static)\b/,
        /\w+\.\w+\(/, // method call
        /\b(int|long|double|float|boolean|String|List|Map|Set|Optional)\b/,
    ];

    const hasCode = codeIndicators.some(regex => regex.test(code));
    if (!hasCode) {
        return false;
    }

    // Check for balanced braces (simple check, ignoring string literals)
    const codeWithoutStrings = code.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const openBraces = (codeWithoutStrings.match(/{/g) || []).length;
    const closeBraces = (codeWithoutStrings.match(/}/g) || []).length;
    if (Math.abs(openBraces - closeBraces) > 1) {
        // Unbalanced braces suggest truncated or malformed code
        return false;
    }

    // Check for fragmented code — starts mid-statement
    const firstNonEmptyLine = nonEmptyLines[0].trim();
    const fragmentedIndicators = [
        /^\./,          // starts with . (method chain without receiver)
        /^\)/,          // starts with ) (unbalanced parenthesis)
        /^,/,            // starts with , (argument continuation)
        /^&&/,           // starts with && (boolean continuation)
        /^\|\|/,         // starts with || (boolean continuation)
        /^:/,            // starts with : (ternary or label)
    ];
    if (fragmentedIndicators.some(regex => regex.test(firstNonEmptyLine))) {
        // Code starts mid-statement — likely missing the first line(s)
        return false;
    }

    // Check for unbalanced parentheses (ignoring string literals)
    const openParens = (codeWithoutStrings.match(/\(/g) || []).length;
    const closeParens = (codeWithoutStrings.match(/\)/g) || []).length;
    if (Math.abs(openParens - closeParens) > 1) {
        return false;
    }

    return true;
}

export async function sendToAI(prompt: string, context: string, contextFiles: string[], className: string, methodName: string, mode: SystemPromptMode = 'default') : Promise<string> {
  const config = vscode.workspace.getConfiguration("aiServer");
  const serverType = config.get<string>("type", "llama");
  const llmModel = config.get<string>("model", "qwen2.5-coder:7b");
  const retryAttempts = config.get<number>("retryAttempts", 2);
  const logger = getLogger();

  let lastError: any = null;
  let lastInvalidResponse: string | null = null;
  let lastInvalidUsage: TokenUsage | undefined;

  for (let attempt = 0; attempt <= retryAttempts; attempt++) {
      if (attempt > 0) {
          const delayMs = Math.pow(2, attempt) * 1000;
          console.log(`[LLMProcessor] Retry ${attempt}/${retryAttempts} for method ${methodName} after ${delayMs}ms`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      try {
          let result: LLMResponse;
          if (serverType === "llama") {
              result = await sendToLlama(prompt, context, className, methodName, config.get<string>("llamaEndpoint", "http://localhost:8080/completion"), llmModel, mode);
          } else if (serverType === "ollama") {
              const apiApproach = config.get<string>("ollamaApiApproach", "generate");
              const endpoint = config.get<string>("ollamaEndpoint", "http://localhost:11434/api/generate");

              if (apiApproach === "chat") {
                  result = await sendToOllamaChat(prompt, context, className, methodName, endpoint, llmModel, mode);
              } else {
                  result = await sendToOllama(prompt, context, className, methodName, endpoint, llmModel, mode);
              }
          } else if (serverType === "openai") {
              const endpoint = config.get<string>("openaiEndpoint", "http://localhost:11434/v1/chat/completions");
              const apiKey = config.get<string>("openaiApiKey", "");
              result = await sendToOpenAI(prompt, context, className, methodName, endpoint, llmModel, apiKey, mode);
          } else {
              vscode.window.showErrorMessage("Invalid AI server type selected.");
              return "";
          }

          const text = result.text;
          const usage = result.usage;

          if (text && text.trim().length > 0) {
              // Check if the LLM returned the default placeholder body
              if (/throw\s+new\s+UnsupportedOperationException\s*\(\s*["']Not\s+yet\s+implemented["']\s*\)/.test(text)) {
                  console.warn(`[LLMProcessor] Response for method ${methodName} is the default placeholder (UnsupportedOperationException) (attempt ${attempt + 1}/${retryAttempts + 1})`);
                  lastError = new Error(`Default placeholder response from ${serverType}`);
                  lastInvalidResponse = text;
                  lastInvalidUsage = usage;
                  // Continue to retry
              }
              // Validate that the response looks like code, not prose
              else if (isResponseValidJava(text)) {
                  logger.log({
                      timestamp: new Date().toISOString(),
                      className,
                      methodName,
                      mode,
                      prompt: getUserPrompt(className, methodName, prompt, context),
                      response: text,
                      status: 'success',
                      usage,
                      attempt: attempt + 1,
                      contextFiles,
                  });
                  if (usage) {
                      console.log(`[LLMProcessor] Tokens for ${methodName}: prompt=${usage.promptTokens}, completion=${usage.completionTokens}, total=${usage.totalTokens}`);
                  }
                  return text;
              } else {
                  console.warn(`[LLMProcessor] Response for method ${methodName} does not look like valid Java code (attempt ${attempt + 1}/${retryAttempts + 1})`);
                  lastError = new Error(`Invalid response (not Java code) from ${serverType}`);
                  lastInvalidResponse = text;
                  lastInvalidUsage = usage;
                  // Continue to retry
              }
          } else {
              lastError = new Error(`Empty response from ${serverType}`);
          }
      } catch (error: any) {
          lastError = error;
          // Don't retry on 4xx client errors
          if (error?.response?.status >= 400 && error?.response?.status < 500) {
              break;
          }
      }
  }

  if (lastError) {
      const serverName = serverType === "llama" ? "Llama.cpp" : (serverType === "openai" ? "OpenAI" : "Ollama");
      handleRequestError(lastError, serverName, methodName);

      // Last resort: if we have an invalid response that contains some code, return it
      if (lastInvalidResponse) {
          // Don't return the placeholder
          if (/throw\s+new\s+UnsupportedOperationException\s*\(\s*["']Not\s+yet\s+implemented["']\s*\)/.test(lastInvalidResponse)) {
              console.warn(`[LLMProcessor] Not returning placeholder for method ${methodName}`);
              logger.log({
                  timestamp: new Date().toISOString(),
                  className,
                  methodName,
                  mode,
                  prompt: getUserPrompt(className, methodName, prompt, context),
                  response: lastInvalidResponse,
                  status: 'placeholder',
                  error: lastError.message,
                  usage: lastInvalidUsage,
                  attempt: retryAttempts + 1,
                  contextFiles,
              });
              return "";
              }
          const extractedCode = extractJavaCode(lastInvalidResponse);
          if (extractedCode && extractedCode.trim().length > 0) {
              console.warn(`[LLMProcessor] Returning last invalid response for method ${methodName} after all retries failed`);
              vscode.window.showWarningMessage(`Method ${methodName}: Using best-effort code after validation failed. Please review.`);
              logger.log({
                  timestamp: new Date().toISOString(),
                  className,
                  methodName,
                  mode,
                  prompt: getUserPrompt(className, methodName, prompt, context),
                  response: lastInvalidResponse,
                  status: 'invalid',
                  error: lastError.message,
                  usage: lastInvalidUsage,
                  attempt: retryAttempts + 1,
                  contextFiles,
              });
              return lastInvalidResponse;
          }
      } else {
          // No response at all
          logger.log({
              timestamp: new Date().toISOString(),
              className,
              methodName,
              mode,
              prompt: getUserPrompt(className, methodName, prompt, context),
              response: '',
              status: 'failed',
              error: lastError.message,
              attempt: retryAttempts + 1,
              contextFiles,
          });
      }
  }
  return "";
}

async function sendToLlama(prompt: string, context: string, className: string, methodName: string, endpoint: string, llmmodel: string, mode: SystemPromptMode = 'default') : Promise<LLMResponse> {
  try {
      console.log(`[LLMProcessor] Sending request to Llama.cpp for method: ${methodName}`);
      const systemPrompt = getSystemPrompt(mode);
      const userPrompt = getUserPrompt(className, methodName, prompt, context);
      const opts = getGenerationOptions();
      const response = await axios.post(endpoint, {
          prompt: userPrompt,
          system_prompt: systemPrompt,
          temperature: opts.temperature,
          top_p: opts.topP,
          max_tokens: opts.maxTokens,
          stop: ["\n}\n"]
      });

      const responseText = response.data.text || response.data.content || '';
      if (!responseText) {
          throw new Error('Empty response from Llama.cpp');
      }

      console.log(`[LLMProcessor] Received response from Llama.cpp (${responseText.length} chars)`);
      return { text: responseText };
  } catch (error: any) {
      console.error(`[LLMProcessor] Llama.cpp error for method ${methodName}: ${error.message}`);
      throw error;
  }
}

async function sendToOllama(prompt: string, context: string, className: string, methodName: string, endpoint: string, llmmodel: string, mode: SystemPromptMode = 'default') : Promise<LLMResponse> {
  try {
      console.log(`[LLMProcessor] Sending request to Ollama for method: ${methodName}`);
      // Initialize Ollama client - endpoint should be the base URL (e.g., http://localhost:11434)
      const baseUrl = endpoint.replace('/api/generate', ''); // Remove the endpoint path if present
      const config = vscode.workspace.getConfiguration("aiServer");
      const apiKey = config.get<string>("ollamaApiKey", "");

      const ollamaOptions: any = { host: baseUrl };
      if (apiKey) {
          ollamaOptions.headers = { 'Authorization': `Bearer ${apiKey}` };
      }

      const ollama = new Ollama(ollamaOptions);

      const systemPrompt = getSystemPrompt(mode);
      const userPrompt = getUserPrompt(className, methodName, prompt, context);
      const opts = getGenerationOptions();

      // Use Ollama library to generate response
      const response = await ollama.generate({
          model: llmmodel,
          prompt: userPrompt,
          system: systemPrompt,
          stream: false,
          options: {
              temperature: opts.temperature,
              top_p: opts.topP,
              num_predict: opts.maxTokens,
          },
      });

      const generatedText = response.response || '';
      if (!generatedText) {
          throw new Error('Empty response from Ollama');
      }

      console.log(`[LLMProcessor] Received response from Ollama (${generatedText.length} chars)`);
      const usage = extractOllamaUsage(response);
      const logResponse = response as any;
      logResponse.response = "";
      if (Array.isArray(logResponse.context)) {
          logResponse.context = [];
      }
      console.log(JSON.stringify(logResponse));
      return { text: generatedText, usage };
  } catch (error: any) {
      console.error(`[LLMProcessor] Ollama error for method ${methodName}: ${error.message}`);
      throw error;
  }
}

async function sendToOllamaChat(prompt: string, context: string, className: string, methodName: string, endpoint: string, llmmodel: string, mode: SystemPromptMode = 'default') : Promise<LLMResponse> {
  try {
      console.log(`[LLMProcessor] Sending chat request to Ollama for method: ${methodName}`);
      // Initialize Ollama client - endpoint should be the base URL (e.g., http://localhost:11434)
      const baseUrl = endpoint.replace('/api/generate', ''); // Remove the endpoint path if present
      const config = vscode.workspace.getConfiguration("aiServer");
      const apiKey = config.get<string>("ollamaApiKey", "");

      const ollamaOptions: any = { host: baseUrl };
      if (apiKey) {
          ollamaOptions.headers = { 'Authorization': `Bearer ${apiKey}` };
      }

      const ollama = new Ollama(ollamaOptions);

      const systemPrompt = getSystemPrompt(mode);
      const opts = getGenerationOptions();

      // Use Ollama chat API with structured messages
      const response = await ollama.chat({
          model: llmmodel,
          messages: [
              {
                  role: 'system',
                  content: systemPrompt
              },
              {
                  role: 'user',
                  content: `**Method to implement**: ${methodName} of class ${className}\n\n**Specification**: ${prompt}\n\n**Context**:\n${context}`
              }
          ],
          stream: false,
          options: {
              temperature: opts.temperature,
              top_p: opts.topP,
              num_predict: opts.maxTokens,
          },
      });

      const generatedText = response.message?.content || '';
      if (!generatedText) {
          throw new Error('Empty response from Ollama Chat');
      }

      console.log(`[LLMProcessor] Received chat response from Ollama (${generatedText.length} chars)`);
      const usage = extractOllamaUsage(response);
      return { text: generatedText, usage };
  } catch (error: any) {
      console.error(`[LLMProcessor] Ollama Chat error for method ${methodName}: ${error.message}`);
      throw error;
  }
}

async function sendToOpenAI(prompt: string, context: string, className: string, methodName: string, endpoint: string, llmmodel: string, apiKey: string, mode: SystemPromptMode = 'default') : Promise<LLMResponse> {
  try {
      console.log(`[LLMProcessor] Sending request to OpenAI-compatible API for method: ${methodName}`);
      const systemPrompt = getSystemPrompt(mode);
      const userPrompt = getUserPrompt(className, methodName, prompt, context);
      const opts = getGenerationOptions();

      const headers: Record<string, string> = {
          'Content-Type': 'application/json',
      };
      if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const response = await axios.post(endpoint, {
          model: llmmodel,
          messages: [
              {
                  role: 'system',
                  content: systemPrompt
              },
              {
                  role: 'user',
                  content: userPrompt
              }
          ],
          temperature: opts.temperature,
          top_p: opts.topP,
          max_tokens: opts.maxTokens,
          stream: false,
      }, { headers });

      const generatedText = response.data?.choices?.[0]?.message?.content || '';
      if (!generatedText) {
          throw new Error('Empty response from OpenAI-compatible API');
      }

      console.log(`[LLMProcessor] Received response from OpenAI-compatible API (${generatedText.length} chars)`);
      const usage = extractOpenAIUsage(response);
      return { text: generatedText, usage };
  } catch (error: any) {
      console.error(`[LLMProcessor] OpenAI API error for method ${methodName}: ${error.message}`);
      throw error;
  }
}

function handleRequestError(error: any, serverName: string, methodName?: string) {
  let errorMsg = '';
  
  if (error.response) {
      errorMsg = `${serverName} API Error: ${error.response.status} - ${error.response.statusText}`;
      console.error(`[LLMProcessor] ${errorMsg}`);
      if (error.response.data) {
          console.error(`[LLMProcessor] Response data:`, error.response.data);
      }
  } else if (error.request) {
      errorMsg = `${serverName} is unreachable. Check the server URL and ensure it's running.`;
      console.error(`[LLMProcessor] ${errorMsg}. Endpoint: ${error.config?.url}`);
  } else {
      errorMsg = `Error sending request to ${serverName}: ${error.message}`;
      console.error(`[LLMProcessor] ${errorMsg}`);
  }
  
  const fullMessage = methodName ? `${errorMsg} (Method: ${methodName})` : errorMsg;
  vscode.window.showErrorMessage(fullMessage);
}

/*
function processResponse(response: any, methodName: string) {
    // Assuming the response is a string containing the generated method body
    const generatedCode = response.trim();

    // Display the generated code in a VSCode information message
    vscode.window.showInformationMessage(`Generated code for ${methodName}:\n${generatedCode}`);
}
*/
