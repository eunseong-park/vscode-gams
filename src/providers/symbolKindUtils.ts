import * as vscode from 'vscode';

export function getSymbolKindForBaseKeyword(baseKeyword: string): vscode.SymbolKind {
    switch (baseKeyword) {
        case 'SET':
            return vscode.SymbolKind.Array;
        case 'PARAMETER':
            return vscode.SymbolKind.TypeParameter;
        case 'VARIABLE':
            return vscode.SymbolKind.Variable;
        case 'EQUATION':
            return vscode.SymbolKind.Interface;
        case 'MODEL':
            return vscode.SymbolKind.Class;
        case 'ACRONYM':
            return vscode.SymbolKind.Enum;
        case 'FILE':
            return vscode.SymbolKind.File;
        case 'FUNCTION':
            return vscode.SymbolKind.Function;
        default:
            return vscode.SymbolKind.Key;
    }
}
