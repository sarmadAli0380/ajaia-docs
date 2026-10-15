import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "../../shared/limits.js";
import { createApp } from "../app.js";
import { ConfigError, loadConfig } from "../config.js";
import { SESSION_COOKIE } from "../http/auth.js";
import { serveClient } from "../http/static.js";
import { SESSION_TTL_MS, signSession } from "../services/session.js";
import { ApiClient, TEST_SECRET, USERS, createDoc, createTestContext, signIn, type TestContext } from "./helpers.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

const DOC = "00000000-0000-4000-8000-000000000000";
const VERSION = "00000000-0000-4000-8000-0000000000ff";

/** Every /api/documents* route (AC-AUTH). */
const PROTECTED: Array<[method: "get" | "post" | "put" | "patch" | "delete", path: string]> = [
  ["get", "/api/documents"],
  ["post", "/api/documents"],
  ["post", "/api/documents/import"],
  ["get", `/api/documents/${DOC}`],
  ["patch", `/api/documents/${DOC}`],
  ["put", `/api/documents/${DOC}/content`],
  ["delete", `/api/documents/${DOC}`],
  ["get", `/api/documents/${DOC}/shares`],
  ["post", `/api/documents/${DOC}/shares`],
  ["delete", `/api/documents/${DOC}/shares/${USERS.bob.id}`],
  ["get", `/api/documents/${DOC}/versions`],
  ["get", `/api/documents/${DOC}/versions/${VERSION}`],
  ["post", `/api/documents/${DOC}/versions/${VERSION}/restore`],
  ["get", `/api/documents/${DOC}/export`],
];

describe("health and routing", () => {
  it("GET /api/health reports ok", async () => {
    const res = await request(ctx.app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("unknown API routes return JSON 404, not HTML", async () => {
    const res = await request(ctx.app).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("sets basic security headers", async () => {
    const res = await request(ctx.app).get("/api/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("mocked sign-in (AC-AUTH)", () => {
  it("lists the three seeded users publicly for the login screen", async () => {
    const res = await request(ctx.app).get("/api/users");
    expect(res.status).toBe(200);
    expect(res.body.users.map((u: { name: string }) => u.name)).toEqual(["Alice", "Bob", "Carol"]);
    expect(res.body.users[0]).toEqual({ id: USERS.alice.id, name: "Alice", email: "alice@ajaia.test" });
  });

  it.each(["alice", "bob", "carol"] as const)("signs in as %s with an httpOnly SameSite=Lax cookie", async (key) => {
    const client = new ApiClient(ctx.app);
    const res = await client.post("/api/session", { userId: USERS[key].id });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(USERS[key].id);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/i); // only in production

    const me = await client.get("/api/session");
    expect(me.status).toBe(200);
    expect(me.body.user.name).toBe(USERS[key].name);
  });

  it("logout clears the session", async () => {
    const client = await signIn(ctx, "alice");
    expect((await client.get("/api/documents")).status).toBe(200);
    const out = await client.delete("/api/session");
    expect(out.status).toBe(204);
    expect(String(out.headers["set-cookie"])).toMatch(new RegExp(`${SESSION_COOKIE}=;`));
    expect((await client.get("/api/session")).status).toBe(401);
    expect((await client.get("/api/documents")).status).toBe(401);
  });

  it("rejects unknown or malformed user ids with 400", async () => {
    const client = new ApiClient(ctx.app);
    expect((await client.post("/api/session", { userId: DOC })).status).toBe(400);
    expect((await client.post("/api/session", { userId: "alice" })).status).toBe(400);
    expect((await client.post("/api/session", { userId: 42 })).status).toBe(400);
    expect((await client.post("/api/session", {})).status).toBe(400);
  });

  it("requires the CSRF header to sign in", async () => {
    const res = await request(ctx.app).post("/api/session").send({ userId: USERS.alice.id });
    expect(res.status).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("GET /api/session without a cookie is 401", async () => {
    const res = await request(ctx.app).get("/api/session");
    expect(res.status).toBe(401);
    expect(res.body.error).toBeTruthy();
  });
});

describe("session enforcement on /api/documents* (AC-AUTH, EC-7)", () => {
  it.each(PROTECTED)("%s %s -> 401 without a session", async (method, path) => {
    const res = await request(ctx.app)[method](path).set(CSRF_HEADER, CSRF_HEADER_VALUE);
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(/json/);
  });

  it.each(PROTECTED)("%s %s -> 401 with a tampered cookie", async (method, path) => {
    const valid = signSession(TEST_SECRET, USERS.alice.id, Date.now());
    const [body, sig] = valid.split(".") as [string, string];
    const forgedBody = Buffer.from(JSON.stringify({ uid: USERS.bob.id, iat: Date.now() })).toString("base64url");
    // Flip one character in the middle of the signature (always changes the decoded bytes).
    const mid = Math.floor(sig.length / 2);
    const flipped = `${sig.slice(0, mid)}${sig[mid] === "A" ? "B" : "A"}${sig.slice(mid + 1)}`;
    for (const cookie of [`${forgedBody}.${sig}`, `${body}.${flipped}`, `${body}.${sig}x`, body, "garbage"]) {
      const res = await request(ctx.app)
        [method](path)
        .set(CSRF_HEADER, CSRF_HEADER_VALUE)
        .set("Cookie", `${SESSION_COOKIE}=${cookie}`);
      expect(res.status).toBe(401);
    }
  });

  it("rejects non-canonical encodings of a valid signature", async () => {
    // The last base64url character of a 32-byte HMAC carries 2 ignored bits.
    const valid = signSession(TEST_SECRET, USERS.alice.id, Date.now());
    const [body, sig] = valid.split(".") as [string, string];
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(sig[sig.length - 1]!);
    const variant = alphabet[last ^ 1]!; // same upper 4 bits, different ignored bit
    const token = `${body}.${sig.slice(0, -1)}${variant}`;
    expect(Buffer.from(token.split(".")[1]!, "base64url")).toEqual(Buffer.from(sig, "base64url"));
    const res = await request(ctx.app).get("/api/documents").set("Cookie", `${SESSION_COOKIE}=${token}`);
    expect(res.status).toBe(401);
  });

  it("rejects a cookie signed with a different secret", async () => {
    const token = signSession("another-secret-another-secret-another", USERS.alice.id, Date.now());
    const res = await request(ctx.app).get("/api/documents").set("Cookie", `${SESSION_COOKIE}=${token}`);
    expect(res.status).toBe(401);
  });

  it("rejects an expired session", async () => {
    const issued = Date.now() - SESSION_TTL_MS - 1000;
    const token = signSession(TEST_SECRET, USERS.alice.id, issued);
    const res = await request(ctx.app).get("/api/documents").set("Cookie", `${SESSION_COOKIE}=${token}`);
    expect(res.status).toBe(401);
    const fresh = signSession(TEST_SECRET, USERS.alice.id, Date.now() - 1000);
    const ok = await request(ctx.app).get("/api/documents").set("Cookie", `${SESSION_COOKIE}=${fresh}`);
    expect(ok.status).toBe(200);
  });

  it("rejects state-changing requests without the CSRF header even with a session", async () => {
    const client = await signIn(ctx, "alice");
    const res = await client.agent.post("/api/documents").send({ title: "x" });
    expect(res.status).toBe(403);
    const list = await client.get("/api/documents");
    expect(list.body.owned.some((d: { title: string }) => d.title === "x")).toBe(false);
  });
});

describe("configuration", () => {
  it("fails fast without SESSION_SECRET in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: "production", SESSION_SECRET: "short" })).toThrow(ConfigError);
    const cfg = loadConfig({ NODE_ENV: "production", SESSION_SECRET: "x".repeat(40), PORT: "8080" });
    expect(cfg).toMatchObject({ production: true, port: 8080, databaseUrl: null });
  });

  it("falls back to a dev secret and .data/pglite outside production", () => {
    const cfg = loadConfig({});
    expect(cfg.usingDevSecret).toBe(true);
    expect(cfg.pgliteDir).toBe(".data/pglite");
    expect(cfg.port).toBe(3000);
    expect(() => loadConfig({ PORT: "abc" })).toThrow(ConfigError);
  });

  it("sets Secure cookies when production is enabled", async () => {
    const app = createApp({ db: ctx.db, sessionSecret: TEST_SECRET, production: true });
    const res = await request(app)
      .post("/api/session")
      .set(CSRF_HEADER, CSRF_HEADER_VALUE)
      .send({ userId: USERS.alice.id });
    expect(String(res.headers["set-cookie"])).toMatch(/Secure/);
  });
});

describe("SPA serving (single process)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ajaia-client-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("serves index.html for client routes and keeps JSON 404s for unknown API paths", async () => {
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Ajaia Docs</title><div id=root></div>");
    const app = createApp({ db: ctx.db, sessionSecret: TEST_SECRET, mountFrontend: serveClient(dir) });
    const page = await request(app).get("/documents/abc");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Ajaia Docs");
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    const api = await request(app).get("/api/does-not-exist");
    expect(api.status).toBe(404);
    expect(api.body).toEqual({ error: "Not found" });
  });

  it("serves the SPA when installed under a hidden directory", async () => {
    const hidden = path.join(dir, ".hidden", "client");
    mkdirSync(hidden, { recursive: true });
    writeFileSync(path.join(hidden, "index.html"), "<!doctype html><title>Hidden install</title>");
    mkdirSync(path.join(hidden, "assets"));
    writeFileSync(path.join(hidden, "assets", "app-123.js"), "console.log(1)");
    const app = createApp({ db: ctx.db, sessionSecret: TEST_SECRET, mountFrontend: serveClient(hidden) });
    const page = await request(app).get("/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Hidden install");
    const asset = await request(app).get("/assets/app-123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["cache-control"]).toContain("immutable");
    const dotfile = await request(app).get("/.env");
    expect(dotfile.text).not.toContain("SECRET");
  });

  it("refuses to start without a built client", () => {
    expect(() => serveClient(path.join(dir, "missing"))).toThrow(/npm run build/);
  });
});

describe("dashboard scoping", () => {
  it("never lists documents the user neither owns nor has been shared", async () => {
    const alice = await signIn(ctx, "alice");
    const carol = await signIn(ctx, "carol");
    const doc = await createDoc(alice, "Alice private");
    const list = await carol.get("/api/documents");
    expect(list.status).toBe(200);
    const ids = [...list.body.owned, ...list.body.shared].map((d: { id: string }) => d.id);
    expect(ids).not.toContain(doc.id);
  });
});
