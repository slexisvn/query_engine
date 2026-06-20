export type Comparator<T> = (a: T, b: T) => number;

export class PriorityQueue<T> {
  private _heap: T[];
  private _comparator: Comparator<T>;

  constructor(comparator: Comparator<T> = (a: T, b: T): number => (a as number) - (b as number)) {
    this._heap = [];
    this._comparator = comparator;
  }

  get size(): number {
    return this._heap.length;
  }

  isEmpty(): boolean {
    return this.size === 0;
  }

  peek(): T | undefined {
    return this._heap[0];
  }

  push(value: T): void {
    this._heap.push(value);
    this._siftUp();
  }

  pop(): T | null {
    if (this.isEmpty()) return null;
    const poppedValue: T | undefined = this.peek();
    const bottom: number = this.size - 1;
    if (bottom > 0) {
      this._heap[0] = this._heap[bottom];
    }
    this._heap.pop();
    this._siftDown();
    return poppedValue as T;
  }

  _parent(i: number): number {
    return ((i + 1) >>> 1) - 1;
  }

  _left(i: number): number {
    return (i << 1) + 1;
  }

  _right(i: number): number {
    return (i + 1) << 1;
  }

  _siftUp(): void {
    let node: number = this.size - 1;
    while (node > 0 && this._compare(node, this._parent(node))) {
      this._swap(node, this._parent(node));
      node = this._parent(node);
    }
  }

  _siftDown(): void {
    let node: number = 0;
    while (
      (this._left(node) < this.size && this._compare(this._left(node), node)) ||
      (this._right(node) < this.size && this._compare(this._right(node), node))
    ) {
      let maxChild: number = (this._right(node) < this.size && this._compare(this._right(node), this._left(node)))
        ? this._right(node)
        : this._left(node);

      this._swap(node, maxChild);
      node = maxChild;
    }
  }

  _compare(i: number, j: number): boolean {
    return this._comparator(this._heap[i], this._heap[j]) < 0;
  }

  _swap(i: number, j: number): void {
    const temp: T = this._heap[i];
    this._heap[i] = this._heap[j];
    this._heap[j] = temp;
  }
}
