import * as vscode from 'vscode';

type Meta = { level?: number };

const metaMap = new WeakMap<vscode.DocumentSymbol, Meta>();

export function setSymbolLevel(sym: vscode.DocumentSymbol, level: number) {
    const existing = metaMap.get(sym) || {};
    existing.level = level;
    metaMap.set(sym, existing);
}

export function getSymbolLevel(sym: vscode.DocumentSymbol): number | undefined {
    const m = metaMap.get(sym);
    return m ? m.level : undefined;
}
