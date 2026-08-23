import { DataChunk } from '../../storage/chunk.js';
import { chunkRecordBytes, readChunkRecords, writeChunkRecords } from '../../storage/column-codec.js';
import { ByteReader, ByteWriter, UINT16_BYTES, UINT32_BYTES } from '../../storage/encoding/byte-io.js';

const HEADER_MAGIC = 0x51454348;
const CODEC_HEADER_BYTES = UINT32_BYTES + UINT16_BYTES + UINT32_BYTES;

export class ChunkCodec {
  encode(chunk: DataChunk): Uint8Array {
    const flatChunk = chunk.selectionVector ? chunk.flatten() : chunk;

    const writer = new ByteWriter(new Uint8Array(CODEC_HEADER_BYTES + chunkRecordBytes(flatChunk.columns)));
    writer.u32(HEADER_MAGIC);
    writer.u16(flatChunk.columns.length);
    writer.u32(flatChunk.size);
    writeChunkRecords(writer, flatChunk.columns);

    return writer.buffer;
  }

  decode(buffer: Uint8Array): DataChunk {
    const reader = new ByteReader(buffer);
    if (reader.u32() !== HEADER_MAGIC) {
      throw new Error('Invalid chunk codec magic number');
    }

    const columnCount = reader.u16();
    const rowCount = reader.u32();

    return new DataChunk(readChunkRecords(reader, columnCount), rowCount);
  }
}
