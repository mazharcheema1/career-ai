/**
 * Career AI — ATS CV Generator
 * Paste a job description → Gemini tailors your CV → Download PDF
 */

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import { exec } from 'child_process';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle, UnderlineType } from 'docx';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME  = 'Career AI';   // ← change the tool name here anytime
const PORT = process.env.PORT || 3738;  // Render sets PORT automatically

// In-memory store for HTML pages being rendered to PDF (avoids temp files)
const pendingPages = new Map();
const CONFIG_DIR  = path.join(__dirname, 'config');
const API_KEY_FILE = path.join(CONFIG_DIR, 'api-key.txt');
const CV_FILE     = path.join(__dirname, 'cv.md');
const OUTPUT_DIR  = path.join(__dirname, 'output');
const DATA_DIR    = path.join(__dirname, 'data');
const TRACKER     = path.join(DATA_DIR, 'applications.md');

for (const d of [OUTPUT_DIR, CONFIG_DIR, DATA_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ─── Mammoth (optional, lazy-loaded for .docx upload) ────────────────────────

let mammoth = null;
async function getMammoth() {
  if (!mammoth) {
    try { mammoth = await import('mammoth'); } catch {
      throw new Error('mammoth not installed — run: npm install mammoth');
    }
  }
  return mammoth;
}

// ─── File Helpers ─────────────────────────────────────────────────────────────

function readCV()        { try { return fs.readFileSync(CV_FILE, 'utf8').trim(); } catch { return ''; } }
function saveCV(c)       { fs.writeFileSync(CV_FILE, c, 'utf8'); }

function loadApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try { return fs.readFileSync(API_KEY_FILE, 'utf8').trim(); } catch { return ''; }
}
function saveApiKey(k) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(API_KEY_FILE, k.trim(), 'utf8');
}

// ─── Gemini API ───────────────────────────────────────────────────────────────

// Preferred models in order — first available one wins
const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-flash-latest',
  'gemini-2.5-pro',
];
let workingModel = null; // cached after first successful call

async function callGemini(apiKey, prompt) {
  const genAI = new GoogleGenerativeAI(apiKey);

  // If we already found a working model, use it directly
  const modelsToTry = workingModel ? [workingModel] : GEMINI_MODELS;

  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      workingModel = modelName; // cache for future calls
      console.log(`  Using model: ${modelName}`);
      return result.response.text();
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('429') || msg.includes('quota') || msg.includes('Too Many Requests')) {
        const retry = msg.match(/retry in ([\d.]+)s/i);
        throw new Error(
          `Gemini quota exceeded for model "${modelName}". ` +
          (retry ? `Please wait ${Math.ceil(parseFloat(retry[1]))} seconds and try again. ` : '') +
          `Visit aistudio.google.com to check your usage.`
        );
      }
      if (msg.includes('403') || msg.includes('API_KEY') || msg.includes('invalid')) {
        throw new Error('Invalid Gemini API key. Go to Settings and paste a fresh key from aistudio.google.com.');
      }
      if (msg.includes('404') || msg.includes('not found')) {
        console.log(`  Model ${modelName} not available, trying next...`);
        continue; // try next model
      }
      throw e;
    }
  }
  throw new Error(
    'No compatible Gemini model found for your API key. ' +
    'Go to Settings → click "Check Available Models" to see what your key supports.'
  );
}

// ─── CV Tailoring Prompt ─────────────────────────────────────────────────────

function buildPrompt(cvContent, company, role, jobDescription) {
  return `You are an expert ATS resume writer with deep knowledge of applicant tracking systems.

CANDIDATE'S BASE CV:
${cvContent}

JOB APPLICATION:
Company: ${company}
Role: ${role}

JOB DESCRIPTION:
${jobDescription}

YOUR TASK: Create a fully tailored, ATS-optimised CV for this specific role. Output ONLY clean Markdown — no code fences, no preamble, no explanations.

Required structure:
# [Full Name]
[email] | [phone] | [location] | [LinkedIn if present]

## Professional Summary
[3–4 sentences targeting this exact role at ${company}. Mirror language from the JD.]

## Core Competencies
[10–12 keywords drawn directly from the job description, comma-separated]

## Professional Experience
### [Job Title] — [Company] | [Dates]
- [Most relevant achievement first, quantified if possible]
- [Achievement that maps to a requirement in this JD]

## Education
### [Degree] — [Institution] | [Year]

## Skills & Tools
[Comma-separated list, prioritise tools mentioned in the JD]

RULES:
- Mirror keywords and phrases from the JD naturally throughout
- Rewrite the summary to directly address this company and role
- Reorder bullets so the most JD-relevant achievements come first
- NEVER invent experience, credentials, or metrics not in the base CV
- Keep to 1–2 pages when printed
- Output Markdown only — nothing else`;
}

// ─── Cover Letter Prompt ─────────────────────────────────────────────────────

function buildCoverLetterPrompt(cvContent, company, role, jobDescription) {
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return `You are an expert career coach writing a compelling cover letter.

CANDIDATE'S CV:
${cvContent}

JOB APPLICATION:
Company: ${company}
Role: ${role}

JOB DESCRIPTION:
${jobDescription}

Write a professional, personalised cover letter for this specific role. Output ONLY clean Markdown.

Structure:
[Candidate Name]
[email] | [phone] | [location]
${today}

Hiring Manager
${company}

Dear Hiring Manager,

## Opening paragraph
[Hook: why THIS company and THIS role excites the candidate. Reference something specific from the JD — a product, mission, or challenge. 2–3 sentences.]

## Body paragraph 1 — Relevant Experience
[Pick the 1–2 strongest experiences from the CV that directly match the top requirements in the JD. Quantify. Mirror JD keywords naturally. 3–4 sentences.]

## Body paragraph 2 — Skills & Value Add
[Highlight 2–3 skills from the JD that the candidate has. Show HOW they'll apply them at ${company}. 3–4 sentences.]

## Closing paragraph
[Express enthusiasm, request interview, professional sign-off. 2–3 sentences.]

Sincerely,
[Candidate Name]

RULES:
- Address this specific company and role — not generic
- Mirror 4–6 keywords from the JD naturally (not stuffed)
- Keep to exactly ONE A4 page when printed
- NEVER invent experience not in the CV
- Output Markdown only`;
}

// ─── PDF Generation via Playwright (msedge on Windows, Chromium on Linux) ───────

async function generatePDF(htmlContent, outputPath) {
  let browser;
  try {
    const { chromium } = await import('playwright');
    // On Windows use the already-installed system Edge (no download needed).
    // On Linux (Render) use Playwright's downloaded Chromium.
    const launchOpts = process.platform === 'win32'
      ? { channel: 'msedge', headless: true }
      : { headless: true };
    browser = await chromium.launch(launchOpts);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(htmlContent, { waitUntil: 'load' });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      displayHeaderFooter: false,
      printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '14mm', right: '14mm' },
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  // Verify the file was actually written and is not empty
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 5000) {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    throw new Error('PDF generation failed — file was empty or not created.');
  }
}

// ─── Markdown → DOCX ─────────────────────────────────────────────────────────

async function markdownToDOCX(md, outputPath) {
  const children = [];

  function parseRuns(text) {
    // Handle **bold** inline
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map(p => {
      if (p.startsWith('**') && p.endsWith('**')) {
        return new TextRun({ text: p.slice(2, -2), bold: true });
      }
      return new TextRun({ text: p });
    });
  }

  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();

    if (line.startsWith('# ')) {
      children.push(new Paragraph({
        children: [new TextRun({ text: line.slice(2), bold: true, size: 36, color: '1a3a6b' })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 80 }
      }));
    } else if (line.startsWith('## ')) {
      children.push(new Paragraph({
        children: [new TextRun({ text: line.slice(3).toUpperCase(), bold: true, size: 22, color: '1a56db' })],
        spacing: { before: 240, after: 60 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '1a56db', space: 4 } }
      }));
    } else if (line.startsWith('### ')) {
      children.push(new Paragraph({
        children: [new TextRun({ text: line.slice(4), bold: true, size: 21 })],
        spacing: { before: 140, after: 40 }
      }));
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      children.push(new Paragraph({
        children: parseRuns(line.slice(2)),
        bullet: { level: 0 },
        spacing: { after: 40 }
      }));
    } else if (line.trim() === '' || line.startsWith('---')) {
      children.push(new Paragraph({ text: '', spacing: { after: 60 } }));
    } else if (line.trim()) {
      children.push(new Paragraph({
        children: parseRuns(line),
        spacing: { after: 60 }
      }));
    }
    i++;
  }

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: { top: 1080, bottom: 1080, left: 1224, right: 1224 } // ~19mm / 21.6mm
        }
      },
      children
    }],
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 21 } } // 10.5pt default
      }
    }
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

// ─── Markdown → Print-ready HTML (CV) ────────────────────────────────────────

function markdownToHTML(md, company, role) {
  const lines = md.split('\n');
  let html = '';
  let inList = false;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.startsWith('# ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h1>${esc(line.slice(2))}</h1>`;
    } else if (line.startsWith('## ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h2>${esc(line.slice(3).toUpperCase())}</h2>`;
    } else if (line.startsWith('### ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h3>${inlineFormat(line.slice(4))}</h3>`;
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineFormat(line.slice(2))}</li>`;
    } else if (line.trim() === '' || line.startsWith('---')) {
      if (inList) { html += '</ul>'; inList = false; }
      if (line.trim() === '') html += '';
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p>${inlineFormat(line)}</p>`;
    }
  }
  if (inList) html += '</ul>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CV — ${esc(role)} at ${esc(company)}</title>
<style>
  /* ATS-safe, print-ready */
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Calibri, Arial, sans-serif; font-size: 10.5pt; color: #111; background: #fff; line-height: 1.45; }
  h1 { font-size: 20pt; font-weight: 700; color: #1a3a6b; text-align: center; margin-bottom: 4px; }
  p:first-of-type { text-align: center; color: #444; font-size: 9pt; margin-bottom: 14px; }
  h2 { font-size: 10.5pt; font-weight: 700; color: #1a56db; text-transform: uppercase;
       letter-spacing: 0.08em; border-bottom: 1.5px solid #1a56db; margin-top: 14px;
       margin-bottom: 5px; padding-bottom: 2px; }
  h3 { font-size: 10.5pt; font-weight: 700; margin-top: 8px; margin-bottom: 2px; }
  ul { margin-left: 18px; margin-bottom: 4px; }
  li { margin-bottom: 2px; font-size: 10pt; }
  p { font-size: 10pt; margin-bottom: 4px; }
  strong { font-weight: 700; }
  @page { size: A4; margin: 18mm 14mm; }
  @media print { body { -webkit-print-color-adjust: exact; } }
</style>
</head>
<body>
${html}
</body>
</html>`;
}

// ─── Markdown → Print-ready HTML (Cover Letter) ───────────────────────────────

function coverLetterToHTML(md, company, role) {
  const lines = md.split('\n');
  let html = '';
  let firstH1Done = false;
  let firstPDone = false;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.startsWith('# ')) {
      // Candidate name
      html += `<div class="candidate-name">${esc(line.slice(2))}</div>`;
      firstH1Done = true;
    } else if (line.startsWith('## ')) {
      // Section headers — render as plain paragraph spacing
      html += `<div class="section-spacer"></div>`;
    } else if (line.trim() === '' || line.startsWith('---')) {
      html += `<div class="spacer"></div>`;
    } else if (!firstH1Done) {
      html += `<p>${inlineFormat(line)}</p>`;
    } else if (!firstPDone && line.trim() && !line.startsWith('#')) {
      // Contact line (first non-header, non-blank line after name)
      html += `<div class="contact-line">${inlineFormat(line)}</div>`;
      firstPDone = true;
    } else if (line.startsWith('Dear ') || line.startsWith('Sincerely')) {
      html += `<p class="salutation">${inlineFormat(line)}</p>`;
    } else if (line.trim()) {
      html += `<p>${inlineFormat(line)}</p>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Cover Letter — ${esc(role)} at ${esc(company)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #111; background: #fff; line-height: 1.6; }
  .candidate-name { font-size: 16pt; font-weight: 700; color: #1a3a6b; margin-bottom: 4px; }
  .contact-line { font-size: 9pt; color: #666; margin-bottom: 16px; }
  .section-spacer { height: 2px; }
  .spacer { height: 10px; }
  p { font-size: 11pt; margin-bottom: 12px; }
  .salutation { font-weight: 700; margin-bottom: 12px; }
  strong { font-weight: 700; }
  @page { size: A4; margin: 18mm 14mm; }
  @media print { body { -webkit-print-color-adjust: exact; } }
</style>
</head>
<body>
${html}
</body>
</html>`;
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function inlineFormat(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

// ─── Multipart Parser (single-file, no deps) ──────────────────────────────────

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buffer, boundary) {
  const sep = Buffer.from('--' + boundary);
  const parts = [];
  let start = 0;

  while (start < buffer.length) {
    const sepIdx = buffer.indexOf(sep, start);
    if (sepIdx === -1) break;
    const afterSep = sepIdx + sep.length;
    if (buffer[afterSep] === 0x2d && buffer[afterSep + 1] === 0x2d) break; // '--'

    // skip CRLF after boundary
    const headerStart = buffer[afterSep] === 0x0d ? afterSep + 2 : afterSep + 1;
    const headerEnd   = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd === -1) { start = afterSep; continue; }

    const headerStr = buffer.slice(headerStart, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4; // skip \r\n\r\n
    const nextSep   = buffer.indexOf(sep, dataStart);
    const dataEnd   = nextSep === -1 ? buffer.length : nextSep - 2; // strip trailing \r\n

    const nameMatch     = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    parts.push({
      name:     nameMatch     ? nameMatch[1]     : '',
      filename: filenameMatch ? filenameMatch[1] : null,
      data:     buffer.slice(dataStart, dataEnd)
    });
    start = nextSep === -1 ? buffer.length : nextSep;
  }
  return parts;
}

// ─── Pipeline Parser ──────────────────────────────────────────────────────────

function parsePipeline() {
  try {
    const rows = [];
    for (const line of fs.readFileSync(TRACKER, 'utf8').split('\n')) {
      if (!line.startsWith('|')) continue;
      const cells = line.split('|').slice(1,-1).map(c => c.trim());
      if (!cells[0] || cells[0] === '#' || /^-+$/.test(cells[0])) continue;
      rows.push({ num: cells[0], date: cells[1], company: cells[2], role: cells[3],
                  score: cells[4], status: cells[5], notes: cells[8] || '' });
    }
    return rows;
  } catch { return []; }
}

function trackApplication(company, role, score, notes) {
  let content = '';
  let nextNum = 1;

  // Ensure tracker exists
  if (!fs.existsSync(TRACKER)) {
    content = `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n`;
  } else {
    content = fs.readFileSync(TRACKER, 'utf8');
    const nums = [...content.matchAll(/^\|\s*(\d+)\s*\|/gm)].map(m => parseInt(m[1]));
    if (nums.length) nextNum = Math.max(...nums) + 1;
  }

  const date = new Date().toISOString().slice(0, 10);
  const row = `| ${String(nextNum).padStart(3,'0')} | ${date} | ${company} | ${role} | ${score}/5 | Evaluated | ❌ | — | ${notes} |`;
  content = content.trimEnd() + '\n' + row + '\n';
  fs.writeFileSync(TRACKER, content, 'utf8');
  return nextNum;
}

// ─── HTML UI ──────────────────────────────────────────────────────────────────

function getUI(hasCV, hasKey) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${APP_NAME} — CV Generator</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
  .header{background:#1e293b;border-bottom:1px solid #334155;padding:15px 28px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
  .logo{font-size:1.25rem;font-weight:800;color:#f8fafc;letter-spacing:-0.02em}
  .logo span{color:#6366f1}
  .tabs{display:flex;gap:4px;margin-left:auto}
  .tab{padding:8px 18px;border-radius:8px;cursor:pointer;font-size:0.875rem;color:#94a3b8;border:none;background:transparent;transition:all .15s}
  .tab:hover{background:#334155;color:#e2e8f0}
  .tab.active{background:#6366f1;color:#fff;font-weight:600}
  .main{padding:28px;max-width:1100px;margin:0 auto}
  .page{display:none}.page.active{display:block}
  .alert{padding:12px 16px;border-radius:8px;font-size:.875rem;margin-bottom:18px;border:1px solid}
  .alert-warn{background:#451a03;border-color:#92400e;color:#fbbf24}
  .alert-ok{background:#064e3b;border-color:#065f46;color:#6ee7b7}
  .alert-err{background:#450a0a;border-color:#991b1b;color:#fca5a5}
  .card{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:24px;margin-bottom:20px}
  .card h2{font-size:1.05rem;font-weight:700;color:#f1f5f9;margin-bottom:4px}
  .card p.sub{font-size:.8rem;color:#64748b;margin-bottom:16px}
  label{display:block;font-size:.78rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
  input[type=text],textarea,select{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:11px 14px;color:#e2e8f0;font-size:.9rem;outline:none;width:100%;font-family:inherit}
  input[type=text]:focus,textarea:focus{border-color:#6366f1}
  textarea{resize:vertical;line-height:1.55}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
  .field{margin-bottom:14px}
  .btn{padding:10px 22px;border-radius:8px;font-size:.9rem;font-weight:600;cursor:pointer;border:none;transition:all .15s;display:inline-flex;align-items:center;gap:6px}
  .btn-primary{background:#6366f1;color:#fff}.btn-primary:hover{background:#4f46e5}
  .btn-primary:disabled{background:#334155;color:#64748b;cursor:not-allowed}
  .btn-secondary{background:#334155;color:#e2e8f0}.btn-secondary:hover{background:#475569}
  .btn-success{background:#059669;color:#fff}.btn-success:hover{background:#047857}
  .btn-sm{padding:7px 14px;font-size:.8rem}

  /* Progress */
  .steps{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
  .step{padding:5px 14px;border-radius:20px;font-size:.78rem;background:#0f172a;color:#64748b;border:1px solid #1e293b}
  .step.active{color:#6366f1;border-color:#6366f1}
  .step.done{color:#10b981;border-color:#10b981}
  .step.hidden{display:none}
  .spinner{width:36px;height:36px;border:3px solid #334155;border-top-color:#6366f1;border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .loading{display:none;flex-direction:column;align-items:center;gap:12px;padding:32px}
  .loading.show{display:flex}

  /* Result */
  .result{display:none}.result.show{display:block}
  .cv-preview{background:#0f172a;border:1px solid #334155;border-radius:10px;padding:20px;font-family:Consolas,monospace;font-size:.82rem;line-height:1.65;color:#cbd5e1;white-space:pre-wrap;min-height:700px;max-height:1400px;overflow-y:auto;margin-bottom:14px;resize:vertical}
  textarea.cv-preview{font-family:'Consolas','Monaco',monospace;resize:vertical;width:100%;box-sizing:border-box}
  .download-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px}
  .section-divider{border:none;border-top:1px solid #334155;margin:18px 0}
  .section-label{font-size:.78rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px}
  .cl-result{display:none}.cl-result.show{display:block;margin-top:16px}

  /* Track form */
  .track-form{background:#0f172a;border:1px solid #334155;border-radius:10px;padding:18px;margin-top:14px;display:none}
  .track-form.show{display:block}
  .track-row{display:grid;grid-template-columns:80px 1fr auto;gap:10px;align-items:end}

  /* Pipeline table */
  .table-wrap{background:#1e293b;border:1px solid #334155;border-radius:12px;overflow:hidden}
  table{width:100%;border-collapse:collapse}
  th{padding:10px 14px;text-align:left;font-size:.72rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em;background:#0f172a}
  td{padding:12px 14px;font-size:.875rem;vertical-align:middle;border-top:1px solid #1e293b}
  tr:hover td{background:#0f172a30}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:.73rem;font-weight:600;color:#fff}
  .empty{text-align:center;padding:60px 20px;color:#64748b}
  .empty h3{color:#94a3b8;font-size:1.05rem;margin-bottom:8px}
  .source-check{display:flex;align-items:center;gap:7px;font-size:.875rem;color:#94a3b8;cursor:pointer}
  .source-check input{width:15px;height:15px;cursor:pointer;accent-color:#6366f1}

  /* Upload area */
  .upload-zone{border:2px dashed #334155;border-radius:10px;padding:18px 14px;margin-bottom:10px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .upload-zone input[type=file]{display:none}
  .upload-status{font-size:.83rem;color:#64748b;margin-top:6px;min-height:1.4em}
  .upload-divider{text-align:center;color:#475569;font-size:.8rem;margin:10px 0;letter-spacing:.05em}
</style>
</head>
<body>

<div class="header">
  <div class="logo">Career <span>AI</span></div>
  <div class="tabs">
    <button class="tab active" onclick="showTab('generate',this)">Generate CV</button>
    <button class="tab" onclick="showTab('pipeline',this)">My Pipeline</button>
    <button class="tab" onclick="showTab('settings',this)">Settings</button>
  </div>
</div>

<div class="main">

  <!-- ── GENERATE CV ── -->
  <div class="page active" id="page-generate">
    ${!hasKey ? `<div class="alert alert-warn">&#9888; No Gemini API key set. Go to <strong>Settings</strong> to add it. Get a free key at <strong>aistudio.google.com</strong></div>` : ''}
    ${!hasCV  ? `<div class="alert alert-warn">&#9888; No CV found. Go to <strong>Settings</strong> to paste your base CV.</div>` : ''}

    <div class="card">
      <h2>Generate ATS-Optimised CV</h2>
      <p class="sub">Paste a job description — Gemini AI will tailor your CV to match the role.</p>

      <div class="row">
        <div class="field">
          <label>Company Name</label>
          <input type="text" id="company" placeholder="e.g. Google">
        </div>
        <div class="field">
          <label>Job Title / Role</label>
          <input type="text" id="role" placeholder="e.g. Digital Marketing Manager">
        </div>
      </div>

      <div class="field">
        <label>Paste Job Description Here</label>
        <textarea id="jd" rows="14" placeholder="Paste the full job posting text here — the more detail the better.&#10;&#10;Include: responsibilities, requirements, skills, and any keywords from the listing."></textarea>
      </div>

      <div class="field" style="margin-bottom:16px">
        <label>Cover Letter</label>
        <div style="margin-top:4px">
          <label class="source-check">
            <input type="checkbox" id="wantCoverLetter" onchange="toggleCLOptions()">
            Also generate a Cover Letter
          </label>
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <button class="btn btn-primary" id="generateBtn" onclick="generate()">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          Generate ATS CV
        </button>
      </div>
    </div>

    <!-- Progress -->
    <div class="card" id="progressCard" style="display:none">
      <div class="steps" id="steps">
        <div class="step active" id="s1">1. Reading job description</div>
        <div class="step" id="s2">2. AI tailoring your CV</div>
        <div class="step hidden" id="s3">3. Generating cover letter</div>
        <div class="step" id="s4">3. Done</div>
      </div>
      <div class="loading show" id="loadingSpinner">
        <div class="spinner"></div>
        <div id="loadingText" style="font-size:.9rem;color:#94a3b8">Sending to Gemini AI...</div>
      </div>
    </div>

    <!-- Result -->
    <div class="card result" id="resultCard">
      <div class="alert alert-ok" id="successMsg"></div>
      <label>Tailored CV — edit before downloading</label>
      <textarea class="cv-preview" id="cvPreview" spellcheck="false" placeholder="Your tailored CV will appear here..."></textarea>
      <div class="download-bar" id="cvExportBar" style="display:none">
        <button class="btn btn-success btn-sm" onclick="exportFile('cv','pdf')">⬇ Download PDF</button>
        <button class="btn btn-secondary btn-sm" onclick="exportFile('cv','docx')">⬇ Download Word</button>
        <span id="cvExportStatus" style="font-size:.78rem;color:#94a3b8;margin-left:8px"></span>
        <button id="cvFolderBtn" onclick="showDownloadHelp()" style="display:none;background:none;border:none;cursor:pointer;font-size:.78rem;color:#6366f1;margin-left:10px;padding:0;text-decoration:underline;">📂 Where is my file?</button>
      </div>

      <!-- Cover Letter result (shown if generated) -->
      <div class="cl-result" id="clResult">
        <hr class="section-divider">
        <div class="section-label">Cover Letter</div>
        <label>Cover Letter — edit before downloading</label>
        <textarea class="cv-preview" id="clPreview" spellcheck="false" placeholder="Your cover letter will appear here..."></textarea>
        <div class="download-bar" id="clExportBar" style="display:none">
          <button class="btn btn-success btn-sm" onclick="exportFile('cl','pdf')">⬇ Download PDF</button>
          <button class="btn btn-secondary btn-sm" onclick="exportFile('cl','docx')">⬇ Download Word</button>
          <span id="clExportStatus" style="font-size:.78rem;color:#94a3b8;margin-left:8px"></span>
          <button id="clFolderBtn" onclick="showDownloadHelp()" style="display:none;background:none;border:none;cursor:pointer;font-size:.78rem;color:#6366f1;margin-left:10px;padding:0;text-decoration:underline;">📂 Where is my file?</button>
        </div>
      </div>

      <!-- Track application -->
      <button class="btn btn-secondary btn-sm" style="margin-top:14px" onclick="toggleTrack()">+ Track this application</button>
      <div class="track-form" id="trackForm">
        <div class="track-row">
          <div>
            <label>Score /5</label>
            <select id="trackScore">
              <option>5.0</option><option>4.5</option><option selected>4.0</option>
              <option>3.5</option><option>3.0</option><option>2.5</option><option>2.0</option>
            </select>
          </div>
          <div>
            <label>Notes</label>
            <input type="text" id="trackNotes" placeholder="e.g. Great culture fit, hybrid role">
          </div>
          <div>
            <button class="btn btn-primary btn-sm" onclick="trackApp()">Save to Pipeline</button>
          </div>
        </div>
        <div id="trackMsg" style="margin-top:8px;font-size:.82rem;color:#6ee7b7"></div>
      </div>
    </div>

    <div class="alert alert-err" id="errorMsg" style="display:none"></div>
  </div>

  <!-- ── PIPELINE ── -->
  <div class="page" id="page-pipeline">
    <div id="pipelineContent"><div class="empty"><h3>Loading...</h3></div></div>
  </div>

  <!-- ── SETTINGS ── -->
  <div class="page" id="page-settings">
    <div class="card">
      <h2>Gemini API Key</h2>
      <p class="sub">Get a free key at <strong>aistudio.google.com</strong> &#8594; Get API Key. Or set the <code>GEMINI_API_KEY</code> environment variable.</p>
      <div class="field">
        <label>API Key</label>
        <input type="text" id="apiKey" placeholder="AIza..." autocomplete="off">
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-primary" onclick="saveKey()">Save Key</button>
        <button class="btn btn-secondary" onclick="checkModels()">Check Available Models</button>
      </div>
      <div id="keyMsg" style="margin-top:10px;font-size:.85rem"></div>
      <div id="modelList" style="margin-top:12px;display:none">
        <div style="font-size:.78rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Models available for your key:</div>
        <div id="modelListItems" style="display:flex;flex-wrap:wrap;gap:6px"></div>
      </div>
    </div>

    <div class="card">
      <h2>Your Base CV</h2>
      <p class="sub">This is the master CV Gemini uses to create tailored versions. Keep it comprehensive — include all experience, skills, and achievements.</p>

      <div class="upload-zone">
        <input type="file" id="cvFileInput" accept=".pdf,.docx,.txt,.md" onchange="uploadCVFile(this)">
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('cvFileInput').click()">
          &#8593; Upload File
        </button>
        <span style="font-size:.82rem;color:#64748b">Accepts .pdf, .docx, .txt, .md</span>
      </div>
      <div class="upload-status" id="uploadStatus"></div>

      <div class="upload-divider">&#8212; OR &#8212;</div>

      <div class="field">
        <label>Base CV (Markdown or plain text)</label>
        <textarea id="cvInput" rows="18" placeholder="# Your Name&#10;email@example.com | Phone | Location&#10;&#10;## Professional Summary&#10;..."></textarea>
      </div>
      <div style="display:flex;align-items:center;gap:14px">
        <button class="btn btn-primary" onclick="saveCV()">Save CV</button>
        <span id="cvMsg" style="font-size:.85rem;color:#64748b"></span>
      </div>
    </div>
  </div>
</div>

<script>
// Server-injected config
const OUTPUT_PATH = ${JSON.stringify(OUTPUT_DIR)};
const APP_NAME    = ${JSON.stringify(APP_NAME)};

// State
let currentCompany = '', currentRole = '';

// ── Tabs ──────────────────────────────────────────────────────────────────────
function showTab(tab, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('page-' + tab).classList.add('active');
  if (tab === 'pipeline') loadPipeline();
  if (tab === 'settings') loadSettings();
}

// ── Cover Letter toggle ───────────────────────────────────────────────────────
function toggleCLOptions() {
  const want = document.getElementById('wantCoverLetter').checked;
  document.getElementById('s3').classList.toggle('hidden', !want);
  document.getElementById('s4').textContent = want ? '4. Done' : '3. Done';
}

// ── Generate ──────────────────────────────────────────────────────────────────
async function generate() {
  const company = document.getElementById('company').value.trim();
  const role    = document.getElementById('role').value.trim();
  const jd      = document.getElementById('jd').value.trim();
  const wantCL  = document.getElementById('wantCoverLetter').checked;
  if (!company) return alert('Please enter the company name.');
  if (!role)    return alert('Please enter the job title / role.');
  if (!jd)      return alert('Please paste the job description.');

  currentCompany = company; currentRole = role;
  document.getElementById('generateBtn').disabled = true;
  document.getElementById('progressCard').style.display = 'block';
  document.getElementById('resultCard').classList.remove('show');
  document.getElementById('clResult').classList.remove('show');
  document.getElementById('cvExportBar').style.display = 'none';
  document.getElementById('clExportBar').style.display = 'none';
  document.getElementById('errorMsg').style.display = 'none';
  setStep(1);

  try {
    setStep(2, APP_NAME + ' is tailoring your CV...');
    const res = await fetch('/api/generate-cv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company, role, jobDescription: jd, coverLetter: wantCL })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed');

    if (wantCL) {
      setStep(3, 'Generating cover letter...');
      await new Promise(r => setTimeout(r, 200));
    }

    setStep(4, 'Done!', true);

    document.getElementById('successMsg').textContent =
      '&#10003; CV tailored for ' + role + ' at ' + company;
    document.getElementById('cvPreview').value = data.markdown || '';
    document.getElementById('cvExportBar').style.display = 'flex';

    // Cover Letter result
    if (wantCL) {
      if (data.clError) {
        document.getElementById('clPreview').value = 'Cover letter generation failed: ' + data.clError;
        document.getElementById('clResult').classList.add('show');
      } else if (data.clMarkdown) {
        document.getElementById('clPreview').value = data.clMarkdown;
        document.getElementById('clExportBar').style.display = 'flex';
        document.getElementById('clResult').classList.add('show');
      }
    }

    document.getElementById('resultCard').classList.add('show');
    document.getElementById('progressCard').style.display = 'none';
    document.getElementById('resultCard').scrollIntoView({ behavior: 'smooth' });

  } catch (e) {
    document.getElementById('progressCard').style.display = 'none';
    document.getElementById('errorMsg').textContent = 'Error: ' + e.message;
    document.getElementById('errorMsg').style.display = 'block';
  } finally {
    document.getElementById('generateBtn').disabled = false;
  }
}

// ── Export File ───────────────────────────────────────────────────────────────
async function exportFile(type, format) {
  const isCV = type === 'cv';
  const content = document.getElementById(isCV ? 'cvPreview' : 'clPreview').value.trim();
  if (!content) return alert('Nothing to export — generate first.');
  const statusEl   = document.getElementById(isCV ? 'cvExportStatus' : 'clExportStatus');
  const folderBtn  = document.getElementById(isCV ? 'cvFolderBtn'    : 'clFolderBtn');
  folderBtn.style.display = 'none';
  statusEl.textContent = 'Generating ' + format.toUpperCase() + '...';
  statusEl.style.color = '#94a3b8';
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, format, content, company: currentCompany, role: currentRole })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Export failed');
    // Trigger browser download — file goes to the user's Downloads folder
    const a = document.createElement('a');
    a.href = '/download/' + encodeURIComponent(data.filename);
    a.download = data.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    statusEl.style.color = '#10b981';
    statusEl.textContent = '✓ Downloaded: ' + data.filename;
    folderBtn.style.display = 'inline';
  } catch(e) {
    statusEl.style.color = '#ef4444';
    statusEl.textContent = 'Failed: ' + e.message;
  }
}

// ── Where is my file? ─────────────────────────────────────────────────────────
function showDownloadHelp() {
  const ua = navigator.userAgent;
  let location = '';
  if (/iPhone|iPad/.test(ua)) {
    location = '📱 iPhone/iPad:\nFiles app → Browse → On My iPhone → Downloads';
  } else if (/Android/.test(ua)) {
    location = '📱 Android:\nFiles app → Downloads\n(or open your browser menu → Downloads)';
  } else if (/Mac/.test(ua)) {
    location = '💻 Mac:\nFinder → Downloads folder\n(or press Cmd+Option+L in Finder)';
  } else {
    location = '💻 Windows:\nFile Explorer → This PC → Downloads\n(or press Win + E, then click Downloads on the left)';
  }
  alert('📂 Your file has been saved to your Downloads folder.\n\n' + location + '\n\nLook for the filename shown next to the Download button.');
}

function setStep(n, text, done) {
  // Steps: 1=read, 2=AI, 3=CL (optional), 4=done
  const order = [1, 2, 3, 4];
  const pos = order.indexOf(n);
  for (let idx = 0; idx < order.length; idx++) {
    const sNum = order[idx];
    const el = document.getElementById('s' + sNum);
    if (!el || el.classList.contains('hidden')) continue;
    el.className = 'step' + (idx < pos ? ' done' : idx === pos ? (done ? ' done' : ' active') : '');
  }
  if (text) document.getElementById('loadingText').textContent = text;
  if (done) document.getElementById('loadingSpinner').classList.remove('show');
}

// ── Track ─────────────────────────────────────────────────────────────────────
function toggleTrack() {
  const f = document.getElementById('trackForm');
  f.classList.toggle('show');
}
async function trackApp() {
  const score = document.getElementById('trackScore').value;
  const notes = document.getElementById('trackNotes').value.trim() || '&#8212;';
  try {
    const res = await fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company: currentCompany, role: currentRole, score, notes })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById('trackMsg').textContent = '&#10003; Saved as #' + data.num + ' in your pipeline.';
  } catch (e) {
    document.getElementById('trackMsg').textContent = 'Error: ' + e.message;
    document.getElementById('trackMsg').style.color = '#fca5a5';
  }
}

// ── Pipeline ──────────────────────────────────────────────────────────────────
async function loadPipeline() {
  const c = document.getElementById('pipelineContent');
  try {
    const res  = await fetch('/api/pipeline');
    const data = await res.json();
    const apps = data.apps || [];
    if (!apps.length) {
      c.innerHTML = '<div class="empty"><h3>No applications yet</h3><p>Generate a CV and track it to see it here.</p></div>';
      return;
    }
    c.innerHTML = '<div class="table-wrap"><table><thead><tr>' +
      '<th>#</th><th>Date</th><th>Company</th><th>Role</th><th>Score</th><th>Status</th><th>Notes</th>' +
      '</tr></thead><tbody>' + apps.map(a => '<tr>' +
        '<td style="color:#64748b">' + e(a.num) + '</td>' +
        '<td style="color:#64748b;font-size:.8rem">' + e(a.date) + '</td>' +
        '<td><strong>' + e(a.company) + '</strong></td>' +
        '<td>' + e(a.role) + '</td>' +
        '<td><span class="badge" style="background:' + scoreCol(a.score) + '">' + e(a.score) + '</span></td>' +
        '<td><span class="badge" style="background:' + statusCol(a.status) + '">' + e(a.status) + '</span></td>' +
        '<td style="color:#94a3b8;font-size:.8rem">' + e(a.notes) + '</td>' +
        '</tr>').join('') + '</tbody></table></div>';
  } catch(err) {
    c.innerHTML = '<div class="empty"><h3>Could not load pipeline</h3><p>' + err.message + '</p></div>';
  }
}

function scoreCol(s)  { const n=parseFloat(s); return isNaN(n)?'#6b7280':n>=4?'#059669':n>=3?'#d97706':'#dc2626'; }
function statusCol(s) { return({Evaluated:'#6366f1',Applied:'#3b82f6',Interview:'#f59e0b',Offer:'#10b981',Rejected:'#ef4444',Discarded:'#6b7280',SKIP:'#9ca3af'}[s]||'#6b7280'); }
function e(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const res  = await fetch('/api/config');
    const data = await res.json();
    if (data.apiKey) document.getElementById('apiKey').value = data.apiKey;
    if (data.cv)     document.getElementById('cvInput').value = data.cv;
  } catch {}
}
async function checkModels() {
  const msg = document.getElementById('keyMsg');
  const listDiv = document.getElementById('modelList');
  const itemsDiv = document.getElementById('modelListItems');
  msg.innerHTML = '<span style="color:#94a3b8">Fetching available models...</span>';
  listDiv.style.display = 'none';
  try {
    const res = await fetch('/api/list-models');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (!data.models.length) {
      msg.innerHTML = '<span style="color:#fca5a5">No generateContent models found for this key.</span>';
      return;
    }
    msg.innerHTML = '';
    itemsDiv.innerHTML = data.models.map(m => {
      const isFlash = m.includes('flash');
      const isPro = m.includes('pro');
      const color = isFlash ? '#059669' : isPro ? '#6366f1' : '#334155';
      return \`<span style="background:\${color};color:#fff;padding:3px 10px;border-radius:12px;font-size:.78rem;font-family:monospace">\${e(m)}</span>\`;
    }).join('');
    listDiv.style.display = 'block';
  } catch(err) {
    msg.innerHTML = '<span style="color:#fca5a5">Error: ' + e(err.message) + '</span>';
  }
}

async function saveKey() {
  const key = document.getElementById('apiKey').value.trim();
  if (!key) return alert('Please enter your API key.');
  try {
    const res  = await fetch('/api/save-key', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({key}) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById('keyMsg').innerHTML = '<span style="color:#6ee7b7">&#10003; ' + data.message + '</span>';
    setTimeout(() => location.reload(), 1200);
  } catch(err) {
    document.getElementById('keyMsg').innerHTML = '<span style="color:#fca5a5">Error: ' + err.message + '</span>';
  }
}
async function saveCV() {
  const cv = document.getElementById('cvInput').value.trim();
  if (!cv) return alert('Please paste your CV first.');
  try {
    const res  = await fetch('/api/save-cv', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({cv}) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById('cvMsg').textContent = '&#10003; Saved.';
    setTimeout(() => { document.getElementById('cvMsg').textContent=''; location.reload(); }, 1500);
  } catch(err) {
    document.getElementById('cvMsg').textContent = 'Error: ' + err.message;
  }
}

// ── CV File Upload ────────────────────────────────────────────────────────────
async function uploadCVFile(input) {
  const file = input.files[0];
  if (!file) return;
  const status = document.getElementById('uploadStatus');
  status.innerHTML = '<span style="color:#94a3b8">Uploading ' + e(file.name) + '...</span>';
  try {
    const formData = new FormData();
    formData.append('cvFile', file, file.name);
    const res = await fetch('/api/upload-cv', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    status.innerHTML = '<span style="color:#6ee7b7">&#10003; CV extracted from ' + e(file.name) + ' and saved.</span>';
    if (data.preview) {
      document.getElementById('cvInput').value = data.preview;
    }
    setTimeout(() => location.reload(), 1800);
  } catch(err) {
    status.innerHTML = '<span style="color:#fca5a5">Error: ' + err.message + '</span>';
  }
  // Reset so same file can be re-uploaded
  input.value = '';
}


// ── Init ──────────────────────────────────────────────────────────────────────
</script>

<footer style="text-align:center;padding:28px 20px 20px;margin-top:40px;border-top:1px solid #1e293b;font-size:.8rem;color:#475569;">
  Career AI — Made by
  <a href="https://www.linkedin.com/in/digitalmazharai/" target="_blank" rel="noopener"
     style="color:#6366f1;text-decoration:none;font-weight:600;">
    Mazhar Hussain
  </a>
  &nbsp;·&nbsp;
  <a href="https://www.linkedin.com/in/digitalmazharai/" target="_blank" rel="noopener"
     style="color:#6366f1;text-decoration:none;">
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle;margin-right:3px;">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
    </svg>
    LinkedIn
  </a>
</footer>

</body>
</html>`;
}

// ─── HTTP Server ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((res, rej) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { res(JSON.parse(b)); } catch { res({}); } });
    req.on('error', rej);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // ── GET / ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getUI(!!readCV(), !!loadApiKey()));

  // ── POST /api/generate-cv ──────────────────────────────────────────────────
  } else if (req.method === 'POST' && url === '/api/generate-cv') {
    const { company, role, jobDescription, coverLetter } = await readBody(req);
    const apiKey    = loadApiKey();
    const cvContent = readCV();
    if (!apiKey)    return json(res, { error: 'No Gemini API key set. Go to Settings.' }, 400);
    if (!cvContent) return json(res, { error: 'No CV found. Go to Settings and paste your CV.' }, 400);
    if (!company || !role || !jobDescription)
      return json(res, { error: 'Company, role, and job description are all required.' }, 400);

    try {
      const prompt   = buildPrompt(cvContent, company, role, jobDescription);
      const markdown = await callGemini(apiKey, prompt);
      let clMarkdown = null, clError = null;
      if (coverLetter) {
        try {
          const clPrompt = buildCoverLetterPrompt(cvContent, company, role, jobDescription);
          clMarkdown = await callGemini(apiKey, clPrompt);
        } catch(e) {
          clError = e.message;
        }
      }
      json(res, { markdown, clMarkdown, clError });
    } catch (e) {
      console.error(e);
      json(res, { error: e.message }, 500);
    }


  // ── POST /api/upload-cv ────────────────────────────────────────────────────
  } else if (req.method === 'POST' && url === '/api/upload-cv') {
    try {
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)$/);
      if (!boundaryMatch) return json(res, { error: 'Invalid multipart request — no boundary found.' }, 400);
      const boundary = boundaryMatch[1].trim();

      const buffer = await readRawBody(req);
      const parts  = parseMultipart(buffer, boundary);
      const filePart = parts.find(p => p.name === 'cvFile' && p.filename);
      if (!filePart) return json(res, { error: 'No file found in upload (field name must be "cvFile").' }, 400);

      const ext = path.extname(filePart.filename).toLowerCase();
      let text = '';

      if (ext === '.txt' || ext === '.md') {
        text = filePart.data.toString('utf8');

      } else if (ext === '.pdf') {
        const result = await pdfParse(filePart.data);
        text = result.text;

      } else if (ext === '.docx') {
        const m = await getMammoth();
        const result = await m.extractRawText({ buffer: filePart.data });
        text = result.value;

      } else {
        return json(res, { error: `Unsupported file type: ${ext}. Use .pdf, .docx, .txt, or .md` }, 400);
      }

      text = text.trim();
      if (!text) return json(res, { error: 'Could not extract any text from the file.' }, 400);

      saveCV(text);
      json(res, { success: true, preview: text });

    } catch (e) {
      console.error('CV upload error:', e);
      json(res, { error: e.message }, 500);
    }

  // ── POST /api/track ────────────────────────────────────────────────────────
  } else if (req.method === 'POST' && url === '/api/track') {
    const { company, role, score, notes } = await readBody(req);
    if (!company || !role) return json(res, { error: 'Company and role required.' }, 400);
    try {
      const num = trackApplication(company, role, score || '—', notes || '—');
      json(res, { num });
    } catch (e) {
      json(res, { error: e.message }, 500);
    }

  // ── GET /api/pipeline ──────────────────────────────────────────────────────
  } else if (req.method === 'GET' && url === '/api/pipeline') {
    json(res, { apps: parsePipeline() });

  // ── GET /api/config ────────────────────────────────────────────────────────
  } else if (req.method === 'GET' && url === '/api/config') {
    const key = loadApiKey();
    json(res, { apiKey: key ? key.slice(0,8)+'...' : '', cv: readCV() });

  // ── GET /api/list-models ───────────────────────────────────────────────────
  } else if (req.method === 'GET' && url === '/api/list-models') {
    const apiKey = loadApiKey();
    if (!apiKey) return json(res, { error: 'No API key set.' }, 400);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      const result = await r.json();
      if (result.error) throw new Error(result.error.message);
      const models = (result.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name.replace('models/', ''));
      json(res, { models });
    } catch(e) {
      json(res, { error: e.message }, 500);
    }

// ── POST /api/save-key ─────────────────────────────────────────────────────
  } else if (req.method === 'POST' && url === '/api/save-key') {
    const { key } = await readBody(req);
    if (!key) return json(res, { error: 'Key is empty.' }, 400);
    saveApiKey(key);
    json(res, { message: 'Gemini API key saved.' });

  // ── POST /api/save-cv ──────────────────────────────────────────────────────
  } else if (req.method === 'POST' && url === '/api/save-cv') {
    const { cv } = await readBody(req);
    if (!cv) return json(res, { error: 'CV content is empty.' }, 400);
    saveCV(cv);
    json(res, { message: 'CV saved.' });

  // ── POST /api/export ───────────────────────────────────────────────────────
  } else if (req.method === 'POST' && url === '/api/export') {
    const { type, format, content, company, role } = await readBody(req);
    if (!content) return json(res, { error: 'No content provided.' }, 400);
    const safeCompany = (company || 'cv').replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 30);
    const safeRole    = (role    || 'role').replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 30);
    const date        = new Date().toISOString().slice(0, 10);
    const prefix      = type === 'cl' ? 'cover' : 'cv';
    const slug        = `${prefix}-${safeCompany}-${safeRole}-${date}`;
    try {
      let filename;
      if (format === 'pdf') {
        filename = `${slug}.pdf`;
        const htmlContent = type === 'cl'
          ? coverLetterToHTML(content, company || '', role || '')
          : markdownToHTML(content, company || '', role || '');
        await generatePDF(htmlContent, path.join(OUTPUT_DIR, filename));
      } else {
        filename = `${slug}.docx`;
        await markdownToDOCX(content, path.join(OUTPUT_DIR, filename));
      }
      json(res, { filename });
    } catch(e) {
      json(res, { error: e.message }, 500);
    }

  // ── GET /api/open-folder ──────────────────────────────────────────────────
  } else if (req.method === 'GET' && url === '/api/open-folder') {
    exec(`explorer "${OUTPUT_DIR}"`);
    json(res, { ok: true });

  // ── GET /download/:filename ────────────────────────────────────────────────
  } else if (req.method === 'GET' && url.startsWith('/download/')) {
    const filename = decodeURIComponent(url.replace('/download/', ''));
    const filepath = path.join(OUTPUT_DIR, filename);
    try {
      const data = fs.readFileSync(filepath);
      const ext  = path.extname(filename).toLowerCase();
      const mime = ext === '.pdf'  ? 'application/pdf'
                 : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                 : 'text/html';
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      res.end(data);
    } catch { res.writeHead(404); res.end('File not found'); }

  // ── GET /tmp/:id — serves HTML in-memory for Edge/Chrome PDF rendering ───────
  } else if (req.method === 'GET' && url.startsWith('/tmp/')) {
    const id = url.slice(5);
    const html = pendingPages.get(id);
    if (html) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(404); res.end('Page expired');
    }

  } else {
    res.writeHead(302, { Location: '/' }); res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  =========================================');
  console.log(`   ${APP_NAME}`);
  console.log('  =========================================');
  console.log(`\n  URL: http://localhost:${PORT}`);
  console.log('  Press Ctrl+C to stop.\n');
  // Auto-open browser 1 second after server is ready
  setTimeout(() => {
    exec(`powershell -ExecutionPolicy Bypass -Command "Start-Process 'http://localhost:${PORT}'"`,
      err => { if (err) console.log('  (Could not auto-open browser — open manually)'); }
    );
  }, 1000);
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} in use — close other instances first.`);
  else console.error(e);
  process.exit(1);
});
