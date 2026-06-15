export class ScanOperator {
  table: any;
  projectedColumns: any;

  constructor(table: any, projectedColumns: any) {
    this.table = table;
    this.projectedColumns = projectedColumns || null;
  }

  async init(): Promise<void> {}

  async *scan(): AsyncGenerator<any> {
    for await (const chunk of this.table.scan()) {
      if (this.projectedColumns) {
        yield chunk.project(this.projectedColumns);
      } else {
        yield chunk;
      }
    }
  }

  estimatedRows(): any {
    return this.table.rowCount();
  }
}
