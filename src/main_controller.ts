import { ChildProcess, spawn } from "child_process";
import path from "path";
import { readFileSync } from "fs";

import { attach, findNvim, NeovimClient } from "neovim";
import vscode, { Disposable, Range, window, workspace, type ExtensionContext } from "vscode";
// eslint-disable-next-line import/no-extraneous-dependencies
import { transports as loggerTransports, createLogger as winstonCreateLogger } from "winston";

import actions from "./actions";
import { BufferManager } from "./buffer_manager";
import { CommandLineManager } from "./cmdline_manager";
import { CommandsController } from "./commands_controller";
import { config } from "./config";
import { NVIM_MIN_VERSION } from "./constants";
import { CursorManager } from "./cursor_manager";
import { DocumentChangeManager } from "./document_change_manager";
import { eventBus } from "./eventBus";
import { HighlightManager } from "./highlight_manager";
import { createLogger } from "./logger";
import { MessagesManager } from "./messages_manager";
import { ModeManager } from "./mode_manager";
import { StatusLineManager } from "./status_line_manager";
import { TypingManager } from "./typing_manager";
import { disposeAll, findLastEvent, VSCodeContext, wslpath } from "./utils";
import { ViewportManager } from "./viewport_manager";

interface RequestResponse {
    send(resp: unknown, isError?: boolean): void;
}

const logger = createLogger("MainController");

interface VSCodeActionOptions {
    args?: any[];
    range?: Range | [number, number] | [number, number, number, number];
    restore_selection?: boolean;
    callback?: string;
}

export class MainController implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];

    private nvimProc!: ChildProcess;
    public client!: NeovimClient;

    /**
     * Clickable status bar item
     */
    private status!: vscode.StatusBarItem;

    /**
     * Neovim API states that multiple redraw batches could be sent following flush() after last batch
     * Save current batch into temp variable
     */
    private currentRedrawBatch: [string, ...unknown[]][] = [];

    public modeManager!: ModeManager;
    public bufferManager!: BufferManager;
    public changeManager!: DocumentChangeManager;
    public typingManager!: TypingManager;
    public cursorManager!: CursorManager;
    public commandsController!: CommandsController;
    public commandLineManager!: CommandLineManager;
    public statusLineManager!: StatusLineManager;
    public highlightManager!: HighlightManager;
    public messagesManager!: MessagesManager;
    public viewportManager!: ViewportManager;

    public constructor(private extContext: ExtensionContext) {
        // #region Setup status bar item
        const commandId = "vscode-neovim.selectNeovim";
        this.status = vscode.window.createStatusBarItem(
            "vscode-neovim-click-status",
            vscode.StatusBarAlignment.Right,
            100,
        );
        this.status.text = "Nvim";
        this.status.command = commandId;
        this.status.show();
        this.disposables.push(
            this.status,
            vscode.commands.registerCommand(commandId, () => this.selectNeovim()),
        );
        // #endregion
    }

    public async init(outputChannel: vscode.LogOutputChannel): Promise<void> {
        const [cmd, args] = this.buildSpawnArgs();
        logger.info(`starting nvim: ${cmd} ${args.join(" ")}`);
        this.nvimProc = spawn(cmd, args);
        this.disposables.push(
            new Disposable(() => {
                this.nvimProc.removeAllListeners();
                this.nvimProc.kill();
            }),
        );
        const spawnPromise = new Promise<void>((resolve, reject) => {
            this.nvimProc.once("spawn", () => resolve());
            this.nvimProc.once("close", (code, signal) => reject(`Neovim exited: ${code} ${signal}`));
            this.nvimProc.once("error", (err) => reject(`Neovim spawn error: ${err.message}`));
        });
        await spawnPromise;
        this.nvimProc.removeAllListeners();
        this.nvimProc.on("close", (code, signal) => this._stop(`Neovim exited: ${code} ${signal}`));
        this.nvimProc.on("error", (err) => this._stop(`Neovim spawn error: ${err.message}`));

        logger.debug(`Attaching to neovim`);
        this.client = attach({
            proc: this.nvimProc,
            options: {
                logger: winstonCreateLogger({
                    transports: [new loggerTransports.Console()],
                    level: "error",
                    exitOnError: false,
                }),
            },
        });
        this.disposables.push(
            new Disposable(() => {
                this.client.removeAllListeners();
                this.client.quit();
            }),
        );
        this.client.on("disconnect", () => this._stop(`Neovim was disconnected`));
        this.client.on("notification", this.onNeovimNotification);
        this.client.on("request", this.onNeovimRequest);
        this.setClientInfo();
        await this.client.setVar("vscode_channel", await this.client.channelId);
        await this.client.setVar("vscode_nvim_min_version", NVIM_MIN_VERSION);

        // This is an exception. Should avoid doing this.
        Object.defineProperty(actions, "client", { get: () => this.client, configurable: true });

        this.disposables.push(
            vscode.commands.registerCommand("_getNeovimClient", () => this.client),
            vscode.commands.registerCommand("vscode-neovim.lua", async (code: string | string[]) => {
                const luaCode = typeof code === "string" ? code : code.join("\n");
                if (!luaCode.length) {
                    window.showWarningMessage("No lua code provided");
                    return;
                }
                try {
                    await this.client.lua(luaCode);
                } catch (e) {
                    logger.error(e instanceof Error ? e.message : e);
                }
            }),
            (this.modeManager = new ModeManager()),
            (this.typingManager = new TypingManager(this)),
            (this.bufferManager = new BufferManager(this)),
            (this.viewportManager = new ViewportManager(this)),
            (this.cursorManager = new CursorManager(this)),
            (this.commandsController = new CommandsController(this)),
            (this.highlightManager = new HighlightManager(this)),
            (this.changeManager = new DocumentChangeManager(this)),
            (this.commandLineManager = new CommandLineManager(this)),
            (this.statusLineManager = new StatusLineManager(this)),
            (this.messagesManager = new MessagesManager(outputChannel)),
        );

        logger.debug(`UIAttach`);
        // !Attach after setup of notifications, otherwise we can get blocking call and stuck
        await this.client.uiAttach(config.neovimViewportWidth, 100, {
            rgb: true,
            // override: true,
            ext_cmdline: true,
            ext_linegrid: true,
            ext_hlstate: true,
            ext_messages: true,
            ext_multigrid: true,
            ext_popupmenu: true,
            ext_tabline: true,
        });

        await this.bufferManager.forceSyncLayout();

        await VSCodeContext.set("neovim.init", true);
        await this.logNvimInfo(); // Do this _after_ UIAttach.
        await this.validateNvimRuntime();
        logger.debug(`Init completed`);
    }

    private _stop(msg: string) {
        logger.error(msg);
        vscode.commands.executeCommand("vscode-neovim.stop");
        vscode.window.showErrorMessage(msg, "Restart").then((value) => {
            if (value == "Restart") vscode.commands.executeCommand("vscode-neovim.restart");
        });
    }

    private buildSpawnArgs(): [string, string[]] {
        let extensionPath = this.extContext.extensionPath.replace(/\\/g, "\\\\");
        if (config.useWsl) {
            extensionPath = wslpath(extensionPath);
        }

        // These paths get called inside WSL, they must be POSIX paths (forward slashes)
        const neovimPreScriptPath = path.posix.join(extensionPath, "vim", "vscode-neovim.vim");

        const args = [];

        if (config.useWsl) {
            args.push("C:\\Windows\\system32\\wsl.exe");
            if (config.wslDistribution.length) {
                args.push("-d", config.wslDistribution);
            }
        }

        const neovimPath = this.getNeovimPath();
        this.status.tooltip = neovimPath;

        args.push(
            neovimPath,
            "-N",
            "--embed",
            // Initialize vscode neovim modules
            "--cmd",
            `source ${neovimPreScriptPath}`,
        );

        const workspaceFolder = vscode.workspace.workspaceFolders;
        const cwd = workspaceFolder?.length ? workspaceFolder[0].uri.fsPath : undefined;
        if (cwd && !vscode.env.remoteName) {
            args.push("-c", `cd ${config.useWsl ? wslpath(cwd) : cwd}`);
        }

        if (parseInt(process.env.NEOVIM_DEBUG || "", 10) === 1) {
            args.push(
                "-u",
                "NONE",
                "--listen",
                `${process.env.NEOVIM_DEBUG_HOST || "127.0.0.1"}:${process.env.NEOVIM_DEBUG_PORT || 4000}`,
            );
        }

        if (config.clean) {
            args.push("--clean");
        }
        // #1162
        if (!config.clean && config.neovimInitPath) {
            args.push("-u", config.neovimInitPath);
        }
        if (config.NVIM_APPNAME) {
            process.env.NVIM_APPNAME = config.NVIM_APPNAME;
            if (config.useWsl) {
                /*
                 * `/u` flag indicates the value should only be included when invoking WSL from Win32.
                 * https://devblogs.microsoft.com/commandline/share-environment-vars-between-wsl-and-windows/#u
                 */
                process.env.WSLENV = "NVIM_APPNAME/u";
            }
        }
        return [args[0], args.slice(1)];
    }

    private get neovimCachePath(): vscode.Uri {
        return vscode.Uri.joinPath(this.extContext.globalStorageUri, "neovim_path");
    }

    private getNeovimPath(): string {
        const neovimPath = config.neovimPath;
        // 1. Use the user specified path
        // Not dealing with WSL for now
        if (neovimPath !== "nvim" || config.useWsl) {
            logger.debug("Using user specified neovim path: ", neovimPath);
            return neovimPath;
        }

        // 2. Use cached path if it exists
        let cachedPath: string | undefined;
        try {
            cachedPath = readFileSync(this.neovimCachePath.fsPath).toString().trim();
        } catch {
            //
        }
        if (cachedPath) {
            logger.debug("Using cached neovim path: ", cachedPath);
            return cachedPath;
        }

        // 3. Find a suitable neovim executable
        const nvimResult = findNvim({ minVersion: NVIM_MIN_VERSION });
        logger.debug("Find nvim result: ", nvimResult);
        const matched = nvimResult.matches.find((match) => !match.error);
        if (!matched) {
            throw new Error("Unable to find a suitable neovim executable. Please check your neovim installation.");
        }
        logger.debug("Using found neovim path: ", matched.path);
        return matched.path;
    }

    private selectNeovim() {
        const nvimResult = findNvim({ minVersion: NVIM_MIN_VERSION });
        const matches = nvimResult.matches.filter((match) => !match.error);
        const picker = window.createQuickPick();
        picker.title = "Select Neovim";
        picker.matchOnDescription = true;
        if (typeof this.status.tooltip === "string") {
            picker.placeholder = "Currently using: " + this.status.tooltip;
        }
        picker.items = [
            {
                label: "Use default",
                description: config.neovimPath,
            },
            ...matches.map((match) => ({
                label: match.nvimVersion!,
                description: match.path,
            })),
        ];
        picker.onDidHide(() => picker.dispose());
        picker.onDidAccept(async () => {
            picker.hide();
            const selectedItem = picker.selectedItems[0];
            await workspace.fs.createDirectory(this.extContext.globalStorageUri);
            const neovimCachePath = this.neovimCachePath;
            if (selectedItem.label === "Use default") {
                try {
                    await workspace.fs.delete(neovimCachePath);
                } catch {
                    //
                }
            } else {
                await workspace.fs.writeFile(neovimCachePath, Buffer.from(selectedItem.description!));
            }
            vscode.commands.executeCommand("vscode-neovim.restart");
        });
        picker.show();
    }

    private async runAction(action: string, options: Omit<VSCodeActionOptions, "callback">): Promise<any> {
        const editor = vscode.window.activeTextEditor;
        if (editor) await this.cursorManager.waitForCursorUpdate(editor);
        if (editor && options.range) {
            const doc = editor.document;
            const prevSelections = editor.selections;
            const range = options.range;
            let targetRange: Range;
            if (Array.isArray(range)) {
                if (range.length == 2) {
                    const startLine = Math.max(0, range[0]);
                    const endLine = Math.min(editor.document.lineCount - 1, range[1]);
                    targetRange = new Range(doc.lineAt(startLine).range.start, doc.lineAt(endLine).range.end);
                } else {
                    targetRange = new Range(...range);
                }
            } else {
                targetRange = new Range(range.start.line, range.start.character, range.end.line, range.end.character);
            }
            targetRange = doc.validateRange(targetRange);
            editor.selections = [new vscode.Selection(targetRange.start, targetRange.end)];
            const res = await actions.run(action, ...(options.args || []));
            if (options.restore_selection !== false) {
                editor.selections = prevSelections;
            }
            return res;
        }
        return actions.run(action, ...(options.args || []));
    }

    private onNeovimNotification = async (method: string, events: [string, ...any[]]) => {
        switch (method) {
            case "vscode-action": {
                const action = events[0];
                let options = events[1] as VSCodeActionOptions | [];
                if (Array.isArray(options)) options = {}; // empty lua table

                const callbackId = options.callback;
                if (callbackId) {
                    this.client.handleRequest("vscode-action", events, {
                        send: (resp: any, isError?: boolean): void => {
                            this.client.executeLua('require"vscode.api".invoke_callback(...)', [
                                callbackId,
                                resp,
                                !!isError,
                            ]);
                        },
                    });
                } else {
                    try {
                        await this.runAction(action, options);
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : err;
                        logger.error("Error on notification: ", errMsg);
                    }
                }
                break;
            }
            case "vscode-neovim": {
                const [command, args] = events;
                eventBus.fire(command as any, args);
                break;
            }
            case "redraw": {
                const redrawEvents = events as [string, ...any[]][];
                const hasFlush = findLastEvent("flush", events);
                // nvim will send us a 'flush' event when we should persist the updates to the editor.
                // Until that point, we should disregard all events
                // https://neovim.io/doc/user/ui.html
                if (hasFlush) {
                    const batch = [...this.currentRedrawBatch.splice(0), ...redrawEvents];
                    // Send out the flush events in order. Nvim insists we handle the events in order.
                    // From the nvim UI docs: "Events must be handled in-order. Nvim sends a "flush" event when it has
                    // completed a redraw of the entire screen (so all windows have a consistent view of buffer state, options,
                    // etc.)."
                    //
                    // NOTE: some of the listeners for `redraw` event will kick off asynchronous tasks, which may
                    //       cause out-of-order execution. Ideally, this should be avoided, but it is not always
                    //       possible. At minimum, listeners should ensure that their `redraw` events complete fully
                    //       before they process `flush-redraw`.
                    batch.forEach((batchItem) => {
                        const eventData = {
                            name: batchItem[0],
                            args: batchItem.slice(1),
                        } as any;

                        eventBus.fire("redraw", eventData);
                    });

                    // Events are processed in order, so we will send a flush event
                    // once all the redraws have been sent
                    eventBus.fire("flush-redraw", []);
                } else {
                    this.currentRedrawBatch.push(...redrawEvents);
                }
            }
        }
    };

    private onNeovimRequest = async (
        method: string,
        requestArgs: [string, ...any[]],
        response: RequestResponse,
    ): Promise<void> => {
        switch (method) {
            case "vscode-action": {
                const action = requestArgs[0];
                let options = requestArgs[1] as Omit<VSCodeActionOptions, "callback"> | [];
                if (Array.isArray(options)) options = {}; // empty lua table

                try {
                    const res = await this.runAction(action, options);
                    response.send(res);
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : err;
                    response.send(errMsg, true);
                    logger.error("Request error: ", errMsg);
                }
                break;
            }
        }
    };

    private setClientInfo() {
        const versionString = this.extContext.extension.packageJSON.version as string;
        const [major, minor, patch] = [...versionString.split(".").map((n) => +n), 0, 0, 0];
        this.client.setClientInfo("vscode-neovim", { major, minor, patch }, "embedder", {}, {});
    }

    /** Logs diagnostic info for troubleshooting. */
    private async logNvimInfo() {
        const luaCode = `
            local rv = {
              configDir = vim.fn.stdpath('config'),
              configFile = vim.env.MYVIMRC,
              logFile = vim.env.NVIM_LOG_FILE,
              nvimVersion = vim.fn.api_info().version,
            }
            return rv
        `;
        const nvimInfo = await this.client.executeLua(luaCode, []);
        logger.info("Nvim info:", nvimInfo);
    }

    private async validateNvimRuntime() {
        // WEIRD BUT TRUE: $VIMRUNTIME may be inaccessible even though Nvim itself is runnable! #1815
        const luaCode = `
            local rt = vim.env.VIMRUNTIME
            return { vim.fs.dir(rt)() ~= nil, rt }
        `;
        const ret = await this.client.executeLua(luaCode, []);
        const [ok, runtimeDir] = ret as [boolean, string];
        if (!ok)
            logger.error(
                `Cannot read $VIMRUNTIME directory "${runtimeDir}". Ensure that VSCode has access to that directory. Also try :checkhealth.`,
            );
    }

    dispose() {
        // word
        disposeAll(this.disposables);
    }
}
