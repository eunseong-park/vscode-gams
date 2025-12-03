import * as vscode from 'vscode';
import { getParsedDocument, GamsToken } from './gamsParser';

export class GamsFoldingRangeProvider implements vscode.FoldingRangeProvider {
    provideFoldingRanges(
        document: vscode.TextDocument,
        context: vscode.FoldingContext,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.FoldingRange[]> {
        const foldingRanges: vscode.FoldingRange[] = [];
        const tokens = getParsedDocument(document);

        // Stack to manage active foldable blocks
        const foldableBlockStack: { type: 'section' | 'declaration' | 'commentBlock'; startLine: number }[] = [];

        for (let t = 0; t < tokens.length; t++) {
            if (token.isCancellationRequested) {
                return [];
            }
            const tk = tokens[t];

            if (tk.type === 'blockCommentStart') {
                foldableBlockStack.push({ type: 'commentBlock', startLine: tk.line });
                continue;
            }

            if (tk.type === 'blockCommentEnd') {
                // Close any blocks that are currently open and are inside this comment block
                while (foldableBlockStack.length > 0) {
                    const lastBlock = foldableBlockStack[foldableBlockStack.length - 1];
                    if (lastBlock.type === 'commentBlock') {
                        foldableBlockStack.pop();
                        foldingRanges.push(new vscode.FoldingRange(lastBlock.startLine, tk.line, vscode.FoldingRangeKind.Comment));
                        break; // processed this $offtext
                    } else {
                        foldableBlockStack.pop();
                        if (lastBlock.startLine < tk.line - 1) {
                            foldingRanges.push(new vscode.FoldingRange(lastBlock.startLine, tk.line - 1, vscode.FoldingRangeKind.Region));
                        }
                    }
                }
                continue;
            }

            // If we are currently inside an $ontext/$offtext block, skip processing other patterns
            if (foldableBlockStack.length > 0 && foldableBlockStack[foldableBlockStack.length - 1].type === 'commentBlock') {
                continue;
            }

            if (tk.type === 'section') {
                // Close open declaration or previous section at same level
                while (foldableBlockStack.length > 0) {
                    const lastBlock = foldableBlockStack[foldableBlockStack.length - 1];
                    if (lastBlock.type === 'declaration' || lastBlock.type === 'section') {
                        foldableBlockStack.pop();
                        foldingRanges.push(new vscode.FoldingRange(lastBlock.startLine, tk.line - 1, vscode.FoldingRangeKind.Region));
                    } else {
                        break;
                    }
                }
                foldableBlockStack.push({ type: 'section', startLine: tk.line });
                continue;
            }

            if (tk.type === 'declaration') {
                // Close previous declaration siblings
                while (foldableBlockStack.length > 0) {
                    const lastBlock = foldableBlockStack[foldableBlockStack.length - 1];
                    if (lastBlock.type === 'declaration') {
                        foldableBlockStack.pop();
                        foldingRanges.push(new vscode.FoldingRange(lastBlock.startLine, tk.line - 1, vscode.FoldingRangeKind.Region));
                    } else {
                        break;
                    }
                }
                foldableBlockStack.push({ type: 'declaration', startLine: tk.line });
                continue;
            }

            // For normal lines, if it ends with semicolon close the latest declaration
            // Use type guards instead of `any` casts to check for processed text
            let endsWithSemicolon = false;
            if ('processedNormalized' in tk && typeof tk.processedNormalized === 'string') {
                endsWithSemicolon = tk.processedNormalized.endsWith(';');
            } else if ('processed' in tk && typeof tk.processed === 'string') {
                endsWithSemicolon = tk.processed.endsWith(';');
            }
            if (endsWithSemicolon) {
                const lastBlock = foldableBlockStack[foldableBlockStack.length - 1];
                if (lastBlock && lastBlock.type === 'declaration') {
                    foldableBlockStack.pop();
                    foldingRanges.push(new vscode.FoldingRange(lastBlock.startLine, tk.line, vscode.FoldingRangeKind.Region));
                }
            }
        }

        // Close any remaining open blocks at the end of the document
        while (foldableBlockStack.length > 0) {
            const lastBlock = foldableBlockStack.pop();
            if (lastBlock) {
                if (lastBlock.startLine < document.lineCount - 1) {
                    foldingRanges.push(new vscode.FoldingRange(lastBlock.startLine, document.lineCount - 1, lastBlock.type === 'commentBlock' ? vscode.FoldingRangeKind.Comment : vscode.FoldingRangeKind.Region));
                }
            }
        }

        return foldingRanges;
    }
}