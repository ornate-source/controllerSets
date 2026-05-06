import test from "node:test";
import assert from "node:assert";
import sharp from "sharp";
import { compressImage } from "../src/s3upload.js";

test("Image Optimization & Compression Tests", async (t) => {
    // Generate a high-entropy random pixel image buffer so that we get a rich, complex JPEG image
    // that is extremely sensitive to JPEG quality compression changes.
    const width = 800;
    const height = 800;
    const size = width * height * 3;
    const randomPixels = Buffer.alloc(size);
    
    // Fill with high-entropy pseudo-random noise
    for (let i = 0; i < size; i++) {
        randomPixels[i] = (i * 33 + 7) % 256;
    }

    const baseJpegBuffer = await sharp(randomPixels, {
        raw: {
            width,
            height,
            channels: 3
        }
    })
    .jpeg({ quality: 95 })
    .toBuffer();

    const originalSize = baseJpegBuffer.length;
    console.log(`[Test] Generated base high-entropy image. Size: ${originalSize} bytes`);

    await t.test("LOW Optimization (Target: 75% - 80% size)", async () => {
        const compressed = await compressImage(baseJpegBuffer, "image/jpeg", "low");
        const ratio = compressed.length / originalSize;
        console.log(`[Test-LOW] Compressed size: ${compressed.length} bytes (Ratio: ${ratio.toFixed(4)})`);
        
        // Assert it is close to target range or within tolerance
        assert.ok(ratio >= 0.74 && ratio <= 0.81, `Ratio ${ratio} should be close to [0.75, 0.80]`);
    });

    await t.test("MEDIUM/MED Optimization (Target: 60% - 65% size)", async () => {
        const compressed = await compressImage(baseJpegBuffer, "image/jpeg", "medium");
        const ratio = compressed.length / originalSize;
        console.log(`[Test-MEDIUM] Compressed size: ${compressed.length} bytes (Ratio: ${ratio.toFixed(4)})`);
        
        assert.ok(ratio >= 0.59 && ratio <= 0.66, `Ratio ${ratio} should be close to [0.60, 0.65]`);
    });

    await t.test("HIGH Optimization (Target: 40% - 45% size)", async () => {
        const compressed = await compressImage(baseJpegBuffer, "image/jpeg", "high");
        const ratio = compressed.length / originalSize;
        console.log(`[Test-HIGH] Compressed size: ${compressed.length} bytes (Ratio: ${ratio.toFixed(4)})`);
        
        assert.ok(ratio >= 0.39 && ratio <= 0.46, `Ratio ${ratio} should be close to [0.40, 0.45]`);
    });

    await t.test("HIGH Optimization for Large 5MB File (Target: 600KB - 700KB size)", async () => {
        // Create an image of ~5MB when JPEG-compressed (8000x5800x3 pixels = ~139MB raw buffer) with moderate entropy
        const wLarge = 8000;
        const hLarge = 5800;
        const largePixels = Buffer.alloc(wLarge * hLarge * 3);
        for (let y = 0; y < hLarge; y++) {
            for (let x = 0; x < wLarge; x++) {
                const idx = (y * wLarge + x) * 3;
                const val1 = Math.sin(x / 120) * 127 + 128;
                const val2 = Math.cos(y / 120) * 127 + 128;
                const val = Math.floor((val1 + val2) / 2);
                largePixels[idx] = val;
                largePixels[idx + 1] = (val + 50) % 256;
                largePixels[idx + 2] = Math.floor(val * 1.5) % 256;
            }
        }
        const largeJpegBuffer = await sharp(largePixels, {
            raw: { width: wLarge, height: hLarge, channels: 3 }
        })
        .jpeg({ quality: 95 })
        .toBuffer();

        console.log(`[Test-5MB] Large original file size: ${largeJpegBuffer.length} bytes (~${(largeJpegBuffer.length / (1024*1024)).toFixed(2)} MB)`);

        const compressed = await compressImage(largeJpegBuffer, "image/jpeg", "high");
        const compressedKB = compressed.length / 1024;
        console.log(`[Test-5MB] Compressed size: ${compressedKB.toFixed(2)} KB`);

        // Assert size is inside or close to [600, 700] KB (allowing a small variance up to 730KB)
        assert.ok(compressedKB >= 580 && compressedKB <= 730, `Size ${compressedKB.toFixed(2)} KB should be close to [600, 700] KB`);
    });

    await t.test("No Optimization if invalid level provided", async () => {
        const compressed = await compressImage(baseJpegBuffer, "image/jpeg", "unknown_level");
        assert.strictEqual(compressed.length, originalSize, "Should return original buffer if level is unrecognized");
    });

    await t.test("Graceful fallback if format optimization fails or is un-optimizable", async () => {
        const fakeBuffer = Buffer.from("not-a-real-image-buffer");
        const result = await compressImage(fakeBuffer, "image/svg+xml", "high");
        assert.deepStrictEqual(result, fakeBuffer, "Should gracefully return original buffer on failure or uncompressed format");
    });
});
