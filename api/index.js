const { ObjectId } = require('mongodb');
const { getCollection } = require('../lib/db');
const {
  hashPassword, verifyPassword, generateToken, verifyToken
} = require('../lib/auth');

const LANGS = ['ja', 'ko', 'my'];

const FIELDS = {
  unit:   ['title', 'order', 'lang'],
  lesson: ['unitId', 'title', 'order', 'vocab', 'notes', 'images', 'lang'],
  video:  ['title', 'url', 'level', 'lang'],
  class:  ['title', 'link', 'when', 'note', 'lang']
};

const oid = (id) => { try { return new ObjectId(String(id)); } catch (e) { return null; } };
const clean = (d) => {
  if (!d) return null;
  const { _id, passwordHash, ...r } = d;
  return { id: _id ? _id.toString() : '', ...r };
};
const today = () => new Date().toISOString().slice(0, 10);

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try { resolve(s ? JSON.parse(s) : {}); }
      catch (e) { resolve({}); }
    });
  });
}

function envAdmins() {
  return (process.env.ADMIN_USERS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

module.exports = async (req, res) => {
  const send = (data, status = 200) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.end(JSON.stringify(data));
  };
  const fail = (error, status = 200) => send({ success: false, error }, status);

  if (req.method === 'OPTIONS') return send({ success: true });
  if (req.method !== 'POST') return fail('Method not allowed', 405);

  const b = await readBody(req);
  const a = b.action;

  try {
    const users    = await getCollection('users');
    const content  = await getCollection('content');
    const progress = await getCollection('progress');

    // ---------- AUTH ----------
    // Ping (health check)
    if (a === 'ping') return send({ success: true, ts: Date.now() });

    if (a === 'register') {
      const u = String(b.username || '').trim().toLowerCase();
      const p = String(b.password || '');
      if (!/^[a-z0-9_.]{3,20}$/.test(u))
        return fail('Username သည် အင်္ဂလိပ်စာ/ဂဏန်း 3-20 လုံး ဖြစ်ရမည် (a-z, 0-9, _, .)');
      if (p.length < 4)
        return fail('Password သည် အနည်းဆုံး 4 လုံး ဖြစ်ရမည်');
      if (await users.findOne({ username: u }))
        return fail('ဤ username ကို အသုံးပြုပြီး ဖြစ်နေသည်');

      const first = (await users.countDocuments({})) === 0;
      const doc = {
        username: u,
        passwordHash: hashPassword(p),
        displayName: String(b.displayName || u).trim().slice(0, 40),
        role: first ? 'teacher' : 'student',
        isAdmin: first,
        isBanned: false,
        exp: 0,
        lang: LANGS.includes(b.lang) ? b.lang : 'ja',
        createdAt: new Date().toISOString()
      };
      // Auto-promote if in ADMIN_USERS env
      if (envAdmins().includes(u)) { doc.isAdmin = true; doc.role = 'teacher'; }

      await users.insertOne(doc);
      return send({
        success: true,
        user: clean(doc),
        token: generateToken(u)
      });
    }

    if (a === 'login') {
      const u = String(b.username || '').trim().toLowerCase();
      const p = String(b.password || '');
      if (!u || !p) return fail('Username နှင့် password ထည့်ပါ');
      const user = await users.findOne({ username: u });
      if (!user || !verifyPassword(p, user.passwordHash))
        return fail('Username သို့မဟုတ် password မှားနေသည်');
      if (user.isBanned)
        return fail('ဤအကောင့်ကို ပိတ်ထားပါသည်');

      // Auto-promote if in ADMIN_USERS env
      if (envAdmins().includes(user.username) && !user.isAdmin) {
        await users.updateOne(
          { username: user.username },
          { $set: { isAdmin: true, role: 'teacher' } }
        );
        user.isAdmin = true;
        user.role = 'teacher';
      }
      return send({
        success: true,
        user: clean(user),
        token: generateToken(user.username)
      });
    }

    // ---------- EVERYTHING BELOW REQUIRES A VALID TOKEN ----------
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const tokenUsername = verifyToken(token);

    if (!tokenUsername) {
      return send({ success: false, error: 'Session သက်တမ်းကုန်သွားပါပြီ — ပြန်လည် login ဝင်ပါ', logout: true }, 401);
    }

    const me = await users.findOne({ username: tokenUsername });
    if (!me) return send({ success: false, error: 'အကောင့် မတွေ့ပါ', logout: true }, 401);
    if (me.isBanned) return send({ success: false, error: 'ဤအကောင့်ကို ပိတ်ထားပါသည်', logout: true }, 401);

    // Auto-promote env admins on every request (cheap, idempotent)
    if (envAdmins().includes(me.username) && !me.isAdmin) {
      await users.updateOne(
        { username: me.username },
        { $set: { isAdmin: true, role: 'teacher' } }
      );
      me.isAdmin = true;
      me.role = 'teacher';
    }

    const isStaff = me.role === 'teacher' || me.isAdmin;
    const isAdmin = !!me.isAdmin;

    // ---------- BOOTSTRAP (initial state) ----------
    if (a === 'bootstrap') {
      const myLang = LANGS.includes(me.lang) ? me.lang : 'ja';
      const vis = (x) => !x.lang || x.lang === myLang;
      const all = (await content.find({}).toArray()).map(clean);
      const by = (k) => all
        .filter((x) => x.kind === k && vis(x))
        .sort((p, q) =>
          (Number(p.order) || 0) - (Number(q.order) || 0) ||
          String(p.createdAt).localeCompare(String(q.createdAt))
        );
      const mine = await progress.find({ username: me.username }).toArray();
      return send({
        success: true,
        user: clean(me),
        units: by('unit'),
        lessons: by('lesson'),
        videos: by('video'),
        classes: by('class').sort((p, q) => String(p.when).localeCompare(String(q.when))),
        progress: mine.map(clean)
      });
    }

    // ---------- PROFILE ----------
    if (a === 'updateProfile') {
      const set = {};
      const dn = String(b.displayName || '').trim();
      if (dn) set.displayName = dn.slice(0, 40);
      if (LANGS.includes(b.lang)) set.lang = b.lang;
      if (Object.keys(set).length)
        await users.updateOne({ username: me.username }, { $set: set });
      return send({ success: true });
    }

    if (a === 'changePassword') {
      const oldP = String(b.oldPassword || '');
      const newP = String(b.newPassword || '');
      if (!verifyPassword(oldP, me.passwordHash))
        return fail('Current password မှားနေသည်');
      if (newP.length < 4)
        return fail('New password သည် အနည်းဆုံး 4 လုံး ဖြစ်ရမည်');
      await users.updateOne(
        { username: me.username },
        { $set: { passwordHash: hashPassword(newP) } }
      );
      return send({ success: true });
    }

    // ---------- LEARNING PROGRESS ----------
    if (a === 'complete') {
      const lesson = await content.findOne({ _id: oid(b.lessonId), kind: 'lesson' });
      if (!lesson) return fail('Lesson မတွေ့ပါ');
      const total = Math.max(1, Math.min(50, Number(b.total) || 1));
      const correct = Math.max(0, Math.min(total, Number(b.correct) || 0));
      const passed = correct >= Math.ceil(total * 0.6);

      const before = await progress.findOne({
        username: me.username, lessonId: String(b.lessonId), passed: true
      });
      const exp = passed && !before ? correct * 5 + 10 : 0;

      await progress.insertOne({
        username: me.username,
        lessonId: String(b.lessonId),
        correct, total, passed, exp,
        day: today(),
        createdAt: new Date().toISOString()
      });
      if (exp) await users.updateOne({ username: me.username }, { $inc: { exp } });
      return send({ success: true, exp, passed, alreadyPassed: !!before });
    }

    // ---------- TEACHER: CONTENT ----------
    if (a === 'save' || a === 'del') {
      if (!isStaff) return fail('ဆရာ/Admin သာ ခွင့်ပြုသည်');
      const kind = b.kind;
      if (!FIELDS[kind]) return fail('Unknown content type');

      if (a === 'del') {
        await content.deleteOne({ _id: oid(b.id), kind });
        if (kind === 'unit') {
          await content.deleteMany({ kind: 'lesson', unitId: String(b.id) });
        }
        return send({ success: true });
      }

      const d = b.data || {};
      const doc = {};
      FIELDS[kind].forEach((f) => {
        doc[f] = f === 'order' ? Number(d[f]) || 0 : String(d[f] ?? '').slice(0, 20000);
      });
      if (!LANGS.includes(doc.lang)) doc.lang = 'ja';
      if (!doc.title.trim()) return fail('Title လိုအပ်သည်');

      if (d.id) {
        await content.updateOne({ _id: oid(d.id), kind }, { $set: doc });
      } else {
        await content.insertOne({
          kind, ...doc,
          author: me.username,
          createdAt: new Date().toISOString()
        });
      }
      return send({ success: true });
    }

    // ---------- ADMIN ----------
    if (a.startsWith('admin')) {
      if (!isAdmin) return fail('Admin သာ ခွင့်ပြုသည်');

      if (a === 'adminGetUsers') {
        const list = await users.find({}).sort({ createdAt: -1 }).toArray();
        return send({ success: true, users: list.map(clean) });
      }

      if (a === 'adminCreateUser') {
        const u = String(b.username || '').trim().toLowerCase();
        const p = String(b.password || '');
        if (!/^[a-z0-9_.]{3,20}$/.test(u))
          return fail('Username သည် 3-20 လုံး ဖြစ်ရမည်');
        if (p.length < 4) return fail('Password သည် အနည်းဆုံး 4 လုံး ဖြစ်ရမည်');
        if (await users.findOne({ username: u }))
          return fail('Username ကို အသုံးပြုပြီး ဖြစ်နေသည်');
        const doc = {
          username: u,
          passwordHash: hashPassword(p),
          displayName: String(b.displayName || u).trim().slice(0, 40),
          role: b.role === 'teacher' ? 'teacher' : 'student',
          isAdmin: false,
          isBanned: false,
          exp: 0,
          lang: LANGS.includes(b.lang) ? b.lang : 'ja',
          createdAt: new Date().toISOString()
        };
        await users.insertOne(doc);
        return send({ success: true });
      }

      const target = String(b.target || '').toLowerCase();
      if (!target) return fail('Target user လိုအပ်သည်');

      if (a === 'adminSetRole') {
        if (target === me.username) return fail('မိမိ role ကို ဤနေရာတွင် မပြောင်းနိုင်ပါ');
        await users.updateOne(
          { username: target },
          { $set: { role: b.role === 'teacher' ? 'teacher' : 'student' } }
        );
      }
      else if (a === 'adminSetAdmin') {
        if (target === me.username) return fail('မိမိ admin status ကို မပြောင်းနိုင်ပါ');
        const makeAdmin = !!b.isAdmin;
        if (!makeAdmin) {
          const tu = await users.findOne({ username: target });
          if (tu && tu.isAdmin) {
            const cnt = await users.countDocuments({ isAdmin: true, isBanned: { $ne: true } });
            if (cnt <= 1) return fail('နောက်ဆုံး admin ကို ဖျက်ခြင်း/ပြောင်းခြင်း မပြုနိုင်ပါ');
          }
        }
        await users.updateOne({ username: target }, { $set: { isAdmin: makeAdmin } });
      }
      else if (a === 'adminToggleBan') {
        if (target === me.username) return fail('မိမိ အကောင့်ကို မပိတ်နိုင်ပါ');
        if (b.isBanned) {
          const tu = await users.findOne({ username: target });
          if (tu && tu.isAdmin) {
            const cnt = await users.countDocuments({ isAdmin: true, isBanned: { $ne: true } });
            if (cnt <= 1) return fail('နောက်ဆုံး admin ကို ပိတ်၍ မရပါ');
          }
        }
        await users.updateOne({ username: target }, { $set: { isBanned: !!b.isBanned } });
      }
      else if (a === 'adminResetPassword') {
        if (String(b.password || '').length < 4)
          return fail('Password သည် အနည်းဆုံး 4 လုံး ဖြစ်ရမည်');
        await users.updateOne(
          { username: target },
          { $set: { passwordHash: hashPassword(String(b.password)) } }
        );
      }
      else if (a === 'adminDeleteUser') {
        if (target === me.username) return fail('မိမိ အကောင့်ကို မဖျက်နိုင်ပါ');
        const tu = await users.findOne({ username: target });
        if (tu && tu.isAdmin) {
          const cnt = await users.countDocuments({ isAdmin: true, isBanned: { $ne: true } });
          if (cnt <= 1) return fail('နောက်ဆုံး admin ကို မဖျက်နိုင်ပါ');
        }
        await users.deleteOne({ username: target });
        await progress.deleteMany({ username: target });
      }
      else return fail('Unknown admin action');

      return send({ success: true });
    }

    return fail('Unknown action', 400);
  } catch (err) {
    console.error('[api error]', err);
    return send({ success: false, error: err.message || 'Server error' }, 500);
  }
};
