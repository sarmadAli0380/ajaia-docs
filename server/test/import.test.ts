import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_TITLE, MAX_UPLOAD_BYTES } from "../../shared/limits.js";
import { titleFromFilename } from "../services/importer.js";
import { USERS, createTestContext, docxPara as p, makeDocx, makeZip, signIn, type ApiClient, type TestContext } from "./helpers.js";

let ctx: TestContext;
let alice: ApiClient;

beforeAll(async () => {
  ctx = await createTestContext();
  alice = await signIn(ctx, "alice");
});
afterAll(async () => {
  await ctx.close();
});

/** DOCX with an unreferenced media entry of `padBytes` bytes (ignored by the converter). */
function makeZipDocxWithPad(bodyXml: string, padBytes: number): Buffer {
  return makeDocx(bodyXml, { extraFiles: { "word/media/pad.bin": Buffer.alloc(padBytes, 0x20) } });
}

async function importOk(filename: string, content: Buffer | string) {
  const res = await alice.upload(filename, content);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.document as { id: string; title: string; content: string; role: string; revision: number; owner: { id: string } };
}

async function documentCount(): Promise<number> {
  const { rows } = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM documents");
  return rows[0]?.n ?? -1;
}

describe("plain text (.txt)", () => {
  it("creates a document owned by the uploader, titled from the filename", async () => {
    const doc = await importOk("Meeting notes.txt", "Hello world");
    expect(doc).toMatchObject({ title: "Meeting notes", role: "owner", content: "<p>Hello world</p>", revision: 1 });
    expect(doc.owner.id).toBe(USERS.alice.id);
    const list = await alice.get("/api/documents");
    expect(list.body.owned.map((d: { id: string }) => d.id)).toContain(doc.id);
    const versions = await alice.get(`/api/documents/${doc.id}/versions`);
    expect(versions.body.versions).toHaveLength(1);
    expect(versions.body.versions[0]).toMatchObject({ source: "import", revision: 1 });
  });

  it("blank lines become paragraphs; single newlines become line breaks; HTML is escaped (EC-13)", async () => {
    const doc = await importOk("notes.txt", "Line one\r\nLine two\r\n\r\n\r\nSecond <b>para</b> & more\n\n   \n\nThird");
    expect(doc.content).toBe(
      "<p>Line one<br />Line two</p><p>Second &lt;b&gt;para&lt;/b&gt; &amp; more</p><p>Third</p>",
    );
  });

  it("strips a UTF-8 BOM (EC-13)", async () => {
    const doc = await importOk("bom.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Café")]));
    expect(doc.content).toBe("<p>Café</p>");
  });

  it("decodes non-UTF-8 (Windows-1252) text without crashing (EC-13)", async () => {
    // "Café “q” – €5" in Windows-1252
    const cp1252 = Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x94, 0x20, 0x96, 0x20, 0x80, 0x35]);
    const doc = await importOk("legacy.txt", cp1252);
    expect(doc.content).toBe("<p>Café \u201Cq\u201D \u2013 \u20AC5</p>");
  });

  it("decodes UTF-16 with a BOM", async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Hi ✓", "utf16le")]);
    expect((await importOk("wide.txt", utf16)).content).toBe("<p>Hi ✓</p>");
  });

  it("removes NUL bytes rather than failing to store them", async () => {
    const doc = await importOk("nul.txt", Buffer.from("a\u0000b", "utf8"));
    expect(doc.content).toBe("<p>ab</p>");
  });

  it("accepts upper-case extensions", async () => {
    expect((await importOk("SHOUT.TXT", "hi")).title).toBe("SHOUT");
  });
});

describe("Markdown (.md)", () => {
  it("preserves headings, lists and emphasis", async () => {
    const md = "# Title\n\n## Section\n\n### Sub\n\nSome **bold**, *italic* and _also italic_.\n\n- one\n- two\n\n1. first\n2. second\n";
    const doc = await importOk("plan.md", md);
    expect(doc.title).toBe("plan");
    expect(doc.content).toContain("<h1>Title</h1>");
    expect(doc.content).toContain("<h2>Section</h2>");
    expect(doc.content).toContain("<h3>Sub</h3>");
    expect(doc.content).toContain("<strong>bold</strong>");
    expect(doc.content).toContain("<em>italic</em>");
    expect(doc.content).toContain("<em>also italic</em>");
    expect(doc.content).toMatch(/<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
    expect(doc.content).toMatch(/<ol>\s*<li>first<\/li>\s*<li>second<\/li>\s*<\/ol>/);
  });

  it("maps deeper headings to h3 (the editor supports three levels)", async () => {
    const doc = await importOk("deep.md", "#### Four\n\n###### Six");
    expect(doc.content).toBe("<h3>Four</h3>\n<h3>Six</h3>");
  });

  it("sanitizes scripts, event handlers and javascript: links (EC-14)", async () => {
    const md = [
      "# Safe heading",
      "<script>alert('x')</script>",
      '<img src="x" onerror="alert(1)">',
      "[click](javascript:alert(1))",
      '<a href="JaVaScRiPt:alert(1)">mixed</a>',
      '<p onclick="steal()" style="color:red">para</p>',
      "<iframe src=\"//evil.test\"></iframe>",
      '<svg onload="alert(1)"><script>alert(2)</script></svg>',
      '<a href="data:text/html;base64,PHNjcmlwdD4=">data</a>',
    ].join("\n\n");
    const doc = await importOk("evil.md", md);
    const html = doc.content.toLowerCase();
    expect(html).toContain("<h1>safe heading</h1>");
    for (const bad of ["<script", "onerror", "onclick", "onload", "javascript:", "<iframe", "<svg", "<img", "style=", "data:"]) {
      expect(html, bad).not.toContain(bad);
    }
    expect(html).toContain("para");
  });
});

describe("Word (.docx)", () => {
  it("preserves headings, bold, italic, underline and lists", async () => {
    const docx = makeDocx(
      p.heading(1, "Quarterly Plan") +
        p.heading(2, "Goals") +
        p.paragraph(p.text("Bold", { b: true }) + p.text(" and ") + p.text("italic", { i: true }) + p.text(" ") + p.text("under", { u: true })) +
        p.bullet("First bullet") +
        p.bullet("Second bullet") +
        p.numbered("Step one"),
    );
    const doc = await importOk("Quarterly Plan.docx", docx);
    expect(doc.title).toBe("Quarterly Plan");
    expect(doc.content).toContain("<h1>Quarterly Plan</h1>");
    expect(doc.content).toContain("<h2>Goals</h2>");
    expect(doc.content).toContain("<strong>Bold</strong>");
    expect(doc.content).toContain("<em>italic</em>");
    expect(doc.content).toContain("<u>under</u>");
    expect(doc.content).toContain("<ul><li>First bullet</li><li>Second bullet</li></ul>");
    expect(doc.content).toContain("<ol><li>Step one</li></ol>");
  });

  it("strips javascript: hyperlinks from DOCX (EC-14)", async () => {
    const docx = makeDocx(p.hyperlink("click me"), { hyperlinkTarget: "javascript:alert(1)" });
    const doc = await importOk("link.docx", docx);
    expect(doc.content).toContain("click me");
    expect(doc.content.toLowerCase()).not.toContain("javascript:");
  });

  it("a file named .docx that is not a DOCX -> 400 'could not read file' (EC-12)", async () => {
    const before = await documentCount();
    for (const body of [Buffer.from("just some text"), makeZip({ "hello.txt": "not a word document" })]) {
      const res = await alice.upload("fake.docx", body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/could not read file/i);
    }
    expect(await documentCount()).toBe(before);
  });

  it("a truncated ZIP -> 400", async () => {
    const docx = makeDocx(p.paragraph(p.text("hello")));
    const res = await alice.upload("cut.docx", docx.subarray(0, docx.length - 30));
    expect(res.status).toBe(400);
  });

  it("refuses archives that declare a huge uncompressed size (zip bomb guard)", async () => {
    const docx = makeDocx(p.paragraph(p.text("hello")));
    // Patch the first central-directory entry's uncompressed size to 1 GB.
    const cdOffset = docx.readUInt32LE(docx.length - 22 + 16);
    docx.writeUInt32LE(1024 * 1024 * 1024, cdOffset + 24);
    const res = await alice.upload("bomb.docx", docx);
    expect(res.status).toBe(413);
  });
});

describe("Word (.docx) real decompression budget", () => {
  it("refuses an archive that lies about its uncompressed size (declared tiny, inflates to 40 MB) -> 413", async () => {
    const real = 40 * 1024 * 1024;
    const docx = makeDocx(p.paragraph(p.text("hello")), {
      extraFiles: { "word/media/bomb.bin": Buffer.alloc(real, 0) },
      zip: { deflate: ["word/media/bomb.bin"], declaredUncompressed: { "word/media/bomb.bin": 1024 } },
    });
    expect(docx.length).toBeLessThan(MAX_UPLOAD_BYTES);
    const before = await documentCount();
    const res = await alice.upload("liar.docx", docx);
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/expands to too much data/i);
    expect(await documentCount()).toBe(before);
    // The server is still healthy afterwards.
    const ok = await alice.upload("after.txt", "still alive");
    expect(ok.status).toBe(201);
  });

  it("accepts a legitimately deflated .docx under the budget", async () => {
    const docx = makeDocx(p.paragraph(p.text("compressed hello")), {
      zip: { deflate: ["word/document.xml", "word/styles.xml", "word/numbering.xml"] },
    });
    const doc = await importOk("deflated.docx", docx);
    expect(doc.content).toBe("<p>compressed hello</p>");
  });

  // Round-2 review: JSZip (used by mammoth) keeps reading central-directory records past the
  // EOCD count, so an undeclared record could be inflated by the parser without being budgeted.
  function hiddenBombDocx(): { docx: Buffer; hiddenRecordLength: number } {
    const name = "word/media/bomb.bin";
    const docx = makeDocx(p.paragraph(p.text("hello")), {
      extraFiles: { [name]: Buffer.alloc(40 * 1024 * 1024, 0) },
      zip: { deflate: [name], declaredUncompressed: { [name]: 1024 } },
    });
    const eocd = docx.length - 22;
    docx.writeUInt16LE(docx.readUInt16LE(eocd + 8) - 1, eocd + 8);
    docx.writeUInt16LE(docx.readUInt16LE(eocd + 10) - 1, eocd + 10);
    return { docx, hiddenRecordLength: 46 + Buffer.byteLength(name) };
  }

  it("an extra central record beyond the declared entry count -> 400, nothing created", async () => {
    const { docx } = hiddenBombDocx();
    const before = await documentCount();
    const res = await alice.upload("hidden.docx", docx);
    expect(res.status).toBe(400);
    expect(await documentCount()).toBe(before);
    const ok = await importOk("after-hidden.docx", makeDocx(p.paragraph(p.text("fine"))));
    expect(ok.content).toBe("<p>fine</p>");
  });

  it("an undeclared record hidden in a gap before the end record -> 400", async () => {
    const { docx, hiddenRecordLength } = hiddenBombDocx();
    const eocd = docx.length - 22;
    docx.writeUInt32LE(docx.readUInt32LE(eocd + 12) - hiddenRecordLength, eocd + 12);
    const res = await alice.upload("gap.docx", docx);
    expect(res.status).toBe(400);
  });

  it("a central directory size that disagrees with its records -> 400", async () => {
    const docx = makeDocx(p.paragraph(p.text("hello")));
    const eocd = docx.length - 22;
    docx.writeUInt32LE(docx.readUInt32LE(eocd + 12) + 4, eocd + 12);
    const res = await alice.upload("size.docx", docx);
    expect(res.status).toBe(400);
  });

  it("duplicate entry names -> 400", async () => {
    const docx = makeDocx(p.paragraph(p.text("hello")), {
      extraFiles: { "word/media/aa.bin": Buffer.from("one"), "word/media/ab.bin": Buffer.from("two") },
    });
    const dup = Buffer.from(docx.toString("latin1").split("word/media/ab.bin").join("word/media/aa.bin"), "latin1");
    const res = await alice.upload("dup.docx", dup);
    expect(res.status).toBe(400);
  });

  it("a corrupt deflate stream -> 400, not a crash", async () => {
    const docx = makeDocx(p.paragraph(p.text("hello")), { zip: { deflate: ["word/document.xml"] } });
    // Corrupt the start of the deflated document.xml payload.
    const name = Buffer.from("word/document.xml");
    const at = docx.indexOf(name) + name.length;
    docx.fill(0xff, at, at + 8);
    const res = await alice.upload("corrupt.docx", docx);
    expect(res.status).toBe(400);
  });
});

describe("upload validation (EC-12)", () => {
  it("empty (0-byte) file -> 400", async () => {
    const res = await alice.upload("empty.txt", Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empty/i);
  });

  it.each(["virus.exe", "image.png", "noext", "archive.docx.zip", "doc.pdf"])(
    "unsupported extension %s -> 415 listing supported types",
    async (name) => {
      const res = await alice.upload(name, "hello");
      expect(res.status).toBe(415);
      expect(res.body.error).toContain(".txt, .md, .docx");
    },
  );

  it("file over 2 MB -> 413 with the limit in the message", async () => {
    const over = await alice.upload("big.txt", Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x61));
    expect(over.status).toBe(413);
    expect(over.body.error).toMatch(/2 MB/);
  });

  it("a file of exactly 2 MB is accepted", async () => {
    // A DOCX padded with an unreferenced media entry to exactly the limit.
    const body = p.paragraph(p.text("padded"));
    const base = makeZipDocxWithPad(body, 0).length;
    const exact = makeZipDocxWithPad(body, MAX_UPLOAD_BYTES - base);
    expect(exact.length).toBe(MAX_UPLOAD_BYTES);
    const doc = await importOk("exact.docx", exact);
    expect(doc.content).toBe("<p>padded</p>");
  });

  it("converted content must still fit the 1 MB document limit -> 413", async () => {
    // 1.5 MB of plain text is a valid upload but exceeds the 1 MB stored-HTML limit.
    const res = await alice.upload("long.txt", Buffer.alloc(1.5 * 1024 * 1024, 0x61));
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/document is too large/i);
    const small = await alice.upload("ok.txt", Buffer.alloc(512 * 1024, 0x61));
    expect(small.status).toBe(201);
  });

  it("missing file field -> 400", async () => {
    const res = await alice.post("/api/documents/import").field("note", "no file here");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file/i);
    const json = await alice.post("/api/documents/import", { file: "nope" });
    expect(json.status).toBe(400);
  });

  it("file in an unexpected field -> 400", async () => {
    const res = await alice.upload("notes.txt", "hi", "document");
    expect(res.status).toBe(400);
  });

  it("two files in one request -> 400", async () => {
    const res = await alice.agent
      .post("/api/documents/import")
      .set("X-Requested-With", "ajaia-docs")
      .attach("file", Buffer.from("a"), "a.txt")
      .attach("file", Buffer.from("b"), "b.txt");
    expect(res.status).toBe(400);
  });
});

describe("titles from filenames (EC-15)", () => {
  it.each([
    ["../../etc/passwd.txt", "passwd"],
    ["C:\\Users\\me\\Desktop\\Report Final.docx", "Report Final"],
    ["   spaced   out   .md", "spaced out"],
    ["tabs\tand\nnewlines.txt", "tabs and newlines"],
    ["<img src=x onerror=alert(1)>.md", "<img src=x onerror=alert(1)>"],
    ["a/<b>.md", "<b>"],
    ["résumé 📄.txt", "résumé 📄"],
    [".txt", DEFAULT_TITLE],
    ["   .md", DEFAULT_TITLE],
    ["notes.final.v2.md", "notes.final.v2"],
  ])("%j -> %j", (input, expected) => {
    expect(titleFromFilename(input)).toBe(expected);
  });

  it("truncates titles over 200 characters", () => {
    const title = titleFromFilename(`${"x".repeat(250)}.txt`);
    expect(title).toBe("x".repeat(200));
    const emoji = titleFromFilename(`${"😀".repeat(250)}.md`);
    expect(Array.from(emoji)).toHaveLength(200);
  });

  it("uses UTF-8 multipart filenames end to end", async () => {
    const doc = await importOk("Prüfbericht 日本.md", "# hi");
    expect(doc.title).toBe("Prüfbericht 日本");
  });

  it("strips path segments sent by the client end to end", async () => {
    const doc = await importOk("../../secret/../notes.txt", "x");
    expect(doc.title).toBe("notes");
  });
});
