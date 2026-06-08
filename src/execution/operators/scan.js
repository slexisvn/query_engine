import { MorselSource } from '../../parallel/morsel-source.js';

export class ScanOperator {
  constructor(table, projectedColumns) {
    this.table = table;
    this.projectedColumns = projectedColumns || null;
  }

  async init() {}

  async *scan() {
    for await (const chunk of this.table.scan()) {
      if (this.projectedColumns) {
        yield chunk.project(this.projectedColumns);
      } else {
        yield chunk;
      }
    }
  }

  async *scanMorsels() {
    const morselSource = new MorselSource(this.table);
    await morselSource.prepare();

    for (const morsel of morselSource.partition()) {
      const fetches = morsel.pageIds.map(id => this.table.bufferPool.fetchPage(id, true));
      const pages = await Promise.all(fetches);
      yield {
        morsel,
        chunks: pages.filter(c => c && c.size > 0),
      };
    }
  }

  morselCount() {
    return new MorselSource(this.table).morselCount();
  }

  estimatedRows() {
    return this.table.rowCount();
  }
}
