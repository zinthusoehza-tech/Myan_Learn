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
    const packagesCol = await getCollection('coin_packages');
    const purchasesCol = await getCollection('purchases');
    const settingsCol = await getCollection('settings');
    const requestsCol = await getCollection('requests');

    // ---------------- SETTINGS ----------------
    if (action === 'getSettings') {
      const settings = await settingsCol.findOne({ key: 'globalSettings' }) || { 
        kpayPhone: '', kpayQr: '', wavePhone: '', waveQr: '', loginBg: '' 
      };
      return send(res, { success: true, settings });
    }
    if (action === 'adminSaveSettings') {
      await settingsCol.updateOne({ key: 'globalSettings' }, { $set: body.settings }, { upsert: true });
      return send(res, { success: true });
    }

    // ---------------- AUTH & PROFILE ----------------
    if (action === 'register') {
      const { username, password, role } = body;
      const existing = await usersCol.findOne({ username: username.toLowerCase() });
      if (existing) return send(res, { success: false, error: 'Username တူနေပါတယ်' });
      
      const newUser = {
        username: username.toLowerCase(), passwordHash: hashPassword(password), displayName: username,
        role: role === 'teacher' ? 'student' : role, isVerifiedStudent: false, isApprovedTeacher: false, isAdmin: false,
        isBanned: false, coins: 100, purchasedCourses: [], profileImage: '', coverImage: '', bio: '', specialty: '', rating: 0, ratingCount: 0, createdAt: nowIso()
      };
      await usersCol.insertOne(newUser);
      if (role === 'teacher') await requestsCol.insertOne({ username: newUser.username, type: 'teacher', status: 'pending', createdAt: nowIso() });

      const { passwordHash, _id, ...safeUser } = newUser;
      return send(res, { success: true, user: { id: _id.toString(), ...safeUser }, token: generateToken(safeUser.username) });
    }

    if (action === 'login') {
      const { username, password } = body;
      const user = await usersCol.findOne({ username: username.toLowerCase() });
      if (!user || !verifyPassword(password, user.passwordHash)) return send(res, { success: false, error: 'Username/Password မှားနေပါတယ်' });
      if (user.isBanned) return send(res, { success: false, error: 'ဤအကောင့်ကို ပိတ်ထားပါသည်' });
      
      const { passwordHash, _id, ...safeUser } = user;
      return send(res, { success: true, user: { id: _id.toString(), ...safeUser }, token: generateToken(safeUser.username) });
    }

    if (action === 'updateProfile') {
      const { username, displayName, bio, profileImage, coverImage, specialty } = body;
      await usersCol.updateOne({ username: username.toLowerCase() }, { $set: { displayName, bio, profileImage, coverImage, specialty } });
      const updatedUser = await usersCol.findOne({ username: username.toLowerCase() });
      const { passwordHash, _id, ...safeUser } = updatedUser;
      return send(res, { success: true, user: { id: _id.toString(), ...safeUser } });
    }

    if (action === 'rateTeacher') {
      const { teacherUsername, rating } = body;
      const teacher = await usersCol.findOne({ username: teacherUsername });
      if (!teacher) return send(res, { success: false, error: 'Teacher not found' });
      const newCount = (teacher.ratingCount || 0) + 1;
      const newRating = (((teacher.rating || 0) * (teacher.ratingCount || 0)) + rating) / newCount;
      await usersCol.updateOne({ username: teacherUsername }, { $set: { rating: newRating, ratingCount: newCount } });
      return send(res, { success: true, rating: newRating, count: newCount });
    }

    // ---------------- POSTS ----------------
    if (action === 'createPost') {
      await postsCol.insertOne({ author: body.username.toLowerCase(), content: body.content, imageUrl: body.imageUrl, likeCount: 0, commentCount: 0, createdAt: nowIso() });
      return send(res, { success: true });
    }
    if (action === 'deletePost') {
      await postsCol.deleteOne({ _id: toObjectId(body.postId) });
      return send(res, { success: true });
    }
    if (action === 'toggleLike') {
      const { postId, username } = body;
      const existing = await likesCol.findOne({ postId, username });
      if (existing) {
        await likesCol.deleteOne({ _id: existing._id });
        await postsCol.updateOne({ _id: toObjectId(postId) }, { $inc: { likeCount: -1 } });
        return send(res, { success: true, liked: false });
      } else {
        await likesCol.insertOne({ postId, username });
        await postsCol.updateOne({ _id: toObjectId(postId) }, { $inc: { likeCount: 1 } });
        return send(res, { success: true, liked: true });
      }
    }

    // ---------------- COURSES ----------------
    if (action === 'createCourse') {
      const { username, title, description, lockedDescription, zoomLink, pdfLink, coverImage, isFree, price } = body;
      const teacher = await usersCol.findOne({ username: username.toLowerCase() });
      await coursesCol.insertOne({
        teacherId: teacher.username, teacherName: teacher.displayName, teacherImage: teacher.profileImage,
        title, description, lockedDescription, zoomLink, pdfLink, coverImage, isFree, price: Number(price) || 0, createdAt: nowIso()
      });
      return send(res, { success: true });
    }
    if (action === 'getTeacherCourses') {
      const courses = await coursesCol.find({ teacherId: body.teacherId }).sort({ createdAt: -1 }).toArray();
      return send(res, { success: true, courses: normalizeDocs(courses) });
    }
    if (action === 'buyCourse') {
      const { username, courseId } = body;
      const user = await usersCol.findOne({ username: username.toLowerCase() });
      const course = await coursesCol.findOne({ _id: toObjectId(courseId) });
      if (user.coins < course.price) return send(res, { success: false, error: 'Coins မလုံလောက်ပါ' });
      
      await usersCol.updateOne({ username: user.username }, { $inc: { coins: -course.price }, $push: { purchasedCourses: courseId } });
      await usersCol.updateOne({ username: course.teacherId }, { $inc: { coins: course.price } });
      return send(res, { success: true });
    }

    // ---------------- CHAT ----------------
    if (action === 'sendMessage') {
      const { from, to, text } = body;
      await chatsCol.insertOne({ from, to, text, createdAt: nowIso() });
      return send(res, { success: true });
    }
    if (action === 'getChatList') {
      const { username } = body;
      const msgs = await chatsCol.find({ $or: [{ from: username }, { to: username }] }).sort({ createdAt: -1 }).toArray();
      const convMap = new Map();
      for (const m of msgs) {
        const other = m.from === username ? m.to : m.from;
        if (!convMap.has(other)) {
          const u = await usersCol.findOne({ username: other });
          convMap.set(other, { username: other, displayName: u?.displayName || other, profileImage: u?.profileImage || '', lastMsg: m.text, time: m.createdAt });
        }
      }
      return send(res, { success: true, chats: Array.from(convMap.values()) });
    }
    if (action === 'getMessages') {
      const msgs = await chatsCol.find({ $or: [{ from: body.user1, to: body.user2 }, { from: body.user2, to: body.user1 }] }).sort({ createdAt: 1 }).toArray();
      return send(res, { success: true, messages: normalizeDocs(msgs) });
    }
    if (action === 'deleteMessages') {
      const { ids } = body;
      for(const id of ids) {
        await chatsCol.deleteOne({ _id: toObjectId(id) });
      }
      return send(res, { success: true });
    }

    // ---------------- COINS & PAYMENT ----------------
    if (action === 'getPackages') {
      const pkgs = await packagesCol.find({}).toArray();
      return send(res, { success: true, packages: normalizeDocs(pkgs) });
    }
    if (action === 'adminSavePackage') {
      await packagesCol.insertOne({ name: body.name, coins: Number(body.coins), price: Number(body.price), imageUrl: body.imageUrl });
      return send(res, { success: true });
    }
    if (action === 'submitPurchase') {
      await purchasesCol.insertOne({ username: body.username, packageId: body.packageId, proofImage: body.proofImage, status: 'pending', createdAt: nowIso() });
      return send(res, { success: true });
    }
    if (action === 'adminGetPurchases') {
      const list = await purchasesCol.find({ status: 'pending' }).toArray();
      const detailed = [];
      for (const p of list) {
        const pkg = await packagesCol.findOne({ _id: toObjectId(p.packageId) });
        detailed.push({ ...normalizeDoc(p), packageData: normalizeDoc(pkg) });
      }
      return send(res, { success: true, purchases: detailed });
    }
    if (action === 'adminApprovePurchase') {
      const purchase = await purchasesCol.findOne({ _id: toObjectId(body.purchaseId) });
      const pkg = await packagesCol.findOne({ _id: toObjectId(purchase.packageId) });
      if (body.approve) {
        await usersCol.updateOne({ username: purchase.username }, { $inc: { coins: pkg.coins } });
        await purchasesCol.updateOne({ _id: purchase._id }, { $set: { status: 'approved' } });
      } else {
        await purchasesCol.updateOne({ _id: purchase._id }, { $set: { status: 'rejected' } });
      }
      return send(res, { success: true });
    }

    // ---------------- ADMIN & USERS ----------------
    if (action === 'getTeachers') {
      const teachers = await usersCol.find({ isApprovedTeacher: true }).project({ passwordHash: 0 }).toArray();
      return send(res, { success: true, teachers: normalizeDocs(teachers) });
    }
    if (action === 'adminGetUsers') {
      const users = await usersCol.find({}).project({ passwordHash: 0 }).toArray();
      return send(res, { success: true, users: normalizeDocs(users) });
    }
    if (action === 'adminToggleBan') {
      await usersCol.updateOne({ username: body.username }, { $set: { isBanned: body.isBanned } });
      return send(res, { success: true });
    }
    if (action === 'adminDeleteUser') {
      await usersCol.deleteOne({ username: body.username });
      return send(res, { success: true });
    }
    if (action === 'adminGetRequests') {
      const reqs = await requestsCol.find({ status: 'pending' }).toArray();
      return send(res, { success: true, requests: normalizeDocs(reqs) });
    }
    if (action === 'adminApproveRequest') {
      const req = await requestsCol.findOne({ _id: toObjectId(body.requestId) });
      if (body.approve) {
        await usersCol.updateOne({ username: req.username }, { $set: { role: 'teacher', isApprovedTeacher: true } });
        await requestsCol.updateOne({ _id: req._id }, { $set: { status: 'approved' } });
      } else {
        await requestsCol.updateOne({ _id: req._id }, { $set: { status: 'rejected' } });
      }
      return send(res, { success: true });
    }

    // ---------------- IMAGE UPLOAD ----------------
    if (action === 'uploadImage') {
      const matches = body.base64.match(/^data:(.+);base64,(.+)$/);
      const buffer = Buffer.from(matches ? matches[2] : body.base64, 'base64');
      const result = await uploadToImgBB(buffer);
      return send(res, { success: true, url: result.url });
    }

    // ---------------- BOOTSTRAP ----------------
    if (action === 'bootstrap') {
      const user = await usersCol.findOne({ username: body.username });
      const posts = await postsCol.find({}).sort({ createdAt: -1 }).limit(30).toArray();
      const feed = [];
      for (const p of posts) {
        const author = await usersCol.findOne({ username: p.author });
        const hasLiked = user ? !!(await likesCol.findOne({ postId: p._id.toString(), username: user.username })) : false;
        feed.push({ ...normalizeDoc(p), authorData: author ? { displayName: author.displayName, profileImage: author.profileImage, role: author.role } : { displayName: p.author }, hasLiked });
      }
      const { passwordHash, _id, ...safeUser } = user || {};
      return send(res, { success: true, user: user ? { id: _id.toString(), ...safeUser } : null, feed });
    }

    return send(res, { success: false, error: 'Unknown action' }, 400);
  } catch (err) {
    return send(res, { success: false, error: err.message }, 500);
  }
};
