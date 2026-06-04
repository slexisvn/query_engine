export class Optimizer {
  constructor() {
    this.passes = [];
  }

  registerPass(pass) {
    this.passes.push(pass);
    return this;
  }

  removePass(name) {
    this.passes = this.passes.filter(p => p.name !== name);
    return this;
  }

  insertPassBefore(name, pass) {
    const idx = this.passes.findIndex(p => p.name === name);
    if (idx === -1) {
      this.passes.push(pass);
    } else {
      this.passes.splice(idx, 0, pass);
    }
    return this;
  }

  insertPassAfter(name, pass) {
    const idx = this.passes.findIndex(p => p.name === name);
    if (idx === -1) {
      this.passes.push(pass);
    } else {
      this.passes.splice(idx + 1, 0, pass);
    }
    return this;
  }

  optimize(plan, context = {}) {
    let current = plan;
    for (const pass of this.passes) {
      current = pass.apply(current, context);
    }
    return current;
  }

  listPasses() {
    return this.passes.map(p => p.name);
  }
}
