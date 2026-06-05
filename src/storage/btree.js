import { Config } from '../config.js';

class BTreeNode {
  constructor(isLeaf) {
    this.isLeaf = isLeaf;
    this.keys = [];
    this.children = [];
    this.values = [];
    this.next = null;
  }
}

export class BTreeIndex {
  constructor(dataType) {
    this.dataType = dataType;
    this.root = new BTreeNode(true);
    this.order = Config.btreeOrder;
  }

  _compare(a, b) {
    if (a === b) return 0;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    if (typeof a === 'bigint') a = Number(a);
    if (typeof b === 'bigint') b = Number(b);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  _findIndex(keys, key) {
    let lo = 0, hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._compare(keys[mid], key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  insert(key, rowLocation) {
    const result = this._insertInternal(this.root, key, rowLocation);
    if (result) {
      const newRoot = new BTreeNode(false);
      newRoot.keys = [result.key];
      newRoot.children = [this.root, result.right];
      this.root = newRoot;
    }
  }

  _insertInternal(node, key, rowLocation) {
    if (node.isLeaf) {
      const pos = this._findIndex(node.keys, key);
      if (pos < node.keys.length && this._compare(node.keys[pos], key) === 0) {
        node.values[pos].push(rowLocation);
        return null;
      }
      node.keys.splice(pos, 0, key);
      node.values.splice(pos, 0, [rowLocation]);

      if (node.keys.length >= this.order) {
        return this._splitLeaf(node);
      }
      return null;
    }

    const childIdx = this._findChildIndex(node, key);
    const result = this._insertInternal(node.children[childIdx], key, rowLocation);
    if (!result) return null;

    const pos = this._findIndex(node.keys, result.key);
    node.keys.splice(pos, 0, result.key);
    node.children.splice(pos + 1, 0, result.right);

    if (node.keys.length >= this.order) {
      return this._splitInternal(node);
    }
    return null;
  }

  _findChildIndex(node, key) {
    let lo = 0, hi = node.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._compare(node.keys[mid], key) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _splitLeaf(leaf) {
    const mid = Math.ceil(leaf.keys.length / 2);
    const rightKeys = leaf.keys.splice(mid);
    const rightValues = leaf.values.splice(mid);
    const newRight = new BTreeNode(true);
    newRight.keys = rightKeys;
    newRight.values = rightValues;
    newRight.next = leaf.next;
    leaf.next = newRight;
    return { key: rightKeys[0], right: newRight };
  }

  _splitInternal(node) {
    const mid = Math.floor(node.keys.length / 2);
    const upKey = node.keys[mid];
    const rightKeys = node.keys.splice(mid + 1);
    node.keys.splice(mid, 1);
    const rightChildren = node.children.splice(mid + 1);
    const newRight = new BTreeNode(false);
    newRight.keys = rightKeys;
    newRight.children = rightChildren;
    return { key: upKey, right: newRight };
  }

  search(key) {
    let node = this.root;
    while (!node.isLeaf) {
      const idx = this._findChildIndex(node, key);
      node = node.children[idx];
    }
    const pos = this._findIndex(node.keys, key);
    if (pos < node.keys.length && this._compare(node.keys[pos], key) === 0) {
      return node.values[pos];
    }
    return [];
  }

  *range(low, high, lowInclusive, highInclusive) {
    let node = this.root;
    if (low !== null && low !== undefined) {
      while (!node.isLeaf) {
        const idx = this._findChildIndex(node, low);
        node = node.children[idx];
      }
    } else {
      while (!node.isLeaf) {
        node = node.children[0];
      }
    }

    let pos = 0;
    if (low !== null && low !== undefined) {
      pos = this._findIndex(node.keys, low);
      if (!lowInclusive && pos < node.keys.length && this._compare(node.keys[pos], low) === 0) {
        pos++;
      }
    }

    let current = node;
    let i = pos;
    while (current) {
      while (i < current.keys.length) {
        const k = current.keys[i];
        if (high !== null && high !== undefined) {
          const cmp = this._compare(k, high);
          if (cmp > 0 || (cmp === 0 && !highInclusive)) return;
        }
        for (const loc of current.values[i]) {
          yield loc;
        }
        i++;
      }
      current = current.next;
      i = 0;
    }
  }
}
