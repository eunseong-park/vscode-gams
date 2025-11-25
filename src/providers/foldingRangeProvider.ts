import * as vscode from 'vscode';

export class GamsFoldingRangeProvider implements vscode.FoldingRangeProvider {
    provideFoldingRanges(
        document: vscode.TextDocument,
        context: vscode.FoldingContext,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.FoldingRange[]> {
        const foldingRanges: vscode.FoldingRange[] = [];
        const lines = document.getText().split('\n');

        // Regex to find GAMS declaration keywords at the beginning of a line
        const declarationRegex = /^\s*(ACRONYM(S)?|ALIAS(ES)?|EQUATION(S)?|FILE(S)?|FUNCTION(S)?|MODEL(S)?|PARAMETER(S)?|SCALAR(S)?|(SINGLETON)?\s*SET(S)?|TABLE(S)?|(FREE|POSITIVE|NONNEGATIVE|NEGATIVE|BINARY|INTEGER|SOS1|SOS2|SEMICONT|SEMIINT)?\s*VARIABLE(S)?)\b/i;
        // Regex for comment-based sections: *** Section Name ---
        const levelBasedSectionRegex = /^\s*(\*+)\s*([^\-]*?)\s*\-{3,}/;
        
        // Stack to manage active foldable blocks
        const foldableBlockStack: { type: 'section' | 'declaration' | 'commentBlock', startLine: number }[] = [];

        for (let i = 0; i < lines.length; i++) {
            if (token.isCancellationRequested) {
                return [];
            }

            const line = lines[i];
            const trimmedLine = line.trim();
            const lowerTrimmedLine = trimmedLine.toLowerCase(); // Convert to lowercase for case-insensitive comparison

            // Handle block comments $ontext / $offtext
            if (lowerTrimmedLine.startsWith('$ontext')) {
                // $ontext does not close parent blocks. It just starts a new nested comment block.
                foldableBlockStack.push({ type: 'commentBlock', startLine: i });
                continue;
            }
            if (lowerTrimmedLine.startsWith('$offtext')) {
                // Close any blocks that are currently open and are inside this comment block
                while (foldableBlockStack.length > 0) {
                    const lastBlock = foldableBlockStack[foldableBlockStack.length - 1];
                    if (lastBlock.type === 'commentBlock') {
                        // Found the matching $ontext, pop it and create the folding range
                        foldableBlockStack.pop();
                        foldingRanges.push(new vscode.FoldingRange(lastBlock.startLine, i, vscode.FoldingRangeKind.Comment));
                        break; // Exit loop, this $offtext is processed
                    } else {
                        // Close any nested sections or declarations that were not explicitly closed
                        foldableBlockStack.pop();
                        if (lastBlock.startLine < i - 1) { // Ensure valid range
                           foldingRanges.push(new vscode.FoldingRange(lastBlock.startLine, i - 1, vscode.FoldingRangeKind.Region));
                        }
                    }
                }
                continue;
            }

            // If we are currently inside an $ontext/$offtext block, skip processing other patterns
            // This is only true if a 'commentBlock' is the top-most item on the stack
            // and we are not on the '$offtext' line itself.
            if (foldableBlockStack.length > 0 && foldableBlockStack[foldableBlockStack.length - 1].type === 'commentBlock') {
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
            
            // Check for comment-based sections (like '*** Section Title ---')
            const sectionMatch = levelBasedSectionRegex.exec(processedLine);
            if (sectionMatch) {
                // A new section should close any open declaration or previous section at the same level
                while(foldableBlockStack.length > 0) {
                    const lastBlock = foldableBlockStack[foldableBlockStack.length - 1];
                    if (lastBlock.type === 'declaration' || lastBlock.type === 'section') {
                        foldableBlockStack.pop();
                        foldingRanges.push(new vscode.FoldingRange(lastBlock.startLine, i - 1, vscode.FoldingRangeKind.Region));
                    } else {
                        // Stop if we hit a commentBlock (which sections can be inside of)
                        break;
                    }
                }
                foldableBlockStack.push({ type: 'section', startLine: i });
                continue;
            }

            // Check for GAMS declaration keywords
            const declarationMatch = processedLine.match(declarationRegex);
            if (declarationMatch) {
                // A new declaration should close any previous declaration (it's a sibling)
                // but it should NOT close an open section (it's a child of a section)
                while(foldableBlockStack.length > 0) {
                    const lastBlock = foldableBlockStack[foldableBlockStack.length - 1];
                    if (lastBlock.type === 'declaration') {
                        foldableBlockStack.pop();
                        foldingRanges.push(new vscode.FoldingRange(lastBlock.startLine, i - 1, vscode.FoldingRangeKind.Region));
                    } else {
                        // Stop if we hit a section or commentBlock (which declarations can be inside of)
                        break;
                    }
                }
                foldableBlockStack.push({ type: 'declaration', startLine: i });
                continue;
            } 
            
            // If the line ends with a semicolon, it closes the most recent declaration
            if (trimmedLine.endsWith(';')) {
                const lastBlock = foldableBlockStack[foldableBlockStack.length - 1];
                if (lastBlock && lastBlock.type === 'declaration') {
                    foldableBlockStack.pop();
                    foldingRanges.push(new vscode.FoldingRange(lastBlock.startLine, i, vscode.FoldingRangeKind.Region));
                }
            }
        }

        // Close any remaining open blocks at the end of the document
        while (foldableBlockStack.length > 0) {
            const lastBlock = foldableBlockStack.pop();
            if (lastBlock) {
                // Ensure valid range (start line < end line)
                if (lastBlock.startLine < lines.length - 1) { 
                    foldingRanges.push(new vscode.FoldingRange(lastBlock.startLine, lines.length - 1, lastBlock.type === 'commentBlock' ? vscode.FoldingRangeKind.Comment : vscode.FoldingRangeKind.Region));
                }
            }
        }

        return foldingRanges;
    }
}