import { createServer, request as httpRequest, Agent } from 'http';
import type { IncomingMessage, ServerResponse, Server, RequestOptions, OutgoingHttpHeaders } from 'http';
import { Transport } from './transport.js';
import { Config } from '../../config.js';
import type {
  NodeId,
  ChannelId,
  NodeAddress,
  ChunkReceivedCallback,
  PendingChunk,
  ControlMessage,
  ControlMessageCallback,
  FragmentDispatchJSON,
  FragmentReceivedCallback,
  NodeRegistration,
  RegisterAck,
  HeartbeatMessage,
  HeartbeatAck,
  StatusResponse,
} from '../distributed-types.js';

export interface HttpTransportOptions {
  port?: number;
  nodeId?: NodeId | null;
}

export type RegisterCallback = (registration: NodeRegistration) => void;

export type HeartbeatCallback = (message: HeartbeatMessage) => void;

type BodyCallback = (body: Buffer) => void;

export class HttpTransport extends Transport {
  _port: number;
  _nodeId: NodeId | null;
  _server: Server | null;
  _nodes: Map<NodeId, NodeAddress>;
  _chunkListeners: Map<ChannelId, ChunkReceivedCallback>;
  _pendingChunks: Map<ChannelId, PendingChunk[]>;
  _controlCallbacks: ControlMessageCallback[];
  _fragmentCallbacks: FragmentReceivedCallback[];
  _registerCallbacks: RegisterCallback[];
  _heartbeatCallbacks: HeartbeatCallback[];
  _agents: Map<string, Agent>;

  constructor(options: HttpTransportOptions = {}) {
    super();
    this._port = options.port || Config.clusterPort;
    this._nodeId = options.nodeId || null;
    this._server = null;
    this._nodes = new Map();
    this._chunkListeners = new Map();
    this._pendingChunks = new Map();
    this._controlCallbacks = [];
    this._fragmentCallbacks = [];
    this._registerCallbacks = [];
    this._heartbeatCallbacks = [];
    this._agents = new Map();
  }

  override async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._server = createServer((req, res) => this._handleRequest(req, res));
      this._server.on('error', reject);
      this._server.listen(this._port, () => resolve());
    });
  }

  override async stop(): Promise<void> {
    if (!this._server) return;
    for (const agent of this._agents.values()) {
      agent.destroy();
    }
    this._agents.clear();

    return new Promise(resolve => {
      (this._server as Server).close(() => resolve());
    });
  }

  override registerNode(nodeId: NodeId, host: string, port: number): void {
    this._nodes.set(nodeId, { host, port });
  }

  override async sendChunk(targetNodeId: NodeId, channelId: ChannelId, encodedChunk: Buffer): Promise<void> {
    const target = this._nodes.get(targetNodeId);
    if (!target) throw new Error(`Unknown node: ${targetNodeId}`);

    const headers: OutgoingHttpHeaders = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': encodedChunk.length,
    };
    if (this._nodeId) headers['x-source-node'] = this._nodeId;

    await this._post(target, `/exchange/${encodeURIComponent(channelId)}`, encodedChunk, headers);
  }

  override onChunkReceived(channelId: ChannelId, callback: ChunkReceivedCallback): void {
    this._chunkListeners.set(channelId, callback);
    const pending = this._pendingChunks.get(channelId);
    if (pending) {
      this._pendingChunks.delete(channelId);
      for (const { sourceNodeId, data } of pending) callback(sourceNodeId, data);
    }
  }

  override removeChunkListener(channelId: ChannelId): void {
    this._chunkListeners.delete(channelId);
    this._pendingChunks.delete(channelId);
  }

  override async sendFragment(targetNodeId: NodeId, fragment: FragmentDispatchJSON): Promise<void> {
    const target = this._nodes.get(targetNodeId);
    if (!target) throw new Error(`Unknown node: ${targetNodeId}`);

    const body = Buffer.from(JSON.stringify(fragment));
    await this._post(target, '/fragment/execute', body, {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
    });
  }

  override async sendControl(targetNodeId: NodeId, message: ControlMessage): Promise<void> {
    const target = this._nodes.get(targetNodeId);
    if (!target) throw new Error(`Unknown node: ${targetNodeId}`);

    const body = Buffer.from(JSON.stringify(message));
    await this._post(target, '/control', body, {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
    });
  }

  async sendRegister(targetNodeId: NodeId, registration: NodeRegistration): Promise<void> {
    const target = this._nodes.get(targetNodeId);
    if (!target) throw new Error(`Unknown node: ${targetNodeId}`);

    const body = Buffer.from(JSON.stringify(registration));
    await this._post(target, '/register', body, {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
    });
  }

  override onControlMessage(callback: ControlMessageCallback): void {
    this._controlCallbacks.push(callback);
  }

  override onFragmentReceived(callback: FragmentReceivedCallback): void {
    this._fragmentCallbacks.push(callback);
  }

  onRegister(callback: RegisterCallback): void {
    this._registerCallbacks.push(callback);
  }

  onHeartbeat(callback: HeartbeatCallback): void {
    this._heartbeatCallbacks.push(callback);
  }

  async sendHeartbeat(targetNodeId: NodeId, message: HeartbeatMessage): Promise<void> {
    const target = this._nodes.get(targetNodeId);
    if (!target) return;
    const body = Buffer.from(JSON.stringify(message));
    await this._post(target, '/heartbeat', body, {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
    });
  }

  _handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url as string, `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const statusResponse: StatusResponse = { status: 'alive', nodeId: this._nodeId };
      res.end(JSON.stringify(statusResponse));
      return;
    }

    if (req.method === 'POST') {
      this._collectBody(req, (body) => {
        if (path.startsWith('/exchange/')) {
          const channelId = decodeURIComponent(path.slice('/exchange/'.length));
          this._handleExchangeData(channelId, body, req, res);
        } else if (path === '/fragment/execute') {
          this._handleFragmentExecute(body, res);
        } else if (path === '/control') {
          this._handleControl(body, res);
        } else if (path === '/heartbeat') {
          this._handleHeartbeat(body, res);
        } else if (path === '/register') {
          this._handleRegister(body, res);
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  }

  _handleExchangeData(channelId: ChannelId, body: Buffer, req: IncomingMessage, res: ServerResponse): void {
    const sourceNodeId = (req.headers['x-source-node'] as NodeId | undefined) || 'unknown';
    const callback = this._chunkListeners.get(channelId);
    if (callback) {
      callback(sourceNodeId, body);
    } else {
      let pending = this._pendingChunks.get(channelId);
      if (!pending) { pending = []; this._pendingChunks.set(channelId, pending); }
      pending.push({ sourceNodeId, data: body });
    }
    res.writeHead(200);
    res.end();
  }

  _handleFragmentExecute(body: Buffer, res: ServerResponse): void {
    try {
      const fragment = JSON.parse(body.toString()) as FragmentDispatchJSON;
      for (const cb of this._fragmentCallbacks) {
        cb(fragment);
      }
      res.writeHead(202);
      res.end();
    } catch (err) {
      res.writeHead(400);
      res.end((err as Error).message);
    }
  }

  _handleControl(body: Buffer, res: ServerResponse): void {
    try {
      const message = JSON.parse(body.toString()) as ControlMessage;
      for (const cb of this._controlCallbacks) {
        cb(message);
      }
      res.writeHead(200);
      res.end();
    } catch (err) {
      res.writeHead(400);
      res.end((err as Error).message);
    }
  }

  _handleHeartbeat(body: Buffer, res: ServerResponse): void {
    try {
      const msg = JSON.parse(body.toString()) as HeartbeatMessage;
      for (const cb of this._heartbeatCallbacks) cb(msg);
    } catch (_) {}
    res.writeHead(200);
    const ack: HeartbeatAck = { ts: Date.now() };
    res.end(JSON.stringify(ack));
  }

  _handleRegister(body: Buffer, res: ServerResponse): void {
    try {
      const registration = JSON.parse(body.toString()) as NodeRegistration;
      for (const cb of this._registerCallbacks) {
        cb(registration);
      }
      res.writeHead(200);
      const ack: RegisterAck = { ok: true };
      res.end(JSON.stringify(ack));
    } catch (err) {
      res.writeHead(400);
      res.end((err as Error).message);
    }
  }

  _collectBody(req: IncomingMessage, callback: BodyCallback): void {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => callback(Buffer.concat(chunks)));
  }

  async _post(target: NodeAddress, path: string, body: Buffer, headers?: OutgoingHttpHeaders): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const options: RequestOptions = {
        hostname: target.host,
        port: target.port,
        path,
        method: 'POST',
        headers: headers || {
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length,
        },
        agent: this._getAgent(target),
      };

      const req = httpRequest(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });

      req.on('error', reject);
      req.end(body);
    });
  }

  _getAgent(target: NodeAddress): Agent {
    const key = `${target.host}:${target.port}`;
    let agent = this._agents.get(key);
    if (!agent) {
      agent = new Agent({ keepAlive: true, maxSockets: 4 });
      this._agents.set(key, agent);
    }
    return agent;
  }
}
