import * as vscode from "vscode";
import { join } from "node:path";

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
  const sdkPath = cfg.get<string>("sdkPath", "C:\\Apps\\RA3-MODSDK-X");
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
    builtmodsDirs: [join(sdkPath, "builtmods"), join(sdkPath, "builtmods-quantum")],
  };
}
