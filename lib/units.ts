declare const __unit: unique symbol;
type Unit<U extends string> = { readonly [__unit]: U };

export type Millis = number & Unit<"ms">;
export type Bytes = number & Unit<"B">;
export type Seconds = number & Unit<"s">;
export type Count = number & Unit<"count">;

export const ms = (n: number): Millis => n as Millis;
export const bytes = (n: number): Bytes => n as Bytes;
export const sec = (n: number): Seconds => n as Seconds;
export const count = (n: number): Count => n as Count;
