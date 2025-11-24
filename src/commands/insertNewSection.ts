import * as vscode from 'vscode';

export function registerInsertNewSectionCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand('gams.insertNewSection', () => {
    insertNewSection();
  }));
}

function insertNewSection() {
  vscode.window.showInputBox({ prompt: 'Enter the name of the section to insert' }).then(sectionName => {
    if (sectionName === undefined) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    let dashes = '';
    if (sectionName.length < 67) {
      dashes = '-'.repeat(71 - sectionName.length);
    }

    const sectionText = `\n* ${sectionName} ${dashes}\n`;

    editor.edit(editBuilder => {
      editBuilder.insert(editor.selection.active, sectionText);
    });
  });
}
