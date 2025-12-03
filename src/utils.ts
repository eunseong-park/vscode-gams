import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { logger } from './logger';

export interface GamsFileInfo {
    filePath: string;
    dirPath: string;
    lstFilePath: string;
    gdxFilePath: string;
}

export function getActiveGamsFileInfo(): GamsFileInfo | undefined {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        vscode.window.showErrorMessage("No file opened in the editor.");
        return undefined;
    }
    const filePath = activeEditor.document.fileName;
    const dirPath = path.dirname(filePath);
    const lstFilePath = filePath.replace(/\.[^/.]+$/, "") + ".lst";
    const gdxFilePath = filePath.replace(/\.[^/.]+$/, "") + ".gdx";
    return { filePath, dirPath, lstFilePath, gdxFilePath };
}

export function getGamsTerminal(cwd: string, terminalLocationSetting: string): vscode.Terminal {
    let terminal = vscode.window.terminals.find(t => t.name === "GAMS");

    if (!terminal) {
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
        type ViewColumnKey = keyof typeof viewColumnMapping;

        let termLoc: vscode.TerminalLocation | { viewColumn: vscode.ViewColumn };
        if (terminalLocationSetting === "Panel") {
            termLoc = vscode.TerminalLocation.Panel;
        } else {
            const key = terminalLocationSetting.toLowerCase() as ViewColumnKey;
            // Default to Beside if key is not found or terminalLocation is invalid
            const column = viewColumnMapping[key] || vscode.ViewColumn.Beside; 
            termLoc = { viewColumn: column };
        }
        
        const terminalOptions: vscode.TerminalOptions = {
            name: "GAMS",
            cwd: cwd,
            location: termLoc
        };
        terminal = vscode.window.createTerminal(terminalOptions);
    }
    return terminal;
}

export function openLstFile(document: vscode.TextDocument, preservesFocus: boolean) {
    const config = vscode.workspace.getConfiguration('GAMS');
    const listingFileLocation = config.get<string>('listingFileLocation', 'Beside');

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
    type ViewColumnKey = keyof typeof viewColumnMapping;

    let column: vscode.ViewColumn = vscode.ViewColumn.Beside; // Default
    const key = listingFileLocation.toLowerCase() as ViewColumnKey;
    if (viewColumnMapping[key]) {
        column = viewColumnMapping[key];
    }
    
	if (preservesFocus) {
		vscode.window.showTextDocument(document, { viewColumn: column, preserveFocus: true });
	} else {
		vscode.window.showTextDocument(document, { viewColumn: column });
	}
}

export function launchGamsIde(...args: string[]) {
	const config = vscode.workspace.getConfiguration('GAMS');
    const idePath = config.get('idePath', 'gamside');
    logger.info('Spawning GAMS IDE/Studio process:', idePath, args.join(' '));
    // Detached process to allow the extension to close without killing GAMS IDE
	const process = cp.spawn(idePath, args, { detached: true });
	process.on('error', (error) => {
        logger.error('Unexpected error:', error);
        vscode.window.showErrorMessage("Unexpected error, check the output panel for more details.");
	});
}