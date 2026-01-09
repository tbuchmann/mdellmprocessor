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
	let disposable = vscode.commands.registerCommand('mdellm.addToDiagram', (range: vscode.Range) => {
		const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        // Extrahiere den Text der gesamten Methode
        const methodText = editor.document.getText(range);
        
        // Hier folgt deine DSL-Logik
        console.log("Analysiere Code für DSL:", methodText);
        vscode.window.showInformationMessage("Methodenkopf und Rumpf in DSL übernommen!");
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

	context.subscriptions.push(disposable, codeLensDisposable);
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
