import { unzipSync } from 'fflate';
import { crc32 } from 'node:zlib';
import { invalid } from '../shared/errors';

/** Reject unsupported ZIP64/encryption and validate expanded data against the directory CRC. */
export function unzip(bytes: Uint8Array) {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = bytes.length - 22;
    for (; end >= Math.max(0, bytes.length - 65557); end--)
      if (
        view.getUint32(end, true) === 0x06054b50 &&
        end + 22 + view.getUint16(end + 20, true) === bytes.length
      )
        break;
    if (end < 0 || view.getUint32(end, true) !== 0x06054b50)
      throw invalid('Invalid ZIP directory.');

    const count = view.getUint16(end + 10, true),
      size = view.getUint32(end + 12, true),
      offset = view.getUint32(end + 16, true);

    if (
      view.getUint16(end + 4, true) ||
      view.getUint16(end + 6, true) ||
      view.getUint16(end + 8, true) !== count ||
      count > 20 ||
      offset + size !== end
    )
      throw invalid('Use a single ZIP with at most 20 files.');

    const integrity = new Map<
      string,
      {
        size: number;
        crc: number;
      }
    >();

    let cursor = offset,
      total = 0;

    for (let i = 0; i < count; i++) {
      if (view.getUint32(cursor, true) !== 0x02014b50) throw invalid('Invalid ZIP entry.');

      const flags = view.getUint16(cursor + 8, true),
        compression = view.getUint16(cursor + 10, true),
        crc = view.getUint32(cursor + 16, true),
        expanded = view.getUint32(cursor + 24, true),
        nameLength = view.getUint16(cursor + 28, true),
        extraLength = view.getUint16(cursor + 30, true),
        commentLength = view.getUint16(cursor + 32, true);

      const name = new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(cursor + 46, cursor + 46 + nameLength),
      );

      if (
        flags & 1 ||
        ![0, 8].includes(compression) ||
        expanded === 0xffffffff ||
        (total += expanded) > 32 * 1024 * 1024 ||
        name.startsWith('/') ||
        name.includes('\\') ||
        name.split('/').includes('..') ||
        integrity.has(name)
      )
        throw invalid('Unsafe or oversized ZIP entry.');
      integrity.set(name, { size: expanded, crc });
      cursor += 46 + nameLength + extraLength + commentLength;
    }

    if (cursor !== end) throw invalid('Invalid ZIP directory length.');
    const files = unzipSync(bytes);

    for (const [name, data] of Object.entries(files)) {
      const expected = integrity.get(name);
      if (!expected || expected.size !== data.length || crc32(data) !== expected.crc)
        throw invalid('ZIP contents failed integrity verification.');
    }

    if (Object.keys(files).length !== count) throw invalid('ZIP entry count mismatch.');

    return files;
  } catch (error) {
    throw invalid(
      error instanceof Error && error.message.startsWith('ZIP')
        ? error.message
        : 'Invalid or unsupported ZIP file.',
    );
  }
}
