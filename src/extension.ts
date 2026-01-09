// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { processJavaFile } from './llmprocessor';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	//console.log('Congratulations, your extension "mdellm" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	// let disposable = vscode.commands.registerCommand('mdellm.addToDiagram', (range: vscode.Range) => {
	// 	const editor = vscode.window.activeTextEditor;
    //     if (!editor) return;

    //     // Extrahiere den Text der gesamten Methode
    //     const methodText = editor.document.getText(range);
        
    //     // Hier folgt deine DSL-Logik
    //     console.log("Analysiere Code für DSL:", methodText);
    //     vscode.window.showInformationMessage("Methodenkopf und Rumpf in DSL übernommen!");
	// });
	let commandDisposable = vscode.commands.registerCommand('myExtension.addToDiagram', async (methodRange: vscode.Range) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const doc = editor.document;
        const fullMethodText = doc.getText(methodRange);

        // 1. Extraktion des Codes zwischen den Kommentaren
        const startMarker = "//generated start";
        const endMarker = "//generated end";
        const startIndex = fullMethodText.indexOf(startMarker);
        const endIndex = fullMethodText.indexOf(endMarker);

        if (startIndex === -1 || endIndex === -1) {
            vscode.window.showErrorMessage("Marker '// generated start/end' nicht gefunden.");
            return;
        }

        const extractedCode = fullMethodText.substring(startIndex + startMarker.length, endIndex).trim();

        // 2. Metadaten bestimmen (Klassenname und Methodenname)
        // Wir nutzen die Symbole erneut, um den Namen der Methode zu finden
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri);
        const methodSymbol = findSymbolAtRange(symbols || [], methodRange);
        const classSymbol = findParentClass(symbols || [], methodRange);

        if (!methodSymbol || !classSymbol) {
            vscode.window.showErrorMessage("Klasse oder Methode konnte nicht identifiziert werden.");
            return;
        }

        const methodName = methodSymbol.name.split('(')[0].trim(); // Falls Java-LS Signatur liefert
        const className = classSymbol.name;

        // 3. .cdiag Datei im Workspace finden
        const cdiagFiles = await vscode.workspace.findFiles('**/*.cdiag');
        if (cdiagFiles.length === 0) {
            vscode.window.showErrorMessage("Keine .cdiag Datei im Projekt gefunden.");
            return;
        }

        // Wir nehmen hier die erste gefundene (oder implementiere Logik zur Auswahl)
        const cdiagUri = cdiagFiles[0];
        const cdiagDoc = await vscode.workspace.openTextDocument(cdiagUri);
        const cdiagText = cdiagDoc.getText();

        // 4. In DSL einfügen via Regex
        // Sucht nach der Klasse, dann nach der Methode, dann nach der öffnenden Klammer
        // Nutzt ein Multiline-Regex, um die Struktur zu finden
        const newImpl = `impl java << ${extractedCode} >>`;
        
        // Simpler Ansatz: Suche nach der Operation innerhalb der Klasse
        // Dies ist ein Regex-Beispiel, das die geschweifte Klammer der Operation findet
        const escapedMethodName = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const methodRegex = new RegExp(`(${escapedMethodName}\\s*\\([^)]*\\)\\s*(?::\\s*\\w+)?\\s*\\{)`, 'm');

        const match = methodRegex.exec(cdiagText);

        if (match) {
            const insertPosition = match.index + match[0].length;
            const updatedContent = cdiagText.slice(0, insertPosition) + "\n     " + newImpl + cdiagText.slice(insertPosition);
            
            // Datei speichern
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

	// CodeLens Provider: Platziert den Button
    let codeLensDisposable = vscode.languages.registerCodeLensProvider('java', {
        async provideCodeLenses(document: vscode.TextDocument) {
            const lenses: vscode.CodeLens[] = [];
            
            // 1. Hole alle Symbole (Methoden, Klassen) vom Java Language Server
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider', 
                document.uri
            );

            if (!symbols) return [];

            // 2. Suche im Dokument nach deinem Marker
            for (let i = 0; i < document.lineCount; i++) {
                const line = document.lineAt(i);
                if (line.text.includes("//generated start")) {
                    
                    // 3. Finde die Methode, die diesen Marker enthält
                    const methodSymbol = findEnclosingMethod(symbols, line.range);

                    if (methodSymbol) {
                        lenses.push(new vscode.CodeLens(methodSymbol.range, {
                            title: "✨ In Klassendiagramm übernehmen",
                            command: "myExtension.addToDiagram",
                            arguments: [methodSymbol.range] // Die ganze Methode übergeben
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

// Hilfsfunktion: Sucht rekursiv nach der Methode, die die Position umschließt
function findEnclosingMethod(symbols: vscode.DocumentSymbol[], range: vscode.Range): vscode.DocumentSymbol | undefined {
    for (const symbol of symbols) {
        if (symbol.range.contains(range)) {
            // Wenn das Symbol eine Methode ist (Kind 5 in VS Code Java)
            if (symbol.kind === vscode.SymbolKind.Method) {
                return symbol;
            }
            // Sonst in den Kindern weitersuchen (z.B. innerhalb einer Klasse)
            if (symbol.children && symbol.children.length > 0) {
                const child = findEnclosingMethod(symbol.children, range);
                if (child) return child;
            }
        }
    }
    return undefined;
}

// Hilfsfunktionen für die Symbolsuche
function findSymbolAtRange(symbols: vscode.DocumentSymbol[], range: vscode.Range): vscode.DocumentSymbol | undefined {
    for (const s of symbols) {
        if (s.range.contains(range) && s.kind === vscode.SymbolKind.Method) return s;
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
