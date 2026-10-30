/** Exhaustiveness helper for discriminated-union switches (`default: absurd(x)`). */
export function absurd(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}
