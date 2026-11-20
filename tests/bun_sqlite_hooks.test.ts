/**
 * @file tests/bun_sqlite_hooks.test.ts
 * @description Contracts for the bun:sqlite 1.4.4 additions: per-row
 * onInsert/onUpdate/onDelete hooks, statement reader/readonly flags and the
 * sqlite-type brand.
 */

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

test("row hooks fire for each insert, update and delete", () => {
  const db = new Database(":memory:");
  const events: [string, string, number | bigint][] = [];
  db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  db.onInsert = (_db, table, rowid) => events.push(["insert", table, rowid]);
  db.onUpdate = (_db, table, rowid) => events.push(["update", table, rowid]);
  db.onDelete = (_db, table, rowid) => events.push(["delete", table, rowid]);

  try {
    db.run("INSERT INTO t (name) VALUES (?)", ["a"]);
    db.run("INSERT INTO t (name) VALUES (?)", ["b"]);
    db.run("UPDATE t SET name = ? WHERE id = ?", ["c", 1]);
    db.run("DELETE FROM t WHERE id = ?", [2]);

    expect(events).toEqual([
      ["insert", "t", 1],
      ["insert", "t", 2],
      ["update", "t", 1],
      ["delete", "t", 2],
    ]);

    db.onInsert = null;
    db.run("INSERT INTO t (name) VALUES (?)", ["d"]);
    expect(events).toHaveLength(4);
  } finally {
    db.close();
  }
});

test("statement reader/readonly flags distinguish SELECT from DML", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");

  try {
    const select = db.query("SELECT * FROM t");
    const insert = db.query("INSERT INTO t (name) VALUES (?)");

    expect(select.reader).toBe(true);
    expect(select.readonly).toBe(true);
    expect(insert.reader).toBe(false);
    expect(insert.readonly).toBe(false);
  } finally {
    db.close();
  }
});

test("a Database carries the sqlite-type brand", () => {
  const db = new Database(":memory:");
  try {
    expect(Reflect.get(db, Symbol.for("sqlite-type"))).toBe("bun:sqlite");
  } finally {
    db.close();
  }
});
