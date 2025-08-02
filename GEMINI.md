# Gemini Project Analysis: VS Code Todo

This document provides a comprehensive overview of the VS Code Todo project, designed to assist AI coding agents in understanding and contributing to the project.

## Project Overview

**VS Code Todo** is a Visual Studio Code extension that functions as a to-do and note manager. It allows users to create, manage, and track tasks and notes directly within the editor. The extension features a webview-based user interface for an interactive experience and provides commands for data import/export in JSON and Markdown formats.

The project is a monorepo composed of two main parts:
1.  **VS Code Extension**: The core extension logic, written in TypeScript, which handles VS Code integration, command registration, and communication with the webview.
2.  **Webview UI**: An Angular-based single-page application that provides the user interface for managing todos.

## Technologies

### Core Extension
-   **Language**: TypeScript
-   **Framework**: VS Code Extension API
-   **State Management**: Redux Toolkit
-   **Linting**: ESLint
-   **Testing**: Mocha

### Webview UI
-   **Framework**: Angular
-   **Styling**: SCSS
-   **Animations**: AutoAnimate
-   **Code Highlighting**: PrismJS
-   **Markdown Rendering**: ngx-markdown

## Project Structure

The project is organized into the following key directories:

-   `src/`: Contains the source code for the VS Code extension.
    -   `panels/`: Manages the webview panels, including the main todo view.
    -   `todo/`: Handles the core todo logic, such as import/export and data storage.
    -   `utilities/`: Provides helper functions for configuration, logging, and theme management.
    -   `test/`: Contains the test suite for the extension.
-   `webview-ui/`: Contains the source code for the Angular-based webview UI.
    -   `src/app/`: The main application module for the webview.
    -   `src/app/todo/`: Components and services related to todo management.
    -   `src/app/shared/`: Reusable components and pipes.
-   `docs/`: Contains project documentation.
-   `assets/`: Stores images, icons, and other static assets.

## Scripts

The following scripts are available for building, testing, and running the project:

### Root Project
-   `npm run install:all`: Installs dependencies for both the extension and the webview.
-   `npm run start:webview`: Starts the Angular development server for the webview.
-
-   `npm run build:webview`: Builds the webview application.
-   `npm run compile`: Compiles the TypeScript code for the extension.
-   `npm run watch`: Watches for changes and recompiles the extension.
-   `npm run pretest`: Compiles and lints the code before running tests.
-   `npm run lint`: Lints the extension's source code.
-   `npm run test`: Runs the test suite for the extension.

### Webview UI
-   `npm run start`: Starts the Angular development server.
-   `npm run build`: Builds the webview application.
-   `npm run watch`: Watches for changes and rebuilds the webview.
-   `npm run test`: Runs the test suite for the webview.

## Key Files

-   `package.json`: Defines the project's metadata, dependencies, and scripts.
-   `webview-ui/package.json`: Defines the dependencies and scripts for the webview UI.
-   `src/extension.ts`: The main entry point for the VS Code extension.
-   `src/panels/TodoViewProvider.ts`: Manages the webview panel for the todo list.
-   `webview-ui/src/app/app.component.ts`: The root component of the Angular application.
-   `webview-ui/src/app/todo/todo.service.ts`: The service responsible for managing todo data in the webview.
