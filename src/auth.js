/* 後台 Session 驗證與角色權限 */
const { redis } = require('./redis');
const { KEYS, SESSION_TTL, DEFAULT_ROLES } = require('./config');
const { parseCookie, safeJSON, isAdminUser } = require('./utils');

// Session 驗證：失效回傳 401 (前端據此登出)；一般帳號每次驗證時同步角色 / 暱稱，刪除帳號後 Session 立即失效
const auth = async (req, res, next) => {
    let u = null;
    const t = parseCookie(req.headers.cookie||'')['token'];
    try {
        u = t ? safeJSON(await redis.get(`${KEYS.SESSION}${t}`)) : null;
        if (u) {
            const [exists, role, nick] = await Promise.all([u.role === 'super' ? 1 : redis.hexists(KEYS.USERS, u.username), redis.hget(KEYS.USER_ROLES, u.username), redis.hget(KEYS.NICKS, u.username)]);
            if (!exists) { await redis.del(`${KEYS.SESSION}${t}`); u = null; }
            else { if (u.role !== 'super') u.userRole = role || 'OPERATOR'; u.nickname = nick || u.username; redis.expire(`${KEYS.SESSION}${t}`, SESSION_TTL).catch(() => {}); }
        }
    } catch (e) { return res.status(500).json({ error: e.message }); }
    if (!u) return res.status(401).json({ error: "Session 失效，請重新登入" });
    req.user = u; next();
};

// 角色設定快取 10 秒；後台修改權限時直接更新快取
let rolesCache = null, rolesCacheAt = 0;
const getRoles = async () => { if (!rolesCache || Date.now() - rolesCacheAt > 10000) { rolesCache = safeJSON(await redis.get(KEYS.ROLES), DEFAULT_ROLES); rolesCacheAt = Date.now(); } return rolesCache; };
const setRolesCache = cfg => { rolesCache = cfg; rolesCacheAt = Date.now(); };
const hasPerm = async (u, a) => { if (isAdminUser(u)) return true; const r = (await getRoles())[u.userRole || 'OPERATOR'] || DEFAULT_ROLES.OPERATOR; return r.level >= 9 || !!r.can?.includes(a) || !!r.can?.includes('*'); };
const perm = (a) => async (req, res, next) => { let ok = false; try { ok = await hasPerm(req.user, a); } catch (e) { return res.status(500).json({ error: e.message }); } ok ? next() : res.status(403).json({ error: "權限不足" }); };

module.exports = { auth, getRoles, setRolesCache, hasPerm, perm };
