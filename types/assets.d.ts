/**
 * @file types/assets.d.ts
 * @description Ambient module declarations for CSS & SVG bundler imports not declared in bun-types/extensions.d.ts.
 * Note: `declare module "*.html"` is canonically provided by `bun-types/extensions.d.ts`.
 */

/** Side-effect and default URL imports — use `declare module "*.module.css"` for CSS modules. */
declare module "*.css" {}

declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export = classes;
}

/** Doc default: `const content: string` — https://bun.com/docs/runtime/check#cannot-find-module-logosvg-or-indexcss */
declare module "*.svg" {
  const path: `${string}.svg`;
  export default path;
}
