import * as vscode from 'vscode';

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
        const lines = document.getText().split('\n');

        // Regex to find GAMS declaration keywords at the beginning of a line
        const declarationRegex = /^\s*(ACRONYM(S)?|ALIAS(ES)?|EQUATION(S)?|FILE(S)?|FUNCTION(S)?|MODEL(S)?|PARAMETER(S)?|SCALAR(S)?|(SINGLETON)?\s*SET(S)?|TABLE(S)?|(FREE|POSITIVE|NONNEGATIVE|NEGATIVE|BINARY|INTEGER|SOS1|SOS2|SEMICONT|SEMIINT)?\s*VARIABLE(S)?)\b/i;
        // Regex for comment-based sections: # Section Name ---
        const levelBasedSectionRegex = /^\s*(\*+)\s*([^\-]*?)\s*\-{3,}/;
        
        let currentParentSymbol: vscode.DocumentSymbol | undefined;
        let sectionStack: vscode.DocumentSymbol[] = []; // To track the current section hierarchy
        let inBlockComment: boolean = false;
        let currentDeclarationContent: string = '';
        let currentDeclarationStartLine: number = -1;

        for (let i = 0; i < lines.length; i++) {
            if (token.isCancellationRequested) {
                return [];
            }

            const line = lines[i];
            const trimmedLine = line.trim();

            // Handle block comments $ontext / $offtext
            if (trimmedLine.startsWith('$ontext')) {
                inBlockComment = true;
                continue;
            }
            if (trimmedLine.startsWith('$offtext')) {
                inBlockComment = false;
                continue;
            }
            if (inBlockComment) {
                continue;
            }

            // Strip end-of-line comments (if not a full line comment)
            let processedLine = trimmedLine;
            if (!processedLine.startsWith('*')) {
                const commentIndex = processedLine.indexOf('*');
                if (commentIndex !== -1) {
                    processedLine = processedLine.substring(0, commentIndex).trim();
                }
            }
            if (processedLine.length === 0) { // Check again after stripping comments
                continue;
            }

            let newSectionSymbol: vscode.DocumentSymbol | undefined;
            let sectionLevel: number = 0;
            let sectionMatchResult: RegExpExecArray | null = null;

            // Check for section/subsection comments - use single regex
            if ((sectionMatchResult = levelBasedSectionRegex.exec(processedLine))) {
                sectionLevel = sectionMatchResult[1].length; // Length of the captured '*' sequence
            }

            if (sectionLevel > 0 && sectionMatchResult) {
                // If we were in the middle of a declaration, process it
                if (currentParentSymbol && currentDeclarationContent.length > 0) {
                    currentDeclarationContent = '';
                    currentParentSymbol = undefined;
                }

                let sectionName = sectionMatchResult[2].trim(); // Captured group for section name
                if (sectionName === '') {
                    sectionName = '(empty)';
                }
                const range = new vscode.Range(i, sectionMatchResult.index, i, line.length);
                const selectionRange = new vscode.Range(i, sectionMatchResult.index, i, sectionMatchResult.index + sectionName.length);

                // Assign a generic symbol kind, as detail is removed
                let kind: vscode.SymbolKind = vscode.SymbolKind.String; 
                
                newSectionSymbol = new vscode.DocumentSymbol(
                    sectionName,
                    '', // No detail
                    kind,
                    range,
                    selectionRange
                );
                (newSectionSymbol as any).level = sectionLevel; // Store level on the symbol
                
                // Manage the sectionStack
                while (sectionStack.length > 0 && (sectionStack[sectionStack.length - 1] as any).level && 
                       (sectionLevel <= (sectionStack[sectionStack.length - 1] as any).level)) {
                    sectionStack.pop();
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
                continue; // Move to next line after processing section
            }

            const match = processedLine.match(declarationRegex);

            if (match) {
                // If we were in the middle of a declaration, process it before starting a new one
                if (currentParentSymbol && currentDeclarationContent.length > 0) {
                    currentDeclarationContent = ''; // Reset for the new declaration
                }

                // Found a new declaration block
                // Determine the base keyword for symbol kind assignment
                let baseKeyword = match[1].toUpperCase();
                if (baseKeyword.includes('VARIABLE')) {
                    baseKeyword = 'VARIABLE';
                } else if (baseKeyword.includes('EQUATION')) {
                    baseKeyword = 'EQUATION';
                } else if (baseKeyword.includes('MODEL')) {
                    baseKeyword = 'MODEL';
                } else if (baseKeyword.includes('PARAMETER') || baseKeyword.includes('SCALAR') || baseKeyword.includes('TABLE')) {
                    baseKeyword = 'PARAMETER';
                } else if (baseKeyword.includes('SET') || baseKeyword.includes('ALIAS')) {
                    baseKeyword = 'SET';
                } else if (baseKeyword.includes('ACRONYM')) {
                    baseKeyword = 'ACRONYM';
                } else if (baseKeyword.includes('FILE')) {
                    baseKeyword = 'FILE';
                } else if (baseKeyword.includes('FUNCTION')) {
                    baseKeyword = 'FUNCTION';
                }


                const keywordRange = new vscode.Range(i, line.indexOf(match[0]), i, line.indexOf(match[0]) + match[0].trim().length);
                const selectionRange = new vscode.Range(i, line.indexOf(match[0]), i, line.indexOf(match[0]) + match[0].trim().length);

                let kind: vscode.SymbolKind;
                switch (baseKeyword) {
                    case 'SET':
                        kind = vscode.SymbolKind.Array;
                        break;
                    case 'PARAMETER':
                        kind = vscode.SymbolKind.TypeParameter;
                        break;
                    case 'VARIABLE':
                        kind = vscode.SymbolKind.Variable;
                        break;
                    case 'EQUATION':
                        kind = vscode.SymbolKind.Interface;
                        break;
                    case 'MODEL':
                        kind = vscode.SymbolKind.Class;
                        break;
                    case 'ACRONYM':
                        kind = vscode.SymbolKind.Enum;
                        break;
                    case 'FILE':
                        kind = vscode.SymbolKind.File;
                        break;
                    case 'FUNCTION':
                        kind = vscode.SymbolKind.Function; // Functions in GAMS
                        break;
                    default:
                        kind = vscode.SymbolKind.Key;
                        break;
                }

                currentParentSymbol = new vscode.DocumentSymbol(
                    match[0].trim(),
                    '', // detail
                    kind,
                    keywordRange, // Use keywordRange here
                    selectionRange // Use selectionRange here
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
                
                currentDeclarationContent = processedLine.substring(match[0].length).trim();
                currentDeclarationStartLine = i;
            } else if (currentParentSymbol && processedLine.length > 0) {
                // Continue accumulating content for the current declaration
                currentDeclarationContent += ' ' + processedLine;
                currentParentSymbol.range = new vscode.Range(currentParentSymbol.range.start, new vscode.Position(i, line.length));
                
                // Check if the declaration ends on this line
                if (processedLine.endsWith(';')) {
                    currentDeclarationContent = '';
                    currentParentSymbol = undefined; // Reset current parent
                }
            } else if (currentDeclarationContent.length > 0 && processedLine.endsWith(';')) {
                // This case handles when currentDeclarationContent is not empty but currentParentSymbol is undefined
                // This can happen if a declaration starts on the last line of a file without a new declaration following.
                // Or if it's a statement like "DISPLAY x,y,z;" not preceded by a block keyword
                // For now, we ignore these orphaned semicolons, assuming valid declarations start with a keyword.
                currentDeclarationContent = '';
            }
        }

        return symbols;
    }
}