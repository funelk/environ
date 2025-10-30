# Environ

![GitHub package.json version](https://img.shields.io/github/package-json/v/funelk/environ)
![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/funelk.envi?label=VS%20Marketplace&logo=visual-studio-code)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/funelk.environ)](https://marketplace.visualstudio.com/items?itemName=funelk.environ)
![GitHub](https://img.shields.io/github/license/funelk/environ)

Environ is a VS Code extension that reads a workspace environment file and parent directories' files (eg. `.env`, `.vscode/.env`) and makes variables available to:

- **Debug configurations** (injected at resolve time; no changes to launch.json required).
- **Tasks** via runtime injection using Task Provider (no modification of original tasks.json).
- **Terminals** via dedicated terminal creation command and terminal profile provider.
  Key behavior
- The extension searches for environment files (eg. `.env`) in the workspace folder and every parent directory up to the filesystem root, then merges them. Parent environment files files are applied first; files closer to the workspace override parent values.
- It can watch those environment files  and auto-apply changes (if configured).
- Supports per-workspace variable filtering and per-task variable mapping (persisted in workspace state).
- Supports preset variables configured in settings and `${VAR}` expansion inside `.env` files.

Install / Build

1. npm install
2. npm run compile
3. Run the extension in the Extension Development Host (F5) from VS Code or package with `vsce package`.

## Runtime Injection (Recommended)

The extension now supports **runtime environment variable injection** without modifying your original configuration files:

### Tasks

- Variables are injected at task execution time via a Task Provider
- All existing tasks automatically get environment variables
- Optional: Prepend workspace and parent directories to PATH

### Terminals

- Use **"Environ: New terminal with environment file variables"** to create a terminal with injected environment
- Terminal Profile Provider available for consistent terminal creation
- No modification of global terminal settings
- Optional: Prepend workspace and parent directories to PATH

### Debug Configurations

- Variables are automatically injected at debug resolution time
- No changes to `launch.json` required

## Commands

### Runtime Injection Commands

- **"Environ: New terminal with environment file's variables"** — Creates a new terminal with environment variables from .env files injected
- **"Environ: Show environment variables status"** — Shows a detailed report of discovered .env files, filters, and variable mappings
- **Command variable** — Use `${command:environ.$MY_VAR}` in `tasks.json`, `launch.json`, or settings to reference a variable managed by Environ

### Configuration Commands

- **"Environ: Configure environment file name"** — Change which file name to search for (e.g., switch from .env to .env.local)
- **"Environ: Configure variable filter"** — Choose which variables from .env files are applied (affects all injection methods)

### Legacy Commands (File Modification)

- **"Environ: Apply environment file variables to tasks and terminal"** — Writes variables into `.vscode/tasks.json` and terminal settings (creates backups)
- **"Environ: Apply environment file variables to terminal.integrated.env.*"** — Only apply to terminal settings

Settings (in Settings UI or settings.json under `environ`)

- If true the `.env` values will overwrite existing keys in tasks' `options.env`. If false, existing keys stay intact.
- `environ.envFileName` (string, default ".env")
  - The name of the environment file to search for in the workspace and parent directories. Change this to use a different file name like `.env.local`, `.env.development`, etc.
- `environ.prependCwdComponentsToPath` (boolean, default false)
  - If true, disable prepending the workspace folder and all parent directories to the PATH environment variable. By default, workspace directories are automatically prepended to PATH.
- `environ.mergeStrategies` (object, default `{"PATH": "prepend"}`)
  - Configure how to merge environment variables when they exist in both .env and system environment. Keys are variable names, values are merge strategies:
    - `"replace"`: Use the configured value, ignoring the system value
    - `"prepend"`: Prepend the configured value before the system value with the path separator (`:` on macOS/Linux, `;` on Windows)
    - `"append"`: Append the configured value after the system value with the path separator
  - Variables not listed use the default "replace" strategy
- `environ.variablePresets` (object, default `{}`)
  - Static environment variables defined directly in settings. These values are merged before any `.env` files and support `${VAR}` style expansion.
- `environ.pathResolves` (object, default `{}`)
  - Configure which environment variables should be treated as paths. Keys are variable names, values are optional directory prefixes used when resolving relative values (defaults to the primary workspace folder).

## Notes and Limitations

### Runtime Injection Benefits

- **No file modification**: Your original `tasks.json`, `launch.json`, and terminal settings remain unchanged
- **Dynamic updates**: Changes to .env files are immediately available to new tasks and terminals
- **Clean workspace**: No backup files or modified configuration files in your repository

### General Limitations

- The extension cannot change the environment of the VS Code process after startup — `${env:VAR}` substitutions that were resolved at startup won't be affected
- The extension stores per-task mappings and filters in workspaceState (local to your machine); they are not automatically stored in git
- The extension reads `.env` files up the filesystem tree. Be careful with sensitive data in parent `.env` files

### How Variables Are Applied

**Runtime Injection (Recommended)**:

- **Tasks**: Environment variables are injected when tasks are resolved/executed
- **Terminals**: Use the dedicated command to create terminals with injected environment
- **Debug**: Variables are injected when debug configurations are resolved

### Environment Variable Resolution Order

1. Load preset variables from `environ.presets`
2. Read all `.env` files from filesystem root to workspace folder and expand `${VAR}` references within values
3. Merge variables so that child folders override parent values
4. Apply folder-level variable filters (if configured)
5. Apply per-task mapping (if configured for that task)
6. Merge with existing process environment values according to `environ.mergeStrategies`

If you'd like a packaged .vsix, a "nearest only" option, or export/import for mappings, tell me which and I'll add it next.
