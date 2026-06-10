export class UnknownColumnError extends Error {}

export class AmbiguousColumnError extends Error {}

export class DFField {
  constructor(name, dataType, index, tableAlias) {
    this.name = name;
    this.dataType = dataType;
    this.index = index;
    this.tableAlias = tableAlias || '';
  }
}

function reindex(fields) {
  return fields.map((f, i) => new DFField(f.name, f.dataType, i, f.tableAlias));
}

export class DFSchema {
  constructor(fields) {
    this._fields = fields;
  }

  static fromStorageSchema(storageSchema, alias) {
    return new DFSchema(storageSchema.map((c, i) => new DFField(c.name, c.dataType, i, alias)));
  }

  static fromFields(fields) {
    return new DFSchema(reindex(fields));
  }

  get fields() {
    return this._fields;
  }

  get length() {
    return this._fields.length;
  }

  field(i) {
    return this._fields[i];
  }

  names() {
    return this._fields.map(f => f.name);
  }

  resolve(name, tableAlias = null) {
    const upper = name.toUpperCase();
    const aliasUpper = tableAlias ? tableAlias.toUpperCase() : null;
    let found = null;
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

  has(name, tableAlias = null) {
    try {
      this.resolve(name, tableAlias);
      return true;
    } catch (_) {
      return false;
    }
  }

  project(fields) {
    return new DFSchema(reindex(fields.map(f => new DFField(f.name, f.dataType, 0, f.tableAlias || ''))));
  }

  drop(names) {
    const removed = new Set(names.map(n => n.toUpperCase()));
    const kept = this._fields.filter(f => !removed.has(f.name.toUpperCase()));
    return new DFSchema(reindex(kept));
  }

  append(other) {
    return new DFSchema(reindex([...this._fields, ...other.fields]));
  }

  requalify(alias) {
    return new DFSchema(this._fields.map(f => new DFField(f.name, f.dataType, f.index, alias)));
  }

  static aggregateOutput(groupFields, aggFields) {
    return new DFSchema(reindex([...groupFields, ...aggFields]));
  }
}
