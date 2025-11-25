import * as vscode from 'vscode';
import { registerRunCommand } from './commands/run';
import { registerRunWithGdxCreationCommand } from './commands/runWithGdxCreation';
import { registerShowListingCommand } from './commands/showListing';
import { registerOpenCorrGDXCommand } from './commands/openCorrGDX';
import { registerOpenSettingsCommand } from './commands/openSettings';
import { registerToggleRunProjectCommand } from './commands/toggleRunProject';
import { registerOpenGDXCommand } from './commands/openGDX';
import { registerToggleLineCommentCommand } from './commands/toggleLineComment';
import { registerInsertNewSectionCommand } from './commands/insertNewSection';
import { GamsDocumentSymbolProvider } from './providers/documentSymbolProvider';
import { GamsFoldingRangeProvider } from './providers/foldingRangeProvider';

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
	registerInsertNewSectionCommand(context);

    // Register Document Symbol Provider
    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider(
            { language: 'gams' },
            new GamsDocumentSymbolProvider()
        )
    );

    // Register Folding Range Provider
    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider(
            { language: 'gams' },
            new GamsFoldingRangeProvider()
        )
    );
}

export function deactivate() { }