import * as vscode from "vscode";
import type { ModWorkspace } from "./workspace";
import {
  detectSdkPathFromRegistry,
  validateSdkPath,
  type SdkValidation,
} from "./sdk";
import { t } from "./localize";

/**
 * Non-intrusive SDK path guidance: a status-bar hint plus a one-time prompt
 * (per session). The prompt prefers a validated registry-detected path, then
 * falls back to a folder picker. Clearing `ra3modxml.sdkPath` explicitly is
 * treated as "intentionally disabled" and never re-prompts.
 */
export class SdkSetup {
  private readonly statusBar: vscode.StatusBarItem;
  private promptAttempted = false;

  constructor(
    context: vscode.ExtensionContext,
    private readonly getWs: () => ModWorkspace | null,
  ) {
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99,
    );
    this.statusBar.name = "RA3 Mod XML SDK";
    this.statusBar.command = "ra3modxml.configureSdkPath";
    context.subscriptions.push(this.statusBar);
    context.subscriptions.push(
      vscode.commands.registerCommand("ra3modxml.configureSdkPath", () => {
        const ws = this.getWs();
        if (!ws) {
          void vscode.window.showInformationMessage(
            t("RA3 Mod XML: open an RA3 mod project first to configure the SDK path."),
          );
          return;
        }
        void this.runSetup();
      }),
    );
  }

  async evaluate(ws: ModWorkspace): Promise<void> {
    if (!ws.isRa3Workspace()) {
      this.statusBar.hide();
      return;
    }
    const config = vscode.workspace.getConfiguration("ra3modxml");
    const raw = config.get<string>("sdkPath", "");
    const explicit = isExplicitlyConfigured(config);
    const validation = validateSdkPath(raw);

    if (validation.status === "ok") {
      this.statusBar.hide();
      return;
    }
    // An explicit empty value means "no SDK, project-only mode" - never nag.
    if (!raw && explicit) {
      this.statusBar.hide();
      return;
    }

    this.statusBar.text = statusBarText(validation);
    this.statusBar.tooltip = describeSdkValidation(validation);
    this.statusBar.show();

    if (!this.promptAttempted) {
      this.promptAttempted = true;
      await this.runSetup();
    }
  }

  private async runSetup(): Promise<void> {
    const detected = await detectSdkPathFromRegistry();
    const detectedValidation = detected ? validateSdkPath(detected) : null;
    if (
      detectedValidation &&
      (detectedValidation.status === "ok" ||
        detectedValidation.status === "partial")
    ) {
      const useDetected = t("Use detected path");
      const chooseManually = t("Choose manually…");
      const notNow = t("Not now");
      const pick = await vscode.window.showWarningMessage(
        t(
          "RA3 Mod XML could not find a valid SDK path. Detected installed SDK: {0}",
          detectedValidation.path,
        ),
        useDetected,
        chooseManually,
        notNow,
      );
      if (pick === useDetected) {
        await applySdkPath(detectedValidation.path);
      } else if (pick === chooseManually) {
        await this.chooseAndApply();
      }
      return;
    }

    const chooseSdkFolder = t("Choose SDK folder…");
    const pick = await vscode.window.showWarningMessage(
      t(
        "RA3 Mod XML needs the RA3 Mod SDK path to enable vanilla data, manifests and cross-file completion/navigation. Without it, the extension runs in project-only mode.",
      ),
      chooseSdkFolder,
      t("Not now"),
    );
    if (pick === chooseSdkFolder) await this.chooseAndApply();
  }

  private async chooseAndApply(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: t("Choose SDK root"),
      title: t(
        "Choose the RA3 Mod SDK root (should contain Schemas/xsd/CnC3Types.xsd)",
      ),
    });
    const dir = picked?.[0]?.fsPath;
    if (!dir) return;
    const validation = validateSdkPath(dir);
    if (validation.status === "missing" || validation.status === "not-sdk") {
      void vscode.window.showErrorMessage(
        t(
          "The selected directory is not a usable RA3 Mod SDK (missing {0}). Please choose again.",
          validation.missing.join(", ") || t("that directory"),
        ),
      );
      return;
    }
    await applySdkPath(validation.path);
  }
}

function statusBarText(validation: SdkValidation): string {
  if (validation.status === "missing") {
    return validation.path
      ? t("$(warning) RA3 XML: SDK path does not exist")
      : t("$(warning) RA3 XML: SDK not configured");
  }
  if (validation.status === "not-sdk") {
    return t("$(warning) RA3 XML: SDK path is invalid");
  }
  return t("$(warning) RA3 XML: SDK is incomplete");
}

function describeSdkValidation(validation: SdkValidation): string {
  if (validation.status === "missing") {
    return validation.path
      ? t(
          "The directory configured in ra3modxml.sdkPath does not exist: {0}. Click to reconfigure, or clear ra3modxml.sdkPath to disable vanilla data features.",
          validation.path,
        )
      : t(
          "RA3 Mod SDK path is not configured. Click to set it, or clear ra3modxml.sdkPath to disable vanilla data features.",
        );
  }
  if (validation.status === "not-sdk") {
    return t(
      "The directory configured in ra3modxml.sdkPath is not an RA3 Mod SDK root (missing Schemas/xsd/CnC3Types.xsd). Click to reconfigure.",
    );
  }
  return t(
    "RA3 Mod SDK is missing: {0}. Manifest / vanilla source / SDK search path features are unavailable.",
    validation.missing.join(", "),
  );
}

function isExplicitlyConfigured(
  config: vscode.WorkspaceConfiguration,
): boolean {
  const info = config.inspect<string>("sdkPath");
  return !!(
    info &&
    (info.globalValue !== undefined ||
      info.workspaceValue !== undefined ||
      info.workspaceFolderValue !== undefined)
  );
}

async function applySdkPath(path: string): Promise<void> {
  await vscode.workspace
    .getConfiguration("ra3modxml")
    .update("sdkPath", path, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    t("RA3 Mod XML: SDK path set to {0}; rebuilding the index…", path),
  );
}
