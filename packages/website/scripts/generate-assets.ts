#!/usr/bin/env bun

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const AMBER = '#D97706'
const AMBER_LIGHT = '#FBBF24'
const DARK = '#1C1917'
const DARK_2 = '#292524'
const MUTED = '#A8A29E'

const publicDir = fileURLToPath(new URL('../public/', import.meta.url))

// A waveform that goes quiet in the middle: the shape of the problem vcut solves.
const waveform = (x: number, y: number, width: number, height: number): string => {
  const bars = 48
  const gap = width / bars
  const parts: string[] = []
  for (let i = 0; i < bars; i++) {
    const t = i / (bars - 1)
    // Two bursts of speech with a silent gap between them.
    const envelope = t < 0.38 || t > 0.62 ? 1 : 0.06
    const wobble = 0.45 + 0.55 * Math.abs(Math.sin(i * 1.7))
    const barHeight = Math.max(2, height * envelope * wobble)
    const barX = x + i * gap
    const barY = y + (height - barHeight) / 2
    const dim = envelope < 0.5
    parts.push(
      `<rect x="${barX.toFixed(1)}" y="${barY.toFixed(1)}" width="${(gap * 0.55).toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2" fill="${dim ? MUTED : AMBER}" opacity="${dim ? 0.35 : 0.95}"/>`
    )
  }
  return parts.join('')
}

const ogSvg = (width: number, height: number): string => `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${DARK}"/>
      <stop offset="100%" stop-color="${DARK_2}"/>
    </linearGradient>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <circle cx="1.5" cy="1.5" r="1.5" fill="${AMBER}" opacity="0.10"/>
    </pattern>
  </defs>

  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect width="${width}" height="${height}" fill="url(#grid)"/>
  <rect x="0" y="0" width="${width}" height="5" fill="${AMBER}"/>
  <rect x="0" y="${height - 5}" width="${width}" height="5" fill="${AMBER}"/>

  <text x="80" y="${height / 2 - 96}" font-family="Geist Mono, monospace" font-size="86" font-weight="700" fill="#FFFFFF" letter-spacing="-3">vcut</text>

  <text x="80" y="${height / 2 - 38}" font-family="Inter, sans-serif" font-size="30" fill="#E7E5E4">Cut dead air out of a recording, reproducibly.</text>

  <text x="80" y="${height / 2 + 4}" font-family="Inter, sans-serif" font-size="21" fill="${MUTED}">Agent-first CLI over ffmpeg. Every cut is proposed, never applied without approval.</text>

  ${waveform(80, height / 2 + 40, width - 160, 76)}

  <rect x="80" y="${height - 128}" width="392" height="50" rx="10" fill="none" stroke="${AMBER}" stroke-width="2"/>
  <text x="104" y="${height - 95}" font-family="Geist Mono, monospace" font-size="21" fill="${AMBER_LIGHT}">npm install -g @crafter/vcut</text>
</svg>`

const faviconSvg = `
<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <rect width="128" height="128" rx="26" fill="${AMBER}"/>
  <rect x="26" y="40" width="11" height="48" rx="4" fill="#FFFFFF"/>
  <rect x="45" y="52" width="11" height="24" rx="4" fill="#FFFFFF" opacity="0.45"/>
  <rect x="64" y="56" width="11" height="16" rx="4" fill="#FFFFFF" opacity="0.3"/>
  <rect x="83" y="34" width="11" height="60" rx="4" fill="#FFFFFF"/>
</svg>`

const run = async () => {
  await sharp(Buffer.from(ogSvg(1200, 630)))
    .png({ quality: 95 })
    .toFile(`${publicDir}og.png`)
  await sharp(Buffer.from(ogSvg(1200, 600)))
    .png({ quality: 95 })
    .toFile(`${publicDir}og-twitter.png`)

  writeFileSync(`${publicDir}favicon.svg`, faviconSvg.trim())
  await sharp(Buffer.from(faviconSvg)).resize(64, 64).png().toFile(`${publicDir}favicon.png`)

  console.log('wrote og.png, og-twitter.png, favicon.svg, favicon.png')
}

await run()
