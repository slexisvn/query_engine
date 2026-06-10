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

  estimatedRows() {
    return this.table.rowCount();
  }
}
