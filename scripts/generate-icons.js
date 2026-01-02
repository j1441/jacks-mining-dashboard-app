#!/usr/bin/env node
/**
 * PWA Icon Generator Script
 *
 * This script generates PWA icons from the source SVG.
 *
 * Usage: node scripts/generate-icons.js
 *
 * Requirements:
 *   npm install sharp
 *
 * Or run without sharp by using the SVG-based fallback icons.
 */

const fs = require('fs');
const path = require('path');

// Icon sizes needed for PWA
const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
const maskableSizes = [192, 512];

// iOS-specific sizes (Apple requires exact sizes)
const iosSizes = [
    { size: 180, name: 'apple-touch-icon-180x180' },  // iPhone retina
    { size: 167, name: 'apple-touch-icon-167x167' },  // iPad Pro
    { size: 152, name: 'apple-touch-icon-152x152' },  // iPad retina
    { size: 120, name: 'apple-touch-icon-120x120' },  // iPhone
];

const svgSource = path.join(__dirname, '..', 'icon.svg');
const outputDir = path.join(__dirname, '..', 'public', 'icons');

// Read the source SVG
const svgContent = fs.readFileSync(svgSource, 'utf8');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

async function generateIcons() {
    try {
        // Try to use sharp if available
        const sharp = require('sharp');

        console.log('Generating PNG icons using sharp...');

        for (const size of sizes) {
            const outputPath = path.join(outputDir, `icon-${size}x${size}.png`);
            await sharp(Buffer.from(svgContent))
                .resize(size, size)
                .png()
                .toFile(outputPath);
            console.log(`  Created: icon-${size}x${size}.png`);
        }

        // Generate iOS-specific icons (Apple Touch Icons)
        // iOS requires NO transparency and NO rounded corners (iOS adds those)
        console.log('\nGenerating iOS icons...');
        for (const { size, name } of iosSizes) {
            const outputPath = path.join(outputDir, `${name}.png`);
            await sharp(Buffer.from(svgContent))
                .resize(size, size)
                .flatten({ background: { r: 26, g: 26, b: 46 } }) // Remove transparency
                .png()
                .toFile(outputPath);
            console.log(`  Created: ${name}.png`);
        }

        // Also create the default apple-touch-icon.png (180x180) in public root
        const defaultAppleIcon = path.join(__dirname, '..', 'public', 'apple-touch-icon.png');
        await sharp(Buffer.from(svgContent))
            .resize(180, 180)
            .flatten({ background: { r: 26, g: 26, b: 46 } })
            .png()
            .toFile(defaultAppleIcon);
        console.log('  Created: apple-touch-icon.png (in public root)');

        // Generate maskable icons (with padding for safe zone)
        console.log('\nGenerating maskable icons...');
        for (const size of maskableSizes) {
            const outputPath = path.join(outputDir, `icon-maskable-${size}x${size}.png`);
            const innerSize = Math.floor(size * 0.8); // 80% of total size for safe zone
            const padding = Math.floor((size - innerSize) / 2);

            // Create icon with padding for maskable
            const innerIcon = await sharp(Buffer.from(svgContent))
                .resize(innerSize, innerSize)
                .toBuffer();

            await sharp({
                create: {
                    width: size,
                    height: size,
                    channels: 4,
                    background: { r: 26, g: 26, b: 46, alpha: 1 } // #1a1a2e
                }
            })
                .composite([{
                    input: innerIcon,
                    top: padding,
                    left: padding
                }])
                .png()
                .toFile(outputPath);
            console.log(`  Created: icon-maskable-${size}x${size}.png`);
        }

        console.log('\nAll icons generated successfully!');

    } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
            console.log('sharp module not found. Creating SVG-based icons instead...');
            generateSvgIcons();
        } else {
            throw err;
        }
    }
}

function generateSvgIcons() {
    // Fallback: Create resized SVG files (browsers can use these)
    for (const size of sizes) {
        const resizedSvg = svgContent.replace(
            /width="256" height="256"/,
            `width="${size}" height="${size}"`
        );
        const outputPath = path.join(outputDir, `icon-${size}x${size}.svg`);
        fs.writeFileSync(outputPath, resizedSvg);
        console.log(`  Created: icon-${size}x${size}.svg`);
    }

    // Create maskable SVGs with background padding
    for (const size of maskableSizes) {
        const innerSize = Math.floor(size * 0.8);
        const offset = Math.floor((size - innerSize) / 2);

        const maskableSvg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" fill="#1a1a2e"/>
  <g transform="translate(${offset}, ${offset}) scale(${innerSize/256})">
    <circle cx="128" cy="128" r="80" fill="#f39c12" stroke="#fff" stroke-width="4"/>
    <path d="M128 68 L158 98 L128 128 L98 98 Z" fill="#fff"/>
    <path d="M128 128 L158 158 L128 188 L98 158 Z" fill="#fff"/>
  </g>
</svg>`;
        const outputPath = path.join(outputDir, `icon-maskable-${size}x${size}.svg`);
        fs.writeFileSync(outputPath, maskableSvg);
        console.log(`  Created: icon-maskable-${size}x${size}.svg`);
    }

    console.log('\nSVG icons created. For PNG icons, install sharp: npm install sharp');
}

generateIcons().catch(console.error);
