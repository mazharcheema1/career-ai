# Career AI

An AI-powered CV and cover letter generator. Paste a job description, and Career AI tailors your CV and writes a cover letter — ready to download as PDF or Word in seconds.

## Features

- Paste any job description and get a tailored CV instantly
- Generates matching cover letters automatically
- Edit your CV and cover letter in the browser before saving
- Download as PDF or Word (.docx)
- Upload your existing CV (PDF, Word, or paste as text)
- Saves all files to a local `output/` folder
- Works fully offline — no cloud storage, your data stays on your computer

## Setup

### 1. Install Node.js
Download from [nodejs.org](https://nodejs.org) if not already installed.

### 2. Install dependencies
Open a terminal in this folder and run:
```
npm install
npx playwright install msedge
```

### 3. Get a free Gemini API key
Go to [aistudio.google.com](https://aistudio.google.com) → Get API key → copy it.

### 4. Launch
Double-click **Launch Career AI.bat** — the browser opens automatically at `http://localhost:3738`.

On first launch, paste your Gemini API key in the Settings tab.

## Usage

1. Go to the **Settings** tab — paste your Gemini API key and your base CV
2. Come back to the main tab — enter company name, role, and paste the job description
3. Click **Generate CV** (and optionally tick "Also generate cover letter")
4. Edit the results in the text boxes
5. Click **Download PDF** or **Download Word** — file saves to the `output/` folder

## Tech Stack

- Node.js (no framework — pure `http` module)
- Google Gemini API for AI generation
- Playwright + Microsoft Edge for PDF generation
- `docx` package for Word files
