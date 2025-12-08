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

The `gams` executable needs to be accessible by the extension. You can achieve this in two ways:
1.  **System PATH:** Ensure the directory containing the `gams` executable is added to your system's PATH environment variable. For example, if GAMS is installed at `C:\GAMS\45`, you would add `C:\GAMS\45` to your system's PATH.
2.  **Extension Setting:** Alternatively, you can specify the full path to the GAMS executable in the `GAMS.executablePath` extension setting (e.g., `C:\GAMS\43\gams.exe`). This is useful if GAMS is not on your PATH or if you want to use a specific GAMS version.

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

*   `GAMS: Run GAMS` (`F9`): Executes the current GAMS model.
*   `GAMS: Run GAMS with GDX creation` (`Shift+F9`): Executes the model and creates a GDX file.
*   `GAMS: Show the GAMS listing file` (`F10`): Displays the listing file for the last run.
*   `GAMS: Toggle Line Comment for GAMS` (`Ctrl+/`): Toggles line comments for the GAMS language.
*   `GAMS: Insert a new section` (`Ctrl+Shift+R`): Inserts a new comment-based section (`*** Section Name ---`) into the active GAMS file.
*   `GAMS: Toggle run project file`: Switches between running the active GAMS file or a project-specific batch file.
*   `GAMS: Open GAMS extension Settings`: Opens the extension's settings page in VS Code.
*   `Open GDX with GAMS IDE/Studio`: Opens a `.gdx` file using the configured GAMS IDE/Studio (available in the Explorer context menu).

## Extension Settings

To configure the extension, go to `File > Preferences > Settings` (or `Code > Preferences > Settings` on macOS) and search for "GAMS".

Available settings:

*   `GAMS.executablePath`: Specifies the path to the GAMS executable. Use this when GAMS is not available on the PATH or to use a specific GAMS version. Example: `C:\GAMS\43\gams.exe`.
*   `GAMS.listingFileLocation`: Determine the location where the GAMS listing file should open. Possible values are `Beside`, `Active`, `One`, `Two`, `Three`, `Four`, `Five`, `Six`, `Seven`, `Eight`, `Nine`.
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

## Author

Maintained by [eunseong-park](https://github.com/eunseong-park)

## Disclaimer

This extension is community-maintained and is not affiliated with or endorsed by GAMS Corporation. A separately installed and licensed GAMS distribution is required to run models; this extension does not include GAMS.