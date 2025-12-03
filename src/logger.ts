import * as vscode from 'vscode';

let output: vscode.OutputChannel | undefined;
function channel(): vscode.OutputChannel {
    if (!output) {
        output = vscode.window.createOutputChannel('GAMS');
    }
    return output;
}

export const logger = {
    info: (message: string, ...args: unknown[]) => {
        channel().appendLine(`[INFO] ${message} ${args.map(a => String(a)).join(' ')}`);
    },
    warn: (message: string, ...args: unknown[]) => {
        channel().appendLine(`[WARN] ${message} ${args.map(a => String(a)).join(' ')}`);
    },
    error: (message: string, ...args: unknown[]) => {
        channel().appendLine(`[ERROR] ${message} ${args.map(a => String(a)).join(' ')}`);
    },
    show: (preserveFocus = true) => {
        channel().show(preserveFocus);
    }
};

export default logger;
