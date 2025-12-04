import * as vscode from 'vscode';

export function registerOpenSettingsCommand(context: vscode.ExtensionContext, extensionId: string) {
    let disposableSettings = vscode.commands.registerCommand('gams.openSettings', () => {
        vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId}`);
    });

    const settingsStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    settingsStatusBarItem.command = 'gams.openSettings';
    settingsStatusBarItem.text = '$(gear) GAMS Settings';
    settingsStatusBarItem.tooltip = 'Open GAMS Extension Settings';

    // Show/hide settings status bar item only when editing GAMS files
    const updateVisibility = () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'gams') {
            settingsStatusBarItem.show();
        } else {
            settingsStatusBarItem.hide();
        }
    };

    const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(updateVisibility);
    updateVisibility();

    context.subscriptions.push(disposableSettings, settingsStatusBarItem, activeEditorListener);
}