import * as vscode from 'vscode';

export function registerToggleRunProjectCommand(context: vscode.ExtensionContext) {
    const toggleRunProjectStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    toggleRunProjectStatusBarItem.command = 'gams.toggleRunProject';
    toggleRunProjectStatusBarItem.tooltip = 'Toggle GAMS Project Run Mode';
    toggleRunProjectStatusBarItem.show();

    // Helper function to update the status bar item text based on the current configuration
    const updateStatusBarItem = () => {
        const config = vscode.workspace.getConfiguration('GAMS');
        const runProject = config.get<boolean>('runProject', false);
        toggleRunProjectStatusBarItem.text = `$(checklist) Run Project: ${runProject ? 'On' : 'Off'}`;
    };

    // Initialize status bar item text
    updateStatusBarItem();

    let disposableToggleRunProject = vscode.commands.registerCommand('gams.toggleRunProject', async () => {
        const config = vscode.workspace.getConfiguration('GAMS');
        const runProject = config.get<boolean>('runProject', false);
        await config.update('runProject', !runProject, vscode.ConfigurationTarget.Global);
        updateStatusBarItem(); // Update status bar after changing setting
    });

    context.subscriptions.push(disposableToggleRunProject, toggleRunProjectStatusBarItem);
}