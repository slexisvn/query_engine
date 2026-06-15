import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { JoinType } from '../../planner/logical-plan.js';
import { Config } from '../../config.js';
import { joinKeyOf, probeJoinRows, buildJoinOutputChunk } from './join-core.js';

function hashString(str: any): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getPartition(keyStr: any): number {
  return hashString(keyStr) % Config.hashJoinPartitions;
}

export class HashJoinBuild {
  keyExtractors: any;
  joinType: any;
  uniqueKeys: boolean;
  buildPreserved: boolean;
  hashTable: Map<any, any>;
  buildSchema: any;
  hasNullKey: boolean;
  nullKeyRows: any[];
  spillManager: any;
  partitions: any[];
  totalRowsInRAM: number;
  matchedSet: Set<any>;

  constructor(keyExtractors: any, joinType: any, uniqueKeys: any, spillManager: any, buildPreserved: any = false) {
    this.keyExtractors = keyExtractors;
    this.joinType = joinType || JoinType.INNER;
    this.uniqueKeys = !!uniqueKeys;
    this.buildPreserved = !!buildPreserved;
    this.hashTable = new Map();
    this.buildSchema = null;
    this.hasNullKey = false;
    this.nullKeyRows = [];

    this.spillManager = spillManager;
    this.partitions = Array.from({ length: Config.hashJoinPartitions }, () => ({
      rows: [],
      spilled: false
    }));
    this.totalRowsInRAM = 0;
    this.matchedSet = new Set();
  }

  async init(): Promise<void> {}

  async consume(chunk: any): Promise<void> {
    if (!this.buildSchema) {
      this.buildSchema = chunk.columns.map((c: any) => c.dataType);
    }
    const flat = chunk.selectionVector ? chunk.flatten() : chunk;

    const chunkRows = new Array(flat.size);
    for (let i = 0; i < flat.size; i++) {
      const row = new Array(flat.columns.length);
      for (let c = 0; c < flat.columns.length; c++) {
        row[c] = flat.columns[c].get(i);
      }
      chunkRows[i] = row;
    }

    for (let i = 0; i < flat.size; i++) {
      const key = this.buildKey(flat, i);
      if (key === null) {
        this.hasNullKey = true;
        if (this.buildPreserved) this.nullKeyRows.push(chunkRows[i]);
        continue;
      }
      const pIdx = getPartition(key);
      const part = this.partitions[pIdx];
      
      part.rows.push({ row: chunkRows[i], key });

      if (!part.spilled) {
        this.totalRowsInRAM++;
      }

      if (part.spilled && part.rows.length >= Config.flushBatchSize) {
        await this.flushPartition(pIdx);
      }
    }

    if (this.totalRowsInRAM > Config.memoryLimit) {
      let maxPart = -1;
      let maxRows = 0;
      for (let i = 0; i < Config.hashJoinPartitions; i++) {
        if (!this.partitions[i].spilled && this.partitions[i].rows.length > maxRows) {
          maxRows = this.partitions[i].rows.length;
          maxPart = i;
        }
      }
      if (maxPart !== -1) {
        this.partitions[maxPart].spilled = true;
        this.totalRowsInRAM -= this.partitions[maxPart].rows.length;
        await this.flushPartition(maxPart);
      }
    }
  }

  async flushPartition(pIdx: any): Promise<void> {
    const part = this.partitions[pIdx];
    if (part.rows.length === 0) return;
    const chunk = this.rowsToChunk(part.rows.map((r: any) => r.row));
    await this.spillManager.appendChunk(`build_${pIdx}`, chunk);
    
    part.rows = [];
  }

  rowsToChunk(rows: any): any {
    if (rows.length === 0) return new DataChunk([], 0);
    const colCount = rows[0].length;
    const columns = new Array(colCount);
    for (let c = 0; c < colCount; c++) {
      const col = new Column(this.buildSchema?.[c] || 'VARCHAR', rows.length);
      for (let r = 0; r < rows.length; r++) {
        col.set(r, rows[r][c]);
      }
      col.length = rows.length;
      columns[c] = col;
    }
    return new DataChunk(columns, rows.length);
  }

  async finalize(): Promise<void> {
    for (let i = 0; i < Config.hashJoinPartitions; i++) {
      const part = this.partitions[i];
      if (part.spilled && part.rows.length > 0) {
        await this.flushPartition(i);
      }
      if (!part.spilled) {
        for (let r = 0; r < part.rows.length; r++) {
          const item = part.rows[r];
          let bucket = this.hashTable.get(item.key);
          if (this.uniqueKeys && bucket) continue;
          if (!bucket) {
            bucket = [];
            this.hashTable.set(item.key, bucket);
          }
          bucket.push({ row: item.row, pIdx: i, rIdx: r });
        }
      }
    }
  }

  markMatched(packed: any): void {
    this.matchedSet.add(`${packed.pIdx}_${packed.rIdx}`);
  }

  emitUnmatched(probeColCount: any): any {
    const rows = [];
    for (let i = 0; i < Config.hashJoinPartitions; i++) {
      const part = this.partitions[i];
      if (!part.spilled) {
        for (let r = 0; r < part.rows.length; r++) {
          if (!this.matchedSet.has(`${i}_${r}`)) {
            const outRow = [...part.rows[r].row];
            for (let c = 0; c < probeColCount; c++) outRow.push(null);
            rows.push(outRow);
          }
        }
      }
    }
    for (let n = 0; n < this.nullKeyRows.length; n++) {
      const outRow = [...this.nullKeyRows[n]];
      for (let c = 0; c < probeColCount; c++) outRow.push(null);
      rows.push(outRow);
    }
    return rows;
  }

  probe(key: any): any {
    return this.hashTable.get(key) || null;
  }

  buildKey(chunk: any, rowIdx: any): any {
    return joinKeyOf(this.keyExtractors, chunk, rowIdx);
  }
}

export class HashJoinProbe {
  buildSide: any;
  probeKeyExtractors: any;
  buildColCount: any;
  probeColCount: any;
  joinType: any;
  conditionEvaluator: any;
  spillBuffers: any[];
  probeSchema: any;

  constructor(buildSide: any, probeKeyExtractors: any, buildColCount: any, probeColCount: any, joinType: any = JoinType.INNER, conditionEvaluator: any = null) {
    this.buildSide = buildSide;
    this.probeKeyExtractors = probeKeyExtractors;
    this.buildColCount = buildColCount;
    this.probeColCount = probeColCount;
    this.joinType = joinType;
    this.conditionEvaluator = conditionEvaluator;
    
    this.spillBuffers = Array.from({ length: Config.hashJoinPartitions }, () => []);
    this.probeSchema = null;
  }

  async init(): Promise<void> {}

  async process(probeChunk: any): Promise<any> {
    if (!this.probeSchema) {
      this.probeSchema = probeChunk.columns.map((c: any) => c.dataType);
    }
    
    const flat = probeChunk.selectionVector ? probeChunk.flatten() : probeChunk;
    const inMemoryRows = [];
    
    for (let i = 0; i < flat.size; i++) {
      const key = this.extractProbeKey(flat, i);
      const row = new Array(flat.columns.length);
      for (let c = 0; c < flat.columns.length; c++) {
        row[c] = flat.columns[c].get(i);
      }
      
      if (key === null) {
        inMemoryRows.push({ row, key: null });
        continue;
      }
      
      const pIdx = getPartition(key);
      if (this.buildSide.partitions[pIdx].spilled) {
        this.spillBuffers[pIdx].push({ row, key });
        if (this.spillBuffers[pIdx].length >= Config.flushBatchSize) {
          await this.flushProbePartition(pIdx);
        }
      } else {
        inMemoryRows.push({ row, key });
      }
    }
    
    if (inMemoryRows.length > 0) {
      return this.executeInMemoryJoin(inMemoryRows);
    }
    return null;
  }

  async flushProbePartition(pIdx: any): Promise<void> {
    const buffer = this.spillBuffers[pIdx];
    if (buffer.length === 0) return;
    
    const chunk = this.rowsToProbeChunk(buffer.map((r: any) => r.row));
    await this.buildSide.spillManager.appendChunk(`probe_${pIdx}`, chunk);
    this.spillBuffers[pIdx] = [];
  }

  rowsToProbeChunk(rows: any): any {
    if (rows.length === 0) return new DataChunk([], 0);
    const colCount = rows[0].length;
    const columns = new Array(colCount);
    for (let c = 0; c < colCount; c++) {
      const col = new Column(this.probeSchema?.[c] || 'VARCHAR', rows.length);
      for (let r = 0; r < rows.length; r++) {
        col.set(r, rows[r][c]);
      }
      col.length = rows.length;
      columns[c] = col;
    }
    return new DataChunk(columns, rows.length);
  }

  executeInMemoryJoin(probeItems: any): any {
    const resultRows = probeJoinRows(probeItems, (key: any) => this.buildSide.probe(key), {
      joinType: this.joinType,
      buildColCount: this.buildColCount,
      probeColCount: this.probeColCount,
      conditionEvaluator: this.conditionEvaluator,
      hasNullKey: this.buildSide.hasNullKey,
      onMatched: (buildItem: any) => this.buildSide.markMatched(buildItem),
    });

    return this.buildOutputChunk(resultRows);
  }

  async finalize(sink: any): Promise<void> {
    for (let i = 0; i < Config.hashJoinPartitions; i++) {
      if (this.spillBuffers[i].length > 0) {
        await this.flushProbePartition(i);
      }
    }

    for (let i = 0; i < Config.hashJoinPartitions; i++) {
      const part = this.buildSide.partitions[i];
      if (!part.spilled) continue;

      this.buildSide.hashTable.clear();
      part.rows = [];

      const buildIter = this.buildSide.spillManager.readChunks(`build_${i}`);
      for await (const bChunk of buildIter) {
        for (let r = 0; r < bChunk.size; r++) {
          const key = this.buildSide.buildKey(bChunk, r);
          const row = new Array(bChunk.columns.length);
          for (let c = 0; c < bChunk.columns.length; c++) row[c] = bChunk.columns[c].get(r);
          
          const rIdx = part.rows.length;
          part.rows.push({ row, key });
          
          let bucket = this.buildSide.hashTable.get(key);
          if (this.buildSide.uniqueKeys && bucket) continue;
          if (!bucket) {
            bucket = [];
            this.buildSide.hashTable.set(key, bucket);
          }
          bucket.push({ row, pIdx: i, rIdx });
        }
      }

      const probeIter = this.buildSide.spillManager.readChunks(`probe_${i}`);
      for await (const pChunk of probeIter) {
        const pItems: any[] = [];
        for (let r = 0; r < pChunk.size; r++) {
          const key = this.extractProbeKey(pChunk, r);
          const row = new Array(pChunk.columns.length);
          for (let c = 0; c < pChunk.columns.length; c++) row[c] = pChunk.columns[c].get(r);
          pItems.push({ row, key });
        }
        
        const result = this.executeInMemoryJoin(pItems);
        if (result && result.size > 0) {
          await sink.consume(result);
        }
      }
    }

    await this.buildSide.spillManager.clearAll();
  }

  extractProbeKey(chunk: any, rowIdx: any): any {
    return joinKeyOf(this.probeKeyExtractors, chunk, rowIdx);
  }

  buildOutputChunk(rows: any): any {
    return buildJoinOutputChunk(rows, {
      joinType: this.joinType,
      buildColCount: this.buildColCount,
      buildSchema: this.buildSide.buildSchema,
      probeSchema: this.probeSchema,
    });
  }
}
