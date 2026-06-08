const ALIGNMENT = 16;

const align = (offset) => (offset + ALIGNMENT - 1) & ~(ALIGNMENT - 1);

export class RegionAllocator {
  constructor(memory, regionSize) {
    this.memory = memory;
    this.regionSize = regionSize;
    this.regions = [];
    this.totalAllocated = 0;
    this.stagingOffset = 0;
    this.dataOffset = 0;
    this.dataBaseOffset = 0;
  }

  addRegion() {
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

  alloc(regionId, bytes) {
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

  reset(regionId) {
    const region = this.regions[regionId];
    if (!region) throw new RangeError(`Region ${regionId} does not exist`);
    region.offset = 0;
  }

  getRegionBounds(regionId) {
    const region = this.regions[regionId];
    if (!region) throw new RangeError(`Region ${regionId} does not exist`);
    return { start: region.start, end: region.start + region.capacity };
  }

  getRegionUsage(regionId) {
    const region = this.regions[regionId];
    if (!region) throw new RangeError(`Region ${regionId} does not exist`);
    return { used: region.offset, capacity: region.capacity, free: region.capacity - region.offset };
  }

  regionCount() {
    return this.regions.length;
  }

  _growRegion(regionId, needed) {
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

  allocData(bytes) {
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

  resetData() {
    this.dataOffset = 0;
  }

  allocStaging(bytes) {
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

  resetStaging() {
    this.stagingOffset = 0;
  }

  _ensureMemory(requiredBytes) {
    const currentBytes = this.memory.buffer.byteLength;
    if (requiredBytes <= currentBytes) return;

    const PAGE_SIZE = 65536;
    const pagesNeeded = Math.ceil((requiredBytes - currentBytes) / PAGE_SIZE);
    this.memory.grow(pagesNeeded);
  }
}
