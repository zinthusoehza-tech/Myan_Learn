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
    const videosCol = await getCollection('videos');
    const requestsCol = await getCollection('requests');

    // ---------------- AUTH ----------------
    if (action === 'register') {
      const { username, password, role } = body;
      const existing = await usersCol.findOne({ username: username.toLowerCase() });
      if (existing) return send(res, { success: false, error: 'Username တူနေပါတယ်' });
      
      const newUser = {
        username: username.toLowerCase(), passwordHash: hashPassword(password), displayName: username,
        role: role === 'teacher' ? 'student' : role, isVerifiedStudent: false, isApprovedTeacher: false, isAdmin: false,
        isBanned: false, coins: 100, xp: 0, purchasedCourses: [], completedLessons: [], profileImage: '', bio: '', specialty: '', experience: '', studentsCount: '', rating: 0, ratingCount: 0, createdAt: nowIso()
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
      const { username, displayName, bio, profileImage, specialty, experience, studentsCount } = body;
      await usersCol.updateOne({ username: username.toLowerCase() }, { $set: { displayName, bio, profileImage, specialty, experience, studentsCount } });
      const updatedUser = await usersCol.findOne({ username: username.toLowerCase() });
      const { passwordHash, _id, ...safeUser } = updatedUser;
      return send(res, { success: true, user: { id: _id.toString(), ...safeUser } });
    }

    // ---------------- COURSES & LESSONS ----------------
    if (action === 'createCourse') {
      const { username, title, description, coverImage, isFree, price, modules } = body;
      const teacher = await usersCol.findOne({ username: username.toLowerCase() });
      await coursesCol.insertOne({
        teacherId: teacher.username, teacherName: teacher.displayName, teacherImage: teacher.profileImage,
        title, description, coverImage, isFree, price: Number(price) || 0, modules: modules || [], createdAt: nowIso()
      });
      return send(res, { success: true });
    }

    if (action === 'getTeacherCourses') {
      const courses = await coursesCol.find({ teacherId: body.teacherId }).sort({ createdAt: -1 }).toArray();
      return send(res, { success: true, courses: normalizeDocs(courses) });
    }

    if (action === 'getCourseDetails') {
      const course = await coursesCol.findOne({ _id: toObjectId(body.courseId) });
      if(!course) return send(res, { success: false, error: 'Course not found' });
      
      const user = await usersCol.findOne({ username: body.username });
      const hasAccess = user.isAdmin || user.isVerifiedStudent || course.isFree || (user.purchasedCourses || []).includes(course._id.toString());
      
      return send(res, { success: true, course: normalizeDoc(course), hasAccess, completedLessons: user.completedLessons || [] });
    }

    if (action === 'completeLesson') {
      const { username, lessonId, xpAmount } = body;
      const user = await usersCol.findOne({ username });
      if(!user.completedLessons.includes(lessonId)) {
        await usersCol.updateOne({ username }, { $addToSet: { completedLessons: lessonId }, $inc: { xp: (xpAmount || 20) } });
      }
      return send(res, { success: true });
    }

    if (action === 'getAllCourses') {
      const courses = await coursesCol.find({}).limit(10).toArray();
      return send(res, { success: true, courses: normalizeDocs(courses) });
    }

    // ---------------- VIDEOS ----------------
    if (action === 'getVideos') {
      const videos = await videosCol.find({}).toArray();
      // If empty, seed some mock videos
      if(videos.length === 0) {
        const mockVideos = [
          { title: "The power of the maid!", category: "Anime", level: "Easy", duration: "00:19", views: "293k", thumbnail: "https://i.ibb.co/3W9Xy0Z/maid.jpg", isPremium: false },
          { title: "Ordering at a Restaurant", category: "Music", level: "Easy", duration: "01:20", views: "99k", thumbnail: "https://i.ibb.co/6P9Qx7b/restaurant.jpg", isPremium: true }
        ];
        await videosCol.insertMany(mockVideos);
        return send(res, { success: true, videos: mockVideos });
      }
      return send(res, { success: true, videos: normalizeDocs(videos) });
    }

    // ---------------- ADMIN ----------------
    if (action === 'getTeachers') {
      const teachers = await usersCol.find({ isApprovedTeacher: true }).project({ passwordHash: 0 }).toArray();
      return send(res, { success: true, teachers: normalizeDocs(teachers) });
    }
    
    if (action === 'adminGetRequests') {
      const reqs = await requestsCol.find({ status: 'pending' }).toArray();
      return send(res, { success: true, requests: normalizeDocs(reqs) });
    }
    
    if (action === 'adminApproveRequest') {
      const req = await requestsCol.findOne({ _id: toObjectId(body.requestId) });
      if (!req) return send(res, { success: false, error: 'Request not found' });
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
      if(!user) return send(res, { success: false, error: 'User not found' });
      const { passwordHash, _id, ...safeUser } = user;
      return send(res, { success: true, user: { id: _id.toString(), ...safeUser } });
    }

    return send(res, { success: false, error: 'Unknown action' }, 400);
  } catch (err) {
    console.error(err);
    return send(res, { success: false, error: err.message }, 500);
  }
};
