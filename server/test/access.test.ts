import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { USERS, createDoc, createTestContext, share, signIn, type ApiClient, type TestContext } from "./helpers.js";

/**
 * Role matrix (AC-ACCESS, REG-7): every document endpoint x {owner, editor, viewer,
 * no access}. No access is always 404; insufficient role is 403.
 */
let ctx: TestContext;
let clients: Record<"owner" | "editor" | "viewer" | "none", ApiClient>;

beforeAll(async () => {
  ctx = await createTestContext();
  clients = {
    owner: await signIn(ctx, "alice"),
    editor: await signIn(ctx, "bob"),
    viewer: await signIn(ctx, "carol"),
    none: await signIn(ctx, "carol"), // "none" cases use a fixture without any shares
  };
});
afterAll(async () => {
  await ctx.close();
});

type Actor = "owner" | "editor" | "viewer" | "none";

interface Fixture {
  id: string;
  revision: number;
  versionId: string;
}

/** Alice owns; Bob edits; Carol views. For "none", a second doc with no shares is used. */
async function fixture(withShares: boolean): Promise<Fixture> {
  const doc = await createDoc(clients.owner, "Matrix", "<p>v1</p>");
  if (withShares) {
    await share(clients.owner, doc.id, "bob", "editor");
    await share(clients.owner, doc.id, "carol", "viewer");
  }
  const versions = await clients.owner.get(`/api/documents/${doc.id}/versions`);
  return { ...doc, versionId: versions.body.versions[0].id };
}

type Op = (c: ApiClient, f: Fixture) => Promise<{ status: number; body: { error?: string } }>;

const OPS: Record<string, Op> = {
  read: (c, f) => c.get(`/api/documents/${f.id}`),
  save: (c, f) => c.put(`/api/documents/${f.id}/content`, { content: "<p>new</p>", baseRevision: f.revision }),
  rename: (c, f) => c.patch(`/api/documents/${f.id}`, { title: "Renamed" }),
  listVersions: (c, f) => c.get(`/api/documents/${f.id}/versions`),
  previewVersion: (c, f) => c.get(`/api/documents/${f.id}/versions/${f.versionId}`),
  restore: (c, f) => c.post(`/api/documents/${f.id}/versions/${f.versionId}/restore`),
  export: (c, f) => c.get(`/api/documents/${f.id}/export`),
  listShares: (c, f) => c.get(`/api/documents/${f.id}/shares`),
  share: (c, f) => c.post(`/api/documents/${f.id}/shares`, { userId: USERS.carol.id, role: "editor" }),
  revoke: (c, f) => c.delete(`/api/documents/${f.id}/shares/${USERS.bob.id}`),
  delete: (c, f) => c.delete(`/api/documents/${f.id}`),
};

const EXPECTED: Record<string, Record<Actor, number>> = {
  read: { owner: 200, editor: 200, viewer: 200, none: 404 },
  save: { owner: 200, editor: 200, viewer: 403, none: 404 },
  rename: { owner: 200, editor: 200, viewer: 403, none: 404 },
  listVersions: { owner: 200, editor: 200, viewer: 200, none: 404 },
  previewVersion: { owner: 200, editor: 200, viewer: 200, none: 404 },
  restore: { owner: 200, editor: 200, viewer: 403, none: 404 },
  export: { owner: 200, editor: 200, viewer: 200, none: 404 },
  listShares: { owner: 200, editor: 403, viewer: 403, none: 404 },
  share: { owner: 200, editor: 403, viewer: 403, none: 404 },
  revoke: { owner: 204, editor: 403, viewer: 403, none: 404 },
  delete: { owner: 204, editor: 403, viewer: 403, none: 404 },
};

const cases: Array<[string, Actor, number]> = [];
for (const [op, byActor] of Object.entries(EXPECTED)) {
  for (const actor of ["owner", "editor", "viewer", "none"] as const) cases.push([op, actor, byActor[actor]]);
}

describe("role matrix", () => {
  it.each(cases)("%s as %s -> %i", async (op, actor, expected) => {
    const f = await fixture(actor !== "none");
    // Owner "share" re-shares Carol (already a viewer) -> upsert -> 200.
    const before = (await clients.owner.get(`/api/documents/${f.id}`)).body.document;
    const res = await OPS[op]!(clients[actor], f);
    expect(res.status).toBe(expected);

    // Denied operations must not have changed anything.
    if (expected >= 400) {
      const after = await clients.owner.get(`/api/documents/${f.id}`);
      expect(after.status).toBe(200);
      expect(after.body.document.revision).toBe(before.revision);
      expect(after.body.document.title).toBe(before.title);
      expect(after.body.document.content).toBe(before.content);
    }
  });
});

describe("read-only role details", () => {
  it("viewer sees role 'viewer' on the document and in the dashboard", async () => {
    const f = await fixture(true);
    const doc = await clients.viewer.get(`/api/documents/${f.id}`);
    expect(doc.body.document.role).toBe("viewer");
    const list = await clients.viewer.get("/api/documents");
    expect(list.body.shared.find((d: { id: string }) => d.id === f.id)?.role).toBe("viewer");
  });

  it("forbidden responses explain why", async () => {
    const f = await fixture(true);
    const res = await OPS.save!(clients.viewer, f);
    expect(res.body.error).toMatch(/view-only/i);
    const del = await OPS.delete!(clients.editor, f);
    expect(del.body.error).toMatch(/owner/i);
  });
});
