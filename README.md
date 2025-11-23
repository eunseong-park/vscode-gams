# GAMS Extension for Visual Studio Code

This extension provides basic support for the GAMS language in Visual Studio Code, acting as a convenient wrapper around the GAMS executable.

## Features

* **Syntax Highlighting:** Provides syntax highlighting for GAMS files (`.gms`, `.inc`, `.lst`).
* **GAMS Command Execution:**
  * Run GAMS models directly from VS Code.
  * Option to run GAMS with GDX creation.
  * Commands to show the GAMS listing file.
* **GDX File Integration:**
  * Open GDX files with GAMS IDE/Studio directly from the explorer context menu.
* **Configurable Settings:**
  * Customize terminal location, working directory, and command line parameters.
  * Option to preserve focus after opening listing files.
  * Support for running project batch files and specifying project-specific listing and GDX files.

## Installation

You can install the GAMS Extension for Visual Studio Code in a few ways:

1. **From the VS Code Marketplace:**

   * Open VS Code.
   * Go to the Extensions view by clicking on the Square icon on the sidebar or pressing `Ctrl+Shift+X`.
   * Search for "GAMS".
   * Click "Install".
2. **From a VSIX file:**

   * Download the `.vsix` file from the [releases page](https://github.com/eunseong-park/gams/releases) (or provided by other means).
   * In VS Code, open the Extensions view (`Ctrl+Shift+X`).
   * Click on the three dots (...) in the top-right corner of the Extensions view header.

   ## Usage

Once installed, the GAMS Extension will automatically provide syntax highlighting for files with `.gms` and `.inc` extensions.

To utilize the GAMS commands:

* **Run GAMS:** Open a `.gms` file and use the command palette (`Ctrl+Shift+P`) to search for "GAMS: Run GAMS" or press `F9`.
* **Run GAMS with GDX creation:** Open a `.gms` file and use the command palette (`Ctrl+Shift+P`) to search for "GAMS: Run GAMS with GDX creation" or press `Shift+F9`.
* **Show GAMS Listing File:** After running a GAMS model, use the command palette (`Ctrl+Shift+P`) to search for "GAMS: Show the GAMS listing file" or press `F10`.
* **Open GDX with GAMS IDE/Studio:** Right-click on a `.gdx` file in the Explorer view and select "Open GDX with GAMS IDE/Studio".

You can also customize the extension's behavior through VS Code settings. Go to `File > Preferences > Settings` (or `Code > Preferences > Settings` on macOS) and search for "GAMS" to configure options like terminal location, working directory, and command line parameters.

## Acknowledgements

This extension builds on the original GAMS syntax highlighting by [lolow](httpss://github.com/lolow/gams). Their work provided the foundation for the language grammar used here.
