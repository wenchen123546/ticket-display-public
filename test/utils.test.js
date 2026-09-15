/* 純函式單元測試：node --test (不需要 Redis / 安裝套件) */
const test = require('node:test');
const assert = require('node:assert/strict');
const u = require('../src/utils');

test('getTWTime 以台灣時區換算日期與時間 (跨日)', () => {
    assert.deepEqual(u.getTWTime(new Date('2026-01-01T16:30:00Z')), { dateStr: '2026-01-02', hour: 0, minute: 30 });
    assert.deepEqual(u.getTWTime(new Date('2026-03-15T03:05:00Z')), { dateStr: '2026-03-15', hour: 11, minute: 5 });
});

test('validateNum 只接受範圍內的整數', () => {
    assert.equal(u.validateNum('12'), 12);
    assert.equal(u.validateNum(0), 0);
    assert.equal(u.validateNum('abc'), null);
    assert.equal(u.validateNum(-1), null);
    assert.equal(u.validateNum(100000), null);
    assert.equal(u.validateNum(0, 1), null);
    assert.equal(u.validateNum(23, 0, 23), 23);
});

test('parseCookie 解析多個 Cookie 並解碼值', () => {
    assert.deepEqual(u.parseCookie('a=1; token=x%3Dy; callsys_tk=abc'), { a: '1', token: 'x=y', callsys_tk: 'abc' });
    assert.deepEqual(u.parseCookie(''), {});
    assert.deepEqual(u.parseCookie('bad=%E0%A4%A'), {}); // 解碼失敗不拋錯
});

test('safeJSON 解析失敗或 null 時回傳預設值', () => {
    assert.deepEqual(u.safeJSON('{"a":1}'), { a: 1 });
    assert.equal(u.safeJSON('not json', 'fb'), 'fb');
    assert.deepEqual(u.safeJSON('null', {}), {});
    assert.equal(u.safeJSON(null), null);
});

test('safeEqual 比對字串 (長度不同也不拋錯)', () => {
    assert.equal(u.safeEqual('secret', 'secret'), true);
    assert.equal(u.safeEqual('secret', 'secreT'), false);
    assert.equal(u.safeEqual('secret', 'secret-longer'), false);
});

test('isAdminUser 辨識超級管理員與 ADMIN 角色', () => {
    assert.equal(u.isAdminUser({ role: 'super' }), true);
    assert.equal(u.isAdminUser({ role: 'normal', userRole: 'ADMIN' }), true);
    assert.equal(u.isAdminUser({ role: 'normal', userRole: 'MANAGER' }), false);
    assert.equal(u.isAdminUser(null), false);
});

test('isSafeUrl 只允許 http / https', () => {
    assert.equal(u.isSafeUrl('https://example.com'), true);
    assert.equal(u.isSafeUrl('http://example.com/a?b=1'), true);
    assert.equal(u.isSafeUrl('javascript:alert(1)'), false);
    assert.equal(u.isSafeUrl('not a url'), false);
});

test('HM_RE 驗證 HH:MM', () => {
    assert.ok(u.HM_RE.test('08:00'));
    assert.ok(u.HM_RE.test('23:59'));
    assert.ok(!u.HM_RE.test('24:00'));
    assert.ok(!u.HM_RE.test('8:00'));
});

test('cleanCounter 移除換行與角括號並限制 12 字', () => {
    assert.equal(u.cleanCounter('  <1號>\n櫃台  '), '1號櫃台');
    assert.equal(u.cleanCounter(undefined), '');
    assert.equal(u.cleanCounter('1234567890ABCDEF'), '1234567890AB');
});

test('cleanName / cleanText 移除換行與角括號並限制長度', () => {
    assert.equal(u.cleanName('  <王>\n先生 '), '王先生');
    assert.equal(u.cleanName('一二三四五六七八九十一二三四五六七八九十超過'), '一二三四五六七八九十一二三四五六七八九十');
    assert.equal(u.cleanText('午休<script>', 50), '午休script');
});

test('normalizePhone 接受常見格式，拒絕不合法號碼', () => {
    assert.equal(u.normalizePhone('0912-345-678'), '0912345678');
    assert.equal(u.normalizePhone(' 0912 345 678 '), '0912345678');
    assert.equal(u.normalizePhone('+886 912 345 678'), '+886912345678');
    assert.equal(u.normalizePhone('(02)2345-6789'), '0223456789');
    assert.equal(u.normalizePhone('12345'), null);
    assert.equal(u.normalizePhone('09123abc78'), null);
    assert.equal(u.normalizePhone(undefined), null);
});

test('maskPhone 只顯示前 2 碼與末 3 碼', () => {
    assert.equal(u.maskPhone('0912345678'), '09*****678');
    assert.equal(u.maskPhone('+886912345678'), '+8********678');
    assert.equal(u.maskPhone('12345'), '*****');
    assert.equal(u.maskPhone(''), '');
});

test('formatPause 組合暫停原因與恢復時間', () => {
    assert.equal(u.formatPause({ reason: '午休', resumeAt: '13:30' }), '（午休），預計 13:30 恢復');
    assert.equal(u.formatPause({ resumeAt: '13:30' }), '，預計 13:30 恢復');
    assert.equal(u.formatPause({}), '');
    assert.equal(u.formatPause(), '');
});

test('maskSecret 只保留末 4 碼', () => {
    assert.equal(u.maskSecret('abcdefgh1234'), '••••1234');
    assert.equal(u.maskSecret(null), null);
});

test('toMax：MAX 不存在時視為目前叫號', () => {
    assert.equal(u.toMax(null, 5), 5);
    assert.equal(u.toMax('3', 30), 3);
    assert.equal(u.toMax('0', 30), 0);
    assert.equal(u.toMax('abc', 5), 0);
});

test('netHourly 扣除過號與取消，並支援舊版純數字 key', () => {
    const r = u.netHourly({ '9_i': '10', '9_p': '2', '9_c': '1', '10': '3', '11_i': '1', '11_p': '5' });
    assert.equal(r.length, 24);
    assert.equal(r[9], 7);
    assert.equal(r[10], 3);
    assert.equal(r[11], 0); // 不會出現負數
    assert.deepEqual(u.netHourly(null), Array(24).fill(0));
});

test('isOpenAt 營業時間判斷', () => {
    const day = { enabled: true, start: '08:00', end: '22:00' };
    assert.equal(u.isOpenAt({ enabled: false, start: '08:00', end: '09:00' }, 3, 0), true);
    assert.equal(u.isOpenAt(day, 7, 59), false);
    assert.equal(u.isOpenAt(day, 8, 0), true);
    assert.equal(u.isOpenAt(day, 21, 59), true);
    assert.equal(u.isOpenAt(day, 22, 0), false);
});

test('isOpenAt 跨夜營業、起訖相同、舊版整點數字', () => {
    const night = { enabled: true, start: '18:00', end: '02:00' };
    assert.equal(u.isOpenAt(night, 23, 0), true);
    assert.equal(u.isOpenAt(night, 1, 59), true);
    assert.equal(u.isOpenAt(night, 2, 0), false);
    assert.equal(u.isOpenAt(night, 12, 0), false);
    assert.equal(u.isOpenAt({ enabled: true, start: '09:00', end: '09:00' }, 3, 0), true);
    assert.equal(u.isOpenAt({ enabled: true, start: 8, end: 22 }, 10, 0), true);
    assert.equal(u.isOpenAt({ enabled: true, start: 8, end: 22 }, 23, 0), false);
});

test('avgIntervalMinutes 平均叫號間隔並略過異常間隔', () => {
    const t = 1_700_000_000_000, min = 60000;
    assert.equal(u.avgIntervalMinutes([t, t - min, t - 2 * min]), 1);
    assert.equal(u.avgIntervalMinutes([t, t - min, t - 3 * min]), 1.5);
    // 5 秒 (太短) 與 20 分鐘 (太長，例如午休) 都不列入
    assert.equal(u.avgIntervalMinutes([t, t - 5000, t - 5000 - 20 * min]), null);
    assert.equal(u.avgIntervalMinutes([t, t - 5000, t - 5000 - 2 * min]), 2);
    assert.equal(u.avgIntervalMinutes([t]), null);
    assert.equal(u.avgIntervalMinutes([t, t - 70000]), 1.2); // 1.17 分無條件進位到小數一位
});

test('isPushEndpoint 只允許瀏覽器推播服務網域', () => {
    assert.equal(u.isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'), true);
    assert.equal(u.isPushEndpoint('https://web.push.apple.com/QOa'), true);
    assert.equal(u.isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'), true);
    assert.equal(u.isPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=1'), true);
    assert.equal(u.isPushEndpoint('http://fcm.googleapis.com/fcm/send/abc'), false);
    assert.equal(u.isPushEndpoint('https://fcm.googleapis.com.evil.com/x'), false);
    assert.equal(u.isPushEndpoint('https://evilpush.apple.com/x'), false);
    assert.equal(u.isPushEndpoint('https://127.0.0.1/x'), false);
    assert.equal(u.isPushEndpoint('garbage'), false);
});

test('pushId 對同一 endpoint 產生固定 24 字元 id', () => {
    const a = u.pushId('https://fcm.googleapis.com/fcm/send/abc');
    assert.equal(a.length, 24);
    assert.equal(a, u.pushId('https://fcm.googleapis.com/fcm/send/abc'));
    assert.notEqual(a, u.pushId('https://fcm.googleapis.com/fcm/send/abd'));
});

test('csvEscape 防公式注入並處理逗號 / 引號', () => {
    assert.equal(u.csvEscape('=SUM(A1)'), "'=SUM(A1)");
    assert.equal(u.csvEscape('@cmd'), "'@cmd");
    assert.equal(u.csvEscape('a,b'), '"a,b"');
    assert.equal(u.csvEscape('say "hi"'), '"say ""hi"""');
    assert.equal(u.csvEscape(null), '');
    assert.equal(u.csvEscape(12), '12');
});

test('parseLink 驗證連結並裁切名稱', () => {
    assert.deepEqual(u.parseLink('  菜單 ', ' https://example.com/menu '), { linkText: '菜單', linkUrl: 'https://example.com/menu' });
    assert.throws(() => u.parseLink('x', 'javascript:alert(1)'));
    assert.throws(() => u.parseLink('', 'https://example.com'));
    assert.equal(u.parseLink('a'.repeat(80), 'https://e.com').linkText.length, 50);
});

test('findLinkIdx 以網址 (與名稱) 找出連結位置', () => {
    const list = [JSON.stringify({ linkText: 'A', linkUrl: 'https://a' }), 'broken', JSON.stringify({ linkText: 'B', linkUrl: 'https://b' })];
    assert.equal(u.findLinkIdx(list, 'B', 'https://b'), 2);
    assert.equal(u.findLinkIdx(list, undefined, 'https://a'), 0);
    assert.equal(u.findLinkIdx(list, 'X', 'https://a'), -1);
});
