export class PriorityQueue {
  constructor(comparator = (a, b) => a - b) {
    this._heap = [];
    this._comparator = comparator;
  }

  get size() {
    return this._heap.length;
  }

  isEmpty() {
    return this.size === 0;
  }

  peek() {
    return this._heap[0];
  }

  push(value) {
    this._heap.push(value);
    this._siftUp();
  }

  pop() {
    if (this.isEmpty()) return null;
    const poppedValue = this.peek();
    const bottom = this.size - 1;
    if (bottom > 0) {
      this._heap[0] = this._heap[bottom];
    }
    this._heap.pop();
    this._siftDown();
    return poppedValue;
  }

  _parent(i) {
    return ((i + 1) >>> 1) - 1;
  }

  _left(i) {
    return (i << 1) + 1;
  }

  _right(i) {
    return (i + 1) << 1;
  }

  _siftUp() {
    let node = this.size - 1;
    while (node > 0 && this._compare(node, this._parent(node))) {
      this._swap(node, this._parent(node));
      node = this._parent(node);
    }
  }

  _siftDown() {
    let node = 0;
    while (
      (this._left(node) < this.size && this._compare(this._left(node), node)) ||
      (this._right(node) < this.size && this._compare(this._right(node), node))
    ) {
      let maxChild = (this._right(node) < this.size && this._compare(this._right(node), this._left(node))) 
        ? this._right(node) 
        : this._left(node);
      
      this._swap(node, maxChild);
      node = maxChild;
    }
  }

  _compare(i, j) {
    return this._comparator(this._heap[i], this._heap[j]) < 0;
  }

  _swap(i, j) {
    const temp = this._heap[i];
    this._heap[i] = this._heap[j];
    this._heap[j] = temp;
  }
}
