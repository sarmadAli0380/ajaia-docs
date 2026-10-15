import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CSRF_HEADER, CSRF_HEADER_VALUE, DEFAULT_TITLE, MAX_CONTENT_BYTES } from "../../shared/limits.js";
import { createDoc, createTestContext, share, signIn, type ApiClient, type TestContext } from "./helpers.js";

let ctx: TestContext;
let alice: ApiClient;
let bob: ApiClient;

beforeAll(async () => {
  ctx = await createTestContext();
  alice = await signIn(ctx, "alice");
  bob = await signIn(ctx, "bob");
});
afterAll(async () => {
  await ctx.close();
});

async function countRows(table: string, documentId: string): Promise<number> {
  const { rows } = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE document_id = $1`,
    [documentId],
  );
  return rows[0]?.n ?? -1;
}

describe("create and list (AC-CREATE, AC-DASHBOARD)", () => {
  it("creates 'Untitled document' by default and lists it under owned", async () => {
    const res = await alice.post("/api/documents");
    expect(res.status).toBe(201);
    const doc = res.body.document;
    expect(doc).toMatchObject({ title: DEFAULT_TITLE, role: "owner", content: "", revision: 1 });
    expect(doc.owner).toMatchObject({ name: "Alice" });

    const list = await alice.get("/api/documents");
    expect(list.status).toBe(200);
    expect(list.body.owned.map((d: { id: string }) => d.id)).toContain(doc.id);
    expect(list.body.owned[0]).toHaveProperty("updatedAt");
  });

  it("accepts an explicit title and opens with full detail", async () => {
    const { id } = await createDoc(alice, "Roadmap");
    const res = await alice.get(`/api/documents/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.document).toMatchObject({ id, title: "Roadmap", role: "owner", revision: 1 });
  });

  it("separates owned from shared documents with owner name and role", async () => {
    const { id } = await createDoc(alice, "Shared plan");
    await share(alice, id, "bob", "editor");
    const list = await bob.get("/api/documents");
    const entry = list.body.shared.find((d: { id: string }) => d.id === id);
    expect(entry).toMatchObject({ title: "Shared plan", role: "editor", owner: { name: "Alice" } });
    expect(list.body.owned.find((d: { id: string }) => d.id === id)).toBeUndefined();
  });
});

describe("titles (AC-RENAME, EC-1)", () => {
  it.each([
    ["whitespace only", { title: "   \t  " }],
    ["empty", { title: "" }],
    ["missing", {}],
    ["null", { title: null }],
    ["too long", { title: "a".repeat(201) }],
    ["wrong type", { title: 42 }],
  ])("rejects %s title with 400 and a message", async (_label, body) => {
    const { id } = await createDoc(alice, "Original");
    const res = await alice.patch(`/api/documents/${id}`, body);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
    expect((await alice.get(`/api/documents/${id}`)).body.document.title).toBe("Original");
  });

  it("rejects invalid titles on create too", async () => {
    expect((await alice.post("/api/documents", { title: "  " })).status).toBe(400);
    expect((await alice.post("/api/documents", { title: "x".repeat(201) })).status).toBe(400);
    expect((await alice.post("/api/documents", { title: ["a"] })).status).toBe(400);
  });

  it("trims and accepts exactly 200 characters, unicode and emoji (counted as one)", async () => {
    const { id } = await createDoc(alice);
    const twoHundred = "b".repeat(200);
    const r1 = await alice.patch(`/api/documents/${id}`, { title: `  ${twoHundred}  ` });
    expect(r1.status).toBe(200);
    expect(r1.body.document.title).toBe(twoHundred);

    const emoji = "📝".repeat(200);
    const r2 = await alice.patch(`/api/documents/${id}`, { title: emoji });
    expect(r2.status).toBe(200);
    expect(r2.body.document.title).toBe(emoji);

    const r3 = await alice.patch(`/api/documents/${id}`, { title: "Café — 日本語 ✅" });
    expect(r3.body.document.title).toBe("Café — 日本語 ✅");
  });

  it("stores HTML in titles verbatim as data (clients render it as text)", async () => {
    const title = `<img src=x onerror="alert(1)"><b>Bold?</b>`;
    const { id } = await createDoc(alice, title);
    const res = await alice.get(`/api/documents/${id}`);
    expect(res.body.document.title).toBe(title);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("collapses control characters and newlines in titles", async () => {
    const { id } = await createDoc(alice, "Line1\nLine2\u0000\tEnd");
    expect((await alice.get(`/api/documents/${id}`)).body.document.title).toBe("Line1 Line2 End");
  });

  it("rename does not change the content revision", async () => {
    const { id, revision } = await createDoc(alice, "R", "<p>x</p>");
    await alice.patch(`/api/documents/${id}`, { title: "Renamed" });
    const doc = (await alice.get(`/api/documents/${id}`)).body.document;
    expect(doc.revision).toBe(revision);
    expect(doc.title).toBe("Renamed");
  });
});

describe("malformed input (EC-2)", () => {
  it("malformed JSON -> 400 JSON error, never 500", async () => {
    const { id } = await createDoc(alice);
    for (const [method, path] of [
      ["post", "/api/documents"],
      ["patch", `/api/documents/${id}`],
      ["put", `/api/documents/${id}/content`],
      ["post", `/api/documents/${id}/shares`],
      ["post", "/api/session"],
    ] as const) {
      const res = await alice.agent[method](path)
        .set(CSRF_HEADER, CSRF_HEADER_VALUE)
        .set("Content-Type", "application/json")
        .send('{"title": "oops",');
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(res.headers["content-type"]).toMatch(/json/);
      expect(res.body.error).toMatch(/malformed json/i);
    }
  });

  it("non-object JSON bodies and wrong field types -> 400", async () => {
    const { id, revision } = await createDoc(alice);
    expect((await alice.put(`/api/documents/${id}/content`, [1, 2])).status).toBe(400);
    expect((await alice.put(`/api/documents/${id}/content`, { content: 5, baseRevision: revision })).status).toBe(400);
    expect((await alice.put(`/api/documents/${id}/content`, { content: "<p>a</p>" })).status).toBe(400);
    for (const baseRevision of ["1", 0, -1, 1.5, 2 ** 31, null]) {
      const res = await alice.put(`/api/documents/${id}/content`, { content: "<p>a</p>", baseRevision });
      expect(res.status, String(baseRevision)).toBe(400);
    }
    const raw = await alice.agent
      .put(`/api/documents/${id}/content`)
      .set(CSRF_HEADER, CSRF_HEADER_VALUE)
      .set("Content-Type", "application/json")
      .send("null");
    expect(raw.status).toBe(400);
  });

  it("body sent as text/plain is treated as missing -> 400", async () => {
    const { id } = await createDoc(alice);
    const res = await alice.agent
      .put(`/api/documents/${id}/content`)
      .set(CSRF_HEADER, CSRF_HEADER_VALUE)
      .set("Content-Type", "text/plain")
      .send("hello");
    expect(res.status).toBe(400);
  });
});

describe("ids (EC-3)", () => {
  const missing = "11111111-2222-4333-8444-555555555555";
  it.each(["not-a-uuid", "123", missing, "11111111-2222-4333-8444-55555555555Z", "%27%20OR%201%3D1"])(
    "id %s -> 404 on every document endpoint",
    async (id) => {
      const checks = [
        alice.get(`/api/documents/${id}`),
        alice.patch(`/api/documents/${id}`, { title: "x" }),
        alice.put(`/api/documents/${id}/content`, { content: "", baseRevision: 1 }),
        alice.delete(`/api/documents/${id}`),
        alice.get(`/api/documents/${id}/export`),
        alice.get(`/api/documents/${id}/versions`),
        alice.get(`/api/documents/${id}/shares`),
      ];
      for (const res of await Promise.all(checks)) {
        expect(res.status).toBe(404);
        expect(res.body.error).toBeTruthy();
      }
    },
  );
});

describe("saving (AC-EDIT, AC-SAVE-STATE, EC-4, EC-5)", () => {
  it("saves formatted HTML, bumps revision, and returns the same formatting on reopen", async () => {
    const html =
      "<h1>Title</h1><h2>Sub</h2><h3>Small</h3><p><strong>b</strong> <em>i</em> <u>u</u></p>" +
      "<ul><li><p>one</p></li></ul><ol><li><p>first</p></li></ol>";
    const { id } = await createDoc(alice, "Formatting");
    const save = await alice.put(`/api/documents/${id}/content`, { content: html, baseRevision: 1 });
    expect(save.status).toBe(200);
    expect(save.body.revision).toBe(2);
    expect(save.body.updatedAt).toBeTruthy();
    const doc = (await alice.get(`/api/documents/${id}`)).body.document;
    expect(doc.content).toBe(html);
    expect(doc.revision).toBe(2);
  });

  it("empty document saves fine", async () => {
    const { id } = await createDoc(alice, "Empty", "<p>text</p>");
    const res = await alice.put(`/api/documents/${id}/content`, { content: "", baseRevision: 2 });
    expect(res.status).toBe(200);
    expect((await alice.get(`/api/documents/${id}`)).body.document.content).toBe("");
  });

  it("content over 1 MB -> 413 with a message; exactly 1 MB is accepted", async () => {
    const { id } = await createDoc(alice, "Big");
    const wrapper = "<p></p>".length;
    const exact = `<p>${"a".repeat(MAX_CONTENT_BYTES - wrapper)}</p>`;
    const ok = await alice.put(`/api/documents/${id}/content`, { content: exact, baseRevision: 1 });
    expect(ok.status).toBe(200);

    const over = `<p>${"a".repeat(MAX_CONTENT_BYTES - wrapper + 1)}</p>`;
    const res = await alice.put(`/api/documents/${id}/content`, { content: over, baseRevision: 2 });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
    expect((await alice.get(`/api/documents/${id}`)).body.document.revision).toBe(2);
  });

  it("multi-byte characters count as bytes for the 1 MB limit", async () => {
    const { id } = await createDoc(alice, "Bytes");
    const content = `<p>${"é".repeat(MAX_CONTENT_BYTES / 2)}</p>`; // 2 bytes each -> over the limit
    const res = await alice.put(`/api/documents/${id}/content`, { content, baseRevision: 1 });
    expect(res.status).toBe(413);
  });

  it("request bodies beyond the parser limit -> 413 JSON", async () => {
    const { id } = await createDoc(alice, "Huge");
    const res = await alice.put(`/api/documents/${id}/content`, {
      content: "a".repeat(4 * 1024 * 1024),
      baseRevision: 1,
    });
    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toMatch(/json/);
  });

  it("stale revision -> 409 with currentRevision and no change (EC-5)", async () => {
    const { id } = await createDoc(alice, "Race", "<p>v1</p>");
    await share(alice, id, "bob", "editor");
    const first = await bob.put(`/api/documents/${id}/content`, { content: "<p>bob</p>", baseRevision: 2 });
    expect(first.status).toBe(200);

    const stale = await alice.put(`/api/documents/${id}/content`, { content: "<p>alice</p>", baseRevision: 2 });
    expect(stale.status).toBe(409);
    expect(stale.body.currentRevision).toBe(3);
    expect(stale.body.error).toMatch(/changed/i);

    const doc = (await alice.get(`/api/documents/${id}`)).body.document;
    expect(doc.content).toBe("<p>bob</p>");
    expect(doc.revision).toBe(3);
    expect(await countRows("document_versions", id)).toBe(2);
  });

  it("two concurrent saves on the same revision: exactly one wins, one gets 409", async () => {
    const { id } = await createDoc(alice, "Concurrent");
    await share(alice, id, "bob", "editor");
    const [a, b] = await Promise.all([
      alice.put(`/api/documents/${id}/content`, { content: "<p>from alice</p>", baseRevision: 1 }),
      bob.put(`/api/documents/${id}/content`, { content: "<p>from bob</p>", baseRevision: 1 }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = a.status === 200 ? "<p>from alice</p>" : "<p>from bob</p>";
    const doc = (await alice.get(`/api/documents/${id}`)).body.document;
    expect(doc.revision).toBe(2);
    expect(doc.content).toBe(winner);
    expect(await countRows("document_versions", id)).toBe(1);
  });

  it("many concurrent saves on the same revision still produce a single winner", async () => {
    const { id } = await createDoc(alice, "Stampede");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        alice.put(`/api/documents/${id}/content`, { content: `<p>${i}</p>`, baseRevision: 1 }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    expect(await countRows("document_versions", id)).toBe(1);
  });
});

describe("delete (EC-22, AC-ACCESS)", () => {
  it("owner delete removes the document, its shares and versions", async () => {
    const { id } = await createDoc(alice, "To delete", "<p>a</p>");
    await share(alice, id, "bob", "viewer");
    expect(await countRows("document_shares", id)).toBe(1);
    expect(await countRows("document_versions", id)).toBe(1);

    const res = await alice.delete(`/api/documents/${id}`);
    expect(res.status).toBe(204);
    expect((await alice.get(`/api/documents/${id}`)).status).toBe(404);
    expect((await bob.get(`/api/documents/${id}`)).status).toBe(404);
    expect(await countRows("document_shares", id)).toBe(0);
    expect(await countRows("document_versions", id)).toBe(0);
    const list = await bob.get("/api/documents");
    expect(list.body.shared.find((d: { id: string }) => d.id === id)).toBeUndefined();
  });

  it("deleting twice -> 404 the second time", async () => {
    const { id } = await createDoc(alice, "Twice");
    expect((await alice.delete(`/api/documents/${id}`)).status).toBe(204);
    expect((await alice.delete(`/api/documents/${id}`)).status).toBe(404);
  });

  it("a save after the document is deleted -> 404 (EC-6)", async () => {
    const { id } = await createDoc(alice, "Gone");
    await share(alice, id, "bob", "editor");
    await alice.delete(`/api/documents/${id}`);
    const res = await bob.put(`/api/documents/${id}/content`, { content: "<p>x</p>", baseRevision: 1 });
    expect(res.status).toBe(404);
    const rename = await bob.patch(`/api/documents/${id}`, { title: "y" });
    expect(rename.status).toBe(404);
  });
});

describe("unauthenticated access is still 401 with valid ids", () => {
  it("does not leak existence to anonymous callers", async () => {
    const { id } = await createDoc(alice, "Secret");
    const res = await request(ctx.app).get(`/api/documents/${id}`);
    expect(res.status).toBe(401);
  });
});
