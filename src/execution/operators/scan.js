export class ScanOperator {
  constructor(table, projectedColumns = null) {
    this.table = table;
    this.projectedColumns = projectedColumns;
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
}
