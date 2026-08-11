import * as vscode from "vscode";
import { join } from "node:path";
import { normalizeSdkPath } from "./sdk";

export interface ExtensionSettings {
  sdkPath: string;
  indexSageXml: boolean;
  reportUnresolvedReferences: "warning" | "information" | "none";
  diagnoseUnknownElements: boolean;
  definitionMode: "all" | "project-only";
  additionalDataSearchPaths: string[];
  builtmodsDirs: string[];
}

export function readSettings(): ExtensionSettings {
  const cfg = vscode.workspace.getConfiguration("ra3modxml");
  const sdkPath = normalizeSdkPath(cfg.get<string>("sdkPath", ""));
  return {
    sdkPath,
    indexSageXml: cfg.get<boolean>("indexSageXml", true),
    reportUnresolvedReferences: cfg.get<string>(
      "reportUnresolvedReferences",
      "warning",
    ) as ExtensionSettings["reportUnresolvedReferences"],
    diagnoseUnknownElements: cfg.get<boolean>("diagnoseUnknownElements", true),
    definitionMode: cfg.get<string>(
      "definitionMode",
      "all",
    ) as ExtensionSettings["definitionMode"],
    additionalDataSearchPaths: cfg.get<string[]>("additionalDataSearchPaths", []),
    builtmodsDirs: sdkPath
      ? [join(sdkPath, "builtmods"), join(sdkPath, "builtmods-quantum")]
      : [],
  };
}
