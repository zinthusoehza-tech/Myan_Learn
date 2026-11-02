const IMGBB_API_KEY = process.env.IMGBB_API_KEY || "7ff81c37659b492882c0ebea8f589d0c";
const IMGBB_UPLOAD_URL = 'https://api.imgbb.com/1/upload';

async function uploadToImgBB(buffer) {
  const base64 = buffer.toString('base64');
  const formData = new URLSearchParams();
  formData.append('key', IMGBB_API_KEY);
  formData.append('image', base64);

  const res = await fetch(IMGBB_UPLOAD_URL, { method: 'POST', body: formData });
  const data = await res.json();
  if (!data.success) throw new Error('ImgBB upload failed');
  return { url: data.data.url, fileId: data.data.id };
}
module.exports = { uploadToImgBB };