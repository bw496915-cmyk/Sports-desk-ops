/**
 * @file types/bun-api.d.ts
 * @description Strictly upstream-absent Bun 1.4.4+ type augmentations.
 *
 * Canonical Bun types (`BunFile`, `FileBlob`, `S3Client`, `S3File`, `S3Options`,
 * `S3Stats`, `S3Error`, `BunFetchRequestInit`, `HTMLBundle`, etc.) are imported
 * directly from `"bun"` or resolved from `bun-types@1.4.4` — never re-declared or
 * hand-aliased here. Only runtime capabilities present in the Bun 1.4.4 binary that
 * are not yet published in `bun-types@1.4.4` / `@types/node` live in this file.
 */

/** Windows Credential Manager persistence for Bun.secrets.set (not yet in bun-types@1.4.4). */
export type BunSecretPersist = "local" | "enterprise";

export interface BunSecretSetOptions {
  readonly service: string;
  readonly name: string;
  readonly value: string;
  readonly persist?: BunSecretPersist;
}

/**
 * Bun 1.4 post-quantum Web Crypto extensions (ML-KEM / ML-DSA), not yet in bun-types@1.4.4.
 * Keeping these declarations here removes `as unknown as` casts at call sites.
 */
declare global {
  interface SubtleCrypto {
    generateKey(
      algorithm:
        "ML-KEM-768" | "ML-KEM-1024" | "ML-DSA-44" | "ML-DSA-65" | "ML-DSA-87",
      extractable: boolean,
      keyUsages: readonly string[],
    ): Promise<CryptoKeyPair>;
    encapsulateBits(
      algorithm: AlgorithmIdentifier,
      key: CryptoKey,
    ): Promise<{ sharedKey: ArrayBuffer; ciphertext: ArrayBuffer }>;
    decapsulateBits(
      algorithm: AlgorithmIdentifier,
      key: CryptoKey,
      ciphertext: BufferSource,
    ): Promise<ArrayBuffer>;
    encapsulateKey(
      algorithm: AlgorithmIdentifier,
      publicKey: CryptoKey,
      sharedKeyAlgorithm: AlgorithmIdentifier,
      extractable: boolean,
      keyUsages: readonly string[],
    ): Promise<{ sharedKey: CryptoKey; ciphertext: ArrayBuffer }>;
    decapsulateKey(
      algorithm: AlgorithmIdentifier,
      privateKey: CryptoKey,
      ciphertext: BufferSource,
      sharedKeyAlgorithm: AlgorithmIdentifier,
      extractable: boolean,
      keyUsages: readonly string[],
    ): Promise<CryptoKey>;
  }
}

/** Bun 1.4 process memory-pressure event (not yet in @types/node). */
declare global {
  namespace NodeJS {
    interface Process {
      on(
        event: "memoryPressure",
        listener: (level: "warning" | "critical") => void,
      ): this;
      off(
        event: "memoryPressure",
        listener: (level: "warning" | "critical") => void,
      ): this;
      removeListener(
        event: "memoryPressure",
        listener: (level: "warning" | "critical") => void,
      ): this;
    }
  }
}
