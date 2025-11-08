// /routes/superadmin.routes.js
const router = require('express').Router();
const bcrypt = require('bcrypt');
const { redis } = require('../config/redis');
const { KEY_USERS_HASH, KEY_ADMIN_LAYOUT } = require('../socket/constants');
const { addAdminLog } = require('./routeHelpers');
 
router.post("/users/list", async (req, res) => {
    const userHash = await redis.hgetall(KEY_USERS_HASH);
    const users = Object.values(userHash).map(u => {
        const user = JSON.parse(u);
        return { username: user.username, role: user.role };
    });
    res.json({ success: true, users });
});
 
router.post("/users/create", async (req, res) => {
    const { username, password, role } = req.body;
    const io = req.app.get('socketio');

    if (!username || !password || !role) {
        return res.status(400).json({ error: "帳號、密碼和角色為必填。" });
    }
    if (role !== 'admin' && role !== 'superadmin') {
        return res.status(400).json({ error: "無效的角色。" });
    }
    
    const targetUsername = username.trim().toLowerCase();
    
    if (targetUsername.length === 0) {
         return res.status(400).json({ error: "帳號不可為空白。" });
    }
    
    // 【v3.11 移除】 密碼長度 8 字元限制
    /*
    if (password.trim().length < 8) {
        return res.status(400).json({ error: "密碼長度至少需要 8 個字元。" });
    }
    */

    if (await redis.hexists(KEY_USERS_HASH, targetUsername)) {
        return res.status(409).json({ error: "此帳號名稱已存在。" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    
    const newUser = {
        username: targetUsername,
        passwordHash: passwordHash, 
        role
    };
    
    await redis.hset(KEY_USERS_HASH, targetUsername, JSON.stringify(newUser));
    await addAdminLog(io, `建立了新用戶: ${targetUsername} (${role})`, req.user.username); 
    
    res.status(201).json({ success: true, user: { username: targetUsername, role } });
});
 
router.post("/users/delete", async (req, res) => {
    const { username } = req.body;
    const io = req.app.get('socketio');
    const targetUsername = username.trim().toLowerCase(); 

    if (targetUsername === req.user.username) {
        return res.status(400).json({ error: "無法刪除您自己的帳號。" });
    }
    
    const result = await redis.hdel(KEY_USERS_HASH, targetUsername);
    if (result === 0) {
        return res.status(404).json({ error: "找不到該用戶。" });
    }

    await addAdminLog(io, `刪除了用戶: ${targetUsername}`, req.user.username); 
    res.json({ success: true, message: "用戶已刪除。" });
});
 
router.post("/users/update-password", async (req, res) => {
    const { username, newPassword } = req.body;
    const io = req.app.get('socketio');

    if (!username || !newPassword) {
        return res.status(400).json({ error: "帳號和新密碼為必填。" });
    }
    
    // 【v3.11 移除】 密碼長度 8 字元限制
    /*
    if (newPassword.trim().length < 8) {
        return res.status(400).json({ error: "密碼長度至少需要 8 個字元。" });
    }
    */
    
    const targetUsername = username.trim().toLowerCase(); 
    const userJSON = await redis.hget(KEY_USERS_HASH, targetUsername);
    
    if (!userJSON) {
        return res.status(404).json({ error: "找不到該用戶。" });
    }

    const user = JSON.parse(userJSON);
    const passwordHash = await bcrypt.hash(newPassword, 10);
    
    const updatedUser = { ...user, passwordHash: passwordHash };
    
    await redis.hset(KEY_USERS_HASH, targetUsername, JSON.stringify(updatedUser));
    await addAdminLog(io, `重設了用戶 ${targetUsername} 的密碼`, req.user.username); 
    
    res.json({ success: true, message: `用戶 ${targetUsername} 的密碼已更新。` });
});

router.post("/users/update-role", async (req, res) => {
    const { username, newRole } = req.body;
    const io = req.app.get('socketio');

    if (!username || !newRole) {
        return res.status(400).json({ error: "帳號和新角色為必填。" });
    }
    
    if (newRole !== 'admin' && newRole !== 'superadmin') {
        return res.status(400).json({ error: "無效的角色。" });
    }

    const targetUsername = username.trim().toLowerCase(); 

    if (targetUsername === req.user.username) {
        return res.status(403).json({ error: "無法修改您自己的角色。" });
    }

    const userJSON = await redis.hget(KEY_USERS_HASH, targetUsername);
    if (!userJSON) {
        return res.status(404).json({ error: "找不到該用戶。" });
    }

    const user = JSON.parse(userJSON);
    const updatedUser = { ...user, role: newRole };

    await redis.hset(KEY_USERS_HASH, targetUsername, JSON.stringify(updatedUser));
    await addAdminLog(io, `將用戶 ${targetUsername} 的角色變更為 ${newRole}`, req.user.username); 
    
    res.json({ success: true, message: `用戶 ${targetUsername} 的角色已更新。` });
});


router.post("/layout/load", async (req, res) => {
    const layoutJSON = await redis.get(KEY_ADMIN_LAYOUT);
    if (layoutJSON) {
        res.json({ success: true, layout: JSON.parse(layoutJSON) });
    } else {
        res.json({ success: true, layout: null });
    }
});
 
router.post("/layout/save", async (req, res) => {
    const { layout } = req.body;
    const io = req.app.get('socketio');

    if (!layout || !Array.isArray(layout)) {
        return res.status(400).json({ error: "排版資料格式不正確。" });
    }
    
    const layoutJSON = JSON.stringify(layout);
    await redis.set(KEY_ADMIN_LAYOUT, layoutJSON);
    await addAdminLog(io, `💾 儀表板排版已儲存`, req.user.username); 
    res.json({ success: true, message: "排版已儲存。" });
});

module.exports = router;
