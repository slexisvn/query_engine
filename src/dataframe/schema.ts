import type { DataType, ColumnSchema } from '../storage/data-type.js';

interface FieldLike {
  name: string;
  dataType: DataType;
  tableAlias?: string;
}

export class UnknownColumnError extends Error {}

export class AmbiguousColumnError extends Error {}

export class DFField {
  name: string;
  dataType: DataType;
  index: number;
  tableAlias: string;

  constructor(name: string, dataType: DataType, index: number, tableAlias?: string) {
    this.name = name;
    this.dataType = dataType;
    this.index = index;
    this.tableAlias = tableAlias || '';
  }
}

function reindex(fields: FieldLike[]): DFField[] {
  return fields.map((f, i) => new DFField(f.name, f.dataType, i, f.tableAlias));
}

export class DFSchema {
  _fields: DFField[];

  constructor(fields: DFField[]) {
    this._fields = fields;
  }

  static fromStorageSchema(storageSchema: ColumnSchema[], alias?: string): DFSchema {
    return new DFSchema(storageSchema.map((c, i) => new DFField(c.name, c.dataType, i, alias)));
  }

  static fromFields(fields: FieldLike[]): DFSchema {
    return new DFSchema(reindex(fields));
  }

  get fields(): DFField[] {
    return this._fields;
  }

  get length(): number {
    return this._fields.length;
  }

  field(i: number): DFField {
    return this._fields[i];
  }

  names(): string[] {
    return this._fields.map(f => f.name);
  }

  resolve(name: string, tableAlias: string | null = null): DFField {
    const upper = name.toUpperCase();
    const aliasUpper = tableAlias ? tableAlias.toUpperCase() : null;
    let found: DFField | null = null;
    for (const field of this._fields) {
      if (field.name.toUpperCase() !== upper) continue;
      if (aliasUpper && field.tableAlias.toUpperCase() !== aliasUpper) continue;
      if (found) {
        throw new AmbiguousColumnError(`Ambiguous column reference: ${name}`);
      }
      found = field;
    }
    if (!found) {
      const qualifier = tableAlias ? `${tableAlias}.` : '';
      throw new UnknownColumnError(`Unknown column: ${qualifier}${name}`);
    }
    return found;
  }

  has(name: string, tableAlias: string | null = null): boolean {
    try {
      this.resolve(name, tableAlias);
      return true;
    } catch (_) {
      return false;
    }
  }

  project(fields: FieldLike[]): DFSchema {
    return new DFSchema(reindex(fields.map(f => new DFField(f.name, f.dataType, 0, f.tableAlias || ''))));
  }

  drop(names: string[]): DFSchema {
    const removed = new Set(names.map(n => n.toUpperCase()));
    const kept = this._fields.filter(f => !removed.has(f.name.toUpperCase()));
    return new DFSchema(reindex(kept));
  }

  append(other: DFSchema): DFSchema {
    return new DFSchema(reindex([...this._fields, ...other.fields]));
  }

  requalify(alias: string): DFSchema {
    return new DFSchema(this._fields.map(f => new DFField(f.name, f.dataType, f.index, alias)));
  }

  static aggregateOutput(groupFields: DFField[], aggFields: DFField[]): DFSchema {
    return new DFSchema(reindex([...groupFields, ...aggFields]));
  }
}
