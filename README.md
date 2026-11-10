# Muverse

Muverse is a local dance-video practice app. It searches and plays YouTube dance videos, suggests chorus/highlight ranges, analyzes dancer formations, and stores user corrections in the browser for later playback.

## Features

### Automatic highlights

The highlight API reads uploader chapters and YouTube comments, then checks time-synced lyrics from LRCLIB to find repeated chorus lines and align them to the video. Clearly labeled chapter/comment ranges can be used directly. A comment must describe a real range; praise such as “love this part” is not a boundary. Verse, pre-chorus, and other explicitly named non-hook sections are excluded. The result is a suggestion and can be absent or inaccurate for edited videos, missing lyrics, live videos, or songs whose metadata is incomplete.

Completed highlight results are saved in browser `localStorage` by YouTube video ID so a later Random Dance session can reuse them without requesting the API again. The lyrics themselves are not stored. The YouTube Data API key is used by the server route and must never be committed.

### Formation analysis and correction

The optional Python worker downloads a temporary copy of the video, samples frames, detects people and pose keypoints with Ultralytics YOLO26s-pose, estimates each dancer's floor position, and uses four user-calibrated stage corners to map camera perspective to a top-down stage. It tracks positions across samples and returns a timeline of formations. The UI overlays a top-down map beside the YouTube player.

After analysis, choose any detected formation from the editor, drag each dot to correct its position, and enter a dancer name. The colored dot and label represent that dancer in the saved snapshot. Click **บันทึกฟอร์เมชันที่แก้แล้ว** to save the corrected timeline. Formation timelines and stage calibration are stored locally in the browser by video ID. Re-run analysis if you change the stage calibration. Pose detection can still miss dancers when people are occluded, outside the frame, reflected in a mirror, or too small/blurred; the editor is provided to correct those cases.

### Random Dance

Choose **Random Dance** in a playlist, then press its play-all button. Muverse includes only videos with both a completed, non-empty highlight result and a saved, non-empty formation timeline. It shuffles eligible videos without repeating until the current round is exhausted, then starts another round. Each video plays from up to four seconds before its earliest saved highlight until four seconds after that highlight ends. The formation timeline saved for that exact video is loaded alongside it. Clips missing either saved analysis are skipped; the playlist shows how many are eligible.

Analysis results and edited formations are stored in the browser that performed the work. They do not sync across browsers or computers. If a video has not yet been analyzed and saved, it is not eligible for Random Dance.

## Technology and upstream projects

- [GridStage](https://github.com/ChangShengHsun/GridStage) — reference for the stage-calibration and top-down formation-editor workflow. Muverse's analyzer/UI in this branch is an independent implementation; GridStage source code was not copied into this repository. GridStage is MIT-licensed; see its [license](https://github.com/ChangShengHsun/GridStage/blob/main/LICENSE).
- [Ultralytics](https://github.com/ultralytics/ultralytics) — YOLO26s-pose runtime and model format used for person/pose detection. Its repository states AGPL-3.0 or Enterprise licensing; review those terms before distributing or operating the analyzer as a service. The pose weights are downloaded from [Ultralytics assets](https://github.com/ultralytics/assets/releases).
- [Next.js](https://github.com/vercel/next.js) / [React](https://github.com/facebook/react) — web app.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FFmpeg](https://ffmpeg.org/) — temporary video/audio download and media decoding in the local worker.
- [LRCLIB](https://lrclib.net/) — time-synced lyric lookup for highlight alignment.

## Run the web app

Install Node.js 20 LTS, clone this repository, and open the repository folder in VS Code. Create `.env.local` in the repository root:

```dotenv
YOUTUBE_API_KEY=your_key
AUDIO_ANALYSIS_URL=http://127.0.0.1:8765
```

Create a key in [Google Cloud Console](https://console.cloud.google.com/), enable **YouTube Data API v3**, and restrict the key to that API. Do not commit `.env.local`.

In the VS Code PowerShell terminal:

```powershell
npm install
npm run dev
```

Open <http://localhost:3100>. Keep this terminal open. The Python worker is a separate process in Ubuntu/WSL; see the [developer setup and handoff guide](docs/DEVELOPER_GUIDE.md).

## Repository map

- `app/page.tsx` — app state, playlist playback, and Random Dance sequencing.
- `components/youtube-player.tsx` — YouTube IFrame player, formation viewer/editor, and calibration controls.
- `lib/highlight-analysis.ts`, `lib/highlight-sources.ts`, `app/api/youtube/highlights/route.ts` — highlight analysis and source alignment.
- `lib/analysis-storage.ts`, `lib/auto-highlights.ts` — browser persistence for completed analyses.
- `services/audio-analysis/server.py` — local loopback worker API.
- `services/audio-analysis/analyze_formations.py` — YOLO pose inference, floor projection, dancer tracking, and formation extraction.
- `docs/DEVELOPER_GUIDE.md` — full installation, exact commands, architecture, and troubleshooting.
- `services/audio-analysis/README.md` — worker-specific operation and analysis details.

## Data and privacy

Playlist data, likes, watch history, analyzed highlights, formation timelines, names, and stage calibration are stored in browser `localStorage`. The worker binds to `127.0.0.1`; video files used for analysis are temporary and removed after processing. YouTube and LRCLIB requests follow their respective service policies. Never add API keys or tokens to Git.
