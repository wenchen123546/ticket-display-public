/* 登入 / 登出、帳號管理、角色權限設定 */
const express = require('express'), rateLimit = require('express-rate-limit'), crypto = require('crypto'), bcrypt = require('bcrypt');
const { redis } = require('../redis');
const { KEYS, ADMIN_TOKEN, SESSION_TTL, VALID_ROLES, IS_PROD } = require('../config');
const { parseCookie, safeEqual, isAdminUser } = require('../utils');
const { H } = require('../http');
const { auth, perm, hasPerm, getRoles, setRolesCache } = require('../auth');
const { addLog } = require('../log');

const router = express.Router();

router.post("/login", rateLimit({windowMs:9e5,max:100}), H(async (req, res) => {
    const { username: u, password: p } = req.body || {};
    if(typeof u !== 'string' || typeof p !== 'string' || !u || !p) throw new Error("帳號或密碼錯誤");
    let valid = u === 'superadmin' && safeEqual(p.trim(), ADMIN_TOKEN.trim());
    if(!valid && u !== 'superadmin') { const hash = await redis.hget(KEYS.USERS, u); if(hash) valid = await bcrypt.compare(p, hash); }
    if(!valid) throw new Error("帳號或密碼錯誤");
    const token = crypto.randomUUID(), nick = await redis.hget(KEYS.NICKS, u) || u, userRole = (u==='superadmin' ? 'ADMIN' : (await redis.hget(KEYS.USER_ROLES, u) || 'OPERATOR'));
    await redis.set(`${KEYS.SESSION}${token}`, JSON.stringify({username:u, role:u==='superadmin'?'super':'normal', userRole, nickname:nick}), "EX", SESSION_TTL);
    res.setHeader('Set-Cookie', [`token=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL}; SameSite=Strict${IS_PROD?'; Secure':''}`]);
    return { success: true, role: u==='superadmin'?'super':'normal', userRole, username: u, nickname: nick };
}));
router.post("/logout", async (req, res) => { const t = parseCookie(req.headers.cookie||'')['token']; if(t) await redis.del(`${KEYS.SESSION}${t}`).catch(()=>{}); res.setHeader('Set-Cookie', 'token=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict'); res.json({ success: true }); });
router.post("/api/admin/me", auth, H(async r => ({ username: r.user.username, role: r.user.role, userRole: r.user.userRole, nickname: r.user.nickname })));

router.post("/api/admin/users", auth, perm('perm_users_view'), H(async () => { const [names, nicks, roles] = await Promise.all([redis.hkeys(KEYS.USERS), redis.hgetall(KEYS.NICKS), redis.hgetall(KEYS.USER_ROLES)]); return { users: [{username:'superadmin', nickname:nicks.superadmin||'Super', role:'ADMIN'}, ...names.filter(n => n!=='superadmin').map(n => ({username:n, nickname:nicks[n]||n, role:roles[n]||'OPERATOR'}))] }; }));
router.post("/api/admin/add-user", auth, perm('perm_users_edit'), H(async r => {
    const { newUsername: u, newPassword: p, newNickname: n, newRole = 'OPERATOR' } = r.body;
    if(typeof u !== 'string' || !/^[^\s<>"'&]{1,32}$/.test(u)) throw new Error("帳號格式錯誤 (1-32 字，不可含空白或 <>\"'&)");
    if(u === 'superadmin') throw new Error("保留帳號，不可建立");
    if(typeof p !== 'string' || p.length < 6) throw new Error("密碼至少 6 碼");
    if(!VALID_ROLES.includes(newRole)) throw new Error("無效角色");
    if(newRole === 'ADMIN' && !isAdminUser(r.user)) throw new Error("僅管理員可建立管理員帳號");
    if(await redis.hexists(KEYS.USERS, u)) throw new Error("已存在");
    await redis.multi().hset(KEYS.USERS, u, await bcrypt.hash(p, 10)).hset(KEYS.NICKS, u, String(n||u).trim().slice(0, 32) || u).hset(KEYS.USER_ROLES, u, newRole).exec();
    addLog(r.user.nickname, `👤 新增帳號 ${u} (${newRole})`);
}));
router.post("/api/admin/del-user", auth, perm('perm_users_edit'), H(async r => {
    const u = r.body.delUsername;
    if(u==='superadmin' || u===r.user.username) throw new Error("不可刪除");
    if((await redis.hget(KEYS.USER_ROLES, u))==='ADMIN' && !isAdminUser(r.user)) throw new Error("權限不足");
    await redis.multi().hdel(KEYS.USERS, u).hdel(KEYS.NICKS, u).hdel(KEYS.USER_ROLES, u).exec(); addLog(r.user.nickname, `👤 刪除帳號 ${u}`);
}));
router.post("/api/admin/set-nickname", auth, H(async r => {
    const { targetUsername: u } = r.body, nick = String(r.body.nickname ?? '').trim().slice(0, 32);
    if(!nick) throw new Error("暱稱不可空白");
    if(r.user.username!==u && !(await hasPerm(r.user, 'perm_users_edit'))) throw new Error("權限不足");
    if(u!=='superadmin' && !(await redis.hexists(KEYS.USERS, u))) throw new Error("帳號不存在");
    await redis.hset(KEYS.NICKS, u, nick);
}));
router.post("/api/admin/set-role", auth, perm('perm_users_edit'), H(async r => { const { targetUsername: u, newRole } = r.body; if(!isAdminUser(r.user)) throw new Error("僅限管理員"); if(!VALID_ROLES.includes(newRole) || u==='superadmin' || !(await redis.hexists(KEYS.USERS, u))) throw new Error("無效操作"); await redis.hset(KEYS.USER_ROLES, u, newRole); addLog(r.user.nickname, `🔧 ${u} 角色改為 ${newRole}`); }));
router.post("/api/admin/roles/get", auth, H(async () => getRoles()));
router.post("/api/admin/roles/update", auth, perm('perm_roles'), H(async r => {
    if(!isAdminUser(r.user)) throw new Error("僅限管理員");
    const cfg = r.body.rolesConfig; if(!cfg || typeof cfg !== 'object') throw new Error("無效設定");
    const clean = { OPERATOR: { level: 1 }, MANAGER: { level: 2 }, ADMIN: { level: 9, can: ['*'] } };
    ['OPERATOR','MANAGER'].forEach(k => clean[k].can = [...new Set((Array.isArray(cfg[k]?.can) ? cfg[k].can : []).filter(p => typeof p === 'string' && /^perm_\w+$/.test(p)))]);
    await redis.set(KEYS.ROLES, JSON.stringify(clean)); setRolesCache(clean); addLog(r.user.nickname, "🔧 修改權限");
}));

module.exports = router;
