import * as vscode from 'vscode';
import * as fs from 'fs';
import { getActiveGamsFileInfo, launchGamsIde } from '../utils';

export function registerOpenCorrGDXCommand(context: vscode.ExtensionContext) {
    let disposableOpenCorrGDX = vscode.commands.registerCommand("gams.openCorrGDX", async () => {
        const config = vscode.workspace.getConfiguration('GAMS');
        const fileInfo = getActiveGamsFileInfo();
        if (!fileInfo) {
            return;
        }
        const { gdxFilePath } = fileInfo;

        // Configuration setting to allow overriding the GDX file path for projects
        const projectGDX: string | undefined = config.get<string>('projectGDX');

        let currentGdxFilePath = gdxFilePath;

        // If runProject mode is active and projectGDX is defined, use it
        if (config.runProject) {
            currentGdxFilePath = projectGDX || currentGdxFilePath;
        }

        try {
            await fs.promises.access(currentGdxFilePath, fs.constants.F_OK);
            launchGamsIde(currentGdxFilePath);
        } catch (err) {
            vscode.window.showInformationMessage("The corresponding GDX file does not exist.");
        }
    });

    context.subscriptions.push(disposableOpenCorrGDX);
}