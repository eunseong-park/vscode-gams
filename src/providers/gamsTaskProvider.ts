import * as vscode from 'vscode';
import * as path from 'path';

export class GamsTaskProvider implements vscode.TaskProvider {
    static GamsTaskType = 'gams';
    private gamsPromise: Thenable<vscode.Task[]> | undefined = undefined;

    public provideTasks(): Thenable<vscode.Task[]> | undefined {
        if (!this.gamsPromise) {
            this.gamsPromise = getGamsTasks();
        }
        return this.gamsPromise;
    }

    public resolveTask(_task: vscode.Task): vscode.Task | undefined {
        const file = _task.definition.file;
        if (file) {
            const gamsConfig = vscode.workspace.getConfiguration('GAMS');
            const gamsExecutable = gamsConfig.get<string>('executablePath', 'gams');
            const commandLineArguments = gamsConfig.get<string>('commandLineParameters', '');
            const task = new vscode.Task(
                _task.definition,
                _task.scope || vscode.TaskScope.Workspace,
                _task.name,
                'gams',
                new vscode.ShellExecution(`${gamsExecutable} "${file}" ${commandLineArguments}`)
            );
            return task;
        }
        return undefined;
    }
}

async function getGamsTasks(): Promise<vscode.Task[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const result: vscode.Task[] = [];
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return result;
    }
    for (const workspaceFolder of workspaceFolders) {
        const folderString = workspaceFolder.uri.fsPath;
        const gmsFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, '**/*.gms'));
        for (const gmsFile of gmsFiles) {
            const relativePath = path.relative(folderString, gmsFile.fsPath);
            const gamsConfig = vscode.workspace.getConfiguration('GAMS');
            const gamsExecutable = gamsConfig.get<string>('executablePath', 'gams');
            const commandLineArguments = gamsConfig.get<string>('commandLineParameters', '');
            const task = new vscode.Task(
                { type: GamsTaskProvider.GamsTaskType, file: relativePath },
                workspaceFolder,
                relativePath,
                'gams',
                new vscode.ShellExecution(`${gamsExecutable} "${gmsFile.fsPath}" ${commandLineArguments}`)
            );
            result.push(task);
        }
    }
    return result;
}
