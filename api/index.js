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
    const requestsCol = await getCollection('requests');

    // ---------------- AUTH ----------------
    if (action === 'register') {
      const { username, password, role } = body;
      const existing = await usersCol.findOne({ username: username.toLowerCase() });
      if (existing) return send(res, { success: false, error: 'Username taken' });
      
      const newUser = {
        username: username.toLowerCase(),
        passwordHash: hashPassword(password),
        displayName: username,
        role: role || 'student',
        isVerifiedStudent: false,
        isAdmin: false,
        coins: 100, // Starter coins
        purchasedCourses: [],
        profileImage: '',
        bio: '',
        createdAt: nowIso()
      };
      const result = await usersCol.insertOne(newUser);
      const { passwordHash, _id, ...safeUser } = newUser;
      const token = generateToken(safeUser.username);
      return send(res, { success: true, user: { id: result.insertedId.toString(), ...safeUser }, token });
    }

    if (action === 'login') {
      const { username, password } = body;
      const user = await usersCol.findOne({ username: username.toLowerCase() });
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return send(res, { success: false, error: 'Invalid credentials' });
      }
      const { passwordHash, _id, ...safeUser } = user;
      const token = generateToken(safeUser.username);
      return send(res, { success: true, user: { id: _id.toString(), ...safeUser }, token });
    }

    // ---------------- PROFILE ----------------
    if (action === 'updateProfile') {
      const { username, displayName, bio, profileImage } = body;
      await usersCol.updateOne({ username: username.toLowerCase() }, { 
        $set: { displayName, bio, profileImage } 
      });
      return send(res, { success: true });
    }

    if (action === 'getUserProfile') {
      const { username } = body;
      const user = await usersCol.findOne({ username: username.toLowerCase() });
      if (!user) return send(res, { success: false, error: 'User not found' });
      const { passwordHash, _id, ...safeUser } = user;
      const userPosts = await postsCol.find({ author: username.toLowerCase() }).sort({ createdAt: -1 }).toArray();
      return send(res, { success: true, user: { id: _id.toString(), ...safeUser }, posts: normalizeDocs(userPosts) });
    }

    // ---------------- POSTS (SOCIAL) ----------------
    if (action === 'createPost') {
      const { username, content, imageUrl } = body;
      const post = { author: username.toLowerCase(), content, imageUrl, likeCount: 0, commentCount: 0, createdAt: nowIso() };
      await postsCol.insertOne(post);
      return send(res, { success: true });
    }

    if (action === 'getFeed') {
      const { username } = body;
      const posts = await postsCol.find({}).sort({ createdAt: -1 }).limit(50).toArray();
      const feed = [];
      for (const p of posts) {
        const author = await usersCol.findOne({ username: p.author });
        const hasLiked = username ? !!(await likesCol.findOne({ postId: p._id.toString(), username: username.toLowerCase() })) : false;
        feed.push({
          ...normalizeDoc(p),
          authorData: author ? { displayName: author.displayName, profileImage: author.profileImage, isTeacher: author.role === 'teacher' } : { displayName: p.author },
          hasLiked
        });
      }
      return send(res, { success: true, posts: feed });
    }

    if (action === 'likePost') {
      const { postId, username } = body;
      const existing = await likesCol.findOne({ postId, username: username.toLowerCase() });
      if (existing) {
        await likesCol.deleteOne({ _id: existing._id });
        await postsCol.updateOne({ _id: toObjectId(postId) }, { $inc: { likeCount: -1 } });
        return send(res, { success: true, liked: false });
      } else {
        await likesCol.insertOne({ postId, username: username.toLowerCase() });
        await postsCol.updateOne({ _id: toObjectId(postId) }, { $inc: { likeCount: 1 } });
        return send(res, { success: true, liked: true });
      }
    }

    if (action === 'addComment') {
      const { postId, username, content } = body;
      await commentsCol.insertOne({ postId, author: username.toLowerCase(), content, createdAt: nowIso() });
      await postsCol.updateOne({ _id: toObjectId(postId) }, { $inc: { commentCount: 1 } });
      return send(res, { success: true });
    }

    if (action === 'getComments') {
      const { postId } = body;
      const comments = await commentsCol.find({ postId }).sort({ createdAt: 1 }).toArray();
      const list = [];
      for (const c of comments) {
        const u = await usersCol.findOne({ username: c.author });
        list.push({ ...normalizeDoc(c), authorData: { displayName: u?.displayName || c.author, profileImage: u?.profileImage || '' } });
      }
      return send(res, { success: true, comments: list });
    }

    // ---------------- COURSES (LEARNING) ----------------
    if (action === 'createCourse') {
      const { username, title, description, zoomLink, coverImage, isFree, price } = body;
      const teacher = await usersCol.findOne({ username: username.toLowerCase() });
      const course = {
        teacherId: teacher.username, teacherName: teacher.displayName, teacherImage: teacher.profileImage,
        title, description, zoomLink, coverImage, isFree, price: Number(price) || 0,
        createdAt: nowIso()
      };
      await coursesCol.insertOne(course);
      return send(res, { success: true });
    }

    if (action === 'getCourses') {
      const { username } = body;
      const user = await usersCol.findOne({ username: username.toLowerCase() });
      const courses = await coursesCol.find({}).sort({ createdAt: -1 }).toArray();
      const list = courses.map(c => {
        const hasAccess = user ? (user.isAdmin || user.isVerifiedStudent || c.isFree || (user.purchasedCourses || []).includes(c._id.toString())) : c.isFree;
        return { ...normalizeDoc(c), hasAccess };
      });
      return send(res, { success: true, courses: list });
    }

    if (action === 'buyCourse') {
      const { username, courseId } = body;
      const user = await usersCol.findOne({ username: username.toLowerCase() });
      const course = await coursesCol.findOne({ _id: toObjectId(courseId) });
      if (user.coins < course.price) return send(res, { success: false, error: 'Not enough coins' });
      
      await usersCol.updateOne({ username: user.username }, { $inc: { coins: -course.price }, $push: { purchasedCourses: courseId } });
      await usersCol.updateOne({ username: course.teacherId }, { $inc: { coins: course.price } });
      return send(res, { success: true });
    }

    // ---------------- CHAT ----------------
    if (action === 'sendMessage') {
      const { from, to, text, imageUrl } = body;
      const msg = { from, to, text, imageUrl, createdAt: nowIso() };
      await chatsCol.insertOne(msg);
      return send(res, { success: true });
    }

    if (action === 'getMessages') {
      const { user1, user2 } = body;
      const msgs = await chatsCol.find({
        $or: [{ from: user1, to: user2 }, { from: user2, to: user1 }]
      }).sort({ createdAt: 1 }).toArray();
      return send(res, { success: true, messages: normalizeDocs(msgs) });
    }

    if (action === 'getChatList') {
      const { username } = body;
      const me = username.toLowerCase();
      const msgs = await chatsCol.find({ $or: [{ from: me }, { to: me }] }).sort({ createdAt: -1 }).toArray();
      const convMap = new Map();
      for (const m of msgs) {
        const other = m.from === me ? m.to : m.from;
        if (!convMap.has(other)) {
          const u = await usersCol.findOne({ username: other });
          convMap.set(other, { username: other, displayName: u?.displayName || other, profileImage: u?.profileImage || '', lastMsg: m.text || '📷 Photo', time: m.createdAt });
        }
      }
      return send(res, { success: true, chats: Array.from(convMap.values()) });
    }

    // ---------------- IMAGE UPLOAD ----------------
    if (action === 'uploadImage') {
      const { base64 } = body;
      const matches = base64.match(/^data:(.+);base64,(.+)$/);
      const buffer = Buffer.from(matches ? matches[2] : base64, 'base64');
      const result = await uploadToImgBB(buffer);
      return send(res, { success: true, url: result.url });
    }

    // ---------------- BOOTSTRAP & ADMIN ----------------
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

      const { passwordHash, _id, ...safeUser } = user || {};
      return send(res, { success: true, user: user ? { id: _id.toString(), ...safeUser } : null, courses: safeCourses, feed });
    }

    if (action === 'adminGetRequests') {
      const reqs = await requestsCol.find({ status: 'pending' }).toArray();
      return send(res, { success: true, requests: normalizeDocs(reqs) });
    }

    if (action === 'adminApproveRequest') {
      const { requestId, approve } = body;
      const req = await requestsCol.findOne({ _id: toObjectId(requestId) });
      if (approve) {
        if (req.type === 'teacher') await usersCol.updateOne({ username: req.username }, { $set: { role: 'teacher' } });
        else await usersCol.updateOne({ username: req.username }, { $set: { isVerifiedStudent: true } });
        await requestsCol.updateOne({ _id: req._id }, { $set: { status: 'approved' } });
      } else {
        await requestsCol.updateOne({ _id: req._id }, { $set: { status: 'rejected' } });
      }
      return send(res, { success: true });
    }

    if (action === 'applyTeacher') {
      await requestsCol.insertOne({ username: body.username.toLowerCase(), type: 'teacher', status: 'pending', createdAt: nowIso() });
      return send(res, { success: true });
    }

    return send(res, { success: false, error: 'Unknown action' }, 400);
  } catch (err) {
    return send(res, { success: false, error: err.message }, 500);
  }
};
