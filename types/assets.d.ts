/**
 * @file types/assets.d.ts
 * @description Ambient module declarations for Bun native HTML & CSS bundler imports.
 */

declare module "*.html" {
  import type { HTMLBundle } from "bun";
  const bundle: HTMLBundle;
  export default bundle;
}

/** Side-effect and default URL imports — use `declare module "*.module.css"` for CSS modules. */
declare module "*.css" {}

declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export = classes;
}

declare module "*.svg" {
  const path: `${string}.svg`;
  export default path;
}
