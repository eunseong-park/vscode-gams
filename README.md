# GAMS Extension for Visual Studio Code

This extension provides basic GAMS language support in Visual Studio Code, acting as a convenient wrapper around the GAMS executable.

## Features

*   **GAMS Language Support**: Enjoy syntax highlighting for GAMS files.
*   **Integrated GAMS Execution**: Run GAMS models and manage listing/GDX files directly within VS Code.
*   **GDX File Management**: Conveniently open GDX files with GAMS IDE/Studio.
*   **Customizable Workflow**: Tailor terminal behavior, and file handling to your preferences.

## Installation

1.  **VS Code Marketplace:**
    *   Open VS Code and go to the Extensions view (`Ctrl+Shift+X`).
    *   Search for "GAMS" and click "Install".
2.  **VSIX File:**
    *   Download the `.vsix` file from the [releases page](https://github.com/eunseong-park/vscode-gams/releases).
    *   In the Extensions view (`Ctrl+Shift+X`), click the `...` menu and select "Install from VSIX...".

## Requirements

The `gams` executable must be available on your system's PATH environment variable. For example, if GAMS is installed at `C:\GAMS\45`, you would add `C:\GAMS\45` to your system's PATH.

## Usage

### Syntax Highlighting

The extension automatically provides syntax highlighting for `.gms` and `.inc` files. To enable syntax highlighting for MPSGE blocks, type "mpsge" after `$ontext`, for example:
```gams
$onText mpsge

$MODEL:HARBERGER
...
$offText
```

### Code Folding

The GAMS extension provides intelligent code folding for better readability and navigation. You can collapse and expand:

*   **Comment-based Sections**: Regions defined by `*** Section Name ---` and similar constructs.
*   **GAMS Block Comments**: Sections enclosed by `$ontext` and `$offtext`.
*   **GAMS Declaration Blocks**: Multi-line declarations for `SET`, `PARAMETER`, `VARIABLE`, `EQUATION`, etc., which are typically terminated by a semicolon (`;`).

### Commands

You can execute GAMS commands using the Command Palette (`Ctrl+Shift+P`), assigned keyboard shortcuts, or by clicking the corresponding icons in the editor title.

*   **GAMS: Run GAMS** (`F9`): Executes the current GAMS model.
*   **GAMS: Run GAMS with GDX creation** (`Shift+F9`): Executes the model and creates a GDX file.
*   **GAMS: Show the GAMS listing file** (`F10`): Displays the listing file for the last run.
*   **GAMS: Toggle Line Comment for GAMS**: Toggles line comments for the GAMS language.
*   **GAMS: Insert a new section** (`Ctrl+Shift+R`): Inserts a new comment-based section (`*** Section Name ---`) into the active GAMS file. This command also supports inserting subsections.

*   **GAMS: Toggle run project file**: Switches between running the active GAMS file or a project batch file.
*   **GAMS: Open GAMS extension Settings**: Opens the settings for this extension.
*   **Open GDX with GAMS IDE/Studio**: Right-click a `.gdx` file in the Explorer and select this option to open it with your configured GAMS IDE/Studio.

## Extension Settings

To configure the extension, go to `File > Preferences > Settings` (or `Code > Preferences > Settings` on macOS) and search for "GAMS".

Available settings:

*   `GAMS.listingFileLocation`: Determine the location where the GAMS listing file should open. Possible values are `Beside`, `Active`, `One`, `Two`, `Three`, `Four`, `Five`, `Six`, `Seven`, `Eight`, `Nine`.
*   `GAMS.terminalLocation`: Determine the location of the terminal. Possible values are `Panel`, `Active`, `Beside`, `One`, ..., `Nine`.
*   `GAMS.terminalCwd`: Specifies the working directory for the terminal. If empty, the terminal's working directory will be the folder containing the `.gms` file.
*   `GAMS.commandLineParameters`: Determine the command line parameters that will be passed to the GAMS executable.
*   `GAMS.preserveFocus`: If selected, the focus remains on the active tab while the listing file is opened. Otherwise, the focus changes to the newly opened listing file.
*   `GAMS.runProject`: Determine whether to run the project run batch file instead of the active `.gms` file.
*   `GAMS.runBatchPath`: Determine the path to the batch file that will be executed when running the project run file.
*   `GAMS.projectLst`: Determine the path to the project listing file.
*   `GAMS.projectGDX`: Determine the path to the project GDX file.
*   `GAMS.idePath`: Determine the path to the GAMS IDE/Studio.

## Acknowledgements

This extension's language grammar is based on the original GAMS syntax highlighting work by [lolow](https://github.com/lolow/gams).