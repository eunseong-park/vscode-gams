import * as vscode from 'vscode';

export function registerToggleLineCommentCommand(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('gams.toggleLineComment', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        editor.edit(editBuilder => {
            editor.selections.forEach(selection => {
                for (let i = selection.start.line; i <= selection.end.line; i++) {
                    const line = editor.document.lineAt(i);
                    const lineText = line.text;

                    if (lineText.startsWith('*')) {
                        editBuilder.delete(new vscode.Range(i, 0, i, 1));
                    } else {
                        editBuilder.insert(new vscode.Position(i, 0), '*');
                    }
                }
            });
        });
    });

    context.subscriptions.push(disposable);
}