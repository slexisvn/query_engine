export class Transport {
  async start() {
    throw new Error('Transport subclass must implement start()');
  }

  async stop() {
    throw new Error('Transport subclass must implement stop()');
  }

  async sendChunk(targetNodeId, channelId, encodedChunk) {
    throw new Error('Transport subclass must implement sendChunk()');
  }

  onChunkReceived(channelId, callback) {
    throw new Error('Transport subclass must implement onChunkReceived()');
  }

  removeChunkListener(channelId) {
    throw new Error('Transport subclass must implement removeChunkListener()');
  }

  async sendFragment(targetNodeId, fragment) {
    throw new Error('Transport subclass must implement sendFragment()');
  }

  async sendControl(targetNodeId, message) {
    throw new Error('Transport subclass must implement sendControl()');
  }

  onControlMessage(callback) {
    throw new Error('Transport subclass must implement onControlMessage()');
  }

  onFragmentReceived(callback) {
    throw new Error('Transport subclass must implement onFragmentReceived()');
  }

  registerNode(nodeId, host, port) {
    throw new Error('Transport subclass must implement registerNode()');
  }
}
