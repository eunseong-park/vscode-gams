import * as vscode from 'vscode';

export class GamsDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    public provideDocumentSymbols(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DocumentSymbol[]> {
        const symbols: vscode.DocumentSymbol[] = [];
        const lines = document.getText().split('\n');

        // Regex to find GAMS declaration keywords at the beginning of a line
        const declarationRegex = /^\s*(SETS?|PARAMETERS?|VARIABLES?|EQUATIONS?|MODELS?)\b/i;

        let currentSection: vscode.DocumentSymbol | undefined;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(declarationRegex);

            if (match) {
                const keyword = match[1].toUpperCase();
                const range = new vscode.Range(i, line.indexOf(match[0]), i, line.length);
                const selectionRange = new vscode.Range(i, line.indexOf(match[0]), i, line.length);

                let kind: vscode.SymbolKind;
                let name: string;
                switch (keyword) {
                    case 'SET':
                    case 'SETS':
                        kind = vscode.SymbolKind.Array; // Represent sets as arrays
                        name = match[0].trim();
                        break;
                    case 'PARAMETER':
                    case 'PARAMETERS':
                        kind = vscode.SymbolKind.Constant; // Represent parameters as constants
                        name = match[0].trim();
                        break;
                    case 'VARIABLE':
                    case 'VARIABLES':
                        kind = vscode.SymbolKind.Variable; // Represent variables
                        name = match[0].trim();
                        break;
                    case 'EQUATION':
                    case 'EQUATIONS':
                        kind = vscode.SymbolKind.Function; // Represent equations as functions
                        name = match[0].trim();
                        break;
                    case 'MODEL':
                    case 'MODELS':
                        kind = vscode.SymbolKind.Class; // Represent models as classes
                        name = match[0].trim();
                        break;
                    default:
                        kind = vscode.SymbolKind.Key;
                        name = match[0].trim();
                        break;
                }
                
                // For simplicity, we'll just add the declaration keyword itself as a symbol
                // A more advanced parser would extract individual set/parameter/variable names
                currentSection = new vscode.DocumentSymbol(
                    name,
                    '', // detail
                    kind,
                    range,
                    selectionRange
                );
                symbols.push(currentSection);
            } else if (currentSection && line.trim().length > 0 && !line.startsWith('*')) {
                // This is a very basic attempt to group items under their declaration.
                // A proper implementation would need to parse individual elements (e.g., 'i', 'j' in SETS i,j;)
                // and correctly assign their ranges. For now, we'll just expand the parent range.
                // This will effectively group all lines under a declaration until another declaration is found.
                currentSection.range = new vscode.Range(currentSection.range.start, new vscode.Position(i, line.length));
            }
        }
        return symbols;
    }
}
