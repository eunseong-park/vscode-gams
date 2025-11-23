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
        const sectionRegex = /^\s*#\s*([^\-]+?)\s*\-{3,}/;
        // Regex for comment-based subsections: ## Subsection Name ---
        const subsectionRegex = /^\s*##\s*([^\-]+?)\s*\-{3,}/;
        
        let currentParentSymbol: vscode.DocumentSymbol | undefined;
        let currentSectionSymbol: vscode.DocumentSymbol | undefined; // To track the current top-level section
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

            // Check for section/subsection comments first
            const sectionMatch = processedLine.match(sectionRegex);
            const subsectionMatch = processedLine.match(subsectionRegex);

            if (sectionMatch) {
                // If we were in the middle of a declaration, process it
                if (currentParentSymbol && currentDeclarationContent.length > 0) {
                    this.parseDeclarationItems(currentParentSymbol, currentDeclarationContent, currentDeclarationStartLine, document);
                    currentDeclarationContent = '';
                    currentParentSymbol = undefined;
                }

                const sectionName = sectionMatch[1].trim();
                const range = new vscode.Range(i, line.indexOf(sectionMatch[0]), i, line.length);
                const selectionRange = new vscode.Range(i, line.indexOf(sectionMatch[0]), i, line.indexOf(sectionMatch[0]) + sectionName.length);

                currentSectionSymbol = new vscode.DocumentSymbol(
                    sectionName,
                    'Section',
                    vscode.SymbolKind.Module, // Module or Namespace for sections
                    range,
                    selectionRange
                );
                symbols.push(currentSectionSymbol);
                continue; // Move to next line after processing section
            } else if (subsectionMatch) {
                // If we were in the middle of a declaration, process it
                if (currentParentSymbol && currentDeclarationContent.length > 0) {
                    this.parseDeclarationItems(currentParentSymbol, currentDeclarationContent, currentDeclarationStartLine, document);
                    currentDeclarationContent = '';
                    currentParentSymbol = undefined;
                }

                const subsectionName = subsectionMatch[1].trim();
                const range = new vscode.Range(i, line.indexOf(subsectionMatch[0]), i, line.length);
                const selectionRange = new vscode.Range(i, line.indexOf(subsectionMatch[0]), i, line.indexOf(subsectionMatch[0]) + subsectionName.length);

                const subsectionSymbol = new vscode.DocumentSymbol(
                    subsectionName,
                    'Subsection',
                    vscode.SymbolKind.Function, // Function or SubFunction for subsections
                    range,
                    selectionRange
                );

                if (currentSectionSymbol) {
                    if (!currentSectionSymbol.children) {
                        currentSectionSymbol.children = [];
                    }
                    currentSectionSymbol.children.push(subsectionSymbol);
                } else {
                    // If no parent section, add as top-level symbol (might happen if file starts with subsection)
                    symbols.push(subsectionSymbol);
                }
                continue; // Move to next line after processing subsection
            }

            const match = processedLine.match(declarationRegex);

            if (match) {
                // If we were in the middle of a declaration, process it before starting a new one
                if (currentParentSymbol && currentDeclarationContent.length > 0) {
                    this.parseDeclarationItems(currentParentSymbol, currentDeclarationContent, currentDeclarationStartLine, document);
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
                // Decide where to push: under current section or top-level
                if (currentSectionSymbol) {
                    if (!currentSectionSymbol.children) {
                        currentSectionSymbol.children = [];
                    }
                    currentSectionSymbol.children.push(currentParentSymbol);
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
                    this.parseDeclarationItems(currentParentSymbol, currentDeclarationContent, currentDeclarationStartLine, document);
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

        // Process any remaining declaration content if file ends without a semicolon
        if (currentParentSymbol && currentDeclarationContent.length > 0) {
            this.parseDeclarationItems(currentParentSymbol, currentDeclarationContent, currentDeclarationStartLine, document);
        }

        return symbols;
    }

    private parseDeclarationItems(
        parentSymbol: vscode.DocumentSymbol,
        declarationContent: string,
        startLine: number,
        document: vscode.TextDocument
    ) {
        // Remove content after / ... / as it's data and not relevant for symbol names
        let contentToParse = declarationContent.replace(/\s*\/.+\/\s*/g, '');
        
        // Split by commas, but handle cases where descriptions or dimensions contain commas
        // This regex attempts to find item definitions: name(dim) "description"
        const itemRegex = /\b([a-zA-Z0-9_]+)(\s*\([^)]+\))?(\s*["'][^"']*["'])?/g;
        let match: RegExpExecArray | null;

        while ((match = itemRegex.exec(contentToParse)) !== null) {
            const itemName = match[1];
            const itemDescription = match[3] ? match[3].trim().replace(/^"|"$/g, '') : '';
            
            // Calculate range for the item name relative to the document
            // This is a simplification; a more accurate range would require parsing the original line number
            // and column index within the full declarationContent string.
            // For now, we'll use the startLine for the item, and estimate its column.
            const itemStartCol = document.lineAt(startLine).text.indexOf(itemName);
            const itemRange = new vscode.Range(
                startLine, 
                itemStartCol === -1 ? 0 : itemStartCol, 
                startLine, 
                (itemStartCol === -1 ? 0 : itemStartCol) + itemName.length
            );
            
            // Assign a default SymbolKind for items, this can be refined based on parentSymbol.kind
            let itemKind: vscode.SymbolKind = vscode.SymbolKind.Field; 
            if (parentSymbol.kind === vscode.SymbolKind.Array) { // Sets
                itemKind = vscode.SymbolKind.EnumMember;
            } else if (parentSymbol.kind === vscode.SymbolKind.Constant) { // Parameters, Scalars, Tables
                itemKind = vscode.SymbolKind.Constant;
            } else if (parentSymbol.kind === vscode.SymbolKind.Variable) { // Variables
                itemKind = vscode.SymbolKind.Variable;
            } else if (parentSymbol.kind === vscode.SymbolKind.Function) { // Equations
                itemKind = vscode.SymbolKind.Function;
            } else if (parentSymbol.kind === vscode.SymbolKind.Class) { // Models
                itemKind = vscode.SymbolKind.Module;
            }

            const itemSymbol = new vscode.DocumentSymbol(
                itemName,
                itemDescription,
                itemKind,
                itemRange,
                itemRange
            );
            
            if (!parentSymbol.children) {
                parentSymbol.children = [];
            }
            parentSymbol.children.push(itemSymbol);
        }
    }
}
