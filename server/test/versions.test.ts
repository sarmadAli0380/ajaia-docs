import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION_RETENTION } from "../../shared/limits.js";
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

async function save(client: ApiClient, id: string, content: string, baseRevision: number): Promise<number> {
  const res = await client.put(`/api/documents/${id}/content`, { content, baseRevision });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.revision as number;
}

describe("version history (AC-VERSIONS)", () => {
  it("a new blank document has no versions (empty state)", async () => {
    const { id } = await createDoc(alice, "Blank");
    const res = await alice.get(`/api/documents/${id}/versions`);
    expect(res.status).toBe(200);
    expect(res.body.versions).toEqual([]);
  });

  it("each successful save records one snapshot, newest first, with author", async () => {
    const { id } = await createDoc(alice, "History");
    await share(alice, id, "bob", "editor");
    let rev = await save(alice, id, "<p>one</p>", 1);
    rev = await save(bob, id, "<p>two</p>", rev);
    await save(alice, id, "<p>three</p>", rev);

    const res = await alice.get(`/api/documents/${id}/versions`);
    const versions = res.body.versions;
    expect(versions.map((v: { revision: number }) => v.revision)).toEqual([4, 3, 2]);
    expect(versions[1]).toMatchObject({ source: "save", createdBy: { id: USERS.bob.id, name: "Bob" } });
    expect(versions[0]).not.toHaveProperty("content");

    const preview = await alice.get(`/api/documents/${id}/versions/${versions[1].id}`);
    expect(preview.status).toBe(200);
    expect(preview.body.version).toMatchObject({ revision: 3, content: "<p>two</p>" });
  });

  it("failed saves (409/403/413) do not create versions", async () => {
    const { id } = await createDoc(alice, "No version on failure");
    await share(alice, id, "carol", "viewer");
    await save(alice, id, "<p>ok</p>", 1);
    expect((await alice.put(`/api/documents/${id}/content`, { content: "<p>x</p>", baseRevision: 1 })).status).toBe(409);
    expect((await carol.put(`/api/documents/${id}/content`, { content: "<p>x</p>", baseRevision: 2 })).status).toBe(403);
    expect(
      (await alice.put(`/api/documents/${id}/content`, { content: "x".repeat(1024 * 1024 + 1), baseRevision: 2 })).status,
    ).toBe(413);
    expect((await alice.get(`/api/documents/${id}/versions`)).body.versions).toHaveLength(1);
  });

  it("viewer can list and preview but not restore", async () => {
    const { id } = await createDoc(alice, "Viewer history", "<p>v</p>");
    await share(alice, id, "carol", "viewer");
    const list = await carol.get(`/api/documents/${id}/versions`);
    expect(list.status).toBe(200);
    const versionId = list.body.versions[0].id;
    expect((await carol.get(`/api/documents/${id}/versions/${versionId}`)).status).toBe(200);
    const restore = await carol.post(`/api/documents/${id}/versions/${versionId}/restore`);
    expect(restore.status).toBe(403);
  });

  it("restore makes the version current, bumps revision and is itself recorded", async () => {
    const { id } = await createDoc(alice, "Restore");
    let rev = await save(alice, id, "<p>original</p>", 1);
    rev = await save(alice, id, "<p>changed</p>", rev);
    const versions = (await alice.get(`/api/documents/${id}/versions`)).body.versions;
    const original = versions.find((v: { revision: number }) => v.revision === 2);

    const res = await alice.post(`/api/documents/${id}/versions/${original.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ revision: rev + 1, content: "<p>original</p>", restoredFromRevision: 2 });

    const doc = (await alice.get(`/api/documents/${id}`)).body.document;
    expect(doc.content).toBe("<p>original</p>");
    expect(doc.revision).toBe(rev + 1);

    const after = (await alice.get(`/api/documents/${id}/versions`)).body.versions;
    expect(after[0]).toMatchObject({ revision: rev + 1, source: "restore", restoredFromRevision: 2 });

    // A save based on the pre-restore revision is now stale.
    const stale = await alice.put(`/api/documents/${id}/content`, { content: "<p>late</p>", baseRevision: rev });
    expect(stale.status).toBe(409);
  });

  it("editor can restore; restoring the same version twice records two snapshots", async () => {
    const { id } = await createDoc(alice, "Repeat restore", "<p>a</p>");
    await share(alice, id, "bob", "editor");
    const v = (await bob.get(`/api/documents/${id}/versions`)).body.versions[0];
    expect((await bob.post(`/api/documents/${id}/versions/${v.id}/restore`)).status).toBe(200);
    expect((await bob.post(`/api/documents/${id}/versions/${v.id}/restore`)).status).toBe(200);
    const versions = (await bob.get(`/api/documents/${id}/versions`)).body.versions;
    expect(versions.map((x: { revision: number }) => x.revision)).toEqual([4, 3, 2]);
  });

  it("version lookups are scoped to their document (no IDOR)", async () => {
    const mine = await createDoc(alice, "Mine", "<p>mine</p>");
    const theirs = await createDoc(bob, "Theirs", "<p>secret</p>");
    const theirVersion = (await bob.get(`/api/documents/${theirs.id}/versions`)).body.versions[0];
    expect((await alice.get(`/api/documents/${mine.id}/versions/${theirVersion.id}`)).status).toBe(404);
    expect((await alice.post(`/api/documents/${mine.id}/versions/${theirVersion.id}/restore`)).status).toBe(404);
    expect((await alice.get(`/api/documents/${mine.id}/versions/not-a-uuid`)).status).toBe(404);
    expect((await alice.get(`/api/documents/${mine.id}/versions/${randomUUID()}`)).status).toBe(404);
    expect((await alice.get(`/api/documents/${mine.id}`)).body.document.content).toBe("<p>mine</p>");
  });

  it(`keeps only the latest ${VERSION_RETENTION} snapshots`, async () => {
    const { id } = await createDoc(alice, "Retention");
    let rev = 1;
    const total = VERSION_RETENTION + 2;
    for (let i = 1; i <= total; i++) rev = await save(alice, id, `<p>${i}</p>`, rev);
    const versions = (await alice.get(`/api/documents/${id}/versions`)).body.versions;
    expect(versions).toHaveLength(VERSION_RETENTION);
    expect(versions[0].revision).toBe(total + 1);
    expect(versions[versions.length - 1].revision).toBe(total + 1 - VERSION_RETENTION + 1);
  });

  it("restore re-sanitizes stored snapshot content", async () => {
    const { id } = await createDoc(alice, "Legacy snapshot");
    const versionId = randomUUID();
    // Simulate a snapshot written before a sanitizer rule existed.
    await ctx.db.query(
      `INSERT INTO document_versions (id, document_id, revision, content, source, created_by)
       VALUES ($1, $2, 99, $3, 'save', $4)`,
      [versionId, id, '<p onclick="x()">hi</p><script>alert(1)</script>', USERS.alice.id],
    );
    const res = await alice.post(`/api/documents/${id}/versions/${versionId}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("<p>hi</p>");
  });
});
