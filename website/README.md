# TermFlow — promo & download site

A self-contained, dependency-free landing + download page for TermFlow. Pure
HTML/CSS/JS — no build step — so it deploys to Vercel with zero config.

## Structure
```
website/
├── index.html      # the page
├── styles.css      # design system (matches the app brand)
├── main.js         # scroll reveal, lightbox, download links
├── vercel.json     # caching + clean URLs
└── assets/
    ├── demo-hero.gif  demo-agents.gif  demo-layout.gif  demo-tools.gif
    ├── shot-01..08.png     # real screenshots
    └── favicon.svg
```

## Deploy to Vercel
1. Push this folder (or the whole repo) to GitHub.
2. On Vercel: **New Project → Import** the repo.
3. Set **Root Directory** to `website` (Framework preset: *Other*). No build
   command, no output dir — it's static.
4. Deploy. Done.

Or with the CLI:
```bash
cd website
npx vercel        # preview
npx vercel --prod # production
```

## Wire the Download button
Open `main.js` and set `DOWNLOADS` to where the binaries live. Two options:

**A) GitHub Releases (recommended)** — no file-size limits:
```js
const DOWNLOADS = {
  installer: 'https://github.com/palamut62/termflow/releases/latest/download/TermFlow-0.1.0-x64.exe',
  portable:  'https://github.com/palamut62/termflow/releases/latest/download/TermFlow-0.1.0-x64.zip'
}
```
Create the release once:
```bash
gh release create v0.1.0 \
  dist/TermFlow-0.1.0-x64.exe dist/TermFlow-0.1.0-x64.zip \
  --repo palamut62/termflow --title "TermFlow v0.1.0" --notes "First release"
```
The `latest/download/...` URLs then always point at the newest release.

**B) Self-host on Vercel** — put the files in `website/public/download/` and use
relative paths:
```js
const DOWNLOADS = {
  installer: './download/TermFlow-0.1.0-x64.exe',
  portable:  './download/TermFlow-0.1.0-x64.zip'
}
```
Note: the installer is ~91 MB; Vercel's Hobby plan caps individual serverless
payloads, but static assets are served from the CDN and are generally fine. If
you hit a limit, use option A.

## Regenerate the GIFs
From the repo root (needs ffmpeg + `tmp-promo/termflow-promo.mp4`):
```bash
ffmpeg -y -ss 5  -t 8 -i tmp-promo/termflow-promo.mp4 -vf "fps=10,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4" website/assets/demo-hero.gif
```
(repeat with different `-ss` start seconds for the other demos).

## Customize
- Colors/spacing: CSS variables at the top of `styles.css`.
- Copy, features, changelog: plain HTML in `index.html`.
- Screenshots: replace anything in `assets/` and update the `<img src>`.
