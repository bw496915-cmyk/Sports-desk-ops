import { describe, expect, test } from "bun:test";
import {
  type CustomerRecord,
  countBySource,
  ensureCustomerSchema,
  findCustomer,
  listCustomers,
  openCustomerIndex,
  searchCustomers,
  upsertCustomers,
} from "../lib/customer_index.ts";

function record(overrides: Partial<CustomerRecord>): CustomerRecord {
  return {
    id: "BGD101",
    source: "artifact",
    agent: "BIGDAD",
    name: "",
    updatedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

describe("customer index", () => {
  test("keeps the same id under different sources and finds all of them", async () => {
    const db = openCustomerIndex();
    try {
      await ensureCustomerSchema(db);
      await upsertCustomers(db, [
        record({ id: "BGD101", source: "artifact", agent: "BIGDAD" }),
        record({ id: "BGD101", source: "demo-book", agent: "BIGDAD" }),
        record({ id: "RF2003", source: "demo-book", agent: "FAKEMONEY" }),
      ]);

      const found = await findCustomer(db, "BGD101");
      expect(found.map((row) => row.source)).toEqual(["artifact", "demo-book"]);
      expect(
        (await countBySource(db)).find((row) => row.source === "demo-book")
          ?.count,
      ).toBe(2);
    } finally {
      await db.close();
    }
  });

  test("re-indexing updates instead of duplicating", async () => {
    const db = openCustomerIndex();
    try {
      await ensureCustomerSchema(db);
      await upsertCustomers(db, [record({ name: "old" })]);
      await upsertCustomers(db, [record({ name: "new" })]);
      const rows = await findCustomer(db, "BGD101");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("new");
    } finally {
      await db.close();
    }
  });

  test("lists by source and searches id, agent or name", async () => {
    const db = openCustomerIndex();
    try {
      await ensureCustomerSchema(db);
      await upsertCustomers(db, [
        record({ id: "BGD101", source: "artifact", agent: "BIGDAD" }),
        record({
          id: "RF2003",
          source: "demo-book",
          agent: "FAKEMONEY",
          name: "Rae Fox",
        }),
      ]);

      const artifacts = await listCustomers(db, { source: "artifact" });
      expect(artifacts.map((row) => row.id)).toEqual(["BGD101"]);

      expect((await searchCustomers(db, "fake")).map((row) => row.id)).toEqual([
        "RF2003",
      ]);
      expect((await searchCustomers(db, "rae")).map((row) => row.id)).toEqual([
        "RF2003",
      ]);
      expect((await searchCustomers(db, "2003")).map((row) => row.id)).toEqual([
        "RF2003",
      ]);
    } finally {
      await db.close();
    }
  });

  test("an empty index lists nothing rather than throwing", async () => {
    const db = openCustomerIndex();
    try {
      await ensureCustomerSchema(db);
      expect(await listCustomers(db)).toEqual([]);
      expect(await findCustomer(db, "missing")).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
