import * as vscode from 'vscode';
import * as fs from 'fs';
import { getActiveGamsFileInfo, openLstFile } from '../utils';

export function registerShowListingCommand(context: vscode.ExtensionContext) {
    let disposableShowLst = vscode.commands.registerCommand("gams.showListing", async () => {
        const config = vscode.workspace.getConfiguration('GAMS');
        // Configuration setting to preserve focus when opening the listing file
        const preservesFocus = config.get<boolean>("preserveFocus", true);
        const fileInfo = getActiveGamsFileInfo();
        if (!fileInfo) {
            return;
        }
        const { lstFilePath } = fileInfo;

        // Configuration setting to allow overriding the listing file path for projects
        const projectLst: string | undefined = config.get<string>('projectLst');

        let currentLstFilePath = lstFilePath;

        // If runProject mode is active and projectLst is defined, use it
        if (config.runProject) {
            currentLstFilePath = projectLst || currentLstFilePath;
        }

        try {
            await fs.promises.access(currentLstFilePath, fs.constants.F_OK);
            const document = await vscode.workspace.openTextDocument(currentLstFilePath);
            openLstFile(document, preservesFocus);
        } catch (err) {
            vscode.window.showInformationMessage("The corresponding listing file does not exist.");
        }
    });

    context.subscriptions.push(disposableShowLst);
}