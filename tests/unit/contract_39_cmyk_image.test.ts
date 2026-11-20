import { expect, test } from "bun:test";

// MIT-licensed Bun quadrant fixtures, pinned to the original regression fix:
// https://github.com/oven-sh/bun/blob/7b0b70ece52704561a8f9ee36a2b6f10cd588acf/test/js/bun/image/image.test.ts
for (const encoding of ["cmyk", "ycck"] as const) {
  test(`Contract #39: ${encoding} JPEG decodes, resizes and encodes as WebP`, async () => {
    const input = new URL(
      `../fixtures/image/${encoding}-quadrants.jpg`,
      import.meta.url,
    );
    const bytes = await Bun.file(input).bytes();
    // APP14 Adobe transform identifies CMYK (0) versus YCCK (2).
    expect(bytes[3]).toBe(0xee);
    expect(bytes[17]).toBe(encoding === "cmyk" ? 0 : 2);
    expect(await new Bun.Image(bytes).metadata()).toEqual({
      width: 64,
      height: 64,
      format: "jpeg",
    });
    const output = await new Bun.Image(input.pathname)
      .resize(400, 400)
      .webp()
      .bytes();
    expect(Buffer.from(output.subarray(0, 4)).toString()).toBe("RIFF");
    expect(Buffer.from(output.subarray(8, 12)).toString()).toBe("WEBP");
    expect(await new Bun.Image(output).metadata()).toEqual({
      width: 400,
      height: 400,
      format: "webp",
    });
    // Force another full decode of the encoded output, beyond header inspection.
    expect((await new Bun.Image(output).png().bytes()).length).toBeGreaterThan(
      0,
    );
  });
}
