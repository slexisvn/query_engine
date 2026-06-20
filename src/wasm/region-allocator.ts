import type { RegionDescriptor, RegionBounds, RegionUsage } from './wasm-types.js';

const ALIGNMENT = 16;

const align = (offset: number): number => (offset + ALIGNMENT - 1) & ~(ALIGNMENT - 1);

export class RegionAllocator {
  memory: WebAssembly.Memory;
  regionSize: number;
  regions: RegionDescriptor[];
  totalAllocated: number;
  stagingOffset: number;
  dataOffset: number;
  dataBaseOffset: number;

  constructor(memory: WebAssembly.Memory, regionSize: number) {
    this.memory = memory;
    this.regionSize = regionSize;
    this.regions = [];
    this.totalAllocated = 0;
    this.stagingOffset = 0;
    this.dataOffset = 0;
    this.dataBaseOffset = 0;
  }

  addRegion(): number {
    const id = this.regions.length;
    const start = this.totalAllocated;
    const capacity = this.regionSize;

    this._ensureMemory(start + capacity);

    this.regions.push({
      id,
      start,
      capacity,
      offset: 0,
    });

    this.totalAllocated = start + capacity;
    return id;
  }

  alloc(regionId: number, bytes: number): number {
    const region = this.regions[regionId];
    if (!region) throw new RangeError(`Region ${regionId} does not exist`);

    const alignedOffset = align(region.offset);
    const needed = alignedOffset + bytes;

    if (needed > region.capacity) {
      this._growRegion(regionId, needed);
    }

    const ptr = region.start + alignedOffset;
    region.offset = alignedOffset + bytes;
    return ptr;
  }

  reset(regionId: number): void {
    const region = this.regions[regionId];
    if (!region) throw new RangeError(`Region ${regionId} does not exist`);
    region.offset = 0;
  }

  getRegionBounds(regionId: number): RegionBounds {
    const region = this.regions[regionId];
    if (!region) throw new RangeError(`Region ${regionId} does not exist`);
    return { start: region.start, end: region.start + region.capacity };
  }

  getRegionUsage(regionId: number): RegionUsage {
    const region = this.regions[regionId];
    if (!region) throw new RangeError(`Region ${regionId} does not exist`);
    return { used: region.offset, capacity: region.capacity, free: region.capacity - region.offset };
  }

  regionCount(): number {
    return this.regions.length;
  }

  _growRegion(regionId: number, needed: number): void {
    const region = this.regions[regionId];
    const isLast = regionId === this.regions.length - 1;

    if (!isLast) {
      throw new RangeError(
        `Region ${regionId} exhausted (${region.capacity} bytes) and cannot grow — only the last region is growable`
      );
    }

    let newCapacity = region.capacity;
    while (newCapacity < needed) {
      newCapacity *= 2;
    }

    this._ensureMemory(region.start + newCapacity);

    const growth = newCapacity - region.capacity;
    region.capacity = newCapacity;
    this.totalAllocated += growth;
  }

  allocData(bytes: number): number {
    if (this.dataBaseOffset === 0) {
      this.dataBaseOffset = this.totalAllocated;
    }
    const alignedOffset = align(this.dataOffset);
    const ptr = this.dataBaseOffset + alignedOffset;
    const needed = ptr + bytes;
    this._ensureMemory(needed);
    this.dataOffset = alignedOffset + bytes;
    return ptr;
  }

  resetData(): void {
    this.dataOffset = 0;
  }

  allocStaging(bytes: number): number {
    const base = this.dataBaseOffset > 0
      ? this.dataBaseOffset + this.dataOffset
      : this.totalAllocated;
    const alignedOffset = align(this.stagingOffset);
    const ptr = base + alignedOffset;
    const needed = ptr + bytes;
    this._ensureMemory(needed);
    this.stagingOffset = alignedOffset + bytes;
    return ptr;
  }

  resetStaging(): void {
    this.stagingOffset = 0;
  }

  _ensureMemory(requiredBytes: number): void {
    const currentBytes = this.memory.buffer.byteLength;
    if (requiredBytes <= currentBytes) return;

    const PAGE_SIZE = 65536;
    const pagesNeeded = Math.ceil((requiredBytes - currentBytes) / PAGE_SIZE);
    this.memory.grow(pagesNeeded);
  }
}
