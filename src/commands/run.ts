import * as vscode from 'vscode';
import { getGamsTerminal, getActiveGamsFileInfo } from '../utils';

export function registerRunCommand(context: vscode.ExtensionContext) {
    let disposableRun = vscode.commands.registerCommand('gams.run', () => {
        const config = vscode.workspace.getConfiguration('GAMS');
        const fileInfo = getActiveGamsFileInfo();
        if (!fileInfo) {
            return;
        }
        const { filePath, dirPath, lstFilePath } = fileInfo;
        const terminalLocation = config.get<string>('terminalLocation', 'Panel');
        const terminalCwd: string | undefined = config.get<string>('terminalCwd');
        const batchPath: string | undefined = config.get<string>('runBatchPath');
        const commandLineParameters: string = config.get<string>('commandLineParameters', '');

        const command = `gams "${filePath}" o "${lstFilePath}" ${commandLineParameters}`;
        
        // If 'runProject' setting is true, use 'runBatchPath' (if provided) or the generated command
        // Otherwise, run the single file command
        if (config.runProject) {
            console.log('Running GAMS in project mode');
        } else {
            console.log('Running single GAMS file');
        }
        
        const terminal = getGamsTerminal(terminalCwd || dirPath, terminalLocation);
        terminal.show(true);

        if (config.runProject) {
            terminal.sendText(batchPath || command, true);
        } else {
            terminal.sendText(command, true);
        }
    });

    context.subscriptions.push(disposableRun);
}