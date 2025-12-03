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
import { updateParsedDocument, invalidateDocumentCache, getParsedDocument } from './providers/gamsParser';

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

    // Keep parser cache up-to-date on document edits and clear on close
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.languageId !== 'gams') {return;}
        updateParsedDocument(e.document, e.contentChanges);
    }));

    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => {
        if (doc.languageId !== 'gams') {return;}
        invalidateDocumentCache(doc.uri);
    }));

    // Refresh the parse cache on save to ensure persisted file state is parsed.
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId !== 'gams') {return;}
        // Rebuild parse cache for the saved document
        getParsedDocument(doc);
    }));
}

export function deactivate() { }