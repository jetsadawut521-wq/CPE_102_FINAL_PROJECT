# Muverse: developer setup and handoff guide

This guide takes a new developer from a Windows PC to a running local copy of Muverse, including the Ubuntu/WSL Python worker used for audio and formation analysis. Commands assume the Windows account folder and repository path shown in the examples; replace `NatNuay` and the repository path when needed.

## 1. What to install

On Windows, download and install:

1. [Git for Windows](https://git-scm.com/download/win) — clone and update the repository.
2. [Node.js 20 LTS](https://nodejs.org/en/download) — runs the Next.js website. The installer includes npm.
3. [Visual Studio Code](https://code.visualstudio.com/download) — open the repository, edit code, and run the web server.
4. **Windows Subsystem for Linux (WSL 2) with Ubuntu 24.04 LTS** — runs the Python media-analysis worker separately from the website. Follow Microsoft's [WSL installation guide](https://learn.microsoft.com/windows/wsl/install) if the command below is unavailable.

Python does not need to be installed on Windows for this setup. Install Python, FFmpeg, and the Linux packages inside Ubuntu. A Windows browser such as Chrome or Edge opens the app.

Install WSL/Ubuntu from an Administrator PowerShell window, then restart Windows if asked:

```powershell
wsl --install -d Ubuntu-24.04
```

Start Ubuntu from the Start menu and create a Linux username/password. When Ubuntu asks for a password, typing is invisible; type it and press Enter. This is the Ubuntu account password, not the GitHub or Google password. Check WSL:

```powershell
wsl --list --verbose
```

Ubuntu should show version `2`. If necessary:

```powershell
wsl --set-version Ubuntu-24.04 2
```

In VS Code, install the Microsoft **WSL** extension if you want to open the same Windows repository through the WSL remote window. It is optional; this guide runs the web app in a Windows PowerShell terminal and the Python worker in Ubuntu.

## 2. Get the repository

Clone the GitHub repository in PowerShell. For an existing checkout, `cd` into it instead of cloning again:

```powershell
cd $env:USERPROFILE\Downloads
git clone https://github.com/NatNuay/my-app-personal.git
cd my-app-personal
```

Open that exact folder in VS Code (**File → Open Folder**). To continue a feature branch, fetch and switch to it:

```powershell
git fetch origin
git switch --track origin/codex/yolo26s-pose
```

If Git says the local branch already exists, use `git switch codex/yolo26s-pose`. Check the active branch and pending edits before pulling:

```powershell
git status --short
git branch --show-current
git pull --ff-only
```

Do not run `git pull` while it reports local edits in files that the update would replace. Commit the edits or stash them first. Example stash and update:

```powershell
git stash push -m "save my work before update"
git pull --ff-only
git stash pop
```

Resolve any conflict before continuing. Do not delete the repository or `.git` directory to fix a pull error.

## 3. Configure YouTube search and highlights

Create a Google Cloud project at [Google Cloud Console](https://console.cloud.google.com/), enable **YouTube Data API v3**, create an API key, and restrict it to YouTube Data API v3. In the repository root, create `.env.local` (the leading dot matters):

```dotenv
YOUTUBE_API_KEY=PASTE_YOUR_GOOGLE_CLOUD_API_KEY_HERE
AUDIO_ANALYSIS_URL=http://127.0.0.1:8765
```

`YOUTUBE_API_KEY` is from Google Cloud, not a GitHub token. Do not put a key in a command history, screenshot, issue, commit, or source file. `.env.local` is ignored by Git. After editing it, restart `npm run dev` so Next.js reads the new values.

Highlights use the server route to read the video's uploader chapter data and relevant comments from YouTube Data API, then request time-synced lyric metadata from LRCLIB to align repeated chorus lines. Explicitly labeled hook/chorus/dance-break ranges are preferred when their start and end are present. Comments that merely praise a moment are not used as boundaries. When evidence is insufficient, the service may return no highlight. Completed results are saved locally in the browser for Random Dance; lyrics are not retained.

## 4. Set up Ubuntu/WSL and the Python worker

Open an Ubuntu terminal. Update apt and install Python tooling, FFmpeg, and Linux libraries needed by OpenCV/Ultralytics:

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip ffmpeg libgl1 libglib2.0-0 libgles2
```

The `sudo` password is the Linux password created during first Ubuntu launch. The terminal does not display characters while typing it.

Move to the Windows checkout through WSL's `/mnt/c` mount. The example below is the default path used in this project:

```bash
cd /mnt/c/Users/NatNuay/Downloads/my-app-personal
```

Create an isolated Python environment and install the fast audio-analysis dependencies plus the YOLO26 pose runtime:

```bash
cd services/audio-analysis
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-fast.txt
python -m pip install -r requirements-formation-yolo.txt
```

The first YOLO installation downloads large PyTorch packages. The first formation analysis also downloads the `yolo26s-pose.pt` weights. Allow time and disk space for both. If `python3 -m venv` reports that `ensurepip` is unavailable, install `python3-venv` with apt and repeat the environment creation. The venv lives under `services/audio-analysis/.venv`; do not commit it.

Run the worker from the repository root (important: this is the correct script path):

```bash
cd ../..
python services/audio-analysis/server.py
```

Leave the Ubuntu terminal open. It serves the local worker on `127.0.0.1:8765`. To stop it, focus that terminal and press **Ctrl+C**. Do not start a second worker on the same port. If the log says `Address already in use`, one is already running; use that worker or stop the old process before starting another.

Optional worker check in a second PowerShell terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
```

The endpoint should return `status: ok`. `AUDIO_ANALYSIS_URL` in `.env.local` must point to the same address.

### Later Ubuntu sessions

Each time Ubuntu is restarted, start the worker again:

```bash
cd /mnt/c/Users/NatNuay/Downloads/my-app-personal/services/audio-analysis
source .venv/bin/activate
cd ../..
python services/audio-analysis/server.py
```

The Python environment and installed packages persist, so normally there is no need to reinstall them. After pulling a commit that changes either requirements file, run the relevant `python -m pip install -r ...` command again inside the activated environment.

## 5. Run the website in VS Code

In VS Code, select **Terminal → New Terminal** and make sure the shell is PowerShell and the current directory is the repository root:

```powershell
cd $env:USERPROFILE\Downloads\my-app-personal
npm install
npm run dev
```

Keep this terminal open, then visit <http://localhost:3100>. For everyday restarts after dependencies are already installed, only `npm run dev` is needed. The site and worker use separate terminals: PowerShell runs Next.js; Ubuntu runs `server.py`.

If port 3100 is already in use, a Next.js server is still running. Reuse its browser page, or stop that existing web-server terminal with Ctrl+C before starting it again. The worker is on port 8765; the two services do not share a port.

## 6. Analyze and correct formations

1. Open a dance video in Muverse and pause on a clear frame that shows the whole stage floor.
2. Press **ตั้งค่าพื้นเวที (4 จุด)**. Click the stage-floor corners in this order: far-left, far-right, near-right, near-left. Click the floor boundary, not the wall, dancer, or video controls. If the video is mirrored, calibrate what you see; the app converts coordinates back to the source frame.
3. Press **วิเคราะห์แถวทั้งคลิป**. The video continues playing while the worker downloads and analyzes the clip. The worker may need several minutes for a long or high-resolution clip; the UI's Random Dance eligibility requires the analysis to finish and save.
4. When the timeline is ready, use **ฟอร์เมชันที่แก้ไข** to select any detected formation. Pause/reference the video at the matching time, drag the dots on the map, and enter dancer names. Names and corrected coordinates belong to that point in that formation snapshot.
5. Press **บันทึกฟอร์เมชันที่แก้แล้ว**. The updated timeline and calibration are saved in this browser, keyed to that YouTube video ID. Repeat for any formations that need correction. Random Dance uses the exact saved video timeline.

The map is a top-down floor projection. It estimates the dancer's ground contact from visible ankle keypoints (with fallback pose cues), projects that location through the four calibrated stage corners, and groups sampled poses into formation snapshots. YOLO26s-pose detects people and pose keypoints; it does not identify real people. The names are user-entered labels. Occlusion, mirrors, people leaving the image, floor boundaries hidden by bodies, and camera motion can still cause missed/incorrect points. Correct them in the editor before using the video in Random Dance.

## 7. Use Random Dance

Each playlist has a **Random Dance** play mode. Choose the mode, then use the playlist's play-all button. Muverse filters the playlist to videos whose browser has both (a) a completed non-empty highlight result and (b) a saved non-empty formation timeline. It skips every other video. It chooses the first highlight by earliest start time, seeks to `max(0, highlight start - 4 seconds)`, and moves on four seconds after the highlight ends. It shuffles eligible clips without repeats; after each has played, it begins another randomized round. Previous/next follows the played order where available.

No eligible tracks means there is no Random Dance playback yet. Open each desired video, let its highlight result finish, analyze and edit its formation timeline, and save the formation. Results are browser-local; the same user on another browser/computer must analyze/save there too. Clearing site data or browser storage removes those saved results.

## 8. Architecture and where to continue development

### Web app

- `app/page.tsx`: application state, playlist selection, play modes, history, and shuffle scheduling.
- `components/playlist-panel.tsx`: playlist controls, including Random Dance selection and play-all.
- `components/youtube-player.tsx` and `.css`: YouTube IFrame API player, highlight controls, stage calibration, formation timeline, drag editor, and dancer labels.
- `lib/playlist.ts`: playlist model stored in browser localStorage.
- `lib/auto-highlights.ts`: retrieves highlight proposals and retains completed local results.
- `lib/analysis-storage.ts`: versioned local browser stores for highlights, formation timelines, and calibration points.
- `app/api/youtube/highlights/route.ts`: YouTube metadata/comments plus LRCLIB lyric alignment.
- `app/api/youtube/formations/route.ts`: web-to-worker bridge for formation analysis.

### Python worker

- `services/audio-analysis/server.py`: bounded local HTTP jobs for fast/full audio analysis and formation jobs. It listens only on loopback and reads/writes its cache beneath the user's home cache folder.
- `services/audio-analysis/analyze.py`: audio analysis runner.
- `services/audio-analysis/analyze_formations.py`: YOLO26s-pose inference, floor projection, dancer tracking, formation segmentation.
- `services/audio-analysis/requirements-fast.txt`: fast audio packages.
- `services/audio-analysis/requirements-formation-yolo.txt`: YOLO runtime and shared NumPy pin.

Formation route requests include the video ID and four normalized stage corners. Worker analysis output is cached server-side for a limited time by video ID and calibration. The corrected user timeline is saved separately in browser localStorage and takes precedence when the video is opened. The highlight browser store is keyed by video ID and only stores segments, not lyric text.

### Upstream projects and licensing

- [GridStage](https://github.com/ChangShengHsun/GridStage) informed the user workflow: calibrate the stage and edit formations on a top-down map. This repository does **not** include copied GridStage code; its analyzer and editor are implemented in Muverse. GridStage's upstream license is [MIT](https://github.com/ChangShengHsun/GridStage/blob/main/LICENSE).
- [Ultralytics](https://github.com/ultralytics/ultralytics) supplies the YOLO model/runtime used by the formation analyzer; the model weights are fetched from [Ultralytics assets](https://github.com/ultralytics/assets/releases). Ultralytics publishes under AGPL-3.0 with an Enterprise option. Confirm license obligations for the intended distribution/deployment before shipping the analyzer.
- The web app uses [Next.js](https://github.com/vercel/next.js) and [React](https://github.com/facebook/react). Media handling uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FFmpeg](https://ffmpeg.org/). Lyrics are looked up through [LRCLIB](https://lrclib.net/).

## 9. Troubleshooting

**`pip: command not found`** — activate `.venv` and use `python -m pip ...`; if pip is not installed, run `sudo apt install python3-pip python3-venv`.

**`libGLESv2.so.2` or `libGL.so.1` missing** — install `libgles2 libgl1 libglib2.0-0` in Ubuntu, then restart the worker.

**`Address already in use` on port 8765** — a Python worker is already running. Use it, or stop it with Ctrl+C in its terminal. Don't launch another worker until it has stopped.

**`Address already in use` on port 3100** — a Next.js dev server is already running. Use its existing browser page or stop its terminal before starting another.

**Formation analysis is unavailable** — verify the Ubuntu worker is running and that `.env.local` contains `AUDIO_ANALYSIS_URL=http://127.0.0.1:8765`. Keep the Ubuntu terminal open during analysis.

**A video is absent in Random Dance** — it must have a non-empty saved highlight result and a formation timeline saved after analysis. Open the video once so its highlight request completes, then analyze/correct/save its formation in the same browser.

**GitHub asks for a password** — GitHub does not accept account passwords for HTTPS Git. Sign in with `gh auth login` or use Git Credential Manager in Windows, or use a fine-grained personal access token as the HTTPS password. Never paste the token into chat or commit it. For read-only repository access the token only needs Contents: read; pushing needs Contents: read and write.

**Local changes block `git pull`** — first inspect `git status --short`. Preserve work with a commit or `git stash push -m "..."`, pull, then restore a stash with `git stash pop`. Don't run `git reset --hard` or delete the checkout to make an update succeed.

## 10. Safe contribution workflow

In PowerShell at the repository root:

```powershell
git status --short
git switch -c codex/short-feature-name
```

After making a focused change, inspect the diff and commit only the intended files:

```powershell
git diff --check
git diff
git add README.md docs/DEVELOPER_GUIDE.md components/youtube-player.tsx
git commit -m "Describe the change"
git push -u origin codex/short-feature-name
```

If working on another file set, replace the `git add` list with those exact paths. Keep `.env.local`, `.venv`, downloaded models, and local media out of Git. Follow project CI and review results before merging.
