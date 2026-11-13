/**
 * @file lib/rot_mapper.ts
 * @description Maps a source system's ROT token onto the desk's canonical ROT,
 * quarantining every unresolved lookup instead of guessing.
 *
 * The failure mode this exists to prevent: a source silently re-labels or omits
 * a ROT, the resolver falls back to "probably the same thing", and the wrong
 * canonical ROT settles a bet. So an unmapped pair is never coerced — it is
 * recorded with a UUIDv7 quarantine id and thrown as `ErrROTUnmapped`.
 *
 * `RotOriginDomainId` is deliberately `string` here: the canonical
 * `OriginDomainId` union lives in the domain registry, which is not part of
 * this module's dependency graph. Callers pass that union; it is structurally
 * assignable.
 */

/** Canonical origin domain of the source system (e.g. F402, GSLive, Kalshi). */
export type RotOriginDomainId = string;

/** The raw ROT token exactly as the source system emitted it. */
export type SourceRot = string;

export interface RotMapping {
  readonly originDomainId: RotOriginDomainId;
  readonly sourceRot: SourceRot;
  /** The desk's canonical ROT for this (origin, source) pair. */
  readonly canonicalRot: string;
}

export interface CanonicalRot {
  readonly canonicalRot: string;
  readonly originDomainId: RotOriginDomainId;
  readonly sourceRot: SourceRot;
}

export interface QuarantinedRotUpdate {
  readonly quarantineId: string;
  readonly originDomainId: RotOriginDomainId;
  readonly sourceWagerId: string;
  readonly sourceRot: SourceRot;
  readonly timestamp: Date;
  readonly reason: string;
}

export interface RotMapperOptions {
  /** Injectable clock; defaults to `new Date()`. */
  readonly now?: () => Date;
  /** Injectable quarantine id source; defaults to `Q-${Bun.randomUUIDv7()}`. */
  readonly nextQuarantineId?: () => string;
}

export class ErrInvalidRotMapping extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErrInvalidRotMapping";
  }
}

export class ErrROTUnmapped extends Error {
  readonly originDomainId: RotOriginDomainId;
  readonly sourceRot: SourceRot;
  readonly sourceWagerId: string;
  readonly quarantineId: string;

  constructor(
    originDomainId: RotOriginDomainId,
    sourceRot: SourceRot,
    sourceWagerId: string,
    quarantineId: string,
  ) {
    super(
      `No canonical ROT mapping for "${sourceRot}" on origin "${originDomainId}" (wager ${sourceWagerId}, quarantine ${quarantineId})`,
    );
    this.name = "ErrROTUnmapped";
    this.originDomainId = originDomainId;
    this.sourceRot = sourceRot;
    this.sourceWagerId = sourceWagerId;
    this.quarantineId = quarantineId;
  }
}

function mappingKey(
  originDomainId: RotOriginDomainId,
  sourceRot: SourceRot,
): string {
  return `${originDomainId}\u0000${sourceRot}`;
}

export class ROTMapper {
  readonly #mappings = new Map<string, RotMapping>();
  readonly #quarantined: QuarantinedRotUpdate[] = [];
  readonly #now: () => Date;
  readonly #nextQuarantineId: () => string;

  constructor(mappings: readonly RotMapping[], options: RotMapperOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#nextQuarantineId =
      options.nextQuarantineId ?? (() => `Q-${Bun.randomUUIDv7()}`);

    for (const mapping of mappings) {
      if (
        typeof mapping.originDomainId !== "string" ||
        mapping.originDomainId.length === 0
      ) {
        throw new ErrInvalidRotMapping("originDomainId must be non-empty");
      }
      if (
        typeof mapping.sourceRot !== "string" ||
        mapping.sourceRot.length === 0
      ) {
        throw new ErrInvalidRotMapping("sourceRot must be non-empty");
      }
      if (
        typeof mapping.canonicalRot !== "string" ||
        mapping.canonicalRot.length === 0
      ) {
        throw new ErrInvalidRotMapping("canonicalRot must be non-empty");
      }
      const key = mappingKey(mapping.originDomainId, mapping.sourceRot);
      if (this.#mappings.has(key)) {
        throw new ErrInvalidRotMapping(
          `duplicate mapping for "${mapping.sourceRot}" on "${mapping.originDomainId}"`,
        );
      }
      this.#mappings.set(key, mapping);
    }
  }

  /** Mappings currently loaded, for diagnostics. */
  get size(): number {
    return this.#mappings.size;
  }

  /** Unresolved updates, in the order they were rejected. */
  quarantined(): readonly QuarantinedRotUpdate[] {
    return this.#quarantined;
  }

  resolve(
    originDomainId: RotOriginDomainId,
    sourceRot: SourceRot,
    sourceWagerId: string,
  ): CanonicalRot {
    const mapping = this.#mappings.get(mappingKey(originDomainId, sourceRot));
    if (mapping) {
      return {
        canonicalRot: mapping.canonicalRot,
        originDomainId,
        sourceRot,
      };
    }

    const quarantineId = this.#nextQuarantineId();
    this.#quarantined.push({
      quarantineId,
      originDomainId,
      sourceWagerId,
      sourceRot,
      timestamp: this.#now(),
      reason: `Source ROT mapped incorrectly or missing resolution on domain ${originDomainId}`,
    });
    throw new ErrROTUnmapped(
      originDomainId,
      sourceRot,
      sourceWagerId,
      quarantineId,
    );
  }
}
