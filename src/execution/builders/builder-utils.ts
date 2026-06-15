export function combinedMappingOf(...schemas: any[]): Map<string, number> {
  const mapping = new Map<string, number>();
  let idx = 0;
  for (const schema of schemas) {
    for (const col of schema) {
      const key = `${col.tableAlias}.${col.name}`.toUpperCase();
      mapping.set(key, idx);
      if (!mapping.has(col.name.toUpperCase())) {
        mapping.set(col.name.toUpperCase(), idx);
      }
      idx++;
    }
  }
  return mapping;
}

export function registerBufferedChild(graph: any, currentPipelineId: any, compiled: any): any[] {
  const chunks: any[] = [];
  const sink = {
    consume: async (chunk: any) => { chunks.push(chunk); },
    finalize: async () => {},
  };
  const pipelineId = graph.createPipeline(sink);
  compiled.register(graph, pipelineId, sink);
  graph.addDependency(currentPipelineId, pipelineId);
  return chunks;
}
