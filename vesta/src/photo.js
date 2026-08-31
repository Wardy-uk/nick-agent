/**
 * A phone photo, made small enough to send.
 *
 * ⚠ This is not an optimisation, it is the difference between the feature
 * working and not. A photo off a modern iPhone is 3-5MB and the server refuses
 * above 4MB, so sending the original means a good proportion of real photographs
 * come back "too big" — a failure she can do nothing useful about, on the one
 * path meant to save her typing.
 *
 * 1600px on the long edge is plenty to read a label off a shelf, and it also
 * cuts what the vision call costs, since an image is billed by its dimensions.
 *
 * ⚠ Nothing is uploaded, stored or kept here. The canvas exists inside this
 * function and the base64 string is handed straight to the caller, which posts
 * it and drops it. The server keeps nothing either — see services/vesta-vision.js.
 */

const MAX_EDGE = 1600;
const QUALITY = 0.8;

// What the server will accept. Kept in step with MEDIA_TYPES in
// services/vesta-vision.js — everything is re-encoded to JPEG below, so this is
// really about what the browser can decode.
export const ACCEPTED = 'image/*';

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // Revoked either way, or a few photos leak a blob URL per session.
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("I couldn't open that photo."));
    };
    img.src = url;
  });
}

/**
 * @returns {Promise<{ image: string, mediaType: string }>} base64 WITHOUT the
 *   data: prefix, because that is what the API expects — sending the prefix is
 *   the classic way this fails, with an unhelpful 400 from the model provider.
 */
export async function preparePhoto(file) {
  if (!file) throw new Error('No photo chosen.');
  if (!String(file.type || '').startsWith('image/')) {
    throw new Error("That doesn't look like a photo.");
  }

  const img = await loadImage(file);

  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("I couldn't read that photo.");
  ctx.drawImage(img, 0, 0, width, height);

  // JPEG regardless of what came in: HEIC arrives as something the browser has
  // already decoded, and re-encoding is what guarantees the server gets one of
  // the four types it accepts.
  const dataUrl = canvas.toDataURL('image/jpeg', QUALITY);
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw new Error("I couldn't read that photo.");

  return { image: dataUrl.slice(comma + 1), mediaType: 'image/jpeg' };
}
