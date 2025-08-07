# Change Log

## [1.13.1]

- [UI] Prevent drag events in edit mode in text area and footer to avoid unintended dragging during text selection
- [UI] Remove unnecessary padding from body element to increase usable space

## [1.13.0]

- [UI] Added manual auto-delete feature for completed todos via UI button
- [UI] Removed drag handle button; the entire todo/note is now draggable

## [1.12.0]

- Added auto-delete feature for completed todos after a specified number of days (configurable)
- Updated Angular to version 20
- Updated dependencies

## [1.11.0]

- Updated Angular to version 19
- Updated dependencies

## [1.10.0]

- Added Delete All button to clear entire list per tab

## [1.9.3]

- Fix webview panel occasionally displaying no data on initial load, particularly affecting slower machines

## [1.9.2]

- Fix inverted legends for import/export menus
- Panel tabs optimizations for small viewports

## [1.9.1]

- UI optimizations for small viewports

## [1.9.0]

- Added view in the Activity Bar
- Minor UI fixes and improvements

## [1.8.0]

- Added 'Wide View' mode with configurable settings and toggle functionality
- Improved consistency for export, import, and view mode icons
- Improved action menu and align colors with VSCode menu

## [1.7.0]

- Improved menu styling and layout
- Added import and export buttons
- Enhanced 'Undo' feature to retain all data and position after deletion
- Fixed bug where restored items were placed in incorrect file lists

## [1.6.0]

- Redesigned the action menu for improved usability
- Added copy button functionality in markdown code blocks
- Added config setting to toggle line numbers in markdown code blocks
- Fixed styling issues when the action menu is open
- Resolved unneeded scrollbar in auto-resizable textarea
- Updated dependencies

## [1.5.1]

- Import/Export: Removed empty newline between checklist items for improved formatting
- Enhanced import functionality: Added support for more checklist syntaxes and improved newline handling in markdown

## [1.5.0]

- Import/Export functionality for Markdown format.
- Option to export data for 'current file' only

## [1.4.0]

- Add configuration "createMarkdownByDefault" to create new tasks with markdown enabled (contributed by @ilya-gs)
- Add configuration "createPosition" to set if new tasks should be placed at the top or bottom of the list (contributed by @ilya-gs)
- Minor bugfixes
- Updated dependencies

## [1.3.0]

- File-associated data is now preserved during move and rename operations, and automatically removed upon file deletion
- Updated dependencies

## [1.2.0]

- Added Import/Export (JSON format)
- Updated Angular to version 18
- Updated dependencies

## [1.1.2]

- Added toggle file list button in file tab
- UI optimizations

## [1.1.1]

- Added informative tooltips to the tabs
- Updated README

## [1.1.0]

- Improved item deletion animation
- Allow resizing of file-list view by dragging and double-clicking
- Increased max width of the webview

## [1.0.1]

- Updated Angular to 17.3.5
- Updated markdown processing and other dependencies

## [1.0.0]

- Initial release