import { deflateRawSync } from "node:zlib";
import type { Express } from "express";
import request from "supertest";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "../../shared/limits.js";
import { createApp } from "../app.js";
import { openDatabase, type Db } from "../db/index.js";
import { SEED_USERS } from "../db/schema.js";
import type { Logger } from "../http/errors.js";

export const TEST_SECRET = "test-session-secret-0123456789abcdef0123456789";

export const USERS = {
  alice: SEED_USERS[0],
  bob: SEED_USERS[1],
  carol: SEED_USERS[2],
} as const;

export type UserKey = keyof typeof USERS;

export interface RecordingLogger extends Logger {
  errors: Array<{ message: string; err: unknown }>;
}

export function recordingLogger(): RecordingLogger {
  const errors: Array<{ message: string; err: unknown }> = [];
  return { errors, info: () => undefined, error: (message, err) => errors.push({ message, err }) };
}

export interface TestContext {
  app: Express;
  db: Db;
  logger: RecordingLogger;
  close(): Promise<void>;
}

/** Fresh in-memory PGlite + app. One per test file keeps files isolated. */
export async function createTestContext(options: { db?: Db; now?: () => number } = {}): Promise<TestContext> {
  const db = options.db ?? (await openDatabase({ databaseUrl: null, pgliteDir: null }));
  const logger = recordingLogger();
  const app = createApp({ db, sessionSecret: TEST_SECRET, production: false, logger, now: options.now });
  return { app, db, logger, close: () => db.close() };
}

type Agent = ReturnType<typeof request.agent>;

/** Cookie-keeping client that adds the CSRF header to state-changing requests. */
export class ApiClient {
  readonly agent: Agent;

  constructor(app: Express) {
    this.agent = request.agent(app);
  }

  get(path: string) {
    return this.agent.get(path);
  }

  post(path: string, body?: unknown) {
    const req = this.agent.post(path).set(CSRF_HEADER, CSRF_HEADER_VALUE);
    return body === undefined ? req : req.send(body as object);
  }

  put(path: string, body?: unknown) {
    const req = this.agent.put(path).set(CSRF_HEADER, CSRF_HEADER_VALUE);
    return body === undefined ? req : req.send(body as object);
  }

  patch(path: string, body?: unknown) {
    const req = this.agent.patch(path).set(CSRF_HEADER, CSRF_HEADER_VALUE);
    return body === undefined ? req : req.send(body as object);
  }

  delete(path: string) {
    return this.agent.delete(path).set(CSRF_HEADER, CSRF_HEADER_VALUE);
  }

  upload(filename: string, content: Buffer | string, field = "file") {
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    return this.agent
      .post("/api/documents/import")
      .set(CSRF_HEADER, CSRF_HEADER_VALUE)
      .attach(field, buf, { filename, contentType: "application/octet-stream" });
  }
}

export async function signIn(ctx: TestContext, user: UserKey): Promise<ApiClient> {
  const client = new ApiClient(ctx.app);
  const res = await client.post("/api/session", { userId: USERS[user].id });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  return client;
}

export interface CreatedDoc {
  id: string;
  revision: number;
}

/** Creates a document (optionally with saved content) owned by `client`'s user. */
export async function createDoc(client: ApiClient, title?: string, content?: string): Promise<CreatedDoc> {
  const res = await client.post("/api/documents", title === undefined ? {} : { title });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  const id = res.body.document.id as string;
  let revision = res.body.document.revision as number;
  if (content !== undefined) {
    const save = await client.put(`/api/documents/${id}/content`, { content, baseRevision: revision });
    if (save.status !== 200) throw new Error(`save failed: ${save.status} ${JSON.stringify(save.body)}`);
    revision = save.body.revision as number;
  }
  return { id, revision };
}

export async function share(owner: ApiClient, docId: string, user: UserKey, role: "viewer" | "editor") {
  const res = await owner.post(`/api/documents/${docId}/shares`, { userId: USERS[user].id, role });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`share failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

// ---------------------------------------------------------------------------------
// Minimal DOCX builder (stored ZIP, no compression) for deterministic fixtures.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface MakeZipOptions {
  /** Entry names to store deflated (method 8) instead of stored. */
  deflate?: string[];
  /** Lie about an entry's uncompressed size in both headers (zip-bomb fixtures). */
  declaredUncompressed?: Record<string, number>;
}

export function makeZip(files: Record<string, string | Buffer>, options: MakeZipOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const method = options.deflate?.includes(name) ? 8 : 0;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const declared = options.declaredUncompressed?.[name] ?? raw.length;
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const count = Object.keys(files).length;
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Builds a .docx whose body is `bodyXml` (WordprocessingML paragraphs). */
export function makeDocx(
  bodyXml: string,
  options: { hyperlinkTarget?: string; extraFiles?: Record<string, Buffer>; zip?: MakeZipOptions } = {},
): Buffer {
  const hyperlinkRel = options.hyperlinkTarget
    ? `<Relationship Id="rIdLink" Type="${REL_TYPE}/hyperlink" Target="${options.hyperlinkTarget}" TargetMode="External"/>`
    : "";
  return makeZip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${REL_TYPE}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="${REL_NS}">
<Relationship Id="rId1" Type="${REL_TYPE}/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="${REL_TYPE}/numbering" Target="numbering.xml"/>
${hyperlinkRel}
</Relationships>`,
    "word/styles.xml": `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="${W_NS}">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`,
    "word/numbering.xml": `<?xml version="1.0" encoding="UTF-8"?>
<w:numbering xmlns:w="${W_NS}">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${bodyXml}</w:body></w:document>`,
    ...options.extraFiles,
  }, options.zip);
}

export const docxPara = {
  heading: (level: 1 | 2, text: string) =>
    `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`,
  text: (text: string, marks: { b?: boolean; i?: boolean; u?: boolean } = {}) => {
    const rPr = `${marks.b ? "<w:b/>" : ""}${marks.i ? "<w:i/>" : ""}${marks.u ? '<w:u w:val="single"/>' : ""}`;
    return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
  },
  paragraph: (runs: string) => `<w:p>${runs}</w:p>`,
  bullet: (text: string) =>
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`,
  numbered: (text: string) =>
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`,
  hyperlink: (text: string) => `<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>${text}</w:t></w:r></w:hyperlink></w:p>`,
};
