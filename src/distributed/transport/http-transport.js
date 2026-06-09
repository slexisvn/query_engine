import { createServer, request as httpRequest, Agent } from 'http';
import { Transport } from './transport.js';
import { Config } from '../../config.js';

export class HttpTransport extends Transport {
  constructor(options = {}) {
    super();
    this._port = options.port || Config.clusterPort;
    this._nodeId = options.nodeId || null;
    this._server = null;
    this._nodes = new Map();
    this._chunkListeners = new Map();
    this._controlCallbacks = [];
    this._fragmentCallbacks = [];
    this._registerCallbacks = [];
    this._agents = new Map();
  }

  async start() {
    return new Promise((resolve, reject) => {
      this._server = createServer((req, res) => this._handleRequest(req, res));
      this._server.on('error', reject);
      this._server.listen(this._port, () => resolve());
    });
  }

  async stop() {
    if (!this._server) return;
    for (const agent of this._agents.values()) {
      agent.destroy();
    }
    this._agents.clear();

    return new Promise(resolve => {
      this._server.close(() => resolve());
    });
  }

  registerNode(nodeId, host, port) {
    this._nodes.set(nodeId, { host, port });
  }

  async sendChunk(targetNodeId, channelId, encodedChunk) {
    const target = this._nodes.get(targetNodeId);
    if (!target) throw new Error(`Unknown node: ${targetNodeId}`);

    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': encodedChunk.length,
    };
    if (this._nodeId) headers['x-source-node'] = this._nodeId;

    await this._post(target, `/exchange/${encodeURIComponent(channelId)}`, encodedChunk, headers);
  }

  onChunkReceived(channelId, callback) {
    this._chunkListeners.set(channelId, callback);
  }

  removeChunkListener(channelId) {
    this._chunkListeners.delete(channelId);
  }

  async sendFragment(targetNodeId, fragment) {
    const target = this._nodes.get(targetNodeId);
    if (!target) throw new Error(`Unknown node: ${targetNodeId}`);

    const body = Buffer.from(JSON.stringify(fragment));
    await this._post(target, '/fragment/execute', body, {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
    });
  }

  async sendControl(targetNodeId, message) {
    const target = this._nodes.get(targetNodeId);
    if (!target) throw new Error(`Unknown node: ${targetNodeId}`);

    const body = Buffer.from(JSON.stringify(message));
    await this._post(target, '/control', body, {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
    });
  }

  async sendRegister(targetNodeId, registration) {
    const target = this._nodes.get(targetNodeId);
    if (!target) throw new Error(`Unknown node: ${targetNodeId}`);

    const body = Buffer.from(JSON.stringify(registration));
    await this._post(target, '/register', body, {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
    });
  }

  onControlMessage(callback) {
    this._controlCallbacks.push(callback);
  }

  onFragmentReceived(callback) {
    this._fragmentCallbacks.push(callback);
  }

  onRegister(callback) {
    this._registerCallbacks.push(callback);
  }

  _handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'alive', nodeId: this._nodeId }));
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

  _handleExchangeData(channelId, body, req, res) {
    const sourceNodeId = req.headers['x-source-node'] || 'unknown';
    const callback = this._chunkListeners.get(channelId);
    if (callback) {
      callback(sourceNodeId, body);
    }
    res.writeHead(200);
    res.end();
  }

  _handleFragmentExecute(body, res) {
    try {
      const fragment = JSON.parse(body.toString());
      for (const cb of this._fragmentCallbacks) {
        cb(fragment);
      }
      res.writeHead(202);
      res.end();
    } catch (err) {
      res.writeHead(400);
      res.end(err.message);
    }
  }

  _handleControl(body, res) {
    try {
      const message = JSON.parse(body.toString());
      for (const cb of this._controlCallbacks) {
        cb(message);
      }
      res.writeHead(200);
      res.end();
    } catch (err) {
      res.writeHead(400);
      res.end(err.message);
    }
  }

  _handleHeartbeat(body, res) {
    res.writeHead(200);
    res.end(JSON.stringify({ ts: Date.now() }));
  }

  _handleRegister(body, res) {
    try {
      const registration = JSON.parse(body.toString());
      for (const cb of this._registerCallbacks) {
        cb(registration);
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400);
      res.end(err.message);
    }
  }

  _collectBody(req, callback) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => callback(Buffer.concat(chunks)));
  }

  async _post(target, path, body, headers) {
    return new Promise((resolve, reject) => {
      const options = {
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
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });

      req.on('error', reject);
      req.end(body);
    });
  }

  _getAgent(target) {
    const key = `${target.host}:${target.port}`;
    let agent = this._agents.get(key);
    if (!agent) {
      agent = new Agent({ keepAlive: true, maxSockets: 4 });
      this._agents.set(key, agent);
    }
    return agent;
  }
}
