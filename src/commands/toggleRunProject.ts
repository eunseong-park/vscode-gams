import * as vscode from 'vscode';

export function registerToggleRunProjectCommand(context: vscode.ExtensionContext) {
    const toggleRunProjectStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    toggleRunProjectStatusBarItem.command = 'gams.toggleRunProject';
    toggleRunProjectStatusBarItem.tooltip = 'Toggle GAMS Project Run Mode';

    // Helper function to update the status bar item text based on the current configuration
    const updateStatusBarItem = () => {
        const config = vscode.workspace.getConfiguration('GAMS');
        const runProject = config.get<boolean>('runProject', false);
        toggleRunProjectStatusBarItem.text = `$(checklist) Run Project: ${runProject ? 'On' : 'Off'}`;
    };

    // Initialize status bar item text
    updateStatusBarItem();

    // Show/hide status bar item based on active editor language
    const updateVisibility = () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'gams') {
            toggleRunProjectStatusBarItem.show();
        } else {
            toggleRunProjectStatusBarItem.hide();
        }
    };

    // Update visibility on active editor change
    const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(updateVisibility);
    // Also update on configuration change to refresh text
    const configListener = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('GAMS.runProject')) {
            updateStatusBarItem();
        }
    });

    // Initialize visibility
    updateVisibility();

    let disposableToggleRunProject = vscode.commands.registerCommand('gams.toggleRunProject', async () => {
        const config = vscode.workspace.getConfiguration('GAMS');
        const runProject = config.get<boolean>('runProject', false);

        // Prefer workspace-level setting if a workspace is open, otherwise fall back to user/global.
        let target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global;
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            target = vscode.ConfigurationTarget.Workspace;
        }

        try {
            await config.update('runProject', !runProject, target);
            updateStatusBarItem(); // Update status bar after changing setting
            const scope = target === vscode.ConfigurationTarget.Workspace ? 'Workspace' : 'User';
            vscode.window.showInformationMessage(`GAMS.runProject toggled to ${!runProject} in ${scope} settings.`);
        } catch (err) {
            // If workspace update fails for any reason, fall back to global and inform the user.
            await config.update('runProject', !runProject, vscode.ConfigurationTarget.Global);
            updateStatusBarItem();
            vscode.window.showWarningMessage('Could not update Workspace settings; updated User settings instead.');
        }
    });

    context.subscriptions.push(disposableToggleRunProject, toggleRunProjectStatusBarItem, activeEditorListener, configListener);
}