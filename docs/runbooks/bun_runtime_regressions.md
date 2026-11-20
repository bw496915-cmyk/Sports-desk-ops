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

The overlapping-species checks exercise forward element-by-element copy semantics.
When the destination starts later in the same buffer, earlier writes affect later
reads. ALS immediate tests keep an async immediate callback suspended on a latch
while checking collection, then release it and verify its inherited context.

## Duration formatting and Linux runtime checks

The Intl test uses the hidden-zero-minute case from the WebKit fix. It checks
both the rendered seconds and their parts, plus separators when hours or minutes
are visible. [WebKit change](https://github.com/WebKit/WebKit/commit/70a75461959a91b29395c03ce7ba494745c37c0a)

The Bun Linux runtime regressions workflow runs the Intl and Linux tests in
digest-pinned Alpine (musl) and Debian (glibc) images on x86-64. Each job checks
the image's libc environment and Bun version. The Linux tests use a private FIFO
and an in-memory object array. They also run in the normal Linux test suite.

| Fix                                                                                                                                                                                                   | Runtime check                                                                                    | Patched source checked by CI                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| [musl array GC](https://github.com/oven-sh/WebKit/commit/2e2aa2290fac856d6f451ceacb58f7f5b44dd057), [Bun integration](https://github.com/oven-sh/bun/commit/7e3744509ce9417b209b45d93419cebdc1123755) | Check object values after shift, splice, truncation and an explicit collection.                  | GC-safe clearing of live object slots in JSArray.cpp and the fence before publishing vector length in JSObject.cpp.                    |
| [Linux FileSink ownership](https://github.com/oven-sh/bun/commit/3044dc6834e5449d20317ad7c41f04013d32e5b0)                                                                                            | End two successive writers to the same FIFO and check both payloads through the original reader. | The buffered and streaming writer registration-error branches in PipeWriter.rs and the descriptor-preserving poll cleanup in pipes.rs. |

To verify source identity locally from the checkout root:

```sh
bash scripts/ci/verify_runtime_patches.sh "$(bun -p 'Bun.revision')"
```

The script fetches source at the running Bun revision, follows its WebKit dependency
pin and checks Git blob IDs against the four reviewed files. A changed file requires
review before updating its expected ID. The local tests exercise sequential GC
and successful FIFO writes.

Bun’s release CI also ran the failed-registration ownership test on Alpine 3.23
x86-64 at the exact 1.4.4 revision. The FileSink JUnit case records one assertion,
no skip and no failure. The Alpine workflow verifies the container revision,
the SHA-256 of the original report and the individual case result. An unavailable
report or runtime upgrade requires fresh evidence for this check.
[Buildkite job](https://buildkite.com/bun/bun/builds/130816/list?jid=01a162c2-7220-497a-bff5-087f27bd98ca)
· [JUnit report](https://buildkite.com/organizations/bun/pipelines/bun/builds/130816/jobs/01a162c2-7220-497a-bff5-087f27bd98ca/artifacts/01a162cb-f54f-4088-9447-274bc7054f93)

Concurrent marking during array mutation remains unverified on the musl binary.
The Alpine x86-64 release reports contain no identified case recording the overlap.
The sequential array test and the reviewed WebKit sources are the available evidence.
