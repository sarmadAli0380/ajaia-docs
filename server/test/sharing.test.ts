import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { USERS, createDoc, createTestContext, share, signIn, type ApiClient, type TestContext } from "./helpers.js";

let ctx: TestContext;
let alice: ApiClient;
let bob: ApiClient;
let carol: ApiClient;

beforeAll(async () => {
  ctx = await createTestContext();
  alice = await signIn(ctx, "alice");
  bob = await signIn(ctx, "bob");
  carol = await signIn(ctx, "carol");
});
afterAll(async () => {
  await ctx.close();
});

async function shareRows(documentId: string) {
  const { rows } = await ctx.db.query<{ user_id: string; role: string }>(
    "SELECT user_id, role FROM document_shares WHERE document_id = $1 ORDER BY user_id",
    [documentId],
  );
  return rows;
}

describe("grant, change, revoke (AC-SHARE)", () => {
  it("grants viewer access (201), lists it, and the grantee can read", async () => {
    const { id } = await createDoc(alice, "Share me");
    const res = await alice.post(`/api/documents/${id}/shares`, { userId: USERS.bob.id, role: "viewer" });
    expect(res.status).toBe(201);
    expect(res.body.share).toMatchObject({ user: { id: USERS.bob.id, name: "Bob" }, role: "viewer" });

    const list = await alice.get(`/api/documents/${id}/shares`);
    expect(list.body.shares).toHaveLength(1);
    expect((await bob.get(`/api/documents/${id}`)).status).toBe(200);
  });

  it("re-sharing an existing grantee updates the role instead of duplicating (EC-10)", async () => {
    const { id } = await createDoc(alice, "Upsert");
    await share(alice, id, "bob", "viewer");
    const res = await alice.post(`/api/documents/${id}/shares`, { userId: USERS.bob.id, role: "editor" });
    expect(res.status).toBe(200);
    expect(res.body.share.role).toBe("editor");
    expect(await shareRows(id)).toEqual([{ user_id: USERS.bob.id, role: "editor" }]);

    // Same role again is a no-op update.
    const again = await alice.post(`/api/documents/${id}/shares`, { userId: USERS.bob.id, role: "editor" });
    expect(again.status).toBe(200);
    expect(await shareRows(id)).toHaveLength(1);
  });

  it("revoke removes access immediately; revoking again is 404", async () => {
    const { id } = await createDoc(alice, "Revoke");
    await share(alice, id, "bob", "editor");
    expect((await alice.delete(`/api/documents/${id}/shares/${USERS.bob.id}`)).status).toBe(204);
    expect((await bob.get(`/api/documents/${id}`)).status).toBe(404);
    expect((await alice.delete(`/api/documents/${id}/shares/${USERS.bob.id}`)).status).toBe(404);
    expect((await alice.delete(`/api/documents/${id}/shares/not-a-uuid`)).status).toBe(404);
  });
});

describe("invalid share requests (EC-10)", () => {
  it.each([
    ["self (the owner)", () => ({ userId: USERS.alice.id, role: "viewer" })],
    ["unknown user", () => ({ userId: "99999999-9999-4999-8999-999999999999", role: "viewer" })],
    ["malformed user id", () => ({ userId: "bob", role: "viewer" })],
    ["missing user id", () => ({ role: "viewer" })],
    ["invalid role", () => ({ userId: USERS.bob.id, role: "owner" })],
    ["role wrong type", () => ({ userId: USERS.bob.id, role: 1 })],
    ["missing role", () => ({ userId: USERS.bob.id })],
  ])("rejects %s with 400", async (_label, body) => {
    const { id } = await createDoc(alice, "Invalid share");
    const res = await alice.post(`/api/documents/${id}/shares`, body());
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
    expect(await shareRows(id)).toHaveLength(0);
  });

  it("rejects the owner's id in upper case (UUIDs are case-insensitive) with 400 and no share row", async () => {
    const { id } = await createDoc(alice, "Upper-case owner");
    const res = await alice.post(`/api/documents/${id}/shares`, { userId: USERS.alice.id.toUpperCase(), role: "editor" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owner/i);
    expect(await shareRows(id)).toHaveLength(0);
  });

  it("an upper-case grantee id is stored canonically and upserts the same row", async () => {
    const { id } = await createDoc(alice, "Upper-case grantee");
    const first = await alice.post(`/api/documents/${id}/shares`, { userId: USERS.bob.id.toUpperCase(), role: "viewer" });
    expect(first.status).toBe(201);
    expect(first.body.share.user.id).toBe(USERS.bob.id);
    const second = await alice.post(`/api/documents/${id}/shares`, { userId: USERS.bob.id, role: "editor" });
    expect(second.status).toBe(200);
    expect(await shareRows(id)).toEqual([{ user_id: USERS.bob.id, role: "editor" }]);
  });

  it("editor cannot share the document with its owner either", async () => {
    const { id } = await createDoc(alice, "Owner share");
    await share(alice, id, "bob", "editor");
    const res = await bob.post(`/api/documents/${id}/shares`, { userId: USERS.alice.id, role: "viewer" });
    expect(res.status).toBe(403);
  });
});

describe("non-owners managing shares (EC-11)", () => {
  it("editor/viewer get 403 for share, revoke, list and delete", async () => {
    const { id } = await createDoc(alice, "Managed");
    await share(alice, id, "bob", "editor");
    await share(alice, id, "carol", "viewer");
    for (const actor of [bob, carol]) {
      expect((await actor.post(`/api/documents/${id}/shares`, { userId: USERS.carol.id, role: "editor" })).status).toBe(
        403,
      );
      expect((await actor.delete(`/api/documents/${id}/shares/${USERS.bob.id}`)).status).toBe(403);
      expect((await actor.get(`/api/documents/${id}/shares`)).status).toBe(403);
      expect((await actor.delete(`/api/documents/${id}`)).status).toBe(403);
    }
    expect(await shareRows(id)).toHaveLength(2);
  });

  it("users with no access get 404", async () => {
    const { id } = await createDoc(alice, "Hidden");
    expect((await carol.post(`/api/documents/${id}/shares`, { userId: USERS.bob.id, role: "editor" })).status).toBe(404);
    expect((await carol.delete(`/api/documents/${id}/shares/${USERS.bob.id}`)).status).toBe(404);
    expect((await carol.delete(`/api/documents/${id}`)).status).toBe(404);
  });
});

describe("access changes while a document is open (EC-6)", () => {
  it("revoked editor's next save and rename -> 404", async () => {
    const { id } = await createDoc(alice, "Open");
    await share(alice, id, "bob", "editor");
    const opened = (await bob.get(`/api/documents/${id}`)).body.document;
    await alice.delete(`/api/documents/${id}/shares/${USERS.bob.id}`);
    const save = await bob.put(`/api/documents/${id}/content`, { content: "<p>x</p>", baseRevision: opened.revision });
    expect(save.status).toBe(404);
    expect((await bob.patch(`/api/documents/${id}`, { title: "x" })).status).toBe(404);
  });

  it("editor downgraded to viewer -> next save 403", async () => {
    const { id } = await createDoc(alice, "Downgrade");
    await share(alice, id, "bob", "editor");
    await share(alice, id, "bob", "viewer");
    const save = await bob.put(`/api/documents/${id}/content`, { content: "<p>x</p>", baseRevision: 1 });
    expect(save.status).toBe(403);
  });

  it("editor can edit and rename but not share or delete", async () => {
    const { id } = await createDoc(alice, "Editor rights");
    await share(alice, id, "bob", "editor");
    expect((await bob.put(`/api/documents/${id}/content`, { content: "<p>b</p>", baseRevision: 1 })).status).toBe(200);
    expect((await bob.patch(`/api/documents/${id}`, { title: "By Bob" })).status).toBe(200);
    expect((await bob.post(`/api/documents/${id}/shares`, { userId: USERS.carol.id, role: "viewer" })).status).toBe(403);
    expect((await bob.delete(`/api/documents/${id}`)).status).toBe(403);
  });
});
