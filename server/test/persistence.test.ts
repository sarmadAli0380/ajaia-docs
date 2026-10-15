import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../db/index.js";
import { migrate } from "../db/schema.js";
import { createDoc, createTestContext, share, signIn } from "./helpers.js";

const dir = mkdtempSync(path.join(tmpdir(), "ajaia-pglite-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("persistence across restarts (AC-PERSIST)", () => {
  it("keeps documents, shares and versions in a PGlite directory; boot is idempotent", async () => {
    const dataDir = path.join(dir, "db");

    // First boot: create data.
    const first = await createTestContext({ db: await openDatabase({ databaseUrl: null, pgliteDir: dataDir }) });
    const alice = await signIn(first, "alice");
    const { id } = await createDoc(alice, "Survives restart", "<h1>Kept</h1>");
    await share(alice, id, "bob", "editor");
    await first.close();

    // Second boot on the same directory: schema/seed run again without duplicating.
    const secondDb = await openDatabase({ databaseUrl: null, pgliteDir: dataDir });
    await migrate(secondDb); // and once more, explicitly
    const second = await createTestContext({ db: secondDb });
    try {
      const users = await secondDb.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
      expect(users.rows[0]?.n).toBe(3);

      const aliceAgain = await signIn(second, "alice");
      const doc = await aliceAgain.get(`/api/documents/${id}`);
      expect(doc.status).toBe(200);
      expect(doc.body.document).toMatchObject({ title: "Survives restart", content: "<h1>Kept</h1>", revision: 2 });

      const bob = await signIn(second, "bob");
      expect((await bob.get(`/api/documents/${id}`)).body.document.role).toBe("editor");
      expect((await aliceAgain.get(`/api/documents/${id}/versions`)).body.versions).toHaveLength(1);
    } finally {
      await second.close();
    }
  });
});
