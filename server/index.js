'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createRoom, joinRoom, act, snapshot } = require('./game.js');
const ROOT = path.resolve(__dirname, '..');
const TTL = 24 * 60 * 60 * 1000;
const MAX_ROOMS = 1000;

function createServer() {
    const rooms = new Map(), streams = new Map(), limits = new Map();
    function publish(id) {
        for (const stream of streams.get(id) || []) stream.write(`data: ${JSON.stringify({ ...snapshot(rooms.get(id)), you: stream.playerIndex })}\n\n`);
    }
    const timer = setInterval(() => {
        const now = Date.now();
        for (const [id, room] of rooms) if (now - room.updated > TTL) {
            for (const stream of streams.get(id) || []) stream.end();
            streams.delete(id); rooms.delete(id);
        }
        for (const [ip, limit] of limits) if (now - limit.start > 60000) limits.delete(ip);
        for (const clients of streams.values()) for (const stream of clients) stream.write(': heartbeat\n\n');
    }, 20000);
    timer.unref();
    const server = http.createServer(async (req, res) => {
        const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
        try {
            const url = new URL(req.url, 'http://localhost');
            if (url.pathname.startsWith('/api/')) {
                if (req.method === 'POST') {
                    // Same-origin JSON requests only; do not permit cross-site room changes.
                    if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Open the game on this server to play.' });
                    if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'JSON required.' });
                    const ip = req.socket.remoteAddress;
                    const now = Date.now(); let limit = limits.get(ip);
                    if (!limit || now - limit.start > 60000) { limit = { start: now, count: 0 }; limits.set(ip, limit); }
                    if (++limit.count > 180) return send(429, { error: 'Too many requests. Try again in a minute.' });
                    let body = '';
                    for await (const chunk of req) { body += chunk; if (body.length > 4096) return send(413, { error: 'Request too large.' }); }
                    let data; try { data = JSON.parse(body); } catch { return send(400, { error: 'Invalid JSON.' }); }
                    if (!data || typeof data !== 'object' || Array.isArray(data)) return send(400, { error: 'Invalid request.' });
                    if (url.pathname === '/api/rooms') {
                        if (rooms.size >= MAX_ROOMS) return send(503, { error: 'Server full. Try again later.' });
                        const room = createRoom(data.variant, data.name, data.playerCount);
                        const id = randomBytes(6).toString('hex'); rooms.set(id, room);
                        return send(201, { id, token: room.players[0].token });
                    }
                    const match = url.pathname.match(/^\/api\/rooms\/([a-f0-9]{12})\/(join|action)$/);
                    if (!match) return send(404, { error: 'Not found.' });
                    const [, id, op] = match, room = rooms.get(id);
                    if (!room) return send(404, { error: 'Room expired or not found. Create a new game.' });
                    if (op === 'join') {
                        const p = joinRoom(room, data.name); publish(id);
                        return send(200, { id, token: p.token });
                    }
                    const index = room.players.findIndex(p => `Bearer ${p.token}` === req.headers.authorization);
                    if (index < 0) return send(401, { error: 'Rejoin this room from your original browser.' });
                    act(room, index, data); publish(id); return send(200, snapshot(room));
                }
                const stateMatch = url.pathname.match(/^\/api\/rooms\/([a-f0-9]{12})$/);
                if (req.method === 'GET' && stateMatch) {
                    const room = rooms.get(stateMatch[1]);
                    if (!room) return send(404, { error: 'Room expired or not found.' });
                    const you = room.players.findIndex(p => `Bearer ${p.token}` === req.headers.authorization);
                    if (you < 0) return send(401, { error: 'Invalid player.' });
                    return send(200, { ...snapshot(room), you });
                }
                const match = url.pathname.match(/^\/api\/rooms\/([a-f0-9]{12})\/events$/);
                if (req.method === 'GET' && match) {
                    const id = match[1], room = rooms.get(id);
                    if (!room) return send(404, { error: 'Room expired or not found.' });
                    // EventSource cannot send Authorization headers. Tokens stay out of invite links.
                    const you = room.players.findIndex(p => p.token === url.searchParams.get('token'));
                    if (you < 0) return send(401, { error: 'Invalid player.' });
                    const clients = streams.get(id) || new Set();
                    if (clients.size >= room.playerCount * 4) return send(429, { error: 'Too many open tabs for this room.' });
                    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no' });
                    res.playerIndex = you;
                    res.write(`data: ${JSON.stringify({ ...snapshot(room), you })}\n\n`);
                    clients.add(res); streams.set(id, clients);
                    req.on('close', () => { clients.delete(res); if (!clients.size) streams.delete(id); });
                    return;
                }
                return send(404, { error: 'Not found.' });
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'Method not allowed.' });
            let file = decodeURIComponent(url.pathname);
            if (file.endsWith('/')) file += 'index.html';
            // Explicit public directories: never serve server code, credentials, or dotfiles.
            if (!(file === '/index.html' || /^\/(shared|img|maxi|yatzy|yahtzee|multiplayer)\/[a-zA-Z0-9_./-]+$/.test(file)) || file.split('/').some(p => p.startsWith('.'))) return send(404, { error: 'Not found.' });
            const absolute = path.resolve(ROOT, '.' + file);
            if (!absolute.startsWith(ROOT + path.sep)) return send(404, { error: 'Not found.' });
            const content = await fs.readFile(absolute);
            const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg' };
            res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
            res.end(req.method === 'HEAD' ? undefined : content);
        } catch (error) {
            if (res.headersSent) { res.end(); return; }
            send(error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : 400, { error: error.code ? 'Not found.' : error.message });
        }
    });
    server.on('close', () => clearInterval(timer));
    return server;
}
if (require.main === module) {
    const port = Number(process.env.PORT || 3000);
    createServer().listen(port, '0.0.0.0', () => console.log(`Yatzy ready at http://localhost:${port}/multiplayer/`));
}
module.exports = { createServer };
