import * as vscode from 'vscode';
import { getParsedDocument, GamsToken } from './gamsParser';
import { getSymbolKindForBaseKeyword } from './symbolKindUtils';
import { setSymbolLevel, getSymbolLevel } from './symbolMeta';

export class GamsDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    public provideDocumentSymbols(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DocumentSymbol[]> {
        return this.parseGAMSFile(document, token);
    }

    private parseGAMSFile(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.DocumentSymbol[] {
        const symbols: vscode.DocumentSymbol[] = [];
        const tokens = getParsedDocument(document);

        // Use shared section parser
        
        let currentParentSymbol: vscode.DocumentSymbol | undefined;
        let sectionStack: vscode.DocumentSymbol[] = []; // To track the current section hierarchy
        let inBlockComment: boolean = false;
        let currentDeclarationContent: string = '';
        let currentDeclarationStartLine: number = -1;

        for (let t = 0; t < tokens.length; t++) {
            if (token.isCancellationRequested) {
                return [];
            }
            const tk = tokens[t];

            // Handle block comments $ontext / $offtext
            if (tk.type === 'blockCommentStart') {
                inBlockComment = true;
                continue;
            }
            if (tk.type === 'blockCommentEnd') {
                inBlockComment = false;
                continue;
            }
            if (inBlockComment) {
                continue;
            }

            if (tk.type === 'section') {
                const sectionLevel = tk.level;
                // If we were in the middle of a declaration, process it
                if (currentParentSymbol && currentDeclarationContent.length > 0) {
                    currentDeclarationContent = '';
                    currentParentSymbol = undefined;
                }

                let sectionName = tk.title;
                const nameIndex = tk.raw.indexOf(sectionName);
                const startCol = nameIndex >= 0 ? nameIndex : 0;
                const range = new vscode.Range(tk.line, startCol, tk.line, tk.raw.length);
                const selectionRange = new vscode.Range(tk.line, startCol, tk.line, startCol + sectionName.length);

                let kind: vscode.SymbolKind = vscode.SymbolKind.String;
                const newSectionSymbol = new vscode.DocumentSymbol(sectionName, '', kind, range, selectionRange);
                setSymbolLevel(newSectionSymbol, sectionLevel);

                // Manage the sectionStack using metadata stored via `symbolMeta`
                while (sectionStack.length > 0) {
                    const last = sectionStack[sectionStack.length - 1];
                    const parentLevel = getSymbolLevel(last);
                    if (parentLevel !== undefined && sectionLevel <= parentLevel) {
                        sectionStack.pop();
                    } else {
                        break;
                    }
                }

                const parent = sectionStack.length > 0 ? sectionStack[sectionStack.length - 1] : undefined;
                if (parent) {
                    if (!parent.children) {
                        parent.children = [];
                    }
                    parent.children.push(newSectionSymbol);
                    parent.range = new vscode.Range(parent.range.start, newSectionSymbol.range.end);
                } else {
                    symbols.push(newSectionSymbol);
                }
                sectionStack.push(newSectionSymbol);
                continue;
            }

            if (tk.type === 'declaration') {
                // If we were in the middle of a declaration, process it before starting a new one
                if (currentParentSymbol && currentDeclarationContent.length > 0) {
                    currentDeclarationContent = ''; // Reset for the new declaration
                }

                // Found a new declaration block
                const idx = tk.keywordIndex;
                const keywordRange = new vscode.Range(tk.line, idx >= 0 ? idx : 0, tk.line, (idx >= 0 ? idx : 0) + tk.keywordLength);
                const selectionRange = keywordRange;
                const kind = getSymbolKindForBaseKeyword(tk.baseKeyword.toUpperCase());

                currentParentSymbol = new vscode.DocumentSymbol(
                    tk.full,
                    '',
                    kind,
                    keywordRange,
                    selectionRange
                );

                // Decide where to push: under current section, or top-level
                const currentSectionParent = sectionStack.length > 0 ? sectionStack[sectionStack.length - 1] : undefined;
                if (currentSectionParent) {
                    if (!currentSectionParent.children) {
                        currentSectionParent.children = [];
                    }
                    currentSectionParent.children.push(currentParentSymbol);
                    // Extend the parent section's range to include this GAMS declaration
                    currentSectionParent.range = new vscode.Range(currentSectionParent.range.start, currentParentSymbol.range.end);
                } else {
                    symbols.push(currentParentSymbol);
                }

                currentDeclarationContent = tk.processed.substring(tk.full.length).trim();
                currentDeclarationStartLine = tk.line;
                continue;
            }

            // Normal line handling: accumulate declaration content if a declaration is open
            if (tk.type === 'normal' && currentParentSymbol && tk.processed.length > 0) {
                currentDeclarationContent += ' ' + tk.processed;
                currentParentSymbol.range = new vscode.Range(currentParentSymbol.range.start, new vscode.Position(tk.line, tk.raw.length));

                if (tk.processed.endsWith(';')) {
                    currentDeclarationContent = '';
                    currentParentSymbol = undefined;
                }
                continue;
            }

            // Handle orphaned semicolon lines when no currentParentSymbol exists
            if (tk.type === 'normal' && currentDeclarationContent.length > 0 && tk.processed.endsWith(';')) {
                currentDeclarationContent = '';
            }
        }

        return symbols;
    }
}