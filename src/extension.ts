import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import dotenvExpand from "dotenv-expand";

type EnvMap = { [key: string]: string };
type TaskMapping = { [taskLabel: string]: string[] };
type MergeStrategy = "replace" | "prepend" | "append";
type MergeStrategies = { [variableName: string]: MergeStrategy };
type PathResolves = { [variableName: string]: string };

const DEFAULT_MERGE_STRATEGIES: MergeStrategies = { PATH: "prepend" };
const DEFAULT_ENV_FILE_NAME: string = ".env";

const pathSeparator = process.platform === "win32" ? ";" : ":";
const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
const primaryWorkspaceFolder: vscode.WorkspaceFolder | undefined =
  workspaceFolders[0];
function expandVariables(map: EnvMap, baseEnv: EnvMap = {}): EnvMap {
  if (!map || Object.keys(map).length === 0) {
    return {};
  }

  const parsed = { ...map };
  const touchedKeys = new Set<string>();
  const originalValues = new Map<string, string | undefined>();

  const rememberOriginal = (key: string) => {
    if (!touchedKeys.has(key)) {
      touchedKeys.add(key);
      originalValues.set(key, process.env[key]);
    }
  };

  for (const [key, value] of Object.entries(baseEnv)) {
    rememberOriginal(key);
    process.env[key] = String(value);
  }

  for (const key of Object.keys(parsed)) {
    rememberOriginal(key);
  }

  const expansion = dotenvExpand.expand({ parsed });
  const expanded = expansion.parsed ?? {};

  for (const key of touchedKeys) {
    const previous = originalValues.get(key);
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }

  return expanded;
}

/**
 * Get all parent directories from a given path up to the filesystem root.
 * Returns paths in order from root to the given path (parents first).
 */
function getParentDirectories(startPath: string): string[] {
  const paths: string[] = [];
  let current = path.resolve(startPath);

  while (true) {
    paths.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break; // reached root
    }
    current = parent;
  }

  return paths;
}

function findEnvFilesUpwards(
  startFolderFsPath: string,
  envFileName: string = DEFAULT_ENV_FILE_NAME
): string[] {
  // Return list of absolute .env file paths from filesystem root -> startFolder (parents first)
  const envPaths: string[] = [];
  let current = path.resolve(startFolderFsPath);

  while (true) {
    for (const candidate of [
      path.join(current, ".vscode", envFileName),
      path.join(current, envFileName),
    ]) {
      if (fs.existsSync(candidate)) {
        envPaths.unshift(candidate);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break; // reached root
    }
    current = parent;
  }

  return envPaths;
}

function parseEnvFiles(paths: string[], expansionBase: EnvMap = {}): EnvMap {
  const merged: EnvMap = {};
  for (const p of paths) {
    try {
      const content = fs.readFileSync(p, { encoding: "utf8" });
      const parsed = dotenv.parse(content);
      for (const [k, v] of Object.entries(parsed)) {
        // later files (closer to workspace) will overwrite previous keys
        merged[k] = String(v);
      }
    } catch (err) {
      console.error(`Environ: failed to parse ${p}:`, err);
    }
  }
  return expandVariables(merged, expansionBase);
}

function getEnvFileName() {
  const config = vscode.workspace.getConfiguration("environ");
  return config.get<string>("envFileName", DEFAULT_ENV_FILE_NAME);
}

/**
 * Read and merge env files found in the folder and all parents.
 * Parent env files are applied first; closer (child) env overrides parents.
 */
function readEnvFiles(
  folder: vscode.WorkspaceFolder,
  envFileName = getEnvFileName(),
  expansionBase: EnvMap = {}
): EnvMap | null {
  const start = folder.uri.fsPath;

  const envPaths = findEnvFilesUpwards(start, envFileName);
  if (!envPaths || envPaths.length === 0) {
    return null;
  }
  return parseEnvFiles(envPaths, expansionBase);
}

async function applyToTerminalSettings(
  env: EnvMap,
  target: vscode.ConfigurationTarget,
  folder?: vscode.WorkspaceFolder
) {
  const platform = process.platform;
  const configKey =
    platform === "win32"
      ? "terminal.integrated.env.windows"
      : platform === "darwin"
      ? "terminal.integrated.env.osx"
      : "terminal.integrated.env.linux";

  const config = vscode.workspace.getConfiguration(undefined, folder?.uri);
  const current = config.get<Record<string, string>>(configKey) || {};
  const merged = Object.assign({}, current, env);
  await config.update(configKey, merged, target);
}

function ensureVscodeDir(folderPath: string) {
  const vscodeDir = path.join(folderPath, ".vscode");
  if (!fs.existsSync(vscodeDir)) {
    fs.mkdirSync(vscodeDir);
  }
  return vscodeDir;
}

async function pickWorkspaceFolder() {
  const wsFolders = vscode.workspace.workspaceFolders ?? [];
  if (!wsFolders.length) {
    vscode.window.showInformationMessage("Environ: no workspace folder open.");
    return;
  }

  let folder: vscode.WorkspaceFolder | undefined = wsFolders[0];
  if (!folder) {
    const pick = await vscode.window.showQuickPick(
      wsFolders.map((f) => ({
        label: f.name,
        description: f.uri.fsPath,
      })),
      {
        placeHolder: "Choose workspace folder to show env status",
      }
    );
    if (!pick) {
      return;
    }
    folder = wsFolders.find((f) => f.name === pick.label);
  }

  return folder;
}

export function activate(context: vscode.ExtensionContext) {
  console.log("Environ: activating");

  // Track dynamically registered commands for cleanup (must be outside function scope)
  const varsCommandDisposables: vscode.Disposable[] = [];

  // Helper: workspaceState keys per-folder
  function stateKeyForFilter(folder: vscode.WorkspaceFolder) {
    return `environ.allowed:${folder.uri.fsPath}`;
  }

  function getAllowedForFolder(
    folder: vscode.WorkspaceFolder
  ): string[] | undefined {
    return context.workspaceState.get<string[]>(stateKeyForFilter(folder));
  }

  async function setAllowedForFolder(
    folder: vscode.WorkspaceFolder,
    keys: string[] | undefined
  ) {
    if (keys === undefined) {
      await context.workspaceState.update(stateKeyForFilter(folder), undefined);
    } else {
      await context.workspaceState.update(stateKeyForFilter(folder), keys);
    }
  }

  function filterEnvByAllowed(
    env: EnvMap,
    allowed?: string[] | undefined
  ): EnvMap {
    if (!allowed || allowed.length === 0) {
      // no filter => apply all
      return env;
    }
    const out: EnvMap = {};
    for (const k of allowed) {
      if (env[k] !== undefined) {
        out[k] = env[k];
      }
    }
    return out;
  }

  function resolveEnvironments(
    folder: vscode.WorkspaceFolder,
    variables: EnvMap
  ) {
    const config = vscode.workspace.getConfiguration("environ");
    const pathResolves = config.get<PathResolves>("pathResolves", {});

    const resolved: EnvMap = { ...variables };
    for (const [key, value] of Object.entries(pathResolves)) {
      resolved[key] = path.resolve(
        value || folder.uri.fsPath,
        resolved[key] || value
      );
      process.env[key] = resolved[key];
      console.log(`Environ: Preset variable ${key}`, resolved[key]);
    }
    return resolved;
  }

  function getConfiguredEnvironment(folder: vscode.WorkspaceFolder) {
    const config = vscode.workspace.getConfiguration("environ");

    const presets = config.get<EnvMap>("presets", {});
    console.log(`Environ: presets `, presets);
    const resolvedPresets: EnvMap = resolveEnvironments(folder, {
      ...presets,
    });

    const envFileName = config.get<string>(
      "envFileName",
      DEFAULT_ENV_FILE_NAME
    );
    const envFromFiles = readEnvFiles(folder, envFileName, presets) ?? {};
    const combined: EnvMap = resolveEnvironments(folder, {
      ...resolvedPresets,
      ...envFromFiles,
    });

    const allowed = getAllowedForFolder(folder);
    const filtered = expandVariables(filterEnvByAllowed(combined, allowed));
    console.log(`Environ: Filtered variables ${filtered}`);

    return {
      config,
      presets,
      envFromFiles,
      combined,
      filtered,
      allowed,
    };
  }

  // Apply environment variables to all terminals (including task terminals) using environmentVariableCollection
  // This is the proper way to inject env vars without modifying tasks.json
  function updateEnvironmentVariableCollection(
    folder = primaryWorkspaceFolder
  ) {
    if (!folder) {
      return {};
    }

    const { config, filtered } = getConfiguredEnvironment(folder);
    if (Object.keys(filtered).length === 0) {
      return {};
    }

    const prependPaths = config.get<boolean>(
      "prependCwdComponentsToPath",
      true
    );
    const mergeStrategies = config.get<MergeStrategies>(
      "mergeStrategies",
      DEFAULT_MERGE_STRATEGIES
    );

    // Apply variables with merge strategies
    const ensured: EnvMap = {};
    const options: vscode.EnvironmentVariableMutatorOptions = {
      applyAtProcessCreation: false,
      applyAtShellIntegration: true,
    };
    for (const [key, value] of Object.entries(filtered)) {
      const strategy = mergeStrategies[key] || "replace";
      const currentValue =
        context.environmentVariableCollection.get(key)?.value ?? "";
      // Non-PATH variables: apply merge strategy
      if (strategy === "prepend") {
        context.environmentVariableCollection.prepend(
          key,
          value + (currentValue && pathSeparator),
          options
        );
      } else if (strategy === "append") {
        context.environmentVariableCollection.append(
          key,
          (currentValue && pathSeparator) + value,
          options
        );
      } else {
        context.environmentVariableCollection.replace(key, value, options);
      }

      ensured[key] = context.environmentVariableCollection.get(key)?.value!;
      process.env[key] = ensured[key];
      console.log(
        `Environ: Ensured environment variable ${key} (${strategy}), ${value} -> ${value}, ${ensured[key]}`
      );
    }

    if (prependPaths) {
      const workspacePath = folder.uri.fsPath;
      const directories = getParentDirectories(workspacePath);
      // if (filtered.PATH || filtered.Path) {
      //   directories.push(filtered.PATH || filtered.Path);
      // }
      const prependString = directories.join(pathSeparator) + pathSeparator;
      context.environmentVariableCollection.prepend("PATH", prependString);
      const ensuredPath =
        context.environmentVariableCollection.get("PATH")?.value;
      if (ensuredPath !== undefined) {
        ensured.PATH = ensuredPath;
        process.env.PATH = ensuredPath;
      }
      console.log(
        `Environ: Prepended ${directories.length} directories to PATH`
      );
    }

    console.log(
      `Environ: Ensured environment variables `,
      Object.entries(ensured).map(([key, value]) => `${key}="${value}"`)
    );

    // Clean up previous dynamic commands before registering new ones
    while (varsCommandDisposables.length > 0) {
      varsCommandDisposables.pop()?.dispose();
    }

    // Register commands for each variable
    for (const key of Object.keys(filtered)) {
      try {
        const disposable = vscode.commands.registerCommand(
          `environ.$${key}`,
          () =>
            context.environmentVariableCollection.get(key)?.value ??
            process.env[key] ??
            ""
        );
        varsCommandDisposables.push(disposable);
        context.subscriptions.push(disposable);
      } catch (err) {
        console.warn(
          `Environ: Failed to register command for variable ${key}:`,
          err
        );
      }
    }
    return ensured;
  }

  // Initial application
  updateEnvironmentVariableCollection();

  // Task provider: For per-task variable mapping, we need to intercept and create custom tasks
  const taskProvider: vscode.TaskProvider = {
    provideTasks(): vscode.Task[] | undefined {
      // We don't provide new tasks, let tasks.json be the source
      return undefined;
    },

    resolveTask(task: vscode.Task): vscode.Task | undefined {
      const execution = task.execution;

      if (execution instanceof vscode.ShellExecution) {
        const newEnv = {
          ...process.env,
          ...execution.options?.env,
          ...updateEnvironmentVariableCollection(),
        } as { [key: string]: string };

        const newExecution = new vscode.ShellExecution(
          execution.commandLine || (execution.command as string),
          {
            ...execution.options,
            env: newEnv,
          }
        );

        return new vscode.Task(
          task.definition,
          task.scope ?? vscode.TaskScope.Workspace,
          task.name,
          task.source,
          newExecution,
          task.problemMatchers
        );
      }

      if (execution instanceof vscode.ProcessExecution) {
        const newEnv = {
          ...process.env,
          ...execution.options?.env,
          ...updateEnvironmentVariableCollection(),
        } as { [key: string]: string };

        const newExecution = new vscode.ProcessExecution(
          execution.process,
          execution.args,
          {
            ...execution.options,
            env: newEnv,
          }
        );

        return new vscode.Task(
          task.definition,
          task.scope ?? vscode.TaskScope.Workspace,
          task.name,
          task.source,
          newExecution,
          task.problemMatchers
        );
      }

      return undefined;
    },
  };

  context.subscriptions.push(
    vscode.tasks.registerTaskProvider("shell", taskProvider),
    vscode.tasks.registerTaskProvider("process", taskProvider)
  );

  // Debug provider: inject env at resolve time (already enhanced with filtering)
  const debugProvider: vscode.DebugConfigurationProvider = {
    resolveDebugConfiguration(folder, debugConfiguration) {
      if (!folder) {
        return debugConfiguration;
      }
      const { filtered } = getConfiguredEnvironment(folder);
      const existingEnv = debugConfiguration?.env || {};
      debugConfiguration = debugConfiguration || {};
      debugConfiguration.env = Object.assign({}, filtered, existingEnv);
      return debugConfiguration;
    },
  };
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider("*", debugProvider)
  );

  // Terminal profile provider: inject env variables into new terminals
  const terminalProfileProvider: vscode.TerminalProfileProvider = {
    provideTerminalProfile(
      token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.TerminalProfile> {
      // Find the current workspace folder
      const activeEditor = vscode.window.activeTextEditor;
      let workspaceFolder: vscode.WorkspaceFolder | undefined;

      if (activeEditor) {
        workspaceFolder = vscode.workspace.getWorkspaceFolder(
          activeEditor.document.uri
        );
      } else if (
        vscode.workspace.workspaceFolders &&
        vscode.workspace.workspaceFolders.length > 0
      ) {
        workspaceFolder = vscode.workspace.workspaceFolders[0];
      }

      if (!workspaceFolder) {
        return undefined;
      }

      return {
        options: {
          name: `Terminal with ${getEnvFileName()} (${workspaceFolder.name})`,
          env: updateEnvironmentVariableCollection(workspaceFolder),
        },
      };
    },
  };

  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider(
      "environ.terminal",
      terminalProfileProvider
    )
  );

  // Command to create terminal with environment variables
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "environ.createTerminalWithEnv",
      async () => {
        let folder = await pickWorkspaceFolder();
        if (!folder) {
          vscode.window.showInformationMessage(
            `Environ: Can't ensure the workspaceFolder`
          );
          return;
        }

        const updated = updateEnvironmentVariableCollection(folder);
        const terminal = vscode.window.createTerminal({
          name: `Terminal with configured env (${folder.name})`,
          env: updated,
        });

        terminal.show();

        const envCount = Object.keys(updated).length;
        vscode.window.showInformationMessage(
          `Environ: created terminal with ${envCount} environment variables from configuration`
        );
      }
    )
  );

  // Command to show current environment variables status
  context.subscriptions.push(
    vscode.commands.registerCommand("environ.showEnvStatus", async () => {
      let folder = await pickWorkspaceFolder();
      if (!folder) {
        vscode.window.showInformationMessage(
          `Environ: Can't ensure the workspaceFolder`
        );
        return;
      }
      const { presets, envFromFiles, combined, filtered, allowed, config } =
        getConfiguredEnvironment(folder);

      if (Object.keys(combined).length === 0) {
        vscode.window.showInformationMessage(
          `Environ: no environment variables configured for ${folder.name}`
        );
        return;
      }

      const envPaths = findEnvFilesUpwards(folder.uri.fsPath);

      const mergeStrategies = config.get<MergeStrategies>(
        "mergeStrategies",
        DEFAULT_MERGE_STRATEGIES
      );

      let message = `# Workspace: environ\n\n**Environment Files Found:**\n\n`;
      if (envPaths.length === 0) {
        message += `- None\n`;
      } else {
        envPaths.forEach((path) => {
          message += `- ${path}\n`;
        });
      }

      message += `\n**Preset Variables:** ${Object.keys(presets).length}\n`;
      message += `**Variables From Environment Files:** ${
        Object.keys(envFromFiles).length
      }\n`;
      message += `**Combined Variables:** ${Object.keys(combined).length}\n`;
      message += `**Filtered Variables:** ${Object.keys(filtered).length}\n`;

      if (allowed && allowed.length > 0) {
        message += `\n**Variable Filter Active:** ${allowed.join(", ")}\n`;
      } else {
        message += `\n**Variable Filter:** None (all variables allowed)\n`;
      }

      message += `\n**Variable Merge Strategies:**\n\n`;
      if (Object.keys(mergeStrategies).length > 0) {
        Object.entries(mergeStrategies).forEach(([varName, strategy]) => {
          message += `- ${varName}: ${strategy}\n`;
        });
        message += `- (default for unlisted variables): replace\n`;
      } else {
        message += `- All variables: replace (default)\n`;
      }

      message += `\n**Available Variables:**\n\n`;
      Object.entries(filtered).forEach(([key, value]) => {
        const strategy = mergeStrategies[key] || "replace";
        message += `- (${strategy}) ${key}=${value}\n`;
      });

      // Show in a new untitled document for better readability
      const doc = await vscode.workspace.openTextDocument({
        content: message,
        language: "markdown",
      });
      await vscode.window.showTextDocument(doc);
    })
  );

  // Command to manually refresh environment variable collection
  context.subscriptions.push(
    vscode.commands.registerCommand("environ.refreshEnvironment", async () => {
      updateEnvironmentVariableCollection();
      vscode.window.showInformationMessage(
        "Environ: Environment variable collection refreshed. Restart terminals/tasks to apply."
      );
    })
  );

  // Command to configure environment file name
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "environ.configureEnvFileName",
      async () => {
        const config = vscode.workspace.getConfiguration("environ");
        const currentFileName = getEnvFileName();

        const commonOptions = [
          ".env",
          ".env.local",
          ".env.development",
          ".env.production",
          ".env.test",
          ".env.staging",
        ];

        // Create quick pick items with the current selection highlighted
        const quickPickItems = commonOptions.map((option) => ({
          label: option,
          description: option === currentFileName ? "(current)" : "",
          picked: option === currentFileName,
        }));

        // Add custom option
        quickPickItems.push({
          label: "$(edit) Custom...",
          description: "Enter a custom file name",
          picked: false,
        });

        const selection = await vscode.window.showQuickPick(quickPickItems, {
          placeHolder: `Current: ${currentFileName}. Select environment file name to search for`,
          canPickMany: false,
        });

        if (!selection) {
          return;
        }

        let newFileName: string;

        if (selection.label === "$(edit) Custom...") {
          const customName = await vscode.window.showInputBox({
            prompt: "Enter custom environment file name",
            value: currentFileName,
            validateInput: (value) => {
              if (!value || value.trim() === "") {
                return "File name cannot be empty";
              }
              if (value.includes("/") || value.includes("\\")) {
                return "File name cannot contain path separators";
              }
              return null;
            },
          });

          if (!customName) {
            return;
          }

          newFileName = customName.trim();
        } else {
          newFileName = selection.label;
        }

        // Update the configuration
        await config.update(
          "envFileName",
          newFileName,
          vscode.ConfigurationTarget.Workspace
        );

        // Refresh environment variables with new file name
        updateEnvironmentVariableCollection();

        vscode.window.showInformationMessage(
          `Environ: Environment file name changed to '${newFileName}'. Environment variables refreshed.`
        );
      }
    )
  );

  // Command: configure variable filter
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "environ.configureVariableFilter",
      async () => {
        let folder = await pickWorkspaceFolder();
        if (!folder) {
          vscode.window.showInformationMessage(
            `Environ: Can't ensure the workspaceFolder`
          );
          return;
        }

        const { combined, allowed } = getConfiguredEnvironment(folder);

        const keys = Object.keys(combined).sort();
        if (keys.length === 0) {
          vscode.window.showInformationMessage(
            `Environ: no variables found for ${folder.name}`
          );
          return;
        }

        const preselected = allowed ?? keys;

        const picks = await vscode.window.showQuickPick(
          keys.map((k) => ({ label: k, picked: preselected.includes(k) })),
          {
            canPickMany: true,
            placeHolder:
              "Select variables to apply for this workspace folder (space to toggle)",
          }
        );

        if (picks === undefined) {
          return;
        }

        const selectedKeys = picks.map((p) => p.label);
        await setAllowedForFolder(folder, selectedKeys);

        // Update environment variable collection
        updateEnvironmentVariableCollection();

        vscode.window.showInformationMessage(
          `Environ: saved ${selectedKeys.length} selected variables for ${folder.name}. Restart terminals/tasks to apply.`
        );
      }
    )
  );

  // Commands

  context.subscriptions.push(
    vscode.commands.registerCommand("environ.applyToTerminal", async () => {
      const wsFolders = vscode.workspace.workspaceFolders ?? [];
      if (wsFolders.length === 0) {
        vscode.window.showInformationMessage(
          "Environ: no workspace folder open."
        );
        return;
      }
      for (const folder of wsFolders) {
        const { filtered } = getConfiguredEnvironment(folder);
        if (Object.keys(filtered).length === 0) {
          continue;
        }
        try {
          await applyToTerminalSettings(
            filtered,
            vscode.ConfigurationTarget.Workspace,
            folder
          );
          vscode.window.showInformationMessage(
            `Environ: applied .env to terminal settings for ${folder.name}.`
          );
        } catch (err) {
          vscode.window.showErrorMessage(
            `Environ: failed to apply terminal settings for ${
              folder.name
            }: ${String(err)}`
          );
        }
      }
    })
  );

  // Command to open extension settings
  context.subscriptions.push(
    vscode.commands.registerCommand("environ.openSettings", async () => {
      // Open the settings UI filtered to this extension
      // Use the extension ID from the context instead of hardcoding it
      const extensionId = context.extension.id;
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `@ext:${extensionId}`
      );
    })
  );

  // File watcher for .env changes in workspace folder and parent directories
  if (vscode.workspace.workspaceFolders) {
    for (const folder of vscode.workspace.workspaceFolders) {
      // Get all parent directories to watch for .env files
      const allParentDirs = getParentDirectories(folder.uri.fsPath);

      // Get configured env file name
      const envFileName = getEnvFileName();
      console.log(
        `Environ: Watching for ${envFileName} files in ${allParentDirs.length} directories (${folder.name} and all parents)`
      );

      // Watch for .env files in all parent directories (not just existing ones)
      for (const dirPath of allParentDirs) {
        const reapplyEnvironmentVariables = async () => {
          updateEnvironmentVariableCollection();

          const choice = await vscode.window.showInformationMessage(
            `Environ: detected changes in ${envFileName} file. Environment variables updated. Reload workspace to ensure all features work correctly?`,
            {
              title: "Reopen Workspace",
              action: "reopen",
            },
            {
              title: "Not Now",
              action: "dismiss",
            }
          );

          if (choice?.action === "reopen") {
            vscode.commands.executeCommand("vscode.openFolder", folder.uri);
          }
        };
        try {
          for (const envPattern of [
            new vscode.RelativePattern(dirPath, `.vscode/${envFileName}`),
            new vscode.RelativePattern(dirPath, envFileName),
          ]) {
            const watcher =
              vscode.workspace.createFileSystemWatcher(envPattern);

            context.subscriptions.push(
              watcher.onDidChange(reapplyEnvironmentVariables)
            );
            context.subscriptions.push(
              watcher.onDidCreate(reapplyEnvironmentVariables)
            );
            context.subscriptions.push(
              watcher.onDidDelete(reapplyEnvironmentVariables)
            );
          }
        } catch (err) {
          console.error("Environ: failed to create watcher for", dirPath, err);
        }
      }
    }
  }

  console.log("Environ: activated");
}

export function deactivate() {
  console.log("Environ: deactivating");
}
