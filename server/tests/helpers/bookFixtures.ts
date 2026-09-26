import AdmZip from "adm-zip";

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A minimal but structurally real EPUB: mimetype, META-INF/container.xml pointing at an OPF, and
 * that OPF's Dublin Core metadata. Written to `dest`. */
export function writeEpub(
  dest: string,
  opts: { title?: string; creators?: { name: string; role?: string }[]; identifiers?: string[]; opfPath?: string } = {}
): string {
  const opfPath = opts.opfPath ?? "OEBPS/content.opf";
  const zip = new AdmZip();
  zip.addFile("mimetype", Buffer.from("application/epub+zip"));
  zip.addFile(
    "META-INF/container.xml",
    Buffer.from(
      `<?xml version="1.0"?>
       <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
         <rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles>
       </container>`
    )
  );
  const title = opts.title ? `<dc:title>${escapeXml(opts.title)}</dc:title>` : "";
  const creators = (opts.creators ?? [])
    .map((c) => `<dc:creator${c.role ? ` opf:role="${c.role}"` : ""}>${escapeXml(c.name)}</dc:creator>`)
    .join("");
  const identifiers = (opts.identifiers ?? []).map((id) => `<dc:identifier>${escapeXml(id)}</dc:identifier>`).join("");
  zip.addFile(
    opfPath,
    Buffer.from(
      `<?xml version="1.0"?>
       <package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" version="2.0">
         <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${title}${creators}${identifiers}</metadata>
       </package>`
    )
  );
  zip.writeZip(dest);
  return dest;
}

const MOBI_HEADER_LENGTH = 232;

/** A minimal MOBI file: PalmDB header + two-entry record list, record 0 holding a PalmDOC header,
 * a MOBI header (full name + EXTH flag) and, when `exth` is given, an EXTH block. */
export function buildMobi(
  opts: {
    palmName?: string;
    /** A string is encoded per `latin1`; a Buffer is written as-is (raw CP1252 bytes). */
    fullName?: string | Buffer;
    exth?: { type: number; value: string | Buffer }[];
    /** Declares text encoding 1252 instead of UTF-8. */
    latin1?: boolean;
    typeCreator?: string;
  } = {}
): Buffer {
  const encoding: BufferEncoding = opts.latin1 ? "latin1" : "utf8";
  const bytes = (value: string | Buffer) => (Buffer.isBuffer(value) ? value : Buffer.from(value, encoding));

  let exth = Buffer.alloc(0);
  if (opts.exth) {
    const records = opts.exth.map(({ type, value }) => {
      const data = bytes(value);
      const record = Buffer.alloc(8 + data.length);
      record.writeUInt32BE(type, 0);
      record.writeUInt32BE(8 + data.length, 4);
      data.copy(record, 8);
      return record;
    });
    const body = Buffer.concat(records);
    const header = Buffer.alloc(12);
    header.write("EXTH", 0, "latin1");
    header.writeUInt32BE(12 + body.length, 4);
    header.writeUInt32BE(records.length, 8);
    exth = Buffer.concat([header, body, Buffer.alloc((4 - ((12 + body.length) % 4)) % 4)]);
  }

  const fullName = bytes(opts.fullName ?? "");
  const palmDoc = Buffer.alloc(16);
  palmDoc.writeUInt16BE(1, 0); // no compression
  const mobi = Buffer.alloc(MOBI_HEADER_LENGTH);
  mobi.write("MOBI", 0, "latin1");
  mobi.writeUInt32BE(MOBI_HEADER_LENGTH, 4);
  mobi.writeUInt32BE(2, 8); // Mobipocket book
  mobi.writeUInt32BE(opts.latin1 ? 1252 : 65001, 12);
  mobi.writeUInt32BE(16 + MOBI_HEADER_LENGTH + exth.length, 0x44); // full name offset, from record 0
  mobi.writeUInt32BE(fullName.length, 0x48);
  mobi.writeUInt32BE(opts.exth ? 0x40 : 0, 0x70);
  const record0 = Buffer.concat([palmDoc, mobi, exth, fullName, Buffer.alloc(2)]);
  const record1 = Buffer.from("text of the book");

  const recordCount = 2;
  const palm = Buffer.alloc(78 + recordCount * 8 + 2);
  palm.write((opts.palmName ?? "Palm_Name").slice(0, 31), 0, "latin1");
  palm.write(opts.typeCreator ?? "BOOKMOBI", 60, "latin1");
  palm.writeUInt16BE(recordCount, 76);
  palm.writeUInt32BE(palm.length, 78);
  palm.writeUInt32BE(palm.length + record0.length, 86);
  return Buffer.concat([palm, record0, record1]);
}
