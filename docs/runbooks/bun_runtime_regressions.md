# Bun runtime regression checks

Runtime baseline is the repository pin, Bun 1.4.4+38afee6c8. The regression cases
below come from the Bun 1.4.2 fixes. Passing these cases exercises their stated
behavior on the pin. It does not establish coverage of every upstream fix.

Run the focused set with the pinned executable on PATH:

```sh
TZ=UTC NO_COLOR=1 bun test tests/bun_runtime_regressions.test.ts tests/unit/ --bail=1
bun run verify:fast --check
```

| Local test                                         | Upstream evidence                                                                          | Exercised behavior                                                                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tests/unit/contract_39_bundle_bindings.test.ts     | [9eb082ab](https://github.com/oven-sh/bun/commit/9eb082ab7fc6addd4307f7ab8c6d4cdff112b745) | CLI build and execution of hoisted var / block let, parameter and catch collisions, with and without minification                                                                |
| tests/unit/contract_39_als_gc_retention.test.ts    | [74326db5](https://github.com/oven-sh/bun/commit/74326db585fe67c2a02bef1119c9e54ab05addf9) | Outer ALS payload is collected through nested-run and exit timers, pending promise reactions and suspended immediate continuations; callbacks observe the expected inner context |
| tests/unit/contract_39_worker_online_order.test.ts | [9fdcf5af](https://github.com/oven-sh/bun/commit/9fdcf5af20726a8416349c2afb3d366908d6fd77) | First worker message reaches a listener attached after online, with an order assertion and bounded timeout                                                                       |
| tests/unit/contract_39_cmyk_image.test.ts          | [7b0b70ec](https://github.com/oven-sh/bun/commit/7b0b70ece52704561a8f9ee36a2b6f10cd588acf) | CMYK and YCCK fixture identification, JPEG decode, 400×400 WebP round trip and quadrant RGB/alpha checks with tolerance 8                                                        |
| tests/bun_runtime_regressions.test.ts              | [5fb9ecbf](https://github.com/oven-sh/bun/commit/5fb9ecbf844650e55b7453162956a17db4b653e6) | Response and Blob JSON diagnostics agree with JSON.parse                                                                                                                         |
| tests/bun_runtime_regressions.test.ts              | [d296efbb](https://github.com/oven-sh/bun/commit/d296efbb4e5bfcd45cd0e93da312c793a1f5b701) | BigInt plural rules, iterable TypedArray conversion after source mutation, and overlapping slice species in both copy directions                                                 |

The image fixtures are copied from the pinned upstream test and carry its license
in tests/fixtures/image/LICENSE.bun.txt. No live customer records are used.

The collector has no runWithRbacScope API. The ALS test therefore exercises a real
AsyncLocalStorage store directly. A test of a lexical object that was never stored
in ALS would not establish ALS retention behavior.

Remaining upstream surfaces include DurationFormat and platform-specific GC/epoll
failure paths. These remain explicit coverage gaps. The links pin upstream
evidence, not a passing verdict on those gaps.

The overlapping-species checks exercise forward element-by-element copy semantics.
When the destination starts later in the same buffer, earlier writes affect later
reads. ALS immediate tests keep an async immediate callback suspended on a latch
while checking collection, then release it and verify its inherited context.
