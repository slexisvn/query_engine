# Further reading

These sources connect the book's implementation to the broader ideas. Read them after the relevant chapter; the book does not require prior database research experience. Other systems may make different implementation choices.

| After reading | Continue with | What to look for |
|---|---|---|
| Rows and columns (4) | [V8: Fast properties](https://v8.dev/blog/fast-properties) | Why a JavaScript object's properties are not necessarily stored in a hash table, and why layout claims need care. |
| Relational algebra and pushdown (10, 17–18) | [PostgreSQL 18: Table expressions](https://www.postgresql.org/docs/18/queries-table-expressions.html) | Join order, the distinction between `ON` and `WHERE`, and the logical transformations performed by grouping. Use it as a semantics reference, not as this engine's feature list. |
| Join ordering (25) | [SIGMOD 2008 proceedings: “Dynamic programming strikes back”](https://sigmod.org/publications/discs/2009/SIGMOD2008.htm) — Guido Moerkotte and Thomas Neumann | The original DPhyp work and its treatment of join graphs. The proceedings entry identifies the paper; chapter 25 follows this repository's adaptation. |
| Decorrelation (26–27) | [“Unnesting Arbitrary Queries”](https://portal.fis.tum.de/en/publications/unnesting-arbitrary-queries/) — Thomas Neumann and Alfons Kemper, 2015 | Dependent joins and the relational approach to removing correlation. Compare the broader method with the operators this engine's pushdown code handles. |
| Vectorized execution (30–31) | [CWI: the X100 vectorized execution paper and its Test of Time award](https://www.cwi.nl/en/news/test-of-time-award-for-paper-on-vectorized-execution/) — Peter Boncz, Marcin Zukowski, Niels Nes | The motivation for processing batches rather than one tuple at a time. The CWI page points to “MonetDB/X100: Hyper-Pipelining Query Execution,” CIDR 2005. A batch size is a design choice, not a universal hardware constant. |
| Parallel execution (45–47) | [“Morsel-Driven Parallelism: A NUMA-Aware Query Evaluation Framework for the Many-Core Age”](https://db.in.tum.de/~leis/papers/morsels.pdf) — Viktor Leis, Peter Boncz, Alfons Kemper, Thomas Neumann, SIGMOD 2014 | Scheduling small work units, locality, and how parallelism interacts with operator state. Shared memory in this TypeScript engine is a different implementation environment. |

When investigating an optimization, ask three questions while reading: under which SQL semantics is it legal, what physical work does it remove, and what evidence supports its performance claim? An elegant rewrite, a working implementation, and a measured speedup are different results.

For terminology, return to the [glossary](glossary.md). For changes to the book, follow the [writing conventions](../CONVENTIONS.md).
