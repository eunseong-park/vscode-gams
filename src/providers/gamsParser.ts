import * as vscode from 'vscode';
import { parseSectionHeader } from './sectionUtils';
import { parseDeclaration, ParsedDeclaration } from './declarationUtils';

// Normalize common dash characters and remove invisible separators
function normalizeWhitespaceAndDashes(s: string): string {
    if (!s) return s;
    // Replace various dashes with ASCII hyphen
    const DASH_MAP: { [k: number]: string } = {
        0x2010: '-', // hyphen
        0x2011: '-', // non-breaking hyphen
        0x2012: '-', // figure dash
        0x2013: '-', // en dash
        0x2014: '-', // em dash
        0x2212: '-', // minus sign
    } as any;
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (DASH_MAP[code]) {
            out += DASH_MAP[code];
        } else if (code === 0x200B || code === 0xFEFF) {
            // skip zero-width space / BOM
            continue;
        } else {
            out += s[i];
        }
    }
    return out;
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

// Simple per-document cache keyed by document URI + version. If document.version
// hasn't changed we return the cached tokens. This avoids reparsing for repeated
// provider calls when the document is unchanged.
const documentParseCache: Map<string, { version: number; tokens: GamsToken[] }> = new Map();

export function getParsedDocument(document: vscode.TextDocument): GamsToken[] {
    const key = document.uri.toString();
    const cached = documentParseCache.get(key);
    if (cached && cached.version === document.version) {
        return cached.tokens;
    }

    const tokens = parseDocument(document);
    documentParseCache.set(key, { version: document.version, tokens });
    return tokens;
}

export function invalidateDocumentCache(uri: vscode.Uri | string) {
    const key = typeof uri === 'string' ? uri : uri.toString();
    documentParseCache.delete(key);
}

export function clearParseCache() {
    documentParseCache.clear();
}
