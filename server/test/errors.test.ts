import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/index.js";
import { GENERIC_ERROR_MESSAGE } from "../http/errors.js";
import { createTestContext, signIn, type TestContext } from "./helpers.js";

/**
 * EC-21: unexpected failures return a generic JSON message without stack traces
 * and are logged server-side.
 */
let base: TestContext;
let ctx: TestContext;

beforeAll(async () => {
  base = await createTestContext();
  // Wrap the real database and make the dashboard query blow up.
  const failing: Db = {
    kind: base.db.kind,
    query: (sql, params) => {
      if (sql.includes("s.user_id = $1 AND d.owner_id <> $1")) {
        return Promise.reject(new Error("db exploded at /secret/path/server.ts:42"));
      }
      return base.db.query(sql, params);
    },
    transaction: (fn) => base.db.transaction(fn),
    close: () => base.db.close(),
  };
  ctx = await createTestContext({ db: failing });
});
afterAll(async () => {
  await base.close();
});

describe("unexpected errors (EC-21)", () => {
  it("returns a generic JSON 500 and logs the error", async () => {
    const alice = await signIn(ctx, "alice");
    const res = await alice.get("/api/documents");
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body).toEqual({ error: GENERIC_ERROR_MESSAGE });
    expect(res.text).not.toMatch(/secret|exploded|server\.ts|at /);

    expect(ctx.logger.errors).toHaveLength(1);
    expect(ctx.logger.errors[0]?.message).toContain("GET /api/documents");
    expect(String(ctx.logger.errors[0]?.err)).toContain("db exploded");
  });

  it("health check reports 503 when the database is unavailable", async () => {
    const broken: Db = {
      kind: "pglite",
      query: () => Promise.reject(new Error("down")),
      transaction: () => Promise.reject(new Error("down")),
      close: async () => undefined,
    };
    const app = await createTestContext({ db: broken });
    const res = await (await import("supertest")).default(app.app).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "unavailable" });
  });

  it("expected client errors are not logged as server errors", async () => {
    const before = ctx.logger.errors.length;
    const alice = await signIn(ctx, "alice");
    await alice.get("/api/documents/not-a-uuid");
    await alice.post("/api/documents", { title: "" });
    expect(ctx.logger.errors.length).toBe(before);
  });
});
