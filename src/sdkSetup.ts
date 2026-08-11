import * as vscode from "vscode";
import type { ModWorkspace } from "./workspace";
import {
  detectSdkPathFromRegistry,
  validateSdkPath,
  type SdkValidation,
} from "./sdk";

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
            "RA3 Mod XML: 打开 RA3 Mod 项目后即可配置 SDK 路径。",
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
      const pick = await vscode.window.showWarningMessage(
        `RA3 Mod XML 未找到有效的 SDK 路径。检测到已安装的 SDK：${detectedValidation.path}`,
        "使用检测到的路径",
        "手动选择…",
        "暂时不用",
      );
      if (pick === "使用检测到的路径") {
        await applySdkPath(detectedValidation.path);
      } else if (pick === "手动选择…") {
        await this.chooseAndApply();
      }
      return;
    }

    const pick = await vscode.window.showWarningMessage(
      "RA3 Mod XML 需要 RA3 Mod SDK 路径才能启用原版数据、manifest 与跨文件补全/跳转功能。未设置时插件将以项目模式运行。",
      "选择 SDK 文件夹…",
      "暂时不用",
    );
    if (pick === "选择 SDK 文件夹…") await this.chooseAndApply();
  }

  private async chooseAndApply(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "选择 SDK 根目录",
      title: "选择 RA3 Mod SDK 根目录（应包含 Schemas/xsd/CnC3Types.xsd）",
    });
    const dir = picked?.[0]?.fsPath;
    if (!dir) return;
    const validation = validateSdkPath(dir);
    if (validation.status === "missing" || validation.status === "not-sdk") {
      void vscode.window.showErrorMessage(
        `所选目录不是可用的 RA3 Mod SDK（缺少 ${
          validation.missing.join("、") || "该目录"
        }）。请重新选择。`,
      );
      return;
    }
    await applySdkPath(validation.path);
  }
}

function statusBarText(validation: SdkValidation): string {
  if (validation.status === "missing") {
    return validation.path
      ? "$(warning) RA3 XML: SDK 路径不存在"
      : "$(warning) RA3 XML: 未设置 SDK";
  }
  if (validation.status === "not-sdk") return "$(warning) RA3 XML: SDK 路径无效";
  return "$(warning) RA3 XML: SDK 不完整";
}

function describeSdkValidation(validation: SdkValidation): string {
  if (validation.status === "missing") {
    return validation.path
      ? `ra3modxml.sdkPath 指向的目录不存在：${validation.path}。点击重新设置；或将 ra3modxml.sdkPath 清空以禁用原版数据功能。`
      : "未配置 RA3 Mod SDK 路径。点击设置；或将 ra3modxml.sdkPath 清空以禁用原版数据功能。";
  }
  if (validation.status === "not-sdk") {
    return "ra3modxml.sdkPath 指向的目录不是 RA3 Mod SDK 根目录（缺少 Schemas/xsd/CnC3Types.xsd）。点击重新设置。";
  }
  return `RA3 Mod SDK 缺少：${validation.missing.join("、")}。manifest / 原版源码 / SDK 搜索路径等功能不可用。`;
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
    `RA3 Mod XML: SDK 路径已设置为 ${path}，正在重建索引…`,
  );
}
