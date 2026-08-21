import fs from 'fs';
import v8 from 'v8';
import type { PartialGroupRecord } from './worker-messages.js';

export function writePartialSpill(file: string, partitions: PartialGroupRecord[][]): void {
  const buffers: (Buffer | null)[] = partitions.map(partition => partition.length > 0 ? v8.serialize(partition) : null);
  const header = Buffer.alloc(4 + partitions.length * 4);
  header.writeUInt32LE(partitions.length, 0);
  for (let i = 0; i < buffers.length; i++) {
    header.writeUInt32LE(buffers[i] ? buffers[i]!.length : 0, 4 + i * 4);
  }

  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, header);
    for (const buffer of buffers) {
      if (buffer) fs.writeSync(fd, buffer);
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function readPartialSpill(file: string, partition: number): PartialGroupRecord[] {
  const fd = fs.openSync(file, 'r');
  try {
    const countBuf = Buffer.alloc(4);
    fs.readSync(fd, countBuf, 0, 4, 0);
    const count = countBuf.readUInt32LE(0);
    if (partition >= count) return [];

    const lensBuf = Buffer.alloc(count * 4);
    fs.readSync(fd, lensBuf, 0, count * 4, 4);
    const length = lensBuf.readUInt32LE(partition * 4);
    if (length === 0) return [];

    let offset = 4 + count * 4;
    for (let i = 0; i < partition; i++) {
      offset += lensBuf.readUInt32LE(i * 4);
    }
    const data = Buffer.alloc(length);
    fs.readSync(fd, data, 0, length, offset);
    return v8.deserialize(data) as PartialGroupRecord[];
  } finally {
    fs.closeSync(fd);
  }
}
