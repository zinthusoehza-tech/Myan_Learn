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

// Helper: Check if user is verified or has paid
async function canAccessCourse(user, course) {
  if (user.isAdmin) return true;
  if (user.isVerifiedStudent) return true;
  if (course.isFree) return true;
  return (user.purchasedCourses || []).includes(course.id);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { send(res, { success: true }); return; }
  const body = await parseBody(req);
  const action = body.action;

  try {
    const usersCol = await getCollection('users');
    const coursesCol = await getCollection('courses');
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
        role: role || 'student', // student, teacher, admin
        isVerifiedStudent: false,
        isApprovedTeacher: false,
        coins: 0,
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

    // ---------------- TEACHER/STUDENT REQUESTS ----------------
    if (action === 'applyTeacher') {
      const { username } = body;
      await requestsCol.insertOne({ username: username.toLowerCase(), type: 'teacher', status: 'pending', createdAt: nowIso() });
      return send(res, { success: true, message: 'Teacher application submitted to Admin.' });
    }

    if (action === 'verifyStudent') {
      const { username } = body; // Normally handled by Admin
      await usersCol.updateOne({ username: username.toLowerCase() }, { $set: { isVerifiedStudent: true } });
      return send(res, { success: true });
    }

    // ---------------- ADMIN ACTIONS ----------------
    if (action === 'adminGetRequests') {
      const reqs = await requestsCol.find({ status: 'pending' }).toArray();
      return send(res, { success: true, requests: normalizeDocs(reqs) });
    }

    if (action === 'adminApproveRequest') {
      const { requestId, approve } = body;
      const req = await requestsCol.findOne({ _id: toObjectId(requestId) });
      if (!req) return send(res, { success: false, error: 'Request not found' });

      if (approve) {
        if (req.type === 'teacher') {
          await usersCol.updateOne({ username: req.username }, { $set: { role: 'teacher', isApprovedTeacher: true } });
        } else if (req.type === 'student') {
          await usersCol.updateOne({ username: req.username }, { $set: { isVerifiedStudent: true } });
        }
        await requestsCol.updateOne({ _id: req._id }, { $set: { status: 'approved' } });
      } else {
        await requestsCol.updateOne({ _id: req._id }, { $set: { status: 'rejected' } });
      }
      return send(res, { success: true });
    }

    // ---------------- COURSES ----------------
    if (action === 'createCourse') {
      const { username, title, description, price, zoomLink, coverImage, isFree } = body;
      const teacher = await usersCol.findOne({ username: username.toLowerCase() });
      if (teacher.role !== 'teacher' && !teacher.isAdmin) return send(res, { success: false, error: 'Only teachers can create courses' });

      const course = {
        teacherId: teacher.username,
        teacherName: teacher.displayName,
        teacherImage: teacher.profileImage,
        title, description,
        price: Number(price) || 0,
        isFree: !!isFree,
        zoomLink: zoomLink || '',
        coverImage: coverImage || '',
        createdAt: nowIso()
      };
      const result = await coursesCol.insertOne(course);
      return send(res, { success: true, courseId: result.insertedId.toString() });
    }

    if (action === 'getCourses') {
      const { username } = body;
      const user = await usersCol.findOne({ username: username.toLowerCase() });
      const courses = await coursesCol.find({}).sort({ createdAt: -1 }).toArray();
      
      const courseList = courses.map(c => {
        const hasAccess = user ? (
          user.isAdmin || user.isVerifiedStudent || c.isFree || (user.purchasedCourses || []).includes(c.id || c._id.toString())
        ) : c.isFree;
        return { ...normalizeDoc(c), hasAccess };
      });
      return send(res, { success: true, courses: courseList });
    }

    if (action === 'buyCourse') {
      const { username, courseId } = body;
      const user = await usersCol.findOne({ username: username.toLowerCase() });
      const course = await coursesCol.findOne({ _id: toObjectId(courseId) });
      
      if (!course) return send(res, { success: false, error: 'Course not found' });
      if (course.isFree) return send(res, { success: false, error: 'Course is already free' });
      if (user.coins < course.price) return send(res, { success: false, error: 'Not enough coins' });

      await usersCol.updateOne({ username: user.username }, { 
        $inc: { coins: -course.price },
        $push: { purchasedCourses: courseId }
      });
      // Add coins to teacher
      await usersCol.updateOne({ username: course.teacherId }, { $inc: { coins: course.price } });

      return send(res, { success: true });
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
      if (username) {
        user = await usersCol.findOne({ username: username.toLowerCase() });
      }
      const courses = await coursesCol.find({}).sort({ createdAt: -1 }).toArray();
      const safeCourses = courses.map(c => {
        const hasAccess = user ? (
          user.isAdmin || user.isVerifiedStudent || c.isFree || (user.purchasedCourses || []).includes(c._id.toString())
        ) : c.isFree;
        return { ...normalizeDoc(c), hasAccess };
      });
      const { passwordHash, _id, ...safeUser } = user || {};
      return send(res, { success: true, user: user ? { id: _id.toString(), ...safeUser } : null, courses: safeCourses });
    }

    return send(res, { success: false, error: 'Unknown action' }, 400);
  } catch (err) {
    return send(res, { success: false, error: err.message }, 500);
  }
};