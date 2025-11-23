import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { launchGamsIde } from '../utils';

/**
 * Opens a GDX file. If no file path is provided, it prompts the user to select one.
 * Then, it launches the GAMS IDE with the selected GDX file.
 */
async function openGDX(filePath: vscode.Uri | undefined) {
	if (filePath === undefined) {
		console.log('No file path provided, launching open file dialog');
		let defaultUri;
		const currentDocumentPath = vscode.window.activeTextEditor?.document.fileName;
		if (currentDocumentPath !== undefined) {
			defaultUri = vscode.Uri.file(path.dirname(currentDocumentPath));
		} else if (vscode.workspace.workspaceFolders) {
			defaultUri = vscode.workspace.workspaceFolders[0].uri;
		} else {
			defaultUri = vscode.Uri.file(os.homedir());
		}
		const paths = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			defaultUri: defaultUri,
			filters: { 'GDX': ['gdx'] },
			title: 'Open GDX File',
		});
		if (paths === undefined) {
			console.log('No file picked, exiting');
			return;
		}
		filePath = paths[0];
	}
	console.log('Opening GDX file:', filePath.fsPath);
	launchGamsIde(filePath.fsPath);
}

export function registerOpenGDXCommand(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerCommand('gams.openGDX', openGDX));
}