# GAMS Extension for Visual Studio Code

This extension provides basic GAMS language support in Visual Studio Code, acting as a convenient wrapper around the GAMS executable.

## Features

*   **Syntax Highlighting:** For GAMS files (`.gms`, `.inc`, `.lst`).
*   **GAMS Command Execution:**
    *   Run GAMS models directly from VS Code.
    *   Run GAMS with GDX creation.
    *   Show the GAMS listing file.
*   **GDX File Integration:**
    *   Open GDX files with GAMS IDE/Studio from the explorer context menu.
*   **Configurable Settings:**
    *   Customize the terminal location, working directory, and command-line parameters.
    *   Option to preserve focus after opening listing files.
    *   Support for running project batch files and specifying project-specific listing and GDX files.

## Installation

1.  **VS Code Marketplace:**
    *   Open VS Code and go to the Extensions view (`Ctrl+Shift+X`).
    *   Search for "GAMS" and click "Install".
2.  **VSIX File:**
    *   Download the `.vsix` file from the [releases page](https://github.com/eunseong-park/vscode-gams/releases).
    *   In the Extensions view (`Ctrl+Shift+X`), click the `...` menu and select "Install from VSIX...".

## Usage

The extension automatically provides syntax highlighting for `.gms` and `.inc` files.

You can execute GAMS commands using the Command Palette (`Ctrl+Shift+P`):

*   **GAMS: Run GAMS** (`F9`): Executes the current GAMS model.
*   **GAMS: Run GAMS with GDX creation** (`Shift+F9`): Executes the model and creates a GDX file.
*   **GAMS: Show the GAMS listing file** (`F10`): Displays the listing file for the last run.
*   **Open GDX with GAMS IDE/Studio**: Right-click a `.gdx` file in the Explorer and select this option.

To configure the extension, go to `File > Preferences > Settings` (or `Code > Preferences > Settings` on macOS) and search for "GAMS".

## Acknowledgements

This extension's language grammar is based on the original GAMS syntax highlighting work by [lolow](https://github.com/lolow/gams).
