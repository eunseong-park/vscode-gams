// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from "fs";
import * as path from "path";
import * as cp from 'child_process';
import * as os from 'os';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	// Get the extension ID dynamically
	const extensionId = context.extension.id;

	// Register the command to open the settings for this extension
	let disposableSettings = vscode.commands.registerCommand('gams.openSettings', () => {
		// Opens the settings with the extension's identifier
		vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId}`);
	});

	// Add a button to the status bar to open settings
	let settingsStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	settingsStatusBarItem.command = 'gams.openSettings';
	settingsStatusBarItem.text = '$(gear) GAMS Settings';
	settingsStatusBarItem.tooltip = 'Open GAMS Extension Settings';
	settingsStatusBarItem.show();

	// Add the button to the subscriptions so it gets disposed of properly
	context.subscriptions.push(disposableSettings);
	context.subscriptions.push(settingsStatusBarItem);
	
	// Register the command to toggle the runProject setting
	let disposableToggleRunProject = vscode.commands.registerCommand('gams.toggleRunProject', async () => {
		// The code you place here will be executed every time your command is executed
		let config = vscode.workspace.getConfiguration('GAMS');
		let runProject = config.get<boolean>('runProject', false);
		await config.update('runProject', !runProject, vscode.ConfigurationTarget.Global);

		// Update the status bar item text based on the new value
		toggleRunProjectStatusBarItem.text = `$(checklist) Run Project: ${!runProject ? 'On' : 'Off'}`;
	});

	// Add a button to the status bar to toggle runProject
	let toggleRunProjectStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
	toggleRunProjectStatusBarItem.command = 'gams.toggleRunProject';
	toggleRunProjectStatusBarItem.text = '$(checklist) Run Project: Off'; // Initial state
	toggleRunProjectStatusBarItem.tooltip = 'Toggle GAMS Project Run Mode';
	toggleRunProjectStatusBarItem.show();

	// Add the toggle button to the subscriptions
	context.subscriptions.push(disposableToggleRunProject);
	context.subscriptions.push(toggleRunProjectStatusBarItem);

	// Initialize the status bar item based on the current configuration
	let initialRunProject = vscode.workspace.getConfiguration('GAMS').get<boolean>('runProject', false);
	toggleRunProjectStatusBarItem.text = `$(checklist) Run Project: ${initialRunProject ? 'On' : 'Off'}`;

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposableRun = vscode.commands.registerCommand('gams.run', () => {

		const config = vscode.workspace.getConfiguration('GAMS');
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			vscode.window.showErrorMessage("No file opened in the editor.");
			return;
		};
		const filePath = activeEditor.document.fileName;
		const dirPath = path.dirname(filePath);
		const lstFilePath = filePath.replace(/\.[^/.]+$/, "") + ".lst";
		const terminalLocation = config.get<string>('terminalLocation', 'Panel');
		const terminalCwd: string | undefined = config.get<string>('terminalCwd');
		const batchPath: string | undefined = config.get<string>('runBatchPath');
		const commandLineParameters: string = config.get<string>('commandLineParameters', '');

		const command = `gams "${filePath}" o "${lstFilePath}" ${commandLineParameters}`;
		if (config.runProject) {
			console.log('run project file');
		} else {
			console.log('run single file');
		}
		
		// Mapping from string to vscode.ViewColumn
		const viewColumnMapping = {
			"active": vscode.ViewColumn.Active,
			"beside": vscode.ViewColumn.Beside,
			"one": vscode.ViewColumn.One,
			"two": vscode.ViewColumn.Two,
			"three": vscode.ViewColumn.Three,
			"four": vscode.ViewColumn.Four,
			"five": vscode.ViewColumn.Five,
			"six": vscode.ViewColumn.Six,
			"seven": vscode.ViewColumn.Seven,
			"eight": vscode.ViewColumn.Eight,
			"nine": vscode.ViewColumn.Nine
		};

		// Define the type for the keys of viewColumnMapping
		type ViewColumnKey = keyof typeof viewColumnMapping;

		let termLoc;
		if (terminalLocation === "Panel") {
			termLoc = vscode.TerminalLocation.Panel;
		} else {
			// Ensure terminalLocation is a valid key of viewColumnMapping, or use a default key
			const key = terminalLocation.toLowerCase() as ViewColumnKey;
			// Default to Beside if key is not found
			const column = viewColumnMapping[key] || vscode.ViewColumn.Beside; 
			termLoc = { viewColumn: column };
		}
		
		
		// Use the setting, falling back to a default if not set
		const terminalOptions: vscode.TerminalOptions = {
			name: "GAMS",
			cwd: terminalCwd || dirPath,
			location: termLoc
		};
		
		let terminal = vscode.window.terminals.find(t => t.name === "GAMS");
		if (!terminal) {
			terminal = vscode.window.createTerminal(terminalOptions);
		}

		terminal.show(true);

		if (config.runProject) {
			terminal.sendText(batchPath || command, true);
		} else {
			terminal.sendText(command, true);
		}
	});

	context.subscriptions.push(disposableRun);

	let disposableRunWithGdxCreation = vscode.commands.registerCommand('gams.runWithGdxCreation', () => {
		const config = vscode.workspace.getConfiguration('GAMS');
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			vscode.window.showErrorMessage("No file opened in the editor.");
			return;
		};
		const filePath = activeEditor.document.fileName;
		const dirPath = path.dirname(filePath);
		const lstFilePath = filePath.replace(/\.[^/.]+$/, "") + ".lst";
		const gdxFilePath = filePath.replace(/\.[^/.]+$/, "") + ".gdx";
		const terminalCwd: string | undefined = config.get<string>('terminalCwd');
		const commandLineParameters: string = config.get<string>('commandLineParameters', '');

		const command = `gams "${filePath}" o "${lstFilePath}" gdx "${gdxFilePath}" ${commandLineParameters}`;

		// Use the setting, falling back to a default if not set
		const terminalOptions: vscode.TerminalOptions = {
			name: "GAMS",
			cwd: terminalCwd || dirPath
		};

		let terminal = vscode.window.terminals.find(t => t.name === "GAMS");
		if (!terminal) {
			terminal = vscode.window.createTerminal(terminalOptions);
		}
		// TODO: path of terminal to be determined in the setting
		terminal.show(true);
		terminal.sendText(command, true);

	});

	context.subscriptions.push(disposableRunWithGdxCreation);

	let disposableShowLst = vscode.commands.registerCommand("gams.showListing", async () => {
		const config = vscode.workspace.getConfiguration('GAMS');
		const preservesFocus = config.get<boolean>("preserveFocus", true);
		const activeEditor = vscode.window.activeTextEditor;

		const projectLst: string | undefined = config.get<string>('projectLst');

		if (activeEditor) {
			const filePath = activeEditor.document.fileName;
			let lstFilePath = filePath.replace(/\.[^/.]+$/, "") + ".lst";

			if (config.runProject) {
				lstFilePath = projectLst || lstFilePath;
			}

			// does the file exist?
			fs.access(lstFilePath, fs.constants.F_OK, async (err) => {
				if (err) {
					vscode.window.showInformationMessage("The corresponding listing file does not exist.");
				} else {
					try {
						const document = await vscode.workspace.openTextDocument(lstFilePath);
						openLstFile(document, preservesFocus);
					} catch (e) {
						vscode.window.showErrorMessage("Failed to open the listing file.");
					}
				}
			});
		}
	});

	context.subscriptions.push(disposableShowLst);

	let disposableOpenCorrGDX = vscode.commands.registerCommand("gams.openCorrGDX", async () => {
		const config = vscode.workspace.getConfiguration('GAMS');
		const activeEditor = vscode.window.activeTextEditor;

		const projectGDX: string | undefined = config.get<string>('projectGDX');

		if (activeEditor) {
			const filePath = activeEditor.document.fileName;
			let gdxFilePath = filePath.replace(/\.[^/.]+$/, "") + ".gdx";

			if (config.runProject) {
				gdxFilePath = projectGDX || gdxFilePath;
			}

			// does the file exist?
			fs.access(gdxFilePath, fs.constants.F_OK, async (err) => {
				if (err) {
					vscode.window.showInformationMessage("The corresponding GDX file does not exist.");
				} else {
					try {
						launchGamsIde(gdxFilePath);
					} catch (e) {
						vscode.window.showErrorMessage("Failed to open the GDX file.");
					}
				}
			});
		}
	});

	context.subscriptions.push(disposableOpenCorrGDX);
	
	context.subscriptions.push(vscode.commands.registerCommand('gams.openGDX', openGDX));
}

// This method is called when your extension is deactivated
export function deactivate() { }

function openLstFile(document: vscode.TextDocument, preservesFocus: boolean) {
	if (preservesFocus) {
		vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
	} else {
		vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });
	}
}

function launchGamsIde(...args: string[]) {
	const config = vscode.workspace.getConfiguration('GAMS');
	const idePath = config.get('idePath', 'gamside');
	console.log('Spawning GAMS IDE/Studio process:', idePath, args.join(' '));
	const process = (0, cp.spawn)(idePath, args, { detached: true });
	process.on('error', (error) => {
		console.log('Unexpected error:', error);
		vscode.window.showErrorMessage("Unexpected error, check the output panel for more details.");
	});
}

async function openGDX(filePath: vscode.Uri | undefined) {
	if (filePath === undefined) {
		console.log('No file path provided, launching open file dialog');
		let defaultUri;
		// Try finding the folder of the current file
		const currentDocumentPath = vscode.window.activeTextEditor?.document.fileName;
		if (currentDocumentPath !== undefined) {
			defaultUri = vscode.Uri.file(path.dirname(currentDocumentPath));
		}
		// Otherwise try the first workspace folder
		else if (vscode.workspace.workspaceFolders) {
			defaultUri = vscode.workspace.workspaceFolders[0].uri;
		}
		// Otherwise default to the homedir
		else {
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
