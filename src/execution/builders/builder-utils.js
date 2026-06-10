export function combinedMappingOf(...schemas) {
  const mapping = new Map();
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

export function registerBufferedChild(graph, currentPipelineId, compiled) {
  const chunks = [];
  const sink = {
    consume: async (chunk) => { chunks.push(chunk); },
    finalize: async () => {},
  };
  const pipelineId = graph.createPipeline(sink);
  compiled.register(graph, pipelineId, sink);
  graph.addDependency(currentPipelineId, pipelineId);
  return chunks;
}
