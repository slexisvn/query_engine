import { Config } from '../../config.js';
import { byteWidthFor, type DataType } from '../data-type.js';
import { UINT32_BYTES, type ByteReader, type ByteWriter } from './byte-io.js';
import { EncodingKind } from './encoding-types.js';
import type {
  ColumnEncoder, EncodableVector, EncodedVector, EncodingPlan,
  IntegerArray, IntegerColumnStats, IntegerSink, IntegerSource,
} from './encoding-types.js';
import { integerArray, integerArrayCtor } from './integer-values.js';

const RUN_HEADER_BYTES = UINT32_BYTES;

interface RunFillTarget<T extends number | bigint> {
  fill(value: T, start: number, end: number): void;
}

function collectRuns<T extends number | bigint>(
  values: IntegerSource<T>, length: number, runStarts: Uint32Array, runValues: IntegerSink<T>,
): void {
  let run = 0;
  runStarts[0] = 0;
  runValues[0] = values[0];

  for (let index = 1; index < length; index++) {
    const value = values[index];
    if (value === runValues[run]) continue;
    run++;
    runStarts[run] = index;
    runValues[run] = value;
  }
}

function expandRuns<T extends number | bigint>(
  target: RunFillTarget<T>, runStarts: Uint32Array, runValues: IntegerSource<T>, length: number,
): void {
  const runCount = runStarts.length;
  for (let run = 0; run < runCount; run++) {
    const end = run + 1 < runCount ? runStarts[run + 1] : length;
    target.fill(runValues[run], runStarts[run], end);
  }
}

export class RunLengthVector implements EncodedVector {
  readonly kind = EncodingKind.RUN_LENGTH;
  readonly dataType: DataType;
  readonly length: number;
  readonly runStarts: Uint32Array;
  readonly runValues: IntegerArray;

  constructor(dataType: DataType, length: number, runStarts: Uint32Array, runValues: IntegerArray) {
    this.dataType = dataType;
    this.length = length;
    this.runStarts = runStarts;
    this.runValues = runValues;
  }

  get runCount(): number {
    return this.runStarts.length;
  }

  runIndexOf(index: number): number {
    const starts = this.runStarts;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (starts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  valueAt(index: number): number | bigint {
    return this.runValues[this.runIndexOf(index)];
  }

  decode(): IntegerArray {
    const target = integerArray(this.dataType, this.length);
    if (target instanceof BigInt64Array) {
      expandRuns<bigint>(target, this.runStarts, this.runValues as BigInt64Array, this.length);
    } else {
      expandRuns<number>(target, this.runStarts, this.runValues as Int32Array, this.length);
    }
    return target;
  }

  byteSize(): number {
    return RUN_HEADER_BYTES + this.runStarts.byteLength + this.runValues.byteLength;
  }

  writeTo(writer: ByteWriter): void {
    writer.u32(this.runStarts.length);
    writer.bytes(this.runStarts);
    writer.bytes(this.runValues);
  }
}

export const runLengthEncoder: ColumnEncoder = {
  kind: EncodingKind.RUN_LENGTH,
  id: 1,

  plan(stats: IntegerColumnStats, dataType: DataType): EncodingPlan {
    return {
      bytes: RUN_HEADER_BYTES + stats.runCount * (UINT32_BYTES + byteWidthFor(dataType)),
      withinThreshold: stats.runCount <= stats.length * Config.encodingRleMaxRunRatio,
    };
  },

  encode(source: EncodableVector): EncodedVector {
    const runStarts = new Uint32Array(source.stats.runCount);
    const runValues = integerArray(source.dataType, source.stats.runCount);

    if (runValues instanceof BigInt64Array) {
      collectRuns<bigint>(source.values as BigInt64Array, source.length, runStarts, runValues);
    } else {
      collectRuns<number>(source.values as Int32Array, source.length, runStarts, runValues);
    }

    return new RunLengthVector(source.dataType, source.length, runStarts, runValues);
  },

  read(reader: ByteReader, dataType: DataType, length: number): EncodedVector {
    const runCount = reader.u32();
    const runStarts = reader.typed(Uint32Array, runCount);
    const runValues = reader.typed(integerArrayCtor(dataType), runCount);
    return new RunLengthVector(dataType, length, runStarts, runValues);
  },
};
