import * as vscode from 'vscode';
import { getGamsTerminal, getActiveGamsFileInfo } from '../utils';

export function registerRunWithGdxCreationCommand(context: vscode.ExtensionContext) {
    let disposableRunWithGdxCreation = vscode.commands.registerCommand('gams.runWithGdxCreation', () => {
        const config = vscode.workspace.getConfiguration('GAMS');
        const fileInfo = getActiveGamsFileInfo();
        if (!fileInfo) {
            return;
        }
        const { filePath, dirPath, lstFilePath, gdxFilePath } = fileInfo;
        const terminalCwd: string | undefined = config.get<string>('terminalCwd');
        const commandLineParameters: string = config.get<string>('commandLineParameters', '');

        const command = `gams "${filePath}" o "${lstFilePath}" gdx "${gdxFilePath}" ${commandLineParameters}`;

        // Default to 'Panel' for terminal location. This could be made configurable in settings if needed.
        const terminal = getGamsTerminal(terminalCwd || dirPath, 'Panel');
        terminal.show(true);
        terminal.sendText(command, true);

    });

    context.subscriptions.push(disposableRunWithGdxCreation);
}