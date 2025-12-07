import * as vscode from 'vscode';
import { getActiveGamsFileInfo, parseCommandLineParameters, executeGamsTask, executeShellTask } from '../utils';
import { logger } from '../logger';

export function registerRunCommand(context: vscode.ExtensionContext) {
    let disposableRun = vscode.commands.registerCommand('gams.run', () => {
        const config = vscode.workspace.getConfiguration('GAMS');
        const fileInfo = getActiveGamsFileInfo();
        if (!fileInfo) {
            return;
        }
        const { filePath, dirPath, lstFilePath } = fileInfo;
        const terminalCwd: string | undefined = config.get<string>('terminalCwd');
        const batchPath: string | undefined = config.get<string>('runBatchPath');
        const commandLineParameters: string = config.get<string>('commandLineParameters', '');
        const executablePath: string = config.get<string>('executablePath', 'gams');

        const cwd = terminalCwd || dirPath;
        
        // If 'runProject' setting is true, use 'runBatchPath' (if provided) or the generated command
        // Otherwise, run the single file command
        if (config.runProject) {
            logger.info('Running GAMS in project mode');
            if (batchPath) {
                // Use ShellExecution for batch files
                executeShellTask(batchPath, cwd);
            } else {
                // Fallback to running the single file
                const args = [filePath, 'o', lstFilePath, ...parseCommandLineParameters(commandLineParameters)];
                executeGamsTask(executablePath, args, cwd);
            }
        } else {
            logger.info('Running single GAMS file');
            const args = [filePath, 'o', lstFilePath, ...parseCommandLineParameters(commandLineParameters)];
            executeGamsTask(executablePath, args, cwd);
        }
    });

    context.subscriptions.push(disposableRun);
}