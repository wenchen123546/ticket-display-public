/* 組裝 Express 中介層與路由 (index.js 與整合測試共用；不含監聽 port、排程與程序事件) */
const express = require('express'), path = require('path');
const { app } = require('./server');
const security = require('./security');
const setupSocket = require('./socket');
const lineRoutes = require('./routes/line');

module.exports = function setupApp() {
    app.disable('x-powered-by'); app.set('trust proxy', 1);
    app.use(security);
    app.use(express.static(path.join(__dirname, '..', 'public')));
    app.use(lineRoutes.webhook); // LINE 簽章驗證需要原始 body，必須在 express.json() 之前
    app.use(express.json());
    app.use(require('./routes/public'));
    app.use(require('./routes/booking'));
    app.use(require('./routes/account'));
    app.use(require('./routes/control'));
    app.use(require('./routes/admin'));
    app.use(lineRoutes.admin);
    setupSocket();
    app.use((err, req, res, _next) => { console.error('Global Error:', err.stack || err.message); res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' }); });
    return app;
};
