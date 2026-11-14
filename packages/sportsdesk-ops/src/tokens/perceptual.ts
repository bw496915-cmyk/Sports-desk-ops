export class TokenColorParseError extends Error {
  override readonly name = "TokenColorParseError";
  readonly code = "ERR_TOKEN_COLOR_PARSE" as const;
}

export type CieLab = {
  readonly lightness: number;
  readonly greenRed: number;
  readonly blueYellow: number;
};

const HEX_COLOR = /^#[0-9a-f]{6}$/;
const LAB_CSS = /^lab\((-?[\d.e+-]+)% (-?[\d.e+-]+) (-?[\d.e+-]+)\)$/;

export function assertHexColor(hex: string, context: string): void {
  if (!HEX_COLOR.test(hex)) {
    throw new TokenColorParseError(
      `${context}: expected lowercase #rrggbb, got ${JSON.stringify(hex)}`,
    );
  }
}

export function srgbChannels(hex: string): readonly [number, number, number] {
  assertHexColor(hex, "srgbChannels");
  const channels = Bun.color(hex, "[rgb]");
  if (channels === null || channels.length !== 3) {
    throw new TokenColorParseError(`Bun.color rejected ${hex}`);
  }
  const [red, green, blue] = channels;
  if (red === undefined || green === undefined || blue === undefined) {
    throw new TokenColorParseError(
      `Bun.color returned a short tuple for ${hex}`,
    );
  }
  return [red, green, blue];
}

function linearize(channel8: number): number {
  const unit = channel8 / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const [red, green, blue] = srgbChannels(hex);
  return (
    0.2126 * linearize(red) +
    0.7152 * linearize(green) +
    0.0722 * linearize(blue)
  );
}

export function wcagContrastRatio(
  foreground: string,
  background: string,
): number {
  const lumA = relativeLuminance(foreground);
  const lumB = relativeLuminance(background);
  return (Math.max(lumA, lumB) + 0.05) / (Math.min(lumA, lumB) + 0.05);
}

/** Bun 1.4.4 `Bun.color(hex, "lab")` returns CSS Color 4 `lab(L% a b)` (D50 white point). */
export function labOf(hex: string): CieLab {
  assertHexColor(hex, "labOf");
  const css = Bun.color(hex, "lab");
  const match = css === null ? null : LAB_CSS.exec(css);
  if (match === null) {
    throw new TokenColorParseError(
      `Bun.color(${hex}, "lab") returned ${JSON.stringify(css)}`,
    );
  }
  return {
    lightness: Number(match[1]),
    greenRed: Number(match[2]),
    blueYellow: Number(match[3]),
  };
}

const DEG = Math.PI / 180;

function hueDegrees(blueYellow: number, greenRedPrime: number): number {
  if (blueYellow === 0 && greenRedPrime === 0) return 0;
  const degrees = Math.atan2(blueYellow, greenRedPrime) / DEG;
  return degrees >= 0 ? degrees : degrees + 360;
}

/** CIEDE2000 (Sharma, Wu & Dalal 2005), kL = kC = kH = 1. */
export function deltaE2000(first: CieLab, second: CieLab): number {
  const chromaFirst = Math.hypot(first.greenRed, first.blueYellow);
  const chromaSecond = Math.hypot(second.greenRed, second.blueYellow);
  const chromaMean7 = ((chromaFirst + chromaSecond) / 2) ** 7;
  const gFactor = 0.5 * (1 - Math.sqrt(chromaMean7 / (chromaMean7 + 25 ** 7)));
  const aPrimeFirst = (1 + gFactor) * first.greenRed;
  const aPrimeSecond = (1 + gFactor) * second.greenRed;
  const cPrimeFirst = Math.hypot(aPrimeFirst, first.blueYellow);
  const cPrimeSecond = Math.hypot(aPrimeSecond, second.blueYellow);
  const hPrimeFirst = hueDegrees(first.blueYellow, aPrimeFirst);
  const hPrimeSecond = hueDegrees(second.blueYellow, aPrimeSecond);

  const deltaLPrime = second.lightness - first.lightness;
  const deltaCPrime = cPrimeSecond - cPrimeFirst;
  let deltaHueDegrees = 0;
  if (cPrimeFirst * cPrimeSecond !== 0) {
    deltaHueDegrees = hPrimeSecond - hPrimeFirst;
    if (deltaHueDegrees > 180) deltaHueDegrees -= 360;
    else if (deltaHueDegrees < -180) deltaHueDegrees += 360;
  }
  const deltaHPrime =
    2 *
    Math.sqrt(cPrimeFirst * cPrimeSecond) *
    Math.sin((deltaHueDegrees * DEG) / 2);

  const lightnessMean = (first.lightness + second.lightness) / 2;
  const cPrimeMean = (cPrimeFirst + cPrimeSecond) / 2;
  let hPrimeMean = hPrimeFirst + hPrimeSecond;
  if (cPrimeFirst * cPrimeSecond !== 0) {
    if (Math.abs(hPrimeFirst - hPrimeSecond) <= 180) hPrimeMean /= 2;
    else if (hPrimeMean < 360) hPrimeMean = (hPrimeMean + 360) / 2;
    else hPrimeMean = (hPrimeMean - 360) / 2;
  }

  const tFactor =
    1 -
    0.17 * Math.cos((hPrimeMean - 30) * DEG) +
    0.24 * Math.cos(2 * hPrimeMean * DEG) +
    0.32 * Math.cos((3 * hPrimeMean + 6) * DEG) -
    0.2 * Math.cos((4 * hPrimeMean - 63) * DEG);
  const deltaTheta = 30 * Math.exp(-(((hPrimeMean - 275) / 25) ** 2));
  const cPrimeMean7 = cPrimeMean ** 7;
  const rotationC = 2 * Math.sqrt(cPrimeMean7 / (cPrimeMean7 + 25 ** 7));
  const lightnessOffset = (lightnessMean - 50) ** 2;
  const scaleL =
    1 + (0.015 * lightnessOffset) / Math.sqrt(20 + lightnessOffset);
  const scaleC = 1 + 0.045 * cPrimeMean;
  const scaleH = 1 + 0.015 * cPrimeMean * tFactor;
  const rotationT = -Math.sin(2 * deltaTheta * DEG) * rotationC;

  const termL = deltaLPrime / scaleL;
  const termC = deltaCPrime / scaleC;
  const termH = deltaHPrime / scaleH;
  return Math.sqrt(
    termL ** 2 + termC ** 2 + termH ** 2 + rotationT * termC * termH,
  );
}

export function deltaE2000Hex(firstHex: string, secondHex: string): number {
  return deltaE2000(labOf(firstHex), labOf(secondHex));
}
