import { ServerUtils } from "@dendronhq/api-server";
import {
  CONSTANTS,
  DendronError,
  DEngineClient,
  DNodeUtils,
  DVault,
  getStage,
  InstallStatus,
  NoteAddBehavior,
  NoteProps,
  NoteUtils,
  Point,
  Position,
  SchemaModuleProps,
  Time,
  VaultUtils,
} from "@dendronhq/common-all";
import {
  goUpTo,
  resolveTilde,
  tmpDir,
  vault2Path,
} from "@dendronhq/common-server";
import { HistoryEvent, HistoryService } from "@dendronhq/engine-server";
import { ExecaChildProcess } from "execa";
import _ from "lodash";
import _md from "markdown-it";
import ogs from "open-graph-scraper";
import os from "os";
import path from "path";
import * as vscode from "vscode";
import { CancellationTokenSource } from "vscode-languageclient";
import { PickerUtilsV2 } from "./components/lookup/utils";
import {
  DendronContext,
  GLOBAL_STATE,
  _noteAddBehaviorEnum,
} from "./constants";
import { FileItem } from "./external/fileutils/FileItem";
import { Logger } from "./logger";
import { EngineAPIService } from "./services/EngineAPIService";
import { DendronWorkspace, getWS } from "./workspace";

export class DisposableStore {
  private _toDispose = new Set<vscode.Disposable>();

  public add(dis: vscode.Disposable) {
    this._toDispose.add(dis);
  }

  public dispose() {
    // eslint-disable-next-line no-restricted-syntax
    for (const disposable of this._toDispose) {
      disposable.dispose();
    }
  }
}

// === File FUtils
// @DEPRECATE, use src/files.ts#resolvePath
export function resolvePath(filePath: string, wsRoot?: string): string {
  const platform = os.platform();

  const isWin = platform === "win32";
  if (filePath[0] === "~") {
    return resolveTilde(filePath);
  } else if (
    path.isAbsolute(filePath) ||
    (isWin && filePath.startsWith("\\"))
  ) {
    return filePath;
  } else {
    if (!wsRoot) {
      throw Error("can't use rel path without a workspace root set");
    }
    return path.join(wsRoot, filePath);
  }
}

export function getPlatform() {
  return process.platform;
}

export class FileUtils {
  static escape(fpath: string) {
    return fpath.replace(/(\s+)/g, "\\$1");
  }
}

// NOTE: used for tests
let _MOCK_CONTEXT: undefined | vscode.ExtensionContext;

type CreateFnameOverrides = {
  domain?: string;
};

type CreateFnameOpts = {
  overrides?: CreateFnameOverrides;
};

type PointOffset = { line?: number; column?: number };

type AddBehavior =
  | "childOfDomain"
  | "childOfCurrent"
  | "asOwnDomain"
  | "childOfDomainNamespace";

export class VSCodeUtils {
  static closeCurrentFileEditor() {
    return vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  }

  static closeAllEditors() {
    return vscode.commands.executeCommand("workbench.action.closeAllEditors");
  }

  static createCancelSource(existingSource?: CancellationTokenSource) {
    const tokenSource = new CancellationTokenSource();
    if (existingSource) {
      existingSource.cancel();
      existingSource.dispose();
    }
    return tokenSource;
  }

  static createQuickPick = vscode.window.createQuickPick;

  static extractRangeFromActiveEditor = async (
    documentParam?: vscode.TextDocument,
    rangeParam?: vscode.Range
  ) => {
    const document = documentParam || vscode.window.activeTextEditor?.document;

    if (!document || (document && document.languageId !== "markdown")) {
      return;
    }

    const range = rangeParam || vscode.window.activeTextEditor?.selection;

    if (!range || (range && range.isEmpty)) {
      return;
    }
    return { document, range };
  };

  static deleteRange = async (
    document: vscode.TextDocument,
    range: vscode.Range
  ) => {
    const editor = await vscode.window.showTextDocument(document);
    await editor.edit((edit) => edit.delete(range));
  };

  static getActiveTextEditor() {
    return vscode.window.activeTextEditor;
  }

  static getActiveTextEditorOrThrow() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new DendronError({ message: "no active editor" });
    }
    return editor;
  }

  static getFsPathFromTextEditor(editor: vscode.TextEditor) {
    return editor.document.uri.fsPath;
  }

  /**
   * Check if we upgraded, initialized for the first time or no change was detected
   * @returns {@link InstallStatus}
   */
  static getInstallStatusForWorkspace({
    previousWorkspaceVersion,
    currentVersion,
  }: {
    previousWorkspaceVersion?: string;
    currentVersion: string;
  }): InstallStatus {
    if (
      _.isUndefined(previousWorkspaceVersion) ||
      previousWorkspaceVersion === CONSTANTS.DENDRON_INIT_VERSION
    ) {
      return InstallStatus.INITIAL_INSTALL;
    }
    if (previousWorkspaceVersion !== currentVersion) {
      return InstallStatus.UPGRADED;
    }
    return InstallStatus.NO_CHANGE;
  }

  static getInstallStatusForExtension({
    previousGlobalVersion,
    currentVersion,
  }: {
    previousGlobalVersion?: string;
    currentVersion: string;
  }): InstallStatus {
    if (
      _.isUndefined(previousGlobalVersion) ||
      previousGlobalVersion === CONSTANTS.DENDRON_INIT_VERSION
    ) {
      return InstallStatus.INITIAL_INSTALL;
    }
    if (previousGlobalVersion !== currentVersion) {
      return InstallStatus.UPGRADED;
    }
    return InstallStatus.NO_CHANGE;
  }

  static getSelection():
    | { text: undefined; selection: undefined; editor: undefined }
    | { text: string; selection: vscode.Selection; editor: vscode.TextEditor } {
    const editor = vscode.window.activeTextEditor;
    if (_.isUndefined(editor))
      return { text: undefined, selection: undefined, editor: undefined };
    const selection = editor.selection;
    const text = editor.document.getText(selection);
    return { text, selection, editor };
  }

  static createWSContext(): vscode.ExtensionContext {
    const pkgRoot = goUpTo({ base: __dirname, fname: "package.json" });
    return {
      extensionMode: vscode.ExtensionMode.Development,
      logPath: tmpDir().name,
      subscriptions: [] as any[],
      extensionPath: pkgRoot,
      globalState: VSCodeUtils.createMockState({
        [GLOBAL_STATE.VERSION]: "0.0.1",
      }),
      workspaceState: VSCodeUtils.createMockState({}),
      extensionUri: vscode.Uri.file(pkgRoot),
      environmentVariableCollection: {} as any,
      storagePath: tmpDir().name,
      globalStoragePath: tmpDir().name,
      asAbsolutePath: {} as any, //vscode.Uri.file(wsPath)
    } as unknown as vscode.ExtensionContext;
  }

  static getOrCreateMockContext(): vscode.ExtensionContext {
    if (!_MOCK_CONTEXT) {
      const pkgRoot = goUpTo({ base: __dirname, fname: "package.json" });
      _MOCK_CONTEXT = {
        extensionMode: vscode.ExtensionMode.Development,
        logPath: tmpDir().name,
        subscriptions: [],
        extensionPath: pkgRoot,
        globalState: VSCodeUtils.createMockState({
          [GLOBAL_STATE.VERSION]: "0.0.1",
        }),
        workspaceState: VSCodeUtils.createMockState({}),
        extensionUri: vscode.Uri.file(pkgRoot),
        environmentVariableCollection: {} as any,
        storagePath: tmpDir().name,
        globalStoragePath: tmpDir().name,
        asAbsolutePath: {} as any, //vscode.Uri.file(wsPath)
      } as unknown as vscode.ExtensionContext;
    }
    return _MOCK_CONTEXT;
  }

  static getNoteFromDocument(document: vscode.TextDocument) {
    const engine = getWS().getEngine();
    const txtPath = document.uri.fsPath;
    const wsRoot = DendronWorkspace.wsRoot();
    const fname = path.basename(txtPath, ".md");
    let vault: DVault;
    try {
      vault = VSCodeUtils.getVaultFromDocument(document);
    } catch (err) {
      // No vault
      return undefined;
    }
    return NoteUtils.getNoteByFnameV5({
      fname,
      vault,
      wsRoot,
      notes: engine.notes,
    });
  }

  static getVaultFromDocument(document: vscode.TextDocument) {
    const txtPath = document.uri.fsPath;
    const wsRoot = DendronWorkspace.wsRoot();
    const vault = VaultUtils.getVaultByNotePath({
      wsRoot,
      vaults: getWS().getEngine().vaults,
      fsPath: txtPath,
    });
    return vault;
  }

  static createMockState(settings: any): vscode.WorkspaceConfiguration {
    const _settings = settings;
    return {
      get: (_key: string) => {
        return _settings[_key];
      },
      update: async (_key: string, _value: any) => {
        _settings[_key] = _value;
        return;
      },
      has: (key: string) => {
        return key in _settings;
      },
      inspect: (_section: string) => {
        return _settings;
      },
    };
  }

  static createWSFolder(root: string): vscode.WorkspaceFolder {
    const uri = vscode.Uri.file(root);
    return {
      index: 0,
      uri,
      name: path.basename(root),
    };
  }

  /**
   * URI.joinPath currentl'y doesn't work in theia
   * @param uri
   * @param path
   */
  static joinPath(uri: vscode.Uri, ...fpath: string[]) {
    return vscode.Uri.file(path.join(uri.fsPath, ...fpath));
  }

  static async openNoteByPath({
    vault,
    fname,
  }: {
    vault: DVault;
    fname: string;
  }) {
    const vpath = vault2Path({ vault, wsRoot: DendronWorkspace.wsRoot() });
    const notePath = path.join(vpath, `${fname}.md`);
    const editor = await VSCodeUtils.openFileInEditor(
      vscode.Uri.file(notePath)
    );
    return editor as vscode.TextEditor;
  }

  static async openNote(note: NoteProps) {
    const { vault, fname } = note;
    const wsRoot = DendronWorkspace.wsRoot();
    const vpath = vault2Path({ vault, wsRoot });
    const notePath = path.join(vpath, `${fname}.md`);
    const editor = await VSCodeUtils.openFileInEditor(
      vscode.Uri.file(notePath)
    );
    return editor as vscode.TextEditor;
  }

  static async openFileInEditor(
    fileItemOrURI: FileItem | vscode.Uri,
    opts?: Partial<{
      column: vscode.ViewColumn;
    }>
  ): Promise<vscode.TextEditor | undefined> {
    let textDocument;
    if (fileItemOrURI instanceof FileItem) {
      if (fileItemOrURI.isDir) {
        return;
      }

      textDocument = await vscode.workspace.openTextDocument(
        fileItemOrURI.path
      );
    } else {
      textDocument = await vscode.workspace.openTextDocument(fileItemOrURI);
    }

    if (!textDocument) {
      throw new Error("Could not open file!");
    }

    const col = opts?.column || vscode.ViewColumn.Active;

    const editor = await vscode.window.showTextDocument(textDocument, col);
    if (!editor) {
      throw new Error("Could not show document!");
    }

    return editor;
  }

  static openLink(link: string) {
    vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(link));
  }

  static async openWS(wsFile: string) {
    return vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(wsFile)
    );
  }

  static async reloadWindow() {
    if (getStage() !== "test") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  }

  static async gatherFolderPath(opts?: {
    default: string;
  }): Promise<string | undefined> {
    const folderPath = await vscode.window.showInputBox({
      prompt: "Select path to folder",
      ignoreFocusOut: true,
      value: opts?.default,
      validateInput: (input: string) => {
        if (!path.isAbsolute(input)) {
          if (input[0] !== "~") {
            return "must enter absolute path";
          }
        }
        return undefined;
      },
    });
    if (_.isUndefined(folderPath)) {
      return;
    }
    return resolvePath(folderPath);
  }

  static isDevMode(): boolean {
    // HACK: vscode does not save env variables btw workspaces
    return !!process.env.VSCODE_DEBUGGING_EXTENSION;
  }

  static setContext(key: DendronContext, status: boolean) {
    vscode.commands.executeCommand("setContext", key, status);
  }

  static showInputBox = vscode.window.showInputBox;
  static showQuickPick = vscode.window.showQuickPick;
  static showWebView = (opts: {
    title: string;
    content: string;
    rawHTML?: boolean;
  }) => {
    const { title, content, rawHTML } = opts;
    const panel = vscode.window.createWebviewPanel(
      _.kebabCase(title),
      title, // Title of the panel displayed to the user
      vscode.ViewColumn.One, // Editor column to show the new webview panel in.
      {} // Webview options. More on these later.
    );
    panel.webview.html = rawHTML ? content : _md().render(content);
  };

  /** Convert a `Point` from a parsed remark node to a `vscode.Poisition`
   *
   * @param point The point to convert.
   * @param offset When converting the point, shift it by this much.
   * @returns The converted Position, shifted by `offset` if provided.
   */
  static point2VSCodePosition(point: Point, offset?: PointOffset) {
    return new vscode.Position(
      // remark Point's are 0 indexed
      point.line - 1 + (offset?.line || 0),
      point.column - 1 + (offset?.column || 0)
    );
  }

  /** Convert a `Position` from a parsed remark node to a `vscode.Range`
   *
   * @param position The position to convert.
   * @returns The converted Range.
   */
  static position2VSCodeRange(position: Position, offset?: PointOffset) {
    return new vscode.Range(
      // remark Point's are 0 indexed
      this.point2VSCodePosition(position.start, offset),
      this.point2VSCodePosition(position.end, offset)
    );
  }

  /** Fold the foldable region at the given line for the active editor.
   *
   * This is equivalent to selecting that point, and using the "Fold" command in the editor.
   */
  static foldActiveEditorAtPosition(opts: { line?: number; levels?: number }) {
    return vscode.commands.executeCommand("editor.fold", {
      selectionLines: [opts.line],
      levels: opts.levels,
    });
  }

  static getCodeUserConfigDir() {
    const CODE_RELEASE_MAP = {
      VSCodium: "VSCodium",
      "Visual Studio Code - Insiders": "Code - Insiders",
    };
    const vscodeRelease = vscode.env.appName;
    const name = _.get(CODE_RELEASE_MAP, vscodeRelease, "Code");

    const osName = os.type();
    let delimiter = "/";
    let userConfigDir;
  
    switch (osName) {
      case "Darwin": {
        userConfigDir =
          process.env.HOME + "/Library/Application Support/" + name + "/User/";
        break;
      }
      case "Linux": {
        userConfigDir = process.env.HOME + "/.config/" + name + "/User/";
        break;
      }
      case "Windows_NT": {
        userConfigDir = process.env.APPDATA + "\\" + name + "\\User\\";
        delimiter = "\\";
        break;
      }
      default: {
        userConfigDir = process.env.HOME + "/.config/" + name + "/User/";
        break;
      }
    }
    // return [userConfigDir, delimiter, osName];
    return {
      userConfigDir,
      delimiter,
      osName
    }
  }

  static isExtensionInstalled(extensionId: string) {
    return !_.isUndefined(
      vscode.extensions.getExtension(extensionId)
    );
  }
}

export class WSUtils {
  static handleServerProcess({
    subprocess,
    context,
    onExit,
  }: {
    subprocess: ExecaChildProcess;
    context: vscode.ExtensionContext;
    onExit: Parameters<typeof ServerUtils["onProcessExit"]>[0]["cb"];
  }) {
    const ctx = "WSUtils.handleServerProcess";
    Logger.info({ ctx, msg: "subprocess running", pid: subprocess.pid });
    // if extension closes, reap server process
    context.subscriptions.push(
      new vscode.Disposable(() => {
        Logger.info({ ctx, msg: "kill server start" });
        process.kill(subprocess.pid);
        Logger.info({ ctx, msg: "kill server end" });
      })
    );
    // if server process has issues, prompt user to restart
    ServerUtils.onProcessExit({
      subprocess,
      cb: onExit,
    });
  }

  static showInitProgress() {
    const ctx = "showInitProgress";
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Starting Dendron...",
        cancellable: true,
      },
      (_progress, _token) => {
        _token.onCancellationRequested(() => {
          console.log("Cancelled");
        });

        const p = new Promise((resolve) => {
          HistoryService.instance().subscribe(
            "extension",
            async (_event: HistoryEvent) => {
              if (_event.action === "initialized") {
                resolve(undefined);
              }
            }
          );
          HistoryService.instance().subscribe(
            "extension",
            async (_event: HistoryEvent) => {
              if (_event.action === "not_initialized") {
                Logger.error({ ctx, msg: "issue initializing Dendron" });
                resolve(undefined);
              }
            }
          );
        });
        return p;
      }
    );
  }

  static updateEngineAPI(port: number | string): DEngineClient {
    const ws = DendronWorkspace.instance();
    const svc = EngineAPIService.createEngine({
      port,
      enableWorkspaceTrust: vscode.workspace.isTrusted,
    });
    ws.setEngine(svc);
    ws.port = _.toInteger(port);
    const engine = ws.getEngine();
    return engine;
  }
}

export class DendronClientUtilsV2 {
  static genNotePrefix(
    fname: string,
    addBehavior: AddBehavior,
    opts: { engine: DEngineClient }
  ) {
    let out: string;
    switch (addBehavior) {
      case "childOfDomain": {
        out = DNodeUtils.domainName(fname);
        break;
      }
      case "childOfDomainNamespace": {
        out = DNodeUtils.domainName(fname);
        const vault = PickerUtilsV2.getOrPromptVaultForOpenEditor();
        const domain = NoteUtils.getNoteByFnameV5({
          fname,
          notes: opts.engine.notes,
          vault,
          wsRoot: DendronWorkspace.wsRoot(),
        });
        if (domain && domain.schema) {
          const smod = opts.engine.schemas[domain.schema.moduleId];
          const schema = smod.schemas[domain.schema.schemaId];
          if (schema && schema.data.namespace) {
            out = NoteUtils.getPathUpTo(fname, 2);
          }
        }
        break;
      }
      case "childOfCurrent": {
        out = fname;
        break;
      }
      case "asOwnDomain": {
        out = "";
        break;
      }
      default: {
        throw Error(`unknown add Behavior: ${addBehavior}`);
      }
    }
    return out;
  }

  /**
   * Generates a file name for a journal or scratch note. Must be derived by an
   * open note, or passed as an option.
   * @param type 'JOURNAL' | 'SCRATCH'
   * @param opts Options to control how the note will be named
   * @returns The file name of the new note
   */
  static genNoteName(
    type: "JOURNAL" | "SCRATCH",
    opts?: CreateFnameOpts
  ): {
    noteName: string;
    prefix: string;
  } {
    // gather inputs
    const dateFormat: string =
      type === "SCRATCH"
        ? DendronWorkspace.instance().getWorkspaceSettingOrDefault({
            wsConfigKey: "dendron.defaultScratchDateFormat",
            dendronConfigKey: "scratch.dateFormat",
          })
        : getWS().config.journal.dateFormat;

    const addBehavior: NoteAddBehavior =
      type === "SCRATCH"
        ? DendronWorkspace.instance().getWorkspaceSettingOrDefault({
            wsConfigKey: "dendron.defaultScratchAddBehavior",
            dendronConfigKey: "scratch.addBehavior",
          })
        : getWS().config.journal.addBehavior;

    const name: string =
      type === "SCRATCH"
        ? DendronWorkspace.instance().getWorkspaceSettingOrDefault({
            wsConfigKey: "dendron.defaultScratchName",
            dendronConfigKey: "scratch.name",
          })
        : getWS().config.journal.name;

    if (!_.includes(_noteAddBehaviorEnum, addBehavior)) {
      const actual = addBehavior;
      const choices = Object.keys(NoteAddBehavior).join(", ");
      throw Error(`${actual} must be one of: ${choices}`);
    }

    const editorPath = vscode.window.activeTextEditor?.document.uri.fsPath;
    const currentNoteFname =
      opts?.overrides?.domain ||
      (editorPath ? path.basename(editorPath, ".md") : undefined);
    if (!currentNoteFname) {
      throw Error("Must be run from within a note");
    }

    const engine = DendronWorkspace.instance().getEngine();
    const prefix = DendronClientUtilsV2.genNotePrefix(
      currentNoteFname,
      addBehavior as AddBehavior,
      {
        engine,
      }
    );

    const noteDate = Time.now().toFormat(dateFormat);
    const noteName = [prefix, name, noteDate]
      .filter((ent) => !_.isEmpty(ent))
      .join(".");
    return { noteName, prefix };
  }

  static getSchemaModByFname = async ({
    fname,
    client,
  }: {
    fname: string;
    client: DEngineClient;
  }): Promise<SchemaModuleProps> => {
    const smod = _.find(client.schemas, { fname });
    if (!smod) {
      throw new DendronError({ message: "no note found" });
    }
    return smod;
  };

  static shouldUseVaultPrefix(engine: DEngineClient) {
    const noXVaultLink = getWS().config.noXVaultWikiLink;
    const useVaultPrefix =
      _.size(engine.vaults) > 1 &&
      (_.isBoolean(noXVaultLink) ? !noXVaultLink : true);
    return useVaultPrefix;
  }
}

export const clipboard = vscode.env.clipboard;

// This layer of indirection is only here enable stubbing a top level function that's the default export of a module // https://github.com/sinonjs/sinon/issues/562#issuecomment-399090111
// Otherwise, we can't mock it for testing.
export const getOpenGraphMetadata = (opts: ogs.Options) => {
  return ogs(opts);
};
