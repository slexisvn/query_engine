import type {
  NodeId,
  ChannelId,
  ChunkReceivedCallback,
  FragmentDispatchJSON,
  ControlMessage,
  ControlMessageCallback,
  FragmentReceivedCallback,
} from '../distributed-types.js';

export class Transport {
  async start(): Promise<void> {
    throw new Error('Transport subclass must implement start()');
  }

  async stop(): Promise<void> {
    throw new Error('Transport subclass must implement stop()');
  }

  async sendChunk(targetNodeId: NodeId, channelId: ChannelId, encodedChunk: Buffer): Promise<void> {
    throw new Error('Transport subclass must implement sendChunk()');
  }

  onChunkReceived(channelId: ChannelId, callback: ChunkReceivedCallback): void {
    throw new Error('Transport subclass must implement onChunkReceived()');
  }

  removeChunkListener(channelId: ChannelId): void {
    throw new Error('Transport subclass must implement removeChunkListener()');
  }

  async sendFragment(targetNodeId: NodeId, fragment: FragmentDispatchJSON): Promise<void> {
    throw new Error('Transport subclass must implement sendFragment()');
  }

  async sendControl(targetNodeId: NodeId, message: ControlMessage): Promise<void> {
    throw new Error('Transport subclass must implement sendControl()');
  }

  onControlMessage(callback: ControlMessageCallback): void {
    throw new Error('Transport subclass must implement onControlMessage()');
  }

  onFragmentReceived(callback: FragmentReceivedCallback): void {
    throw new Error('Transport subclass must implement onFragmentReceived()');
  }

  registerNode(nodeId: NodeId, host: string, port: number): void {
    throw new Error('Transport subclass must implement registerNode()');
  }
}
