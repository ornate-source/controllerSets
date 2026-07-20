/**
 * Content-based file type detection.
 *
 * The multipart `Content-Type` header is written by the client, so it states an
 * intent, not a fact. Trusting it for the stored object's `ContentType` is what
 * turns an "image upload" endpoint into arbitrary HTML hosting on the bucket's
 * origin. Everything here reads the bytes instead.
 */

/** Types that are safe to serve inline. Everything else gets `attachment`. */
export const INLINE_SAFE_TYPES = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/avif",
];

/**
 * Active content: a browser will execute these on the serving origin.
 * Blocked unless a consumer explicitly allowlists them, and never served inline.
 */
export const ACTIVE_CONTENT_TYPES = [
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "text/javascript",
    "application/javascript",
    "application/xml",
    "text/xml",
];

const startsWith = (buffer, bytes, offset = 0) =>
    buffer.length >= offset + bytes.length &&
    bytes.every((byte, i) => buffer[offset + i] === byte);

const asciiAt = (buffer, offset, text) =>
    buffer.length >= offset + text.length &&
    buffer.toString("latin1", offset, offset + text.length) === text;

/**
 * Sniffs markup out of a leading text sample.
 *
 * This runs before the binary checks because it is the security-relevant path:
 * a payload that is HTML or SVG must be recognised as such even when the client
 * labelled it `image/png` and even when it carries no binary signature.
 */
const detectMarkup = (buffer) => {
    const sample = buffer
        .toString("utf8", 0, Math.min(buffer.length, 1024))
        .replace(/^﻿/, "")
        .trim()
        .toLowerCase();

    if (!sample.startsWith("<")) return null;
    if (sample.startsWith("<!doctype html") || sample.startsWith("<html")) return "text/html";
    if (sample.startsWith("<svg")) return "image/svg+xml";
    // An XML prolog may precede either an SVG root or arbitrary markup.
    if (sample.startsWith("<?xml")) return sample.includes("<svg") ? "image/svg+xml" : "application/xml";
    if (sample.includes("<script")) return "text/html";
    return null;
};

/**
 * Returns `{ mime, ext }` for a buffer, or `null` when the type is unrecognised.
 * Unrecognised is deliberately not the same as "allow" — callers reject it.
 */
export const detectFileType = (buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;

    const markup = detectMarkup(buffer);
    if (markup) {
        const ext = { "text/html": ".html", "image/svg+xml": ".svg", "application/xml": ".xml" };
        return { mime: markup, ext: ext[markup] };
    }

    if (startsWith(buffer, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: ".jpg" };
    if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        return { mime: "image/png", ext: ".png" };
    if (asciiAt(buffer, 0, "GIF87a") || asciiAt(buffer, 0, "GIF89a"))
        return { mime: "image/gif", ext: ".gif" };
    if (asciiAt(buffer, 0, "RIFF") && asciiAt(buffer, 8, "WEBP"))
        return { mime: "image/webp", ext: ".webp" };
    if (asciiAt(buffer, 0, "%PDF-")) return { mime: "application/pdf", ext: ".pdf" };

    // ISO base media format: brand lives at offset 8, after the `ftyp` box marker.
    if (asciiAt(buffer, 4, "ftyp")) {
        const brand = buffer.toString("latin1", 8, 12);
        if (brand === "avif" || brand === "avis") return { mime: "image/avif", ext: ".avif" };
        if (brand.startsWith("hei") || brand.startsWith("mif")) return { mime: "image/heic", ext: ".heic" };
        return { mime: "video/mp4", ext: ".mp4" };
    }

    if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]))
        return { mime: "application/zip", ext: ".zip" };
    if (startsWith(buffer, [0x49, 0x44, 0x33]) || startsWith(buffer, [0xff, 0xfb]))
        return { mime: "audio/mpeg", ext: ".mp3" };

    return null;
};

/** Maps a detected mime to the sharp encoder name, or null if not a raster image. */
export const sharpFormatFor = (mime) =>
    ({
        "image/jpeg": "jpeg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
        "image/avif": "avif",
    })[mime] ?? null;
