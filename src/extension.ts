import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { processJavaFile } from './llmprocessor';

export function activate(context: vscode.ExtensionContext) {

	let commandDisposable = vscode.commands.registerCommand('myExtension.addToDiagram', async (methodRange: vscode.Range) => {
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
        const className = classSymbol.name;

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
        
        // regex to find: method_name(...) { ... spec "..." }
        // we need to insert after the spec "..." line
        const escapedMethodName = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const methodRegex = new RegExp(`(${escapedMethodName}\\s*\\([^)]*\\)\\s*(?::\\s*\\w+)?\\s*\\{\\s*spec\\s+"[^"]*")`, 'm');

        const match = methodRegex.exec(cdiagText);

        if (match) {
            const insertPosition = match.index + match[0].length;
            const updatedContent = cdiagText.slice(0, insertPosition) + "\n     " + newImpl + cdiagText.slice(insertPosition);
            
            // save file
            const edit = new vscode.WorkspaceEdit();
            edit.replace(cdiagUri, new vscode.Range(0, 0, cdiagDoc.lineCount, 0), updatedContent);
            await vscode.workspace.applyEdit(edit);
            await cdiagDoc.save();

            vscode.window.showInformationMessage(`Code in ${path.basename(cdiagUri.fsPath)} übertragen.`);
        } else {
            vscode.window.showErrorMessage(`Methode '${methodName}' in der DSL-Datei nicht gefunden.`);
        }
    });
	const command = vscode.commands.registerCommand(
		"mdellm.processJavaFolder",
		async (uri: vscode.Uri) => {
			if (!uri || !fs.lstatSync(uri.fsPath).isDirectory()) {
				vscode.window.showErrorMessage("Please select a valid folder.");
				return;
			}
	
			const files = fs.readdirSync(uri.fsPath).filter(file => file.endsWith(".java"));;
	
			if (files.length === 0) {
                vscode.window.showErrorMessage("No Java files found in this folder.");
                return;
            }
	
			vscode.window.showInformationMessage(`Processing folder: ${uri.fsPath}`);
		  	
			// Process files sequentially
			for (const file of files) {
				const filePath = path.join(uri.fsPath, file);
				await processJavaFile(filePath, uri.fsPath);
			}
			vscode.window.showInformationMessage("Processed all Java files successfully.");
		}
	  );

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

            // 2. looks for our marker in the document
            for (let i = 0; i < document.lineCount; i++) {
                const line = document.lineAt(i);
                if (line.text.includes("// generated start")) {
                    
                    // 3. finds method containing this marker
                    const methodSymbol = findEnclosingMethod(symbols, line.range);

                    if (methodSymbol) {
                        lenses.push(new vscode.CodeLens(methodSymbol.range, {
                            title: "✨ Add to model",
                            command: "myExtension.addToDiagram",
                            arguments: [methodSymbol.range] // pass the whole method range
                        }));
                    }
                }
            }
            return lenses;
        }
    });

	context.subscriptions.push(commandDisposable, codeLensDisposable);
	context.subscriptions.push(command);
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
