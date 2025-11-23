import * as vscode from 'vscode';
import { GamsFileInfo, getActiveGamsFileInfo, getGamsTerminal, launchGamsIde } from './utils';
import { registerRunCommand } from './commands/run';
import { registerRunWithGdxCreationCommand } from './commands/runWithGdxCreation';
import { registerShowListingCommand } from './commands/showListing';
import { registerOpenCorrGDXCommand } from './commands/openCorrGDX';
import { registerOpenSettingsCommand } from './commands/openSettings';
import { registerToggleRunProjectCommand } from './commands/toggleRunProject';
import { registerOpenGDXCommand } from './commands/openGDX';
import { registerToggleLineCommentCommand } from './commands/toggleLineComment';

export function activate(context: vscode.ExtensionContext) {
	const extensionId = context.extension.id;

	// Register commands
	registerRunCommand(context);
	registerRunWithGdxCreationCommand(context);
	registerShowListingCommand(context);
	registerOpenCorrGDXCommand(context);
	registerOpenSettingsCommand(context, extensionId);
	registerToggleRunProjectCommand(context);
	registerOpenGDXCommand(context);
	registerToggleLineCommentCommand(context);
}

export function deactivate() { }