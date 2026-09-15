/* 路由包裝：回傳值轉 JSON (undefined → {success:true}，false → 已自行回應)，拋出的錯誤回 500 */
const H = fn => async(req, res, next) => { try { const r = await fn(req, res); if(r!==false) res.json(r||{success:true}); } catch(e){ res.status(500).json({error:e.message}); } };

module.exports = { H };
