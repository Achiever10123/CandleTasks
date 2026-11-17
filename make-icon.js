/**
 * Run this once with: node make-icon.js
 * It generates a simple icon.ico file so electron-builder doesn't error.
 * You can replace icon.ico later with your own 256x256 .ico file.
 *
 * Requires: npm install png-to-ico canvas
 * Or just drop your own icon.ico in the folder and skip this script.
 */

const fs = require('fs');
const path = require('path');

// Minimal valid 16x16 ICO file (candle orange pixel art, hand-crafted bytes)
// This is a real .ico binary so electron-builder won't complain.
// Replace with a proper 256x256 icon for a polished release.

const icoHex =
  '00000100' + // Reserved, Type=1 (ICO)
  '0100'     + // Count = 1 image
  // Directory entry for 16x16
  '10'       + // Width  = 16
  '10'       + // Height = 16
  '00'       + // Color count = 0 (no palette)
  '00'       + // Reserved
  '0100'     + // Planes = 1
  '1800'     + // Bit count = 24
  '8802 0000'+ // Size of image data
  '2200 0000'; // Offset to image data

// Since generating a valid ICO binary by hand is complex,
// we'll write a minimal BMP-based ICO that Windows accepts.
// This creates a 16x16 solid amber square as the app icon.

function writeMiniIco(filePath) {
  const size = 16;
  const bmpRowSize = Math.ceil((size * 3) / 4) * 4;
  const bmpDataSize = bmpRowSize * size * 2; // *2 for XOR + AND masks
  const bmpHeaderSize = 40;
  const totalBmpSize = bmpHeaderSize + bmpDataSize;

  const buf = Buffer.alloc(6 + 16 + totalBmpSize);
  let o = 0;

  // ICO header
  buf.writeUInt16LE(0, o); o += 2;           // Reserved
  buf.writeUInt16LE(1, o); o += 2;           // Type: 1 = ICO
  buf.writeUInt16LE(1, o); o += 2;           // Count: 1 image

  // ICO directory entry
  buf.writeUInt8(size, o); o++;              // Width
  buf.writeUInt8(size, o); o++;              // Height
  buf.writeUInt8(0, o);    o++;              // Color count
  buf.writeUInt8(0, o);    o++;              // Reserved
  buf.writeUInt16LE(1, o); o += 2;           // Planes
  buf.writeUInt16LE(24, o); o += 2;          // Bit count
  buf.writeUInt32LE(totalBmpSize, o); o += 4;// Size of BMP data
  buf.writeUInt32LE(22, o); o += 4;          // Offset to BMP data (6+16=22)

  // BMP INFOHEADER
  buf.writeUInt32LE(40, o); o += 4;          // Header size
  buf.writeInt32LE(size, o); o += 4;         // Width
  buf.writeInt32LE(size * 2, o); o += 4;     // Height * 2 (ICO quirk)
  buf.writeUInt16LE(1, o); o += 2;           // Planes
  buf.writeUInt16LE(24, o); o += 2;          // Bit count
  buf.writeUInt32LE(0, o); o += 4;           // Compression: none
  buf.writeUInt32LE(bmpDataSize, o); o += 4; // Image size
  buf.writeInt32LE(0, o); o += 4;            // X pixels per meter
  buf.writeInt32LE(0, o); o += 4;            // Y pixels per meter
  buf.writeUInt32LE(0, o); o += 4;           // Colors used
  buf.writeUInt32LE(0, o); o += 4;           // Colors important

  // XOR mask: amber color (BGR = 42, 130, 201 → warm orange #c97b2a)
  for (let row = size - 1; row >= 0; row--) {
    for (let col = 0; col < size; col++) {
      buf[o++] = 0x2a; // B
      buf[o++] = 0x7b; // G
      buf[o++] = 0xc9; // R
    }
    // Row padding
    for (let p = 0; p < (bmpRowSize - size * 3); p++) buf[o++] = 0;
  }

  // AND mask: all opaque (0 = show pixel)
  const andRowSize = Math.ceil(size / 32) * 4;
  for (let row = 0; row < size; row++) {
    for (let b = 0; b < andRowSize; b++) buf[o++] = 0;
  }

  fs.writeFileSync(filePath, buf);
  console.log('icon.ico created at', filePath);
  console.log('Replace it with a 256x256 .ico for a polished app icon.');
}

writeMiniIco(path.join(__dirname, 'icon.ico'));
