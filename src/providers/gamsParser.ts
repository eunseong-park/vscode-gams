import type * as vscode from 'vscode';
import { parseSectionHeader } from './sectionUtils';
import { parseDeclaration, ParsedDeclaration } from './declarationUtils';

// Preserve original line content exactly — do not strip or normalize characters
function normalizeWhitespaceAndDashes(s: string): string {
    return s;
}

export type GamsToken =
    | { type: 'blockCommentStart'; line: number; raw: string }
    | { type: 'blockCommentEnd'; line: number; raw: string }
    | { type: 'section'; line: number; raw: string; processed: string; processedNormalized: string; level: number; title: string }
    | { type: 'declaration'; line: number; raw: string; processed: string; processedNormalized: string; full: string; baseKeyword: string; keywordIndex: number; keywordLength: number }
    | { type: 'normal'; line: number; raw: string; processed: string; processedNormalized: string };

export function parseLines(lines: string[]): GamsToken[] {
    const tokens: GamsToken[] = [];

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        const lower = trimmed.toLowerCase();

        // Block comment markers
        if (lower.startsWith('$ontext')) {
            tokens.push({ type: 'blockCommentStart', line: i, raw });
            continue;
        }
        if (lower.startsWith('$offtext')) {
            tokens.push({ type: 'blockCommentEnd', line: i, raw });
            continue;
        }

        // Strip end-of-line comments (unless it's a full line comment starting with '*')
        let processed = trimmed;
        if (!processed.startsWith('*')) {
            const commentIndex = processed.indexOf('*');
            if (commentIndex !== -1) {
                processed = processed.substring(0, commentIndex).trim();
            }
        }

        const processedNormalized = normalizeWhitespaceAndDashes(processed);

        if (processed.length === 0) {
            tokens.push({ type: 'normal', line: i, raw, processed, processedNormalized });
            continue;
        }

        // Section headers (comment-based)
        const section = parseSectionHeader(processedNormalized);
        if (section) {
            tokens.push({ type: 'section', line: i, raw, processed, processedNormalized, level: section.level, title: section.title });
            continue;
        }

        // Declaration keywords
        const decl = parseDeclaration(processedNormalized);
        if (decl) {
            // find index in original processed string so selection matches original
            const keywordIndex = processed.toLowerCase().indexOf(decl.full.toLowerCase());
            const keywordLength = decl.full.trim().length;
            tokens.push({ type: 'declaration', line: i, raw, processed, processedNormalized, full: decl.full, baseKeyword: decl.baseKeyword, keywordIndex: keywordIndex >= 0 ? keywordIndex : 0, keywordLength });
            continue;
        }

        // Normal line
        tokens.push({ type: 'normal', line: i, raw, processed, processedNormalized });
    }

    return tokens;
}

export function parseDocument(document: vscode.TextDocument): GamsToken[] {
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
        lines.push(document.lineAt(i).text);
    }
    return parseLines(lines);
}

// Per-document per-line cache. We keep tokens parsed per-line so incremental
// edits only reparse affected lines and reuse unchanged lines' tokens.
type PerLineCache = {
    version: number;
    lineCount: number;
    perLineTokens: Map<number, GamsToken[]>; // key = line index
    perLineText: Map<number, string>; // original raw text per line for reuse checks
};

const documentPerLineCache: Map<string, PerLineCache> = new Map();

function assembleTokensFromPerLine(perLine: Map<number, GamsToken[]>): GamsToken[] {
    const tokens: GamsToken[] = [];
    const keys = Array.from(perLine.keys()).sort((a, b) => a - b);
    for (const k of keys) {
        const arr = perLine.get(k)!;
        for (const t of arr) {tokens.push(t);}
    }
    return tokens;
}

export function getParsedDocument(document: vscode.TextDocument): GamsToken[] {
    const key = document.uri.toString();
    const cached = documentPerLineCache.get(key);
    if (cached && cached.version === document.version) {
        return assembleTokensFromPerLine(cached.perLineTokens);
    }

    // Build per-line tokens fresh and record per-line text
    const perLine = new Map<number, GamsToken[]>();
    const perLineText = new Map<number, string>();
    for (let i = 0; i < document.lineCount; i++) {
        const lineText = document.lineAt(i).text;
        const local = parseLines([lineText]);
        // Adjust token line numbers to global
        const adjusted = local.map(t => ({ ...t, line: t.line + i } as GamsToken));
        perLine.set(i, adjusted);
        perLineText.set(i, lineText);
    }
    const cacheEntry: PerLineCache = { version: document.version, lineCount: document.lineCount, perLineTokens: perLine, perLineText };
    documentPerLineCache.set(key, cacheEntry);
    return assembleTokensFromPerLine(perLine);
}

export function invalidateDocumentCache(uri: vscode.Uri | string) {
    const key = typeof uri === 'string' ? uri : uri.toString();
    documentPerLineCache.delete(key);
}

export function clearParseCache() {
    documentPerLineCache.clear();
}

// Apply incremental changes to the cached tokens. `contentChanges` is the array
// from `TextDocumentChangeEvent.contentChanges` and refers to ranges in the old
// document. The provided `document` is the new document after the changes.
export function updateParsedDocument(document: vscode.TextDocument, contentChanges: readonly vscode.TextDocumentContentChangeEvent[]): GamsToken[] {
    const key = document.uri.toString();
    const cached = documentPerLineCache.get(key);
    // If we don't have a per-line cache yet, create one by parsing whole document
    if (!cached) {
        const tokens = getParsedDocument(document);
        return tokens;
    }
    // Merge changes into a single composite replacement to minimize reparses
    const mergedChanges = mergeCompositeChanges(contentChanges, document);
    // Start from cached maps (clone to avoid mutating shared maps)
    let perLine = new Map<number, GamsToken[]>(cached.perLineTokens);
    let perLineText = new Map<number, string>(cached.perLineText || []);
    let lineCount = cached.lineCount;

    for (const change of mergedChanges) {
        const oldStart = change.range.start.line;
        const oldEnd = change.range.end.line;
        const newLines = change.text.split('\n').length; // number of new lines in replacement
        const newEnd = oldStart + Math.max(0, newLines - 1);
        const oldLineCount = Math.max(0, oldEnd - oldStart);
        const delta = newLines - (oldLineCount + 1);

        // Build new perLine and perLineText maps: keep lines before oldStart, insert new parsed lines, shift the tail
        const newPerLine = new Map<number, GamsToken[]>();
        const newPerLineText = new Map<number, string>();
        // copy before
        for (const [ln, toks] of perLine.entries()) {
            if (ln < oldStart) {
                newPerLine.set(ln, toks);
                const txt = perLineText.get(ln);
                if (txt !== undefined) {newPerLineText.set(ln, txt);}
            }
        }

        // parse and insert new lines from document into newPerLine at positions oldStart..newEnd
        for (let ln = oldStart; ln <= newEnd; ln++) {
            if (ln >= 0 && ln < document.lineCount) {
                const lineText = document.lineAt(ln).text;
                // If the cached per-line text is identical, reuse token objects to avoid reparsing
                const oldText = perLineText.get(ln);
                if (oldText !== undefined && oldText === lineText) {
                    const existing = perLine.get(ln) || [];
                    newPerLine.set(ln, existing);
                    newPerLineText.set(ln, lineText);
                } else {
                    const local = parseLines([lineText]);
                    const adjusted = local.map(t => ({ ...t, line: t.line + ln } as GamsToken));
                    newPerLine.set(ln, adjusted);
                    newPerLineText.set(ln, lineText);
                }
            } else {
                newPerLine.set(ln, []);
                newPerLineText.set(ln, '');
            }
        }

        // copy and shift tail
        for (const [ln, toks] of perLine.entries()) {
            if (ln > oldEnd) {
                newPerLine.set(ln + delta, toks.map(t => ({ ...t, line: t.line + delta } as GamsToken)));
                const txt = perLineText.get(ln);
                newPerLineText.set(ln + delta, txt !== undefined ? txt : '');
            }
        }

        perLine = newPerLine;
        perLineText = newPerLineText;
        lineCount = lineCount + delta;
    }

    const cacheEntry: PerLineCache = { version: document.version, lineCount, perLineTokens: perLine, perLineText };
    documentPerLineCache.set(key, cacheEntry);
    return assembleTokensFromPerLine(perLine);
}

// Merge adjacent or overlapping content changes to reduce reparses.
function mergeAdjacentChanges(changes: readonly vscode.TextDocumentContentChangeEvent[]) : vscode.TextDocumentContentChangeEvent[] {
    if (!changes || changes.length <= 1) {return Array.from(changes);}
    const sorted = Array.from(changes).sort((a,b) => {
        if (a.range.start.line !== b.range.start.line) {return a.range.start.line - b.range.start.line;}
        return a.range.start.character - b.range.start.character;
    });
    const merged: vscode.TextDocumentContentChangeEvent[] = [];
    let current = sorted[0];
    for (let i=1;i<sorted.length;i++) {
        const next = sorted[i];
        // If next starts before or at current.end + 1 then merge
        if (next.range.start.line <= current.range.end.line + 1) {
            // new merged range: start = current.start, end = next.end
            const mergedRange = { start: current.range.start, end: next.range.end };
            const mergedText = current.text + next.text; // concatenation works for contiguous edits
            current = { range: mergedRange, text: mergedText } as vscode.TextDocumentContentChangeEvent;
        } else {
            merged.push(current);
            current = next;
        }
    }
    merged.push(current);
    return merged;
}

// Merge all changes into one composite change that replaces the minimal
// contiguous range in the old document that covers all edits with the
// corresponding lines from the new document after edits.
function mergeCompositeChanges(changes: readonly vscode.TextDocumentContentChangeEvent[], document: vscode.TextDocument): vscode.TextDocumentContentChangeEvent[] {
    if (!changes || changes.length === 0) {return [];}
    // determine minimal start and maximal old end
    let minStart = Number.MAX_SAFE_INTEGER;
    let maxOldEnd = -1;
    let totalDelta = 0;
    for (const c of changes) {
        const s = c.range.start.line;
        const e = c.range.end.line;
        minStart = Math.min(minStart, s);
        maxOldEnd = Math.max(maxOldEnd, e);
        const newLines = c.text.split('\n').length;
        const oldLines = Math.max(0, e - s) + 1;
        totalDelta += (newLines - oldLines);
    }
    const newEnd = Math.min(document.lineCount - 1, maxOldEnd + totalDelta);

    // build replacement text from the new document's lines
    const newLinesArr: string[] = [];
    for (let ln = minStart; ln <= newEnd; ln++) {
        if (ln >= 0 && ln < document.lineCount) {newLinesArr.push(document.lineAt(ln).text);}
    }
    const replacementText = newLinesArr.join('\n');

    const composite: vscode.TextDocumentContentChangeEvent = {
        range: { start: { line: minStart, character: 0 }, end: { line: maxOldEnd, character: Number.MAX_SAFE_INTEGER } },
        text: replacementText
    } as vscode.TextDocumentContentChangeEvent;

    return [composite];
}
