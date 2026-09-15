/* Express app、HTTP server 與 Socket.io 實例 (其他模組共用同一個 io) */
const { Server } = require("http"), express = require("express"), socketio = require("socket.io");
const { ALLOWED_ORIGINS } = require('./config');

const app = express();
const server = Server(app);
const io = socketio(server, { cors: { origin: ALLOWED_ORIGINS ? ALLOWED_ORIGINS.split(',') : ["http://localhost:3000"], methods: ["GET", "POST"], credentials: true }, pingTimeout: 60000 });

module.exports = { app, server, io };
