# คู่มือติดตั้งและส่งต่องาน Muverse

คู่มือนี้อธิบายวิธีดึง branch ปัจจุบัน ตั้งค่าเว็บและ worker สำหรับวิเคราะห์เสียง/ฟอร์เมชัน และจุดสำคัญสำหรับนักพัฒนาที่รับช่วงต่อ

## 1. สิ่งที่ต้องติดตั้ง

- Git สำหรับดึงและจัดการ source code
- Node.js 20 LTS และ npm สำหรับเว็บ Next.js
- VS Code หรือ editor ที่ถนัด
- หากต้องใช้การวิเคราะห์ฟอร์เมชันบน Windows: WSL 2 พร้อม Ubuntu 24.04 และ Python 3.11 ขึ้นไปใน Ubuntu
- FFmpeg ในสภาพแวดล้อมที่เปิด worker

ติดตั้ง WSL ได้จาก PowerShell แบบ Administrator:

```powershell
wsl --install -d Ubuntu-24.04
```

เปิด Ubuntu ให้ตั้งชื่อบัญชีและรหัสผ่าน จากนั้นตรวจว่าใช้ WSL 2:

```powershell
wsl --list --verbose
```

VS Code WSL extension เป็นตัวเลือก ไม่จำเป็นหากเปิดเว็บใน PowerShell ของ Windows และเปิด worker แยกใน Ubuntu

## 2. ดึง branch ของโครงการ

branch ที่ใช้ส่งต่องานคือ `codex/xpo-ui-integration` ใน repository `NatNuay/muverse-xpo-integration`:

```powershell
cd $env:USERPROFILE\Downloads
git clone --branch codex/xpo-ui-integration --single-branch https://github.com/NatNuay/muverse-xpo-integration.git
cd muverse-xpo-integration
git status --short --branch
```

ถ้ามี checkout อยู่แล้ว ให้เข้าโฟลเดอร์นั้นและตรวจ branch/การแก้ไขก่อนอัปเดต:

```powershell
git fetch origin
git switch codex/xpo-ui-integration
git status --short --branch
git pull --ff-only
```

อย่าทับหรือลบการแก้ไขที่ยังไม่ได้ commit เพื่อแก้ปัญหา pull ให้ commit หรือสำรองการแก้ไขก่อน

## 3. ตั้งค่า YouTube API และเว็บ

ใน [Google Cloud Console](https://console.cloud.google.com/) สร้างโปรเจกต์ เปิด **YouTube Data API v3** และสร้าง API key โดยจำกัดสิทธิ์ให้ใช้กับ API นี้ จากนั้นสร้างไฟล์ `.env.local` ในโฟลเดอร์หลัก:

```dotenv
YOUTUBE_API_KEY=ใส่คีย์ของคุณ
AUDIO_ANALYSIS_URL=http://127.0.0.1:8765
```

คีย์นี้ใช้ฝั่ง API route ของ Next.js อย่าใส่ใน source code, ภาพหน้าจอ, commit หรือ issue ไฟล์ `.env.local` ต้องไม่ถูก commit หากแก้คีย์ขณะเว็บเปิดอยู่ ให้หยุดและเปิด `npm run dev` ใหม่

ติดตั้งและเปิดเว็บจาก PowerShell ที่โฟลเดอร์หลัก:

```powershell
npm ci
npm run dev
```

เปิด <http://localhost:3100> และคง terminal นี้ไว้ หากต้องการ build สำหรับ production ใช้ `npm run build` แล้วเปิดด้วย `npm start`

## 4. ติดตั้งและเปิด worker ใน Ubuntu/WSL

ใน Ubuntu ติดตั้ง Python, FFmpeg และไลบรารีระบบที่ OpenCV ใช้:

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip ffmpeg libgl1 libglib2.0-0 libgles2
```

เข้า checkout เดียวกันที่อยู่ในไดรฟ์ Windows โดยแทน `<ชื่อบัญชี Windows>` ด้วยชื่อโฟลเดอร์บัญชี Windows จริง:

```bash
WIN_USER="ชื่อโฟลเดอร์บัญชี Windows"  # แก้เป็นชื่อโฟลเดอร์จริง เช่น NatNuay
cd "/mnt/c/Users/$WIN_USER/Downloads/muverse-xpo-integration/services/audio-analysis"
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-fast.txt
python -m pip install -r requirements-formation-yolo.txt
```

ชุด formation ติดตั้ง PyTorch/Ultralytics ซึ่งมีขนาดใหญ่ และดาวน์โหลดน้ำหนัก YOLO เมื่อวิเคราะห์ครั้งแรก ตรวจพื้นที่ว่างและรอให้การติดตั้ง/ดาวน์โหลดเสร็จ อย่า commit โฟลเดอร์ `.venv`

เปิด worker จากโฟลเดอร์หลักของ repository:

```bash
cd ../..
python services/audio-analysis/server.py
```

Worker เปิดที่ `127.0.0.1:8765` โดยค่าเริ่มต้น ทดสอบจาก PowerShell อีกหน้าต่าง:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
```

ควรได้ `status: ok` พร้อม `engine` และจำนวนเธรด เปิดทั้งเว็บและ worker ไว้ในคนละ terminal การวิเคราะห์เสียงเริ่มจากโหมด `fast` หากเปลี่ยนแพ็กเกจใน requirements ให้เปิด venv แล้วติดตั้งไฟล์ requirements ที่เปลี่ยนอีกครั้ง

หาก port 8765 ถูกใช้อยู่ แสดงว่ามี worker ทำงานอยู่แล้ว เลือกใช้ตัวเดิมหรือหยุดตัวเดิมด้วย **Ctrl+C** ก่อน การเปิด worker ซ้ำบน port เดียวกันจะทำให้เริ่มไม่ได้

## 5. การตั้งค่า worker เพิ่มเติม

กำหนดตัวแปรใน environment ของ process ฝั่ง Ubuntu ได้:

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
| --- | --- | --- |
| `AUDIO_ANALYSIS_PORT` | `8765` | port ของ worker |
| `AUDIO_ANALYSIS_ENGINE` | `fast` | ใช้ `fast` หรือ `full` สำหรับวิเคราะห์เสียง |
| `AUDIO_ANALYSIS_THREADS` | `6` | จำนวนเธรดสูงสุดที่ร้องขอ; worker จำกัดตาม CPU ที่มี |
| `AUDIO_ANALYSIS_CACHE` | `~/.cache/muverse-audio` | ที่เก็บแคชผลฟอร์เมชันฝั่ง worker |
| `AUDIO_ANALYSIS_TOKEN` | ว่าง | token สำหรับกรณีตั้งค่าการเชื่อมต่อที่มีการตรวจ token |

เว็บอ่าน `AUDIO_ANALYSIS_URL` และ token ที่เกี่ยวข้องจาก environment ของ Next.js ไม่ใช่จากโค้ดหน้าเว็บ อย่าเปิดพอร์ต worker สู่สาธารณะโดยตรง หากต้องให้ worker อยู่คนละเครื่อง ต้องใช้ HTTPS/reverse proxy และตั้ง token ให้ตรงกัน พร้อมจำกัดสิทธิ์เข้าถึง

## 6. วิธีใช้งานและขอบเขตผลวิเคราะห์

### ไฮไลท์

ระบบใช้ข้อมูลบท/ความเห็นของ YouTube ที่ระบุช่วงอย่างชัดเจน ข้อมูลเนื้อเพลงแบบซิงก์เวลา และข้อเสนอจากการวิเคราะห์เสียงเพื่อหาช่วงที่อาจเป็นฮุค ผลเสียงโหมด `fast` มองหารูปแบบเสียงที่ซ้ำ จึงอาจเลือก verse หรือไม่พบฮุคได้ การค้นหาเนื้อเพลง/YouTube อาจไม่มีข้อมูลสำหรับบางคลิป ผู้ใช้ตรวจ ปรับ และบันทึกช่วง A–B ได้

ผลที่บันทึกแล้วและช่วงที่แก้ไขเก็บใน browser `localStorage` ตาม video ID ไม่ได้ sync ระหว่างอุปกรณ์

### ฟอร์เมชัน

1. เปิดวิดีโอและหยุดในภาพที่เห็นขอบพื้นเวทีชัด
2. เลือกตั้งค่าพื้นเวที 4 มุม แล้วคลิกตามลำดับมุมไกลซ้าย → ไกลขวา → ใกล้ขวา → ใกล้ซ้าย
3. เริ่มวิเคราะห์ฟอร์เมชัน รอให้ worker ทำงานเสร็จ
4. เลือกช่วงในไทม์ไลน์ ลากจุดเพื่อแก้ตำแหน่ง และแก้ชื่อนักเต้นได้
5. บันทึกการแก้ไข ฟอร์เมชันและมุมพื้นจะถูกจัดเก็บในเบราว์เซอร์ของผู้ใช้

ตัวตรวจจับประเมินจุดยืนจาก keypoints ของร่างกายและแปลงมุมมองด้วยจุดพื้นทั้งสี่ YOLO ตรวจจับท่าทาง ไม่ได้ระบุตัวบุคคลจริง การบังกัน เงาสะท้อน การเคลื่อนกล้อง หรือภาพไม่ชัดอาจทำให้ผลคลาดเคลื่อน ควรตรวจแก้ก่อนนำไปใช้

### Random Dance

คลิปจะเข้าคิว Random Dance เมื่อมีไฮไลท์ที่บันทึกแล้วอย่างน้อยหนึ่งช่วงและมีไทม์ไลน์ฟอร์เมชันที่บันทึกแล้ว หากไม่มีข้อมูลครบ คลิปจะไม่เข้าเงื่อนไข การเล่นและข้อมูลวิเคราะห์อ้างอิงข้อมูลใน browser ปัจจุบัน การเปิดเว็บบนเครื่อง/โปรไฟล์เบราว์เซอร์ใหม่ไม่ได้ย้ายข้อมูลส่วนตัวจากเครื่องเดิม

หน้า Random Dance มีรายการแนะนำที่ฝังมากับแอป 3 ชุด (Trending, T-pop และ K-pop Mix) ชุดละ 6 คลิป พร้อมข้อมูลไฮไลท์และฟอร์เมชันที่เตรียมไว้สำหรับคลิปไม่ซ้ำ 14 รายการ ข้อมูลเหล่านี้อยู่ใน `data/recommended-playlists.json` และแยกจากเพลย์ลิสต์ส่วนตัว

## 7. จุดสำคัญใน source code

- `app/page.tsx` — สถานะแอป การเปลี่ยนหน้า ประวัติ และการจัดคิว Random Dance
- `components/youtube-player.tsx` และ `components/youtube-player.css` — YouTube player เครื่องมือฝึก แผนผังไทม์ไลน์ ไฮไลท์ และหน้าจอเต็ม
- `components/playlist-panel.tsx` — การจัดการและเล่นเพลย์ลิสต์
- `lib/playlist.ts` — โมเดลเพลย์ลิสต์และการจัดเก็บในเบราว์เซอร์
- `lib/analysis-storage.ts` — การเก็บผลไฮไลท์ ฟอร์เมชัน และจุดปรับเทียบ
- `data/recommended-playlists.json` — เพลย์ลิสต์แนะนำและผลวิเคราะห์ตั้งต้นที่ส่งไปกับเว็บ
- `app/api/youtube/` — API routes สำหรับค้นหา ข้อมูลคลิป และการเชื่อมต่อ worker
- `services/audio-analysis/server.py` — HTTP worker ในเครื่องสำหรับงานวิเคราะห์
- `services/audio-analysis/analyze.py` — วิเคราะห์รูปแบบเสียง
- `services/audio-analysis/analyze_formations.py` — ตรวจจับท่าทาง แปลงตำแหน่งพื้น และจัดช่วงฟอร์เมชัน

## 8. แก้ปัญหาเบื้องต้น

- **ค้นหาไม่ได้** — ตรวจว่า `YOUTUBE_API_KEY` ถูกต้อง เปิด YouTube Data API v3 แล้ว และ restart Next.js หลังแก้ `.env.local`
- **เปิดคลิปได้แต่ไม่พบไฮไลท์** — อาจไม่มีเนื้อเพลง/บท/ความเห็นที่ใช้ได้ หรือเสียงไม่พบช่วงซ้ำ ตรวจสถานะ worker และข้อความผลวิเคราะห์
- **วิเคราะห์ฟอร์เมชันไม่ได้** — ตรวจ `http://127.0.0.1:8765/health`, dependencies ใน venv, FFmpeg และมุมเวทีทั้งสี่
- **ข้อมูลหายบนเครื่องอื่น** — ข้อมูลบัญชีและผลแก้ไขอยู่ใน localStorage ไม่ใช่ฐานข้อมูลส่วนกลาง
- **port ถูกใช้แล้ว** — ตรวจ terminal/process เดิมก่อนเริ่ม service ซ้ำ

อย่าลบ `.git` หรือ repository เพื่อแก้ปัญหา pull และอย่าแชร์ API key/token ผ่านแชตหรือ commit

## 9. แหล่งอ้างอิงและสิทธิ์ใช้งาน

แนวทางหน้าจออ้างอิงไฟล์ Figma ตาม [บันทึกการผสาน UI](XPO_UI_INTEGRATION.md) โดยไม่คัดลอก source/assets จาก Figma โฟลว์ปรับเทียบพื้นเวทีอ้างอิงแนวคิดจาก [GridStage](https://github.com/ChangShengHsun/GridStage) แต่โค้ดใน Muverse เขียนแยก

โปรเจกต์ใช้ Next.js, React, yt-dlp, FFmpeg, LRCLIB และ Ultralytics โปรดตรวจ license ของ dependency และโมเดลก่อนเผยแพร่ โดยเฉพาะ Ultralytics ที่มีเงื่อนไข AGPL-3.0 หรือ Enterprise
