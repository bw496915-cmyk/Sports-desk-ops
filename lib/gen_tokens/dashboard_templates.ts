/** HTML dashboard splice templates (customer vs telegram). */

export type DashboardTemplate = {
  repoPath: string;
  houdiniBlockRegex: RegExp;
  rootVarsRegex: RegExp;
  houdiniReplacementSuffix: string;
  rootVarsReplacementSuffix: string;
};

export const CUSTOMER_DASHBOARD_TEMPLATE: DashboardTemplate = {
  repoPath: "static/customer-churn-simulation-dashboard.html",
  houdiniBlockRegex:
    /\/\* ==========================================================================\s+1\. CSS Houdini @property Declarations[\s\S]*?(?=\/\* ==========================================================================\s+2\. Canonical :root)/,
  rootVarsRegex:
    /:root\s*\{\s*\/\* Generated from tokens\.toml \(v[^)]*\) \*\/[\s\S]*?(?=--sd-primary:)/,
  houdiniReplacementSuffix: "\n\n",
  rootVarsReplacementSuffix: "\n      ",
};

export const TELEGRAM_DASHBOARD_TEMPLATE: DashboardTemplate = {
  repoPath: "static/telegram-miniapp-dashboard.html",
  houdiniBlockRegex:
    /\/\* ==========================================================================\s+1\. CSS Houdini @property Declarations[\s\S]*?(?=\/\* ==========================================================================\s+2\. TMA Theme Mapping)/,
  rootVarsRegex:
    /:root\s*\{\s*\/\* Generated from tokens\.toml \(v[^)]*\) \*\/[\s\S]*?(?=--sd-primary:)/,
  houdiniReplacementSuffix: "\n\n    ",
  rootVarsReplacementSuffix: "\n      ",
};

export const DASHBOARD_TEMPLATES: readonly DashboardTemplate[] = [
  CUSTOMER_DASHBOARD_TEMPLATE,
  TELEGRAM_DASHBOARD_TEMPLATE,
];

export function spliceDashboardHtml(
  html: string,
  filePath: string,
  template: DashboardTemplate,
  houdiniCss: string,
  rootVarsCss: string,
  spliceOrExit: (
    html: string,
    filePath: string,
    marker: RegExp,
    replacement: string,
  ) => string,
): string {
  let out = spliceOrExit(
    html,
    filePath,
    template.houdiniBlockRegex,
    houdiniCss.trim() + template.houdiniReplacementSuffix,
  );
  out = spliceOrExit(
    out,
    filePath,
    template.rootVarsRegex,
    rootVarsCss + template.rootVarsReplacementSuffix,
  );
  return out;
}
