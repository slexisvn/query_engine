import { Config } from '../config.js';
import { DEFAULT_CHUNK_SIZE } from '../storage/chunk.js';

export class MorselSource {
  constructor(table, morselPageCount) {
    this.table = table;
    this.morselPageCount = morselPageCount || this._defaultMorselPages();
  }

  _defaultMorselPages() {
    const workerCount = Config.parallelWorkers;
    if (workerCount <= 1) return Infinity;

    const totalPages = this.table.pageIds.length;
    if (totalPages <= workerCount) return 1;

    return Math.max(1, Math.ceil(totalPages / (workerCount * 2)));
  }

  async prepare() {
    await this.table.flush();
  }

  *partition() {
    const pageIds = this.table.pageIds;
    const totalPages = pageIds.length;

    let offset = 0;
    while (offset < totalPages) {
      const end = Math.min(offset + this.morselPageCount, totalPages);
      yield new Morsel(
        pageIds.slice(offset, end),
        offset,
        end,
        totalPages
      );
      offset = end;
    }
  }

  morselCount() {
    return Math.ceil(this.table.pageIds.length / this.morselPageCount);
  }

  estimatedRows() {
    return this.table.rowCount();
  }
}

export class Morsel {
  constructor(pageIds, startPageIndex, endPageIndex, totalPages) {
    this.pageIds = pageIds;
    this.startPageIndex = startPageIndex;
    this.endPageIndex = endPageIndex;
    this.totalPages = totalPages;
  }

  pageCount() {
    return this.pageIds.length;
  }

  isLast() {
    return this.endPageIndex >= this.totalPages;
  }
}
