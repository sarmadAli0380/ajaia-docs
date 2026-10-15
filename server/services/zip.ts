import { inflateRawSync } from "node:zlib";

/**
 * ZIP inspection used before a DOCX parser touches an upload.
 *
 * `inspectZip` reads the central directory without decompressing anything, so obviously
 * hostile archives (ZIP64, thousands of entries, huge declared sizes) are rejected cheaply.
 * Declared sizes are uploader-controlled and can lie, so `assertInflatedSizeWithin` then
 * actually inflates every entry with a hard output cap and enforces the real cumulative
 * decompressed size (see ARCHITECTURE.md).
 */
export interface ZipInfo {
  entryCount: number;
  uncompressedBytes: number;
}

const LOCAL_FILE_SIG = 0x04034b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const EOCD_MIN = 22;

export class ZipFormatError extends Error {}

/** The archive really inflates to more than the allowed budget. */
export class ZipBudgetError extends Error {}

export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === LOCAL_FILE_SIG;
}

function findEocd(buf: Buffer): number {
  const minPos = Math.max(0, buf.length - EOCD_MIN - 0xffff);
  let eocd = -1;
  for (let i = buf.length - EOCD_MIN; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  return eocd;
}

export function inspectZip(buf: Buffer): ZipInfo {
  const { entries } = walkCentralDirectory(buf);
  return {
    entryCount: entries.length,
    uncompressedBytes: entries.reduce((sum, e) => sum + e.uncompressedSize, 0),
  };
}

interface CentralEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Walks the central directory the way JSZip (used by mammoth) does: record after record for
 * as long as the signature matches, ignoring the EOCD count. The archive is rejected unless that
 * walk agrees exactly with the EOCD record (count, size, and the directory ending right at the
 * EOCD with no gap or prepended bytes) and entry names are unique. Without this, an extra
 * record past the declared count would be decompressed by the parser but never budgeted here.
 */
function walkCentralDirectory(buf: Buffer): { entries: CentralEntry[] } {
  if (buf.length < EOCD_MIN || !isZip(buf)) throw new ZipFormatError("Not a ZIP archive");

  const eocd = findEocd(buf);
  if (eocd < 0) throw new ZipFormatError("ZIP end of central directory not found");

  const diskEntries = buf.readUInt16LE(eocd + 8);
  const declared = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (declared === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipFormatError("ZIP64 archives are not supported");
  }
  if (diskEntries !== declared) throw new ZipFormatError("Multi-disk ZIP archives are not supported");
  // JSZip treats any gap here as prepended data and shifts every offset; require none.
  if (cdOffset + cdSize !== eocd) throw new ZipFormatError("Corrupt ZIP central directory");

  const entries: CentralEntry[] = [];
  const names = new Set<string>();
  let p = cdOffset;
  while (p + 4 <= buf.length && buf.readUInt32LE(p) === CENTRAL_DIR_SIG) {
    if (p + 46 > eocd) throw new ZipFormatError("Corrupt ZIP central directory entry");
    const uncompressedSize = buf.readUInt32LE(p + 24);
    if (uncompressedSize === 0xffffffff) throw new ZipFormatError("ZIP64 archives are not supported");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > eocd) throw new ZipFormatError("Corrupt ZIP central directory entry");
    const name = buf.toString("latin1", p + 46, p + 46 + nameLen);
    if (names.has(name)) throw new ZipFormatError("Duplicate ZIP entry name");
    names.add(name);
    entries.push({
      name,
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      uncompressedSize,
      localHeaderOffset: buf.readUInt32LE(p + 42),
    });
    p = end;
  }
  if (entries.length !== declared || p !== eocd) {
    throw new ZipFormatError("ZIP central directory does not match its end record");
  }
  return { entries };
}

/**
 * Inflates every entry (discarding the output) and throws `ZipBudgetError` as soon as the
 * cumulative *actual* decompressed size exceeds `maxBytes`. Each inflate is capped with
 * `maxOutputLength`, so a lying archive can never allocate more than the remaining budget.
 * Overlapping entries are counted once per entry, like a parser would inflate them.
 */
export function assertInflatedSizeWithin(buf: Buffer, maxBytes: number): number {
  let total = 0;
  for (const entry of walkCentralDirectory(buf).entries) {
    const lho = entry.localHeaderOffset;
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== LOCAL_FILE_SIG) {
      throw new ZipFormatError("Corrupt ZIP local file header");
    }
    if (entry.flags & 0x1) throw new ZipFormatError("Encrypted ZIP entries are not supported");
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buf.length) throw new ZipFormatError("Corrupt ZIP entry data");
    const data = buf.subarray(dataStart, dataEnd);
    const remaining = maxBytes - total;

    let size: number;
    if (entry.method === 0) {
      size = data.length;
    } else if (entry.method === 8) {
      try {
        // +1 so "exactly at the budget" is distinguishable from "over the budget".
        size = inflateRawSync(data, { maxOutputLength: Math.max(1, remaining + 1) }).length;
      } catch (err) {
        if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
          throw new ZipBudgetError("ZIP expands beyond the allowed size");
        }
        throw new ZipFormatError("Corrupt ZIP entry data");
      }
    } else {
      throw new ZipFormatError("Unsupported ZIP compression method");
    }
    total += size;
    if (total > maxBytes) throw new ZipBudgetError("ZIP expands beyond the allowed size");
  }
  return total;
}
