const { ObjectId } = require('mongodb');
const { getCollection } = require('../lib/db');
const { hashPassword, verifyPassword, generateToken } = require('../lib/auth');

// Teachers can create these 4 kinds of content. Only these fields are stored.
const FIELDS = {
  unit:   ['title', 'order'],
  lesson: ['unitId', 'title', 'order', 'vocab', 'notes'],
  video:  ['title', 'url', 'level'],
  class:  ['title', 'link', 'when', 'note']
};
const oid = (id) => { try { return new ObjectId(String(id)); } catch (e) { return null; } };
const clean = (d) => { if (!d) return null; const { _id, passwordHash, ...r } = d; return { id: _id.toString(), ...r }; };
const today = () => new Date().toISOString().slice(0, 10);

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { resolve({}); } });
  });
}

module.exports = async (req, res) => {
  const send = (data, status = 200) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.end(JSON.stringify(data));
  };
  const fail = (error) => send({ success: false, error });
  if (req.method === 'OPTIONS') return send({ success: true });

  const b = await readBody(req);
  const a = b.action;

  try {
    const users = await getCollection('users');
    const content = await getCollection('content');
    const progress = await getCollection('progress');

    const uname = String(b.username || '').trim().toLowerCase();
    const me = uname ? await users.findOne({ username: uname }) : null;
    const active = me && !me.isBanned;
    const isStaff = !!(active && (me.role === 'teacher' || me.isAdmin));
    const isAdmin = !!(active && me.isAdmin);

    // ---------- AUTH ----------
    if (a === 'register') {
      const u = String(b.username || '').trim().toLowerCase();
      const p = String(b.password || '');
      if (!/^[a-z0-9_.]{3,20}$/.test(u)) return fail('Username must be 3-20 letters/numbers (a-z, 0-9)');
      if (p.length < 4) return fail('Password must be at least 4 characters');
      if (await users.findOne({ username: u })) return fail('This username is already taken');
      const first = (await users.countDocuments({})) === 0; // first account = admin teacher
      const doc = {
        username: u, passwordHash: hashPassword(p), displayName: String(b.displayName || u).trim().slice(0, 40),
        role: first ? 'teacher' : 'student', isAdmin: first, isBanned: false, exp: 0, createdAt: new Date().toISOString()
      };
      await users.insertOne(doc);
      return send({ success: true, user: clean(doc), token: generateToken(u) });
    }

    if (a === 'login') {
      const user = uname ? await users.findOne({ username: uname }) : null;
      if (!user || !verifyPassword(String(b.password || ''), user.passwordHash)) return fail('Wrong username or password');
      if (user.isBanned) return fail('This account has been disabled');
      return send({ success: true, user: clean(user), token: generateToken(user.username) });
    }

    // ---------- EVERYTHING BELOW NEEDS A VALID, ACTIVE USER ----------
    if (!active) return send({ success: false, error: 'Please log in again', logout: true }, 401);

    if (a === 'bootstrap') {
      const all = (await content.find({}).toArray()).map(clean);
      const by = (k) => all.filter((x) => x.kind === k)
        .sort((p, q) => (Number(p.order) || 0) - (Number(q.order) || 0) || String(p.createdAt).localeCompare(String(q.createdAt)));
      const mine = await progress.find({ username: me.username }).toArray();
      return send({
        success: true, user: clean(me),
        units: by('unit'), lessons: by('lesson'), videos: by('video'),
        classes: by('class').sort((p, q) => String(p.when).localeCompare(String(q.when))),
        progress: mine.map(clean)
      });
    }

    if (a === 'updateProfile') {
      await users.updateOne({ username: me.username }, { $set: { displayName: String(b.displayName || me.username).trim().slice(0, 40) } });
      return send({ success: true });
    }

    // ---------- LEARNING PROGRESS ----------
    if (a === 'complete') {
      const lesson = await content.findOne({ _id: oid(b.lessonId), kind: 'lesson' });
      if (!lesson) return fail('Lesson not found');
      const total = Math.max(1, Math.min(50, Number(b.total) || 1));
      const correct = Math.max(0, Math.min(total, Number(b.correct) || 0));
      const passed = correct >= Math.ceil(total * 0.6);
      const before = await progress.findOne({ username: me.username, lessonId: String(b.lessonId), passed: true });
      const exp = correct * 5 + (passed && !before ? 10 : 0);
      await progress.insertOne({ username: me.username, lessonId: String(b.lessonId), correct, total, passed, exp, day: today(), createdAt: new Date().toISOString() });
      await users.updateOne({ username: me.username }, { $inc: { exp } });
      return send({ success: true, exp, passed });
    }

    // ---------- TEACHER: ADD / EDIT / DELETE CONTENT ----------
    if (a === 'save' || a === 'del') {
      if (!isStaff) return fail('Teachers only');
      const kind = b.kind;
      if (!FIELDS[kind]) return fail('Unknown content type');
      if (a === 'del') {
        await content.deleteOne({ _id: oid(b.id), kind });
        if (kind === 'unit') await content.deleteMany({ kind: 'lesson', unitId: String(b.id) });
        return send({ success: true });
      }
      const d = b.data || {};
      const doc = {};
      FIELDS[kind].forEach((f) => { doc[f] = f === 'order' ? Number(d[f]) || 0 : String(d[f] ?? '').slice(0, 20000); });
      if (!doc.title.trim()) return fail('Title is required');
      if (d.id) await content.updateOne({ _id: oid(d.id), kind }, { $set: doc });
      else await content.insertOne({ kind, ...doc, author: me.username, createdAt: new Date().toISOString() });
      return send({ success: true });
    }

    // ---------- ADMIN: STUDENTS ----------
    if (a.startsWith('admin')) {
      if (!isAdmin) return fail('Admin only');
      const target = String(b.target || '').toLowerCase();
      if (a === 'adminGetUsers') {
        const list = await users.find({}).sort({ createdAt: -1 }).toArray();
        return send({ success: true, users: list.map(clean) });
      }
      if (target === me.username) return fail('You cannot change your own account here');
      if (a === 'adminSetRole') await users.updateOne({ username: target }, { $set: { role: b.role === 'teacher' ? 'teacher' : 'student' } });
      else if (a === 'adminToggleBan') await users.updateOne({ username: target }, { $set: { isBanned: !!b.isBanned } });
      else if (a === 'adminResetPassword') {
        if (String(b.password || '').length < 4) return fail('Password must be at least 4 characters');
        await users.updateOne({ username: target }, { $set: { passwordHash: hashPassword(String(b.password)) } });
      } else if (a === 'adminDeleteUser') {
        await users.deleteOne({ username: target });
        await progress.deleteMany({ username: target });
      } else return fail('Unknown action');
      return send({ success: true });
    }

    return send({ success: false, error: 'Unknown action' }, 400);
  } catch (err) {
    return send({ success: false, error: err.message }, 500);
  }
};
