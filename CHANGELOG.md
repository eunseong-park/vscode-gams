# Change Log

## [0.1.4] - 2025-12-08

### Changed
- `Toggle Line Comment` command now closely matches VS Code's native behavior, improving multi-selection and toggle logic.
- GAMS execution now uses VS Code's Tasks API (`vscode.ShellExecution` for batch files and `vscode.ProcessExecution` for GAMS executable) for better integration and robustness, allowing users to specify `GAMS.executablePath` for reliable execution regardless of system PATH configuration.

### Removed
- Obsolete `GAMS.terminalLocation` setting and related internal code.

## [0.1.3] - 2025-12-04

### Changed
- Commands and keybindings now use case-insensitive matching for file extensions, ensuring menu items appear regardless of filename casing (for example `file.GdX` or `file.GMS`).
- Opening GDX files is more reliable across platforms.
- Status bar items (`GAMS Settings`, `Run Project`) only show when editing GAMS files.
- The `Run Project` toggle now saves to the workspace settings when possible.

### Fixed
- Minor fixes and reliability improvements.

## [0.1.1] - 2025-11-25

### Added
- Implemented Code Folding for GAMS files, supporting:
  - Comment-based sections (e.g., `*** Section Name ---`).
  - GAMS `$ontext`/`$offtext` blocks.
  - GAMS declaration blocks (e.g., `SET`, `PARAMETER`, `EQUATION`).

## [0.1.0] - 2025-11-24
### Added
- "Insert New Section" command (`ctrl+shift+r`) to insert a new section with a formatted header.
### Fixed
- Fixed a bug in the document outline feature that caused it to fail when encountering a section without a name.

## [0.0.11] - 2025-11-24

### Added
* Added `GAMS.listingFileLocation` setting to customize where the listing file opens.

## [0.0.10] - 2025-11-24

### Changed

* Updated extension icon to `images/letter-gams.png`.

## [0.0.9] - 2025-11-24

### Added

* Added tip to `README.md` for MPSGE syntax highlighting.

### Fixed

* Resolved `vsce package` error by explicitly adding `activationEvents` property.

## [0.0.8] - 2025-11-24

### Added

* Implemented "Toggle Line Comment" functionality (uses `*`).
* Added Document Symbol Provider for GAMS files, enabling outline view for declarations and sections.

### Changed

* Updated syntax highlighting for improved accuracy and consistency across various GAMS language constructs (keywords, options, comments, strings).
* Added '#' as a recognized line comment character in syntax highlighting.

## [0.0.7] - 2025-02-20

### Changed

* Improved syntax highlighting for plural/singular forms of field names in MPSGE.

## [0.0.6] - 2025-01-15

### Fixed

* Corrected syntax highlighting for variables.

## [0.0.5] - 2024-11-21

### Added

* Added a button to the status bar to quickly open GAMS extension settings.
* Added a status bar button to toggle the `runProject` setting, displaying the current status (`On`/`Off`).

## [0.0.4] - 2024-06-07

### Added

* Users can now add command-line parameters.

## [0.0.3] - 2024-05-20

### Added

* Added "Open GDX with GAMS IDE" button and context menu in the explorer.

### Fixed

* Fixed syntax highlighting issues.

## [0.0.2] - 2024-05-06

### Added

* Support for running project batch files.
* Icons for GAMS-related files.

## [0.0.1] - 2024-04-01

### Added

* Initial release of the extension.
