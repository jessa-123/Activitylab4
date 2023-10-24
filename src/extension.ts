import * as vscode from "vscode";

import actions from "./actions";
import { config } from "./config";
import { EXT_ID } from "./constants";
import { eventBus } from "./eventBus";
import { LogLevel, createLogger, logger as rootLogger } from "./logger";
import { MainController } from "./main_controller";
import { VSCodeContext, disposeAll } from "./utils";

const logger = createLogger(EXT_ID);

let restartCommandDisposable: vscode.Disposable | undefined = undefined;

export async function activate(context: vscode.ExtensionContext, isRestart = false): Promise<void> {
    if (!isRestart) verifyExperimentalAffinity();

    config.init();
    rootLogger.init(LogLevel[config.logLevel], config.logPath, config.outputToConsole);
    eventBus.init();
    actions.init();
    context.subscriptions.push(config, rootLogger, eventBus, actions);

    try {
        const plugin = new MainController(context.extensionPath.replace(/\\/g, "\\\\"));
        context.subscriptions.push(plugin);
        await plugin.init();
    } catch (e) {
        vscode.window.showErrorMessage(`Unable to init vscode-neovim: ${(e as Error).message}`);
    }

    if (!isRestart) {
        restartCommandDisposable = vscode.commands.registerCommand("vscode-neovim.restart", async () => {
            deactivate(true);
            disposeAll(context.subscriptions);
            await activate(context, true);
        });
    }
    context.subscriptions.push(
        vscode.commands.registerCommand("vscode-neovim.stop", () => disposeAll(context.subscriptions)),
    );
}

export function deactivate(isRestart = false) {
    // Reset all when clause contexts that impact the keybindings
    VSCodeContext.set("neovim.init");
    VSCodeContext.set("neovim.mode");
    VSCodeContext.set("neovim.recording");
    if (!isRestart) restartCommandDisposable?.dispose();
}

async function verifyExperimentalAffinity(): Promise<void> {
    const extensionsConfiguration = vscode.workspace.getConfiguration("extensions");
    const affinityConfiguration = extensionsConfiguration.inspect<{ [key: string]: [number] }>("experimental.affinity");

    const affinityConfigWorkspaceValue = affinityConfiguration?.workspaceValue;
    if (affinityConfigWorkspaceValue && EXT_ID in affinityConfigWorkspaceValue) {
        logger.debug(`Extension affinity value ${affinityConfigWorkspaceValue[EXT_ID]} found in Workspace settings`);
        return;
    }

    const affinityConfigGlobalValue = affinityConfiguration?.globalValue;
    if (affinityConfigGlobalValue && EXT_ID in affinityConfigGlobalValue) {
        logger.debug(`Extension affinity value ${affinityConfigGlobalValue[EXT_ID]} found in User settings`);
        return;
    }

    logger.debug("Extension affinity value not set in User and Workspace settings");

    const defaultAffinity = 1;

    const setAffinity = (value: number): void => {
        logger.debug(`Setting extension affinity value to ${value} in User settings`);
        extensionsConfiguration
            .update("experimental.affinity", { ...affinityConfigGlobalValue, [EXT_ID]: value }, true)
            .then(
                () => {
                    logger.debug(`Successfull set extension affinity value to ${value} in User settings`);
                },
                (error) => {
                    logger.error(`Error while setting experimental affinity. ${error}`);
                },
            );
    };

    vscode.window
        .showWarningMessage(
            "No affinity assigned to vscode-neovim. It is recommended to assign affinity for major performance improvements. Would you like to set default affinity? [Learn more](https://github.com/vscode-neovim/vscode-neovim#affinity)",
            "Yes",
            "Cancel",
        )
        .then((value) => {
            if (value == "Yes") {
                setAffinity(defaultAffinity);
                vscode.window
                    .showInformationMessage(
                        "Requires restart of extension host for changes to take effect. This restarts all extensions.",
                        "Restart",
                    )
                    .then((value) => {
                        if (value == "Restart") {
                            vscode.commands.executeCommand("workbench.action.restartExtensionHost");
                        }
                    });
            }
        });
}
