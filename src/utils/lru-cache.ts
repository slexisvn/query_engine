interface LRUNode<K, V> {
  key: K;
  value: V;
  prev: LRUNode<K, V> | null;
  next: LRUNode<K, V> | null;
}

export class LRUCache<K, V> {
  _maxSize: number;
  _map: Map<K, LRUNode<K, V>>;
  _head: LRUNode<K, V> | null;
  _tail: LRUNode<K, V> | null;

  constructor(maxSize: number) {
    this._maxSize = maxSize;
    this._map = new Map();
    this._head = null;
    this._tail = null;
  }

  _detach(node: LRUNode<K, V>): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this._head = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this._tail = node.prev;
    }
    node.prev = null;
    node.next = null;
  }

  _prepend(node: LRUNode<K, V>): void {
    node.next = this._head;
    node.prev = null;
    if (this._head) {
      this._head.prev = node;
    }
    this._head = node;
    if (!this._tail) {
      this._tail = node;
    }
  }

  _moveToHead(node: LRUNode<K, V>): void {
    if (node === this._head) return;
    this._detach(node);
    this._prepend(node);
  }

  _evictTail(): K | null {
    const evicted = this._tail;
    if (!evicted) return null;
    this._map.delete(evicted.key);
    this._detach(evicted);
    return evicted.key;
  }

  get(key: K): V | undefined {
    const node = this._map.get(key);
    if (!node) return undefined;
    this._moveToHead(node);
    return node.value;
  }

  set(key: K, value: V): K | null {
    const existing = this._map.get(key);
    if (existing) {
      existing.value = value;
      this._moveToHead(existing);
      return null;
    }
    const node: LRUNode<K, V> = { key, value, prev: null, next: null };
    this._map.set(key, node);
    this._prepend(node);
    if (this._map.size > this._maxSize) {
      return this._evictTail();
    }
    return null;
  }

  has(key: K): boolean {
    return this._map.has(key);
  }

  delete(key: K): boolean {
    const node = this._map.get(key);
    if (!node) return false;
    this._detach(node);
    this._map.delete(key);
    return true;
  }

  clear(): void {
    this._map.clear();
    this._head = null;
    this._tail = null;
  }

  get size(): number {
    return this._map.size;
  }
}
