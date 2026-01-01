#!/usr/bin/env node
/**
 * Favicon Generator Script
 *
 * Generates favicon.ico from the source SVG icon.
 *
 * Usage: node scripts/generate-favicon.js
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const svgSource = path.join(__dirname, '..', 'icon.svg');
const outputPath = path.join(__dirname, '..', 'public', 'favicon.ico');

async function generateFavicon() {
    const svgContent = fs.readFileSync(svgSource);

    // Generate a 32x32 PNG (standard favicon size)
    const pngBuffer = await sharp(svgContent)
        .resize(32, 32)
        .png()
        .toBuffer();

    // For simplicity, save as PNG with .ico extension
    // Modern browsers support PNG favicons
    // For true ICO format, you'd need a library like 'png-to-ico'
    await sharp(pngBuffer)
        .toFile(outputPath);

    console.log('Favicon generated:', outputPath);

    // Also generate a 16x16 version
    const favicon16Path = path.join(__dirname, '..', 'public', 'favicon-16x16.png');
    await sharp(svgContent)
        .resize(16, 16)
        .png()
        .toFile(favicon16Path);
    console.log('Favicon 16x16 generated:', favicon16Path);

    // And a 32x32 version
    const favicon32Path = path.join(__dirname, '..', 'public', 'favicon-32x32.png');
    await sharp(svgContent)
        .resize(32, 32)
        .png()
        .toFile(favicon32Path);
    console.log('Favicon 32x32 generated:', favicon32Path);
}

generateFavicon().catch(console.error);
