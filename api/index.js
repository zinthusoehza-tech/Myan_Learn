const { ObjectId } = require('mongodb');
const { getCollection } = require('../lib/db');
const { hashPassword, verifyPassword, generateToken } = require('../lib/auth');
const { uploadToImgBB } = require('../lib/imagehost');

async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
  });
}
function send(res, data, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(data));
}
function normalizeDoc(doc) { if (!doc) return null; const { _id, ...rest } = doc; return { id: _id.toString(), ...rest }; }
function normalizeDocs(docs) { return (docs || []).map(normalizeDoc); }
function toObjectId(id) { try { return new ObjectId(String(id)); } catch (e) { return null; } }
function nowIso() { return new Date().toISOString(); }

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { send(res, { success: true }); return; }
  const body = await parseBody(req);
  const action = body.action;

  try {
    const usersCol = await getCollection('users');
    const coursesCol = await getCollection('courses');
    const postsCol = await getCollection('posts');
    const commentsCol = await getCollection('comments');
    const likesCol = await getCollection('likes');
    const chatsCol = await getCollection('chat_messages');
    const groupsCol = await getCollection('chat_groups');
    const packagesCol = await getCollection('coin_packages');

    // ---------------- AUTH ----------------
    if (action === 'register') {
      const { username, password, role } = body;
      const existing = await usersCol.findOne({ username: username.toLowerCase() });
      if (existing) return send(res, { success: false, error: 'Username တူနေပါတယ်' });
      
      const newUser = {
        username: username.toLowerCase(),
        passwordHash: hashPassword(password),
        displayName: username,
        role: role === 'teacher' ? 'student' : role, // Teacher လျှောက်ရင် student အနေနဲ့ပဲ ဆောက်မယ်
        isVerifiedStudent: false,
        isApprovedTeacher: false,
        isAdmin: false,
        coins: 100,
        purchasedCourses: [],
        profileImage: '',
        bio: '',
        rating: 0,
        ratingCount: 0,
        createdAt: nowIso()
      };
      const result = await usersCol.insertOne(newUser);
      
      if (role === 'teacher') {
        await getCollection('requests').insertOne({ username: newUser.username, type: 'teacher', status: 'pending', createdAt: nowIso() });
      }

      const { passwordHash, _id, ...safeUser } = newUser;
      const token = generateToken(safeUser.username);
      return send(res, { success: true, user: { id: result.insertedId.toString(), ...safeUser }, token });
    }

    if (action === 'login') {
      const { username, password } = body;
      const user = await usersCol.findOne({ username: username.toLowerCase() });
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return send(res, { success: false, error: 'Username သို့မဟုတ် Password မှားနေပါတယ်' });
      }
      const { passwordHash, _id, ...safeUser } = user;
      const token = generateToken(safeUser.username);
      return send(res, { success: true, user: { id: _id.toString(), ...safeUser }, token });
    }

    // ---------------- TEACHER & RATING ----------------
    if (action === 'getTeachers') {
      const teachers = await usersCol.find({ isApprovedTeacher: true }).project({ passwordHash: 0 }).toArray();
      return send(res, { success: true, teachers: normalizeDocs(teachers) });
    }

    if (action === 'rateTeacher') {
      const { teacherUsername, studentUsername, rating } = body;
      const teacher = await usersCol.findOne({ username: teacherUsername });
      if (!teacher) return send(res, { success: false, error: 'Teacher not found' });
      
      const newCount = (teacher.ratingCount || 0) + 1;
      const newRating = (((teacher.rating || 0) * (teacher.ratingCount || 0)) + rating) / newCount;
      
      await usersCol.updateOne({ username: teacherUsername }, { $set: { rating: newRating, ratingCount: newCount } });
      return send(res, { success: true, rating: newRating, count: newCount });
    }

    // ---------------- POSTS (9:16 Image) ----------------
    if (action === 'createPost') {
      const { username, content, imageUrl } = body;
      const post = { author: username.toLowerCase(), content, imageUrl, likeCount: 0, commentCount: 0, createdAt: nowIso() };
      await postsCol.insertOne(post);
      return send(res, { success: true });
    }

    // ---------------- CHAT & GROUPS ----------------
    if (action === 'createGroup') {
      const { teacherUsername, groupName, members } = body;
      const group = { teacher: teacherUsername, name: groupName, members, createdAt: nowIso() };
      await groupsCol.insertOne(group);
      return send(res, { success: true });
    }

    if (action === 'getGroups') {
      const { username } = body;
      const groups = await groupsCol.find({ $or: [{ teacher: username }, { members: username }] }).toArray();
      return send(res, { success: true, groups: normalizeDocs(groups) });
    }

    if (action === 'sendGroupMessage') {
      const { groupId, from, text, imageUrl } = body;
      const msg = { groupId, from, text, imageUrl, createdAt: nowIso() };
      await chatsCol.insertOne(msg);
      return send(res, { success: true, message: normalizeDoc(msg) });
    }

    if (action === 'getGroupMessages') {
      const { groupId } = body;
      const msgs = await chatsCol.find({ groupId }).sort({ createdAt: 1 }).toArray();
      return send(res, { success: true, messages: normalizeDocs(msgs) });
    }

    if (action === 'deleteMessage') {
      const { messageId } = body;
      await chatsCol.deleteOne({ _id: toObjectId(messageId) });
      return send(res, { success: true });
    }

    // ---------------- ADMIN & COINS ----------------
    if (action === 'getPackages') {
      const pkgs = await packagesCol.find({}).toArray();
      return send(res, { success: true, packages: normalizeDocs(pkgs) });
    }

    if (action === 'adminSavePackage') {
      const { name, coins, price, imageUrl } = body;
      await packagesCol.insertOne({ name, coins: Number(coins), price: Number(price), imageUrl });
      return send(res, { success: true });
    }

    if (action === 'buyCoins') {
      const { username, packageId } = body;
      const pkg = await packagesCol.findOne({ _id: toObjectId(packageId) });
      if (!pkg) return send(res, { success: false, error: 'Package not found' });
      
      await usersCol.updateOne({ username: username.toLowerCase() }, { $inc: { coins: pkg.coins } });
      return send(res, { success: true, added: pkg.coins });
    }

    // ---------------- IMAGE UPLOAD ----------------
    if (action === 'uploadImage') {
      const { base64 } = body;
      const matches = base64.match(/^data:(.+);base64,(.+)$/);
      const buffer = Buffer.from(matches ? matches[2] : base64, 'base64');
      const result = await uploadToImgBB(buffer);
      return send(res, { success: true, url: result.url });
    }

    // ---------------- BOOTSTRAP ----------------
    if (action === 'bootstrap') {
      const { username } = body;
      let user = null;
      if (username) user = await usersCol.findOne({ username: username.toLowerCase() });
      
      const courses = await coursesCol.find({}).sort({ createdAt: -1 }).toArray();
      const safeCourses = courses.map(c => ({
        ...normalizeDoc(c),
        hasAccess: user ? (user.isAdmin || user.isVerifiedStudent || c.isFree || (user.purchasedCourses || []).includes(c._id.toString())) : c.isFree
      }));

      const posts = await postsCol.find({}).sort({ createdAt: -1 }).limit(30).toArray();
      const feed = [];
      for (const p of posts) {
        const author = await usersCol.findOne({ username: p.author });
        const hasLiked = user ? !!(await likesCol.findOne({ postId: p._id.toString(), username: user.username })) : false;
        feed.push({
          ...normalizeDoc(p),
          authorData: author ? { displayName: author.displayName, profileImage: author.profileImage, role: author.role } : { displayName: p.author },
          hasLiked
        });
      }

      const pkgs = await packagesCol.find({}).toArray();
      const { passwordHash, _id, ...safeUser } = user || {};
      return send(res, { success: true, user: user ? { id: _id.toString(), ...safeUser } : null, courses: safeCourses, feed, packages: normalizeDocs(pkgs) });
    }

    if (action === 'adminGetRequests') {
      const reqs = await getCollection('requests').find({ status: 'pending' }).toArray();
      return send(res, { success: true, requests: normalizeDocs(reqs) });
    }

    if (action === 'adminApproveRequest') {
      const { requestId, approve } = body;
      const req = await getCollection('requests').findOne({ _id: toObjectId(requestId) });
      if (approve) {
        await usersCol.updateOne({ username: req.username }, { $set: { role: 'teacher', isApprovedTeacher: true } });
        await getCollection('requests').updateOne({ _id: req._id }, { $set: { status: 'approved' } });
      } else {
        await getCollection('requests').updateOne({ _id: req._id }, { $set: { status: 'rejected' } });
      }
      return send(res, { success: true });
    }

    return send(res, { success: false, error: 'Unknown action' }, 400);
  } catch (err) {
    return send(res, { success: false, error: err.message }, 500);
  }
};
