import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { processJavaFile, sendToAI as sendToAILLM, extractJavaCode, normalizeCodeWhitespace, getAllJavaFilesContentExported, setExtensionRootPath, SystemPromptMode } from './llmprocessor';
import { addMissingImports } from './imports';
import { resetLogger, getLogger } from './logger';

export function activate(context: vscode.ExtensionContext) {
    setExtensionRootPath(context.extensionPath);

	let commandDisposable = vscode.commands.registerCommand('mdellm.addToDiagram', async (methodRange: vscode.Range) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const doc = editor.document;
        const fullMethodText = doc.getText(methodRange);

        // 1. Extract code between markers
        const startMarker = "// generated start";
        const endMarker = "// generated end";
        const startIndex = fullMethodText.indexOf(startMarker);
        const endIndex = fullMethodText.indexOf(endMarker);

        if (startIndex === -1 || endIndex === -1) {
            vscode.window.showErrorMessage("Marker '// generated start/end' nicht gefunden.");
            return;
        }

        const extractedCode = fullMethodText.substring(startIndex + startMarker.length, endIndex).trim();

        // 2. Retrieve metadata (class and method names)        
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri);
        const methodSymbol = findSymbolAtRange(symbols || [], methodRange);
        const classSymbol = findParentClass(symbols || [], methodRange);

        if (!methodSymbol || !classSymbol) {
            vscode.window.showErrorMessage("Class or method could not be identified.");
            return;
        }

        const methodName = methodSymbol.name.split('(')[0].trim(); // if Java-LS gives the signature
        const methodSignature = methodSymbol.name; // Full signature including parameters
        const className = classSymbol.name;

        // Convert Java parameter notation to UML notation
        // Java: method(Type param) -> UML: method(param: Type)
        const umlSignature = convertToUMLSignature(methodSignature);

        // 3. Find .cdiag in Workspace 
        const cdiagFiles = await vscode.workspace.findFiles('**/*.cdiag');
        if (cdiagFiles.length === 0) {
            vscode.window.showErrorMessage("Keine .cdiag Datei im Projekt gefunden.");
            return;
        }

        // we take the first match 
        // TODO implement selecting the correct .cdiag if multiple exist
        const cdiagUri = cdiagFiles[0];
        const cdiagDoc = await vscode.workspace.openTextDocument(cdiagUri);
        const cdiagText = cdiagDoc.getText();

        // 4. Insert into DSL via Regex
        // searches the class, then the method, then the opening {
        // then finds the spec "..." and inserts after it
        const newImpl = `impl java << ${extractedCode} >>`;
        
        // First, try to match using the UML signature (method_name with UML parameters)
        // If that fails, fall back to just the method name
        let escapedMethodName = umlSignature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let methodRegex = new RegExp(`(${escapedMethodName}\\s*(?::\\s*\\w+)?\\s*\\{\\s*spec\\s+"[^"]*")`, 'm');
        
        let match = methodRegex.exec(cdiagText);
        
        // Fallback: if UML signature doesn't match, try just the method name
        if (!match) {
            escapedMethodName = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            methodRegex = new RegExp(`(${escapedMethodName}\\s*\\([^)]*\\)\\s*(?::\\s*\\w+)?\\s*\\{\\s*spec\\s+"[^"]*")`, 'm');
            match = methodRegex.exec(cdiagText);
        }

        if (match) {
            const insertPosition = match.index + match[0].length;
            const updatedContent = cdiagText.slice(0, insertPosition) + "\n     " + newImpl + cdiagText.slice(insertPosition);
            
            // save file
            const lastLine = cdiagDoc.lineAt(cdiagDoc.lineCount - 1);
            const fullRange = new vscode.Range(0, 0, lastLine.lineNumber, lastLine.text.length);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(cdiagUri, fullRange, updatedContent);
            await vscode.workspace.applyEdit(edit);
            await cdiagDoc.save();

            vscode.window.showInformationMessage(`Code in ${path.basename(cdiagUri.fsPath)} übertragen.`);
        } else {
            vscode.window.showErrorMessage(`Methode '${methodName}' in der DSL-Datei nicht gefunden.`);
        }
    });
	const processFolderCommand = async (uri: vscode.Uri, mode: SystemPromptMode) => {
		// Start timing
		console.time("[DEBUG] Total processing time");

		// Reset logger for this run
		resetLogger();
		const logger = getLogger();

		if (!uri || !fs.lstatSync(uri.fsPath).isDirectory()) {
			vscode.window.showErrorMessage("Please select a valid folder.");
			return;
		}

		// Recursively collect all .java files
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
		collectJavaFiles(uri.fsPath);

		if (javaFiles.length === 0) {
			vscode.window.showErrorMessage("No Java files found in this folder.");
			return;
		}

		vscode.window.showInformationMessage(`Processing folder: ${uri.fsPath}`);

		// Process files sequentially
		for (const file of javaFiles) {
			await processJavaFile(file, uri.fsPath, mode);
		}

		// Save usage summary and show results
		const usage = logger.getUsage();
		logger.saveUsageSummary();
		const summary = `Processed ${usage.methodCount} methods (${usage.failureCount} failed). ` +
			`Tokens: ${usage.totalTokens.toLocaleString()} total ` +
			`(${usage.promptTokens.toLocaleString()} prompt, ${usage.completionTokens.toLocaleString()} completion). ` +
			`Log: ${logger.getLogFile()}`;
		vscode.window.showInformationMessage(summary);
		console.log(`[LLMProcessor] ${summary}`);

		// Stop timing and log elapsed time
		console.timeEnd("[DEBUG] Total processing time");
	};

	const command = vscode.commands.registerCommand(
		"mdellm.processJavaFolder",
		async (uri: vscode.Uri) => {
			await processFolderCommand(uri, 'default');
		}
	  );

	const commandSpringBoot = vscode.commands.registerCommand(
		"mdellm.processJavaFolderSpringBoot",
		async (uri: vscode.Uri) => {
			await processFolderCommand(uri, 'springboot');
		}
	  );

	// Register regenerate command
	let regenerateDisposable = vscode.commands.registerCommand('mdellm.regenerateMethod', async (methodRange: vscode.Range) => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const doc = editor.document;
		const fullMethodText = doc.getText(methodRange);

		// 1. Extract prompt from JavaDoc
		const promptMatch = fullMethodText.match(/\/\*\*[\s\S]*?@prompt\s+([\s\S]*?)\*\//);
		if (!promptMatch) {
			vscode.window.showErrorMessage("@prompt tag not found in method JavaDoc");
			return;
		}

		let promptContent = promptMatch[1].trim();
		promptContent = promptContent.split("\n").map(line => line.trim().replace(/^\*/, "").trim()).join(" ");

		// 2. Extract code between markers
		const startMarker = "// generated start";
		const endMarker = "// generated end";
		const startIndex = fullMethodText.indexOf(startMarker);
		const endIndex = fullMethodText.indexOf(endMarker);

		if (startIndex === -1 || endIndex === -1) {
			vscode.window.showErrorMessage("Markers '// generated start/end' not found in method");
			return;
		}

		// 3. Get method name
		const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri);
		const methodSymbol = findSymbolAtRange(symbols || [], methodRange);
		const classSymbol = findParentClass(symbols || [], methodRange);

		if (!methodSymbol) {
			vscode.window.showErrorMessage("Could not identify method");
			return;
		}
		if (!classSymbol) {
			vscode.window.showErrorMessage("Could not identify enclosing class");
			return;
		}

		const methodName = methodSymbol.name.split('(')[0].trim();
		const className = classSymbol.name;

		// 4. Get context from folder
		const folderPath = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath;
		if (!folderPath) {
			vscode.window.showErrorMessage("Workspace folder not found");
			return;
		}

		// 4b. Detect if this is a Spring Boot project
		const docContent = doc.getText();
		const isSpringBoot = /@(RestController|Controller|Service|Repository|SpringBootApplication)\b/.test(docContent);
		const mode: SystemPromptMode = isSpringBoot ? 'springboot' : 'default';

		// 5. Send to LLM
		vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Regenerating method: ${methodName}`,
				cancellable: false,
			},
			async (progress) => {
				const contextText = getAllJavaFilesContentExported(folderPath, doc.uri.fsPath);

				let attempt = 0;
				while (true) {
					attempt++;
					const llmResponse = await sendToAILLM(promptContent, contextText, className, methodName, mode);

					if (!llmResponse) {
						vscode.window.showErrorMessage(`Failed to generate code for method: ${methodName}`);
						return;
					}

					try {
						const extractedCode = extractJavaCode(llmResponse);
						const normalizedCode = normalizeCodeWhitespace(extractedCode);

						if (!normalizedCode) {
							throw new Error('Empty code generated');
						}

						// 6. Locate markers in document
						const docContent = doc.getText();
						const startMarkerIndex = docContent.indexOf('// generated start', doc.offsetAt(methodRange.start));
						const endMarkerIndex = docContent.indexOf('// generated end', startMarkerIndex);

						if (startMarkerIndex === -1 || endMarkerIndex === -1) {
							throw new Error('Markers not found in document');
						}

						const startPos = doc.positionAt(startMarkerIndex + startMarker.length);
						const endPos = doc.positionAt(endMarkerIndex);

						// Current code between markers
						const currentCode = doc.getText(new vscode.Range(startPos, endPos)).trim();
						// Proposed new code
						const proposedCode = normalizedCode;

						// 7. Show diff preview
						const choice = await showDiffPreview(
							methodName,
							currentCode,
							proposedCode,
							attempt
						);

						if (choice === 'apply') {
							const edit = new vscode.WorkspaceEdit();
							edit.replace(doc.uri, new vscode.Range(startPos, endPos), "\n" + proposedCode + "\n");
							await vscode.workspace.applyEdit(edit);
							await doc.save();

							// Postprocessing: add missing imports
							try {
								const added = addMissingImports(doc.uri.fsPath, proposedCode, folderPath);
								if (added.length > 0) {
									// Re-open the document to see the changes
									await vscode.window.showTextDocument(doc.uri, { preview: false });
								}
							} catch (e: any) {
								console.warn(`[LLMProcessor] Failed to add missing imports: ${e}`);
							}

							const usage = getLogger().getUsage();
							const tokenInfo = usage.totalTokens > 0 ? ` (${usage.totalTokens.toLocaleString()} tokens used)` : '';
							vscode.window.showInformationMessage(`Successfully regenerated method: ${methodName}${tokenInfo}`);
							return;
						} else if (choice === 'discard') {
							vscode.window.showInformationMessage(`Discarded generated code for: ${methodName}`);
							return;
						}
						// else 'regenerate' -> loop again
					} catch (error: any) {
						vscode.window.showErrorMessage(`Error processing generated code: ${error.message}`);
						return;
					}
				}
			}
		);
	});

	// CodeLens Provider: places the button above methods with the marker
    let codeLensDisposable = vscode.languages.registerCodeLensProvider('java', {
        async provideCodeLenses(document: vscode.TextDocument) {
            const lenses: vscode.CodeLens[] = [];
            
            // 1. fetches all symbols (methods, classes) from the Java LS
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider', 
                document.uri
            );

            if (!symbols) return [];

            // 2. looks for our markers and @prompt tags in the document
            for (let i = 0; i < document.lineCount; i++) {
                const line = document.lineAt(i);
                
                // Check for @prompt in JavaDoc
                if (line.text.includes("@prompt")) {
                    const methodSymbol = findEnclosingMethod(symbols, line.range);
                    if (methodSymbol) {
                        lenses.push(new vscode.CodeLens(methodSymbol.range, {
                            title: "🔄 Regenerate",
                            command: "mdellm.regenerateMethod",
                            arguments: [methodSymbol.range]
                        }));
                    }
                }
                
                // Check for generated start marker
                if (line.text.includes("// generated start")) {
                    const methodSymbol = findEnclosingMethod(symbols, line.range);
                    if (methodSymbol) {
                        lenses.push(new vscode.CodeLens(methodSymbol.range, {
                            title: "✨ Add to model",
                            command: "mdellm.addToDiagram",
                            arguments: [methodSymbol.range]
                        }));
                    }
                }
            }
            return lenses;
        }
    });

	context.subscriptions.push(commandDisposable, codeLensDisposable, regenerateDisposable);
	context.subscriptions.push(command, commandSpringBoot);
}

// This method is called when your extension is deactivated
export function deactivate() {}

// Helper: searches recursively for the method which encloses the current position
function findEnclosingMethod(symbols: vscode.DocumentSymbol[], range: vscode.Range): vscode.DocumentSymbol | undefined {
    for (const symbol of symbols) {
        if (symbol.range.contains(range)) {
            // if the symbol is a method, return it
            if (symbol.kind === vscode.SymbolKind.Method || symbol.kind === vscode.SymbolKind.Constructor) {
                return symbol;
            }
            // continue searching in the children elements otherwise (i.e. within a class)
            if (symbol.children && symbol.children.length > 0) {
                const child = findEnclosingMethod(symbol.children, range);
                if (child) return child;
            }
        }
    }
    return undefined;
}
/**
 * Converts Java parameter notation to UML notation
 * Java: method(Type param, String name) -> UML: method(param: Type, name: String)
 */
function convertToUMLSignature(javaSignature: string): string {
    // Extract method name and parameters
    const match = javaSignature.match(/^([a-zA-Z0-9_]+)\s*\(([^)]*)\)(.*)$/);
    if (!match) {
        return javaSignature;
    }

    const methodName = match[1];
    const paramString = match[2];
    const returnType = match[3];

    // Convert parameters from "Type name" to "name: Type"
    const params = paramString.split(',').map(p => p.trim()).filter(p => p.length > 0);
    const umlParams = params.map(param => {
        // Match pattern: [modifiers] Type name
        const paramMatch = param.match(/^(?:\w+\s+)*([a-zA-Z0-9_<>\[\].,\s]+)\s+([a-zA-Z0-9_]+)(?:\s*=.*)?$/);
        if (paramMatch) {
            const type = paramMatch[1].trim();
            const name = paramMatch[2].trim();
            return `${name}: ${type}`;
        }
        return param;
    }).join(', ');

    return `${methodName}(${umlParams})${returnType}`;
}
// helper for searching symbols
function findSymbolAtRange(symbols: vscode.DocumentSymbol[], range: vscode.Range): vscode.DocumentSymbol | undefined {
    for (const s of symbols) {
        if (s.range.contains(range) && (s.kind === vscode.SymbolKind.Method || s.kind === vscode.SymbolKind.Constructor) ) return s;
        if (s.children) {
            const child = findSymbolAtRange(s.children, range);
            if (child) return child;
        }
    }
    return undefined;
}

function findParentClass(symbols: vscode.DocumentSymbol[], range: vscode.Range): vscode.DocumentSymbol | undefined {
    for (const s of symbols) {
        if (s.range.contains(range) && (s.kind === vscode.SymbolKind.Class)) return s;
        if (s.children) {
            const child = findParentClass(s.children, range);
            if (child) return child;
        }
    }
    return undefined;
}

/**
 * Shows a diff between the current and proposed code, then asks the user what to do.
 * Returns 'apply', 'discard', or 'regenerate'.
 */
async function showDiffPreview(
    methodName: string,
    currentCode: string,
    proposedCode: string,
    attempt: number
): Promise<'apply' | 'discard' | 'regenerate'> {
    // Create virtual documents for diff
    const oldUri = vscode.Uri.parse(`mdellm:${methodName}.current.java?attempt=${attempt}`);
    const newUri = vscode.Uri.parse(`mdellm:${methodName}.proposed.java?attempt=${attempt}`);

    const provider = new (class implements vscode.TextDocumentContentProvider {
        provideTextDocumentContent(uri: vscode.Uri): string {
            if (uri.toString().includes('proposed')) {
                return proposedCode;
            }
            return currentCode;
        }
    })();

    const registration = vscode.workspace.registerTextDocumentContentProvider('mdellm', provider);

    try {
        // Open diff editor
        await vscode.commands.executeCommand(
            'vscode.diff',
            oldUri,
            newUri,
            `Method ${methodName} (Attempt ${attempt}): Current ↔ Proposed`,
            { preview: true }
        );

        // Ask user what to do
        const choice = await vscode.window.showQuickPick(
            [
                { label: '✅ Apply', value: 'apply' as const, description: 'Insert the generated code' },
                { label: '🔄 Regenerate', value: 'regenerate' as const, description: 'Ask the LLM again' },
                { label: '❌ Discard', value: 'discard' as const, description: 'Keep the current code' },
            ],
            {
                placeHolder: `Review the diff for method '${methodName}', then choose an action`,
            }
        );

        // Close the diff tab
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

        return choice?.value ?? 'discard';
    } finally {
        registration.dispose();
    }
}
