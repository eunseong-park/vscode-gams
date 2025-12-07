import * as vscode from 'vscode';
import { getActiveGamsFileInfo, parseCommandLineParameters, executeGamsTask } from '../utils';

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
        const executablePath: string = config.get<string>('executablePath', 'gams');

        const cwd = terminalCwd || dirPath;
        const args = [filePath, 'o', lstFilePath, 'gdx', gdxFilePath, ...parseCommandLineParameters(commandLineParameters)];
        
        executeGamsTask(executablePath, args, cwd);
    });

    context.subscriptions.push(disposableRunWithGdxCreation);
}