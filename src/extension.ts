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
	console.log('Congratulations, your extension "mdellm" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('mdellm.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from mdellm!');
	});

	const command = vscode.commands.registerCommand(
		"mdellm.processJavaFolder",
		async (uri: vscode.Uri) => {
			if (!uri || !fs.lstatSync(uri.fsPath).isDirectory()) {
				vscode.window.showErrorMessage("Please select a valid folder.");
				return;
			}
	
			const files = fs.readdirSync(uri.fsPath).filter(file => file.endsWith(".java"));;
			// const hasJavaFiles = files.some(file => file.endsWith(".java"));
	
			// if (!hasJavaFiles) {
			// 	vscode.window.showErrorMessage("No Java files found in this folder.");
			// 	return;
			// }
			if (files.length === 0) {
                vscode.window.showErrorMessage("No Java files found in this folder.");
                return;
            }
	
			vscode.window.showInformationMessage(`Processing folder: ${uri.fsPath}`);
		  	// Add your logic here
			for (const file of files) {
				const filePath = path.join(uri.fsPath, file);
				processJavaFile(filePath, uri.fsPath);
			}
			vscode.window.showInformationMessage("Processed Java files successfully.");
		}
	  );

	context.subscriptions.push(disposable);
	context.subscriptions.push(command);
}

// This method is called when your extension is deactivated
export function deactivate() {}
