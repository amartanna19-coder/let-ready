'use strict';

// Certificate uploads. Only PDFs, JPEGs and PNGs are accepted, and the file's
// first bytes must match the declared type, so a renamed file is rejected.
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

const SIGNATURES = {
  'application/pdf': [Buffer.from('%PDF-')],
  'image/jpeg': [Buffer.from([0xff, 0xd8, 0xff])],
  'image/png': [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
};

const ALLOWED_TYPES = Object.keys(SIGNATURES);

function sanitizeFilename(name) {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return base || 'document';
}

// Returns true when the buffer starts with a signature for the declared type.
function matchesDeclaredType(buffer, contentType) {
  const signatures = SIGNATURES[contentType];
  if (!signatures) return false;
  return signatures.some((signature) => buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature));
}

// Lets a browser download a file without running it in the app's origin.
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

module.exports = {
  MAX_DOCUMENT_BYTES,
  ALLOWED_TYPES,
  sanitizeFilename,
  matchesDeclaredType,
  contentDisposition,
};
