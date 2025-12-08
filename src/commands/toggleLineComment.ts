import * as vscode from 'vscode';

export function registerToggleLineCommentCommand(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('gams.toggleLineComment', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        const commentsOptions = vscode.workspace.getConfiguration('editor').get('comments') as any;
        const insertSpace = commentsOptions?.insertSpace ?? true;
        const ignoreEmptyLines = commentsOptions?.ignoreEmptyLines ?? true;
        const commentToken = '*';
        const tokenWithSpace = commentToken + (insertSpace ? ' ' : '');

        editor.edit(editBuilder => {
            for (const selection of editor.selections) {
                // VS Code's selection logic: if a multi-line selection ends at character 0,
                // it doesn't include the last line.
                const endLine = (selection.end.character === 0 && !selection.isSingleLine)
                    ? selection.end.line - 1
                    : selection.end.line;

                // --- Determine Action ---
                let isCommentingAction = true;
                let containsOnlyWhitespace = true;

                // 1. Check for content and determine toggle state
                for (let i = selection.start.line; i <= endLine; i++) {
                    const line = editor.document.lineAt(i);
                    if (!line.isEmptyOrWhitespace) {
                        containsOnlyWhitespace = false;
                        // If we find any line that is not commented, the action is to comment all lines.
                        if (!line.text.trim().startsWith(commentToken)) {
                            isCommentingAction = true;
                            break; // Action is now 'comment', no need to check further.
                        } else {
                            // So far, all lines are commented. The action is 'uncomment' unless we find an uncommented one.
                            isCommentingAction = false;
                        }
                    }
                }

                // 2. Override for whitespace-only selections
                if (containsOnlyWhitespace) {
                    isCommentingAction = true;
                }

                // --- Apply Action ---
                for (let i = selection.start.line; i <= endLine; i++) {
                    const line = editor.document.lineAt(i);
                    if (ignoreEmptyLines && line.isEmptyOrWhitespace) {
                        continue;
                    }

                    if (isCommentingAction) {
                        editBuilder.insert(new vscode.Position(i, 0), tokenWithSpace);
                    } else { // Uncommenting
                        if (line.text.startsWith(tokenWithSpace)) {
                            editBuilder.delete(new vscode.Range(i, 0, i, tokenWithSpace.length));
                        } else if (line.text.startsWith(commentToken)) {
                            editBuilder.delete(new vscode.Range(i, 0, i, commentToken.length));
                        }
                    }
                }
            }
        });
    });

    context.subscriptions.push(disposable);
}