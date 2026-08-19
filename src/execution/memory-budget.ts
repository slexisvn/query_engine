import { byteWidthFor, isFixedWidth, type DataType } from '../storage/data-type.js';
import { Config } from '../config.js';

export function rowByteWidth(schema: readonly DataType[] | null | undefined): number {
  if (!schema || schema.length === 0) return Config.materializedRowOverheadBytes;

  let width = Config.materializedRowOverheadBytes;
  for (const dataType of schema) {
    width += isFixedWidth(dataType) ? byteWidthFor(dataType) : Config.variableWidthValueBytes;
  }
  return width;
}

export class RowMemoryBudget {
  limitBytes: number;
  rowBytes: number;
  residentRows: number;

  constructor(limitBytes: number = Config.memoryLimitBytes) {
    this.limitBytes = limitBytes;
    this.rowBytes = Config.materializedRowOverheadBytes;
    this.residentRows = 0;
  }

  adoptSchema(schema: readonly DataType[] | null | undefined): void {
    this.rowBytes = rowByteWidth(schema);
  }

  admit(rowCount: number): void {
    this.residentRows += rowCount;
  }

  release(rowCount: number): void {
    this.residentRows = Math.max(0, this.residentRows - rowCount);
  }

  reset(): void {
    this.residentRows = 0;
  }

  get residentBytes(): number {
    return this.residentRows * this.rowBytes;
  }

  get exceeded(): boolean {
    return this.residentBytes >= this.limitBytes;
  }

  get rowCapacity(): number {
    return Math.max(1, Math.floor(this.limitBytes / this.rowBytes));
  }
}
