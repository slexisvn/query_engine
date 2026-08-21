import { DataChunk } from './chunk.js';
import { chunkRecordBytes, readChunkRecords, writeChunkRecords } from './column-codec.js';
import { ByteReader, ByteWriter, UINT16_BYTES, UINT32_BYTES } from './encoding/byte-io.js';
import { heapAllocator, type Allocator } from './sab-arena.js';

const CHUNK_HEADER_BYTES = UINT32_BYTES + UINT16_BYTES;

export class ChunkSerializer {
  static serialize(source: DataChunk): Buffer {
    const chunk = source.selectionVector ? source.flatten() : source;

    const writer = new ByteWriter(Buffer.allocUnsafe(CHUNK_HEADER_BYTES + chunkRecordBytes(chunk.columns)));
    writer.u32(chunk.size);
    writer.u16(chunk.columns.length);
    writeChunkRecords(writer, chunk.columns);

    return writer.buffer;
  }

  static deserialize(buffer: Buffer, allocator: Allocator = heapAllocator): DataChunk {
    const reader = new ByteReader(buffer, 0, allocator);
    const size = reader.u32();
    const columnCount = reader.u16();

    return new DataChunk(readChunkRecords(reader, columnCount), size);
  }
}
