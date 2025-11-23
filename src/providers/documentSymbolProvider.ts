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
        const declarationRegex = /^\s*(SETS?|PARAMETERS?|VARIABLES?|EQUATIONS?|MODELS?|SCALARS?|TABLES?|ACRONYMS?|ASSIGNS?|OPTIONS?)\b/i;
        // Regex for comment-based sections: # Section Name ---
        const sectionRegex = /^\s*\*(?![*])\s*([^\-]+?)\s*\-{3,}/;
        // Regex for comment-based subsections: ** Subsection Name ---
        const subsectionRegex = /^\s*\*\*\s*([^\-]+?)\s*\-{3,}/;
        // Regex for comment-based sub-subsections: *** Sub-subsection Name ---
        const subSubsectionRegex = /^\s*\*\*\*\s*([^\-]+?)\s*\-{3,}/;
        // Regex for comment-based sub-sub-subsections: **** Sub-sub-subsection Name ---
        const subSubSubsectionRegex = /^\s*\*\*\*\*\s*([^\-]+?)\s*\-{3,}/;
        
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

            // Check for section/subsection comments - prioritize deepest levels first
            if ((sectionMatchResult = subSubSubsectionRegex.exec(processedLine))) {
                sectionLevel = 4;
            } else if ((sectionMatchResult = subSubsectionRegex.exec(processedLine))) {
                sectionLevel = 3;
            } else if ((sectionMatchResult = subsectionRegex.exec(processedLine))) {
                sectionLevel = 2;
            } else if ((sectionMatchResult = sectionRegex.exec(processedLine))) {
                sectionLevel = 1;
            }

            if (sectionLevel > 0 && sectionMatchResult) {
                // If we were in the middle of a declaration, process it
                if (currentParentSymbol && currentDeclarationContent.length > 0) {
                    currentDeclarationContent = '';
                    currentParentSymbol = undefined;
                }

                const sectionName = sectionMatchResult[1].trim();
                const range = new vscode.Range(i, sectionMatchResult.index, i, line.length);
                const selectionRange = new vscode.Range(i, sectionMatchResult.index, i, sectionMatchResult.index + sectionName.length);

                let kind: vscode.SymbolKind;
                let detail: string;
                switch (sectionLevel) {
                    case 1: kind = vscode.SymbolKind.Module; detail = 'Section'; break;
                    case 2: kind = vscode.SymbolKind.Namespace; detail = 'Subsection'; break;
                    case 3: kind = vscode.SymbolKind.Class; detail = 'Sub-subsection'; break;
                    case 4: kind = vscode.SymbolKind.Method; detail = 'Sub-sub-subsection'; break;
                    default: kind = vscode.SymbolKind.Module; detail = 'Section'; break;
                }
                
                newSectionSymbol = new vscode.DocumentSymbol(
                    sectionName,
                    detail,
                    kind,
                    range,
                    selectionRange
                );

                // Manage the sectionStack
                while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].detail && 
                       (sectionLevel <= (sectionStack[sectionStack.length - 1].detail === 'Section' ? 1 : 
                                         sectionStack[sectionStack.length - 1].detail === 'Subsection' ? 2 :
                                         sectionStack[sectionStack.length - 1].detail === 'Sub-subsection' ? 3 : 4))) {
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
                const keyword = match[1].toUpperCase();
                const range = new vscode.Range(i, line.indexOf(match[0]), i, line.length);
                const selectionRange = new vscode.Range(i, line.indexOf(match[0]), i, line.length);

                let kind: vscode.SymbolKind;
                switch (keyword) {
                    case 'SET':
                    case 'SETS':
                        kind = vscode.SymbolKind.Array;
                        break;
                    case 'PARAMETER':
                    case 'PARAMETERS':
                        kind = vscode.SymbolKind.Constant;
                        break;
                    case 'VARIABLE':
                    case 'VARIABLES':
                        kind = vscode.SymbolKind.Variable;
                        break;
                    case 'EQUATION':
                    case 'EQUATIONS':
                        kind = vscode.SymbolKind.Function;
                        break;
                    case 'MODEL':
                    case 'MODELS':
                        kind = vscode.SymbolKind.Class;
                        break;
                    case 'SCALAR':
                    case 'SCALARS':
                        kind = vscode.SymbolKind.Constant;
                        break;
                    case 'TABLE':
                    case 'TABLES':
                        kind = vscode.SymbolKind.Constant; // Can also be an Array
                        break;
                    case 'ACRONYM':
                    case 'ACRONYMS':
                        kind = vscode.SymbolKind.Enum;
                        break;
                    case 'ASSIGN':
                        kind = vscode.SymbolKind.Operator; // Or some other suitable kind
                        break;
                    case 'OPTION':
                        kind = vscode.SymbolKind.Property;
                        break;
                    default:
                        kind = vscode.SymbolKind.Key;
                        break;
                }

                currentParentSymbol = new vscode.DocumentSymbol(
                    match[0].trim(),
                    '', // detail
                    kind,
                    range,
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